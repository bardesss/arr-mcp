import { randomUUID } from 'node:crypto';
import type { Config } from '../config/schema.ts';
import { logger } from '../core/logger.ts';
import { defaultSweepRange, LOOKUP_CONCURRENCY, LOOKUP_QUEUE_TIMEOUT_MS, LOOKUP_TIMEOUT_MS, lookupGate, type LookupGate, parseSweepRange, requestHost, resolvePrivate } from './addresses.ts';
import { CATALOG, type CatalogEntry } from './catalog.ts';
import { matchResults, urlResolver, type ResultRow } from './match.ts';
import { probeHost, type Found, type ProbeOpts } from './probe.ts';

export type RunState = {
    id: string;
    phase: 'quick' | 'sweep';
    running: boolean;
    tried: number;
    total: number;
    rows: ResultRow[];
    skipped: { what: string; reason: string }[];
    range?: string;
    suggestedRange?: string;
    /** A quick search's host, as the request named it, when it was probed. */
    hostTried?: string;
    /** The address that host was probed at. */
    hostAddress?: string;
    /** How many container names resolved to a private address and were probed. */
    containersResolved?: number;
    /** Set when a quick search threw; the error is in the log. */
    failed?: true;
    startedAt: string;
};

export type DiscoveryOpts = {
    catalog?: readonly CatalogEntry[];
    probe?: (host: string, entries: readonly CatalogEntry[], source: Found['source'], opts: ProbeOpts) => Promise<Found[]>;
    lookup?: (host: string) => Promise<string[]>;
    timeoutMs?: number;
    sweepTimeoutMs?: number;
    lookupTimeoutMs?: number;
    lookupQueueTimeoutMs?: number;
    concurrency?: number;
};

const snapshot = (s: RunState): RunState => ({ ...s, rows: [...s.rows], skipped: [...s.skipped] });

const sameFind = (a: Found, b: Found): boolean => a.type === b.type && a.url === b.url;

/**
 * One run at a time, kept in memory. Every probe goes to an address that
 * `resolvePrivate` has checked, while the reported url keeps the name.
 */
export class Discovery {
    private readonly catalog: readonly CatalogEntry[];
    private readonly probe: NonNullable<DiscoveryOpts['probe']>;
    private readonly lookup: DiscoveryOpts['lookup'];
    private readonly timeoutMs: number;
    private readonly sweepTimeoutMs: number;
    private readonly lookupTimeoutMs: number;
    private readonly concurrency: number;
    private readonly lookups: LookupGate;
    private state: RunState | undefined;
    /** What the current run found, before matching, so a render can match it against the config as it is then. */
    private finds: Found[] = [];

    constructor(opts: DiscoveryOpts = {}) {
        this.catalog = opts.catalog ?? CATALOG;
        this.probe = opts.probe ?? probeHost;
        this.lookup = opts.lookup;
        // A cold first request to a service can take more than a second.
        this.timeoutMs = opts.timeoutMs ?? 3000;
        // The whole answer, body included, so a cold *arr login page or a Plex on a slow NAS still makes it.
        this.sweepTimeoutMs = opts.sweepTimeoutMs ?? 800;
        this.lookupTimeoutMs = opts.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
        this.lookups = lookupGate(LOOKUP_CONCURRENCY, opts.lookupQueueTimeoutMs ?? LOOKUP_QUEUE_TIMEOUT_MS);
        // A dead /24 costs one timeout per round: 32 rounds of 800 ms is about 26 s.
        this.concurrency = opts.concurrency ?? 8;
    }

    /** The run as it was matched when its rows last changed. */
    current(): RunState | undefined {
        return this.state ? snapshot(this.state) : undefined;
    }

    /**
     * The run with its rows matched against `config` now, so a service added
     * since the run started shows as already added rather than offered again.
     * Each configured url is resolved once per call.
     */
    async view(config: Config): Promise<RunState | undefined> {
        if (this.state === undefined) return undefined;
        const out = snapshot(this.state);
        try {
            out.rows = await matchResults(this.finds, config, urlResolver(this.lookup, this.lookupTimeoutMs, this.lookups));
        } catch (err) {
            logger.warn({ err }, 'service discovery could not match against the current config');
        }
        return out;
    }

    private resolve(host: string) {
        return resolvePrivate(host, this.lookup, this.lookupTimeoutMs, this.lookups);
    }

    async quick(hostHeader: string | undefined, config: Config): Promise<RunState> {
        if (this.state?.running) return snapshot(this.state);
        const state = this.begin('quick', 0, []);
        const finds = this.finds;
        const sources: string[] = [];
        state.containersResolved = 0;

        try {
            // The host first: name lookups share a small thread pool, and the
            // host's own lookup must not wait behind a queue of container names
            // that do not exist.
            const host = requestHost(hostHeader);
            let hostJob: Promise<void> = Promise.resolve();
            if (host !== undefined) {
                sources.push(`host ${host}`);
                const out = await this.resolve(host);
                if (!out.ok) {
                    state.skipped.push({ what: host, reason: out.reason });
                } else {
                    const range = defaultSweepRange(out.address);
                    if (range !== undefined) state.suggestedRange = range;
                    state.hostTried = host;
                    state.hostAddress = out.address;
                    state.total += 1;
                    hostJob = (async () => {
                        finds.push(...(await this.safeProbe(host, this.catalog, 'host', { timeoutMs: this.timeoutMs, address: out.address })));
                        state.tried += 1;
                    })();
                }
            }

            const names = [...new Set(this.catalog.flatMap(e => e.containerNames))];
            if (names.length > 0) sources.push('containers');
            const containerJobs = names.map(async name => {
                // Not resolving, resolving too slowly, or resolving off the
                // private network drops the name quietly.
                const out = await this.resolve(name);
                if (!out.ok) return;
                const entries = this.catalog.filter(e => e.containerNames.includes(name));
                state.containersResolved = (state.containersResolved ?? 0) + 1;
                state.total += 1;
                finds.push(...(await this.safeProbe(name, entries, 'container', { timeoutMs: this.timeoutMs, address: out.address })));
                state.tried += 1;
            });

            await Promise.all([hostJob, ...containerJobs]);
            state.rows = await matchResults(finds, config, urlResolver(this.lookup, this.lookupTimeoutMs, this.lookups));
        } catch (err) {
            state.failed = true;
            logger.error({ err }, 'service discovery quick failed');
        } finally {
            this.finish(state, sources);
        }
        return snapshot(state);
    }

    startSweep(range: string, config: Config): RunState | { refused: string } {
        if (this.state?.running) return snapshot(this.state);
        const parsed = parseSweepRange(range);
        if (!parsed.ok) return { refused: parsed.reason };
        // What a quick search found stays listed: a service found only by its
        // container name is not on any address the sweep tries.
        const carried = this.finds.filter(f => f.source !== 'sweep');
        const carriedRows = this.state?.rows.filter(r => r.source !== 'sweep') ?? [];
        const state = this.begin('sweep', parsed.addresses.length, carried);
        state.rows = carriedRows;
        state.range = range.trim();
        this.sweep(state, parsed.addresses, config).catch(err => {
            logger.error({ err }, 'service discovery sweep failed');
        });
        return snapshot(state);
    }

    private begin(phase: RunState['phase'], total: number, finds: Found[]): RunState {
        const state: RunState = {
            id: randomUUID(),
            phase,
            running: true,
            tried: 0,
            total,
            rows: [],
            skipped: [],
            startedAt: new Date().toISOString()
        };
        this.state = state;
        this.finds = finds;
        return state;
    }

    private finish(state: RunState, sources: string[]): void {
        state.running = false;
        try {
            logger.info({ sources, range: state.range, rows: state.rows.length, phase: state.phase }, `service discovery ${state.phase} finished`);
        } catch {
            // a failing logger must not undo a finished run
        }
    }

    private async safeProbe(host: string, entries: readonly CatalogEntry[], source: Found['source'], opts: ProbeOpts): Promise<Found[]> {
        try {
            return await this.probe(host, entries, source, opts);
        } catch {
            return [];
        }
    }

    private async sweep(state: RunState, addresses: string[], config: Config): Promise<void> {
        const finds = this.finds;
        const resolve = urlResolver(this.lookup, this.lookupTimeoutMs, this.lookups);
        // Matches run one after another so an older answer never overwrites a newer one.
        let chain: Promise<void> = Promise.resolve();
        const rematch = (): void => {
            chain = chain.then(async () => {
                state.rows = await matchResults(finds, config, resolve).catch(() => state.rows);
            });
        };
        let next = 0;
        const worker = async (): Promise<void> => {
            while (next < addresses.length) {
                const address = addresses[next++]!;
                try {
                    const out = await this.resolve(address);
                    if (out.ok) {
                        const hits = await this.safeProbe(address, this.catalog, 'sweep', {
                            timeoutMs: this.sweepTimeoutMs,
                            address: out.address
                        });
                        const fresh = hits.filter(h => !finds.some(f => sameFind(f, h)));
                        if (fresh.length > 0) {
                            finds.push(...fresh);
                            rematch();
                        }
                    }
                } catch (err) {
                    logger.warn({ err, address }, 'service discovery sweep address failed');
                }
                state.tried += 1;
            }
        };
        try {
            await Promise.all(Array.from({ length: Math.min(this.concurrency, addresses.length) }, worker));
            await chain;
        } finally {
            this.finish(state, ['sweep']);
        }
    }
}
