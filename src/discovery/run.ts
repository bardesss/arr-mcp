import { randomUUID } from 'node:crypto';
import type { Config } from '../config/schema.ts';
import { logger } from '../core/logger.ts';
import { defaultSweepRange, parseSweepRange, requestHost, resolvePrivate } from './addresses.ts';
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
    startedAt: string;
};

export type DiscoveryOpts = {
    catalog?: readonly CatalogEntry[];
    probe?: (host: string, entries: readonly CatalogEntry[], source: Found['source'], opts: ProbeOpts) => Promise<Found[]>;
    lookup?: (host: string) => Promise<string[]>;
    timeoutMs?: number;
    sweepTimeoutMs?: number;
    concurrency?: number;
};

const snapshot = (s: RunState): RunState => ({ ...s, rows: [...s.rows], skipped: [...s.skipped] });

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
    private readonly concurrency: number;
    private state: RunState | undefined;

    constructor(opts: DiscoveryOpts = {}) {
        this.catalog = opts.catalog ?? CATALOG;
        this.probe = opts.probe ?? probeHost;
        this.lookup = opts.lookup;
        this.timeoutMs = opts.timeoutMs ?? 1500;
        this.sweepTimeoutMs = opts.sweepTimeoutMs ?? 400;
        // A dead /24 costs one timeout per round: 32 rounds of 400 ms is about 13 s.
        this.concurrency = opts.concurrency ?? 8;
    }

    current(): RunState | undefined {
        return this.state ? snapshot(this.state) : undefined;
    }

    async quick(hostHeader: string | undefined, config: Config): Promise<RunState> {
        if (this.state?.running) return snapshot(this.state);
        const state = this.begin('quick', 0);
        const finds: Found[] = [];
        const jobs: Promise<void>[] = [];
        const sources: string[] = [];

        const host = requestHost(hostHeader);
        if (host !== undefined) {
            sources.push(`host ${host}`);
            jobs.push(
                (async () => {
                    const out = await resolvePrivate(host, this.lookup);
                    if (!out.ok) {
                        state.skipped.push({ what: host, reason: out.reason });
                        return;
                    }
                    const range = defaultSweepRange(out.address);
                    if (range !== undefined) state.suggestedRange = range;
                    state.total += 1;
                    finds.push(...(await this.safeProbe(host, this.catalog, 'host', { timeoutMs: this.timeoutMs, address: out.address })));
                    state.tried += 1;
                })()
            );
        }

        const names = [...new Set(this.catalog.flatMap(e => e.containerNames))];
        if (names.length > 0) sources.push('containers');
        for (const name of names) {
            jobs.push(
                (async () => {
                    // Not resolving, or resolving off the private network, drops the name quietly.
                    const out = await resolvePrivate(name, this.lookup);
                    if (!out.ok) return;
                    const entries = this.catalog.filter(e => e.containerNames.includes(name));
                    state.total += 1;
                    finds.push(...(await this.safeProbe(name, entries, 'container', { timeoutMs: this.timeoutMs, address: out.address })));
                    state.tried += 1;
                })()
            );
        }

        await Promise.all(jobs);
        state.rows = await matchResults(finds, config, urlResolver(this.lookup));
        this.finish(state, sources);
        return snapshot(state);
    }

    startSweep(range: string, config: Config): RunState | { refused: string } {
        if (this.state?.running) return snapshot(this.state);
        const parsed = parseSweepRange(range);
        if (!parsed.ok) return { refused: parsed.reason };
        const state = this.begin('sweep', parsed.addresses.length);
        state.range = range.trim();
        void this.sweep(state, parsed.addresses, config);
        return snapshot(state);
    }

    private begin(phase: RunState['phase'], total: number): RunState {
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
        return state;
    }

    private finish(state: RunState, sources: string[]): void {
        state.running = false;
        logger.info({ sources, range: state.range, rows: state.rows.length, phase: state.phase }, `service discovery ${state.phase} finished`);
    }

    private async safeProbe(host: string, entries: readonly CatalogEntry[], source: Found['source'], opts: ProbeOpts): Promise<Found[]> {
        try {
            return await this.probe(host, entries, source, opts);
        } catch {
            return [];
        }
    }

    private async sweep(state: RunState, addresses: string[], config: Config): Promise<void> {
        const finds: Found[] = [];
        const resolve = urlResolver(this.lookup);
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
                const out = await resolvePrivate(address, this.lookup);
                if (out.ok) {
                    const hits = await this.safeProbe(address, this.catalog, 'sweep', {
                        timeoutMs: this.sweepTimeoutMs,
                        address: out.address
                    });
                    if (hits.length > 0) {
                        finds.push(...hits);
                        rematch();
                    }
                }
                state.tried += 1;
            }
        };
        await Promise.all(Array.from({ length: Math.min(this.concurrency, addresses.length) }, worker));
        await chain;
        this.finish(state, ['sweep']);
    }
}
