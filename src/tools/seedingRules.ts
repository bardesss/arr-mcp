import { logger } from '../core/logger.ts';
import { resolveRuleSets } from './cleanuparrQueue.ts';
import {
    hasCleanuparr,
    hasSeedCriteria,
    hasSeedLimits,
    type CleanuparrSeeding,
    type CleanuparrRuleSet,
    type ClientSeedLimits,
    type IndexerSeedCriteria,
    type ServiceAdapter
} from '../services/types.ts';

export type SeedingRules = {
    clients: ClientSeedLimits[];
    indexers: IndexerSeedCriteria[];
    cleanuparr?: Array<CleanuparrRuleSet & { service?: string }>;
    /** Where the rules contradict each other or leave a gap. */
    notes: string[];
};

/** Prowlarr names each synced copy `"<name> (Prowlarr)"`. */
const SYNCED = / \(Prowlarr\)$/;

const describe = (c: IndexerSeedCriteria): string =>
    [
        c.seedRatio === undefined ? 'no ratio' : `ratio ${c.seedRatio}`,
        c.seedTimeSeconds === undefined ? 'no seed time' : `${c.seedTimeSeconds / 60} min`
    ].join(', ');

function notesFor(clients: ClientSeedLimits[], indexers: IndexerSeedCriteria[], prowlarrIds: Set<string>): string[] {
    const notes: string[] = [];
    const prowlarr = indexers.filter(i => prowlarrIds.has(i.service));
    const apps = indexers.filter(i => !prowlarrIds.has(i.service));

    for (const copy of apps) {
        if (!SYNCED.test(copy.indexer)) continue;
        const name = copy.indexer.replace(SYNCED, '');
        const source = prowlarr.find(p => p.indexer === name);
        if (source === undefined) continue;
        if (source.seedRatio === copy.seedRatio && source.seedTimeSeconds === copy.seedTimeSeconds) continue;
        notes.push(
            `${copy.service}'s copy of "${name}" has ${describe(copy)}, but ${source.service} has ${describe(source)}. ` +
                `The copy is what ${copy.service} hands the client on a grab.`
        );
    }

    const clientLimited = clients.some(c => c.ratioLimit !== undefined || c.seedingLimitSeconds !== undefined);
    if (clients.length > 0 && !clientLimited) {
        for (const i of apps) {
            if (i.seedRatio !== undefined || i.seedTimeSeconds !== undefined) continue;
            notes.push(
                `"${i.indexer}" in ${i.service} sets no seed ratio or time, and no torrent client has a default limit, ` +
                    'so its grabs seed until someone stops them.'
            );
        }
    }

    return notes;
}

function cleanuparrNotes(
    seeding: CleanuparrSeeding,
    mapped: Map<string, CleanuparrRuleSet>,
    conflicts: Map<string, CleanuparrRuleSet[]>,
    clients: ClientSeedLimits[]
): string[] {
    const notes: string[] = [];
    for (const [service, list] of conflicts) {
        const names = list.map(s => `"${s.client}"`);
        notes.push(`Cleanuparr's clients ${names.slice(0, -1).join(', ')} and ${names.at(-1)} both point at ${service}, so neither's rules are applied to get_queue.`);
    }
    const conflicted = new Set([...conflicts.values()].flat());
    for (const set of seeding.sets) {
        if (conflicted.has(set)) continue;
        const service = [...mapped].find(([, s]) => s === set)?.[0];
        if (service === undefined) {
            notes.push(`Cleanuparr's client "${set.client}" matches no configured arr-mcp client, so its rules are not applied to get_queue.`);
            continue;
        }
        const own = clients.find(c => c.service === service)?.ratioLimit;
        for (const rule of set.rules) {
            if (rule.maxRatio === undefined || own === undefined || own === rule.maxRatio) continue;
            notes.push(
                `Cleanuparr rule "${rule.name}" on ${service} ${rule.action === 'delete' ? 'removes' : 'stops'} at ratio ${rule.maxRatio}, ` +
                    `but ${service} itself seeds to ${own}. Cleanuparr acts first when it runs.`
            );
        }
    }
    if (!seeding.enforced && seeding.sets.some(s => s.rules.length > 0)) {
        notes.push("Cleanuparr's Download Cleaner is not scheduled, so none of its seeding rules are applied.");
    }
    return notes;
}

/** Settled per service: one unreachable client must not hide the others. */
export async function buildSeedingRules(
    adapters: readonly ServiceAdapter[],
    markDegraded: (id: string) => void
): Promise<SeedingRules> {
    const read = async <T>(id: string, fetch: () => Promise<T>): Promise<T | undefined> => {
        try {
            return await fetch();
        } catch (err) {
            logger.warn({ service: id, err }, 'seeding rules unavailable; omitting');
            markDegraded(id);
            return undefined;
        }
    };

    const cleanuparrSource = adapters.find(hasCleanuparr);
    const [clients, indexers, cleanuparr] = await Promise.all([
        Promise.all(adapters.filter(hasSeedLimits).map(a => read(a.id, () => a.getSeedLimits()))),
        Promise.all(adapters.filter(hasSeedCriteria).map(a => read(a.id, () => a.getSeedCriteria()))),
        cleanuparrSource === undefined ? undefined : read(cleanuparrSource.id, () => cleanuparrSource.getSeedingRules())
    ]);

    const prowlarrIds = new Set(adapters.filter(a => a.type === 'prowlarr').map(a => a.id));
    const clientRows = clients.filter((c): c is ClientSeedLimits => c !== undefined);
    const indexerRows = indexers
        .flatMap(i => i ?? [])
        .sort((a, b) => a.service.localeCompare(b.service) || a.indexer.localeCompare(b.indexer));
    clientRows.sort((a, b) => a.service.localeCompare(b.service));

    const notes = notesFor(clientRows, indexerRows, prowlarrIds);
    const { mapped, conflicts } =
        cleanuparr === undefined
            ? { mapped: new Map<string, CleanuparrRuleSet>(), conflicts: new Map<string, CleanuparrRuleSet[]>() }
            : resolveRuleSets(cleanuparr.sets, adapters);
    const sets = (cleanuparr?.sets ?? []).map(set => {
        const service = [...mapped].find(([, s]) => s === set)?.[0];
        return service === undefined ? set : { ...set, service };
    });
    if (cleanuparr !== undefined) notes.push(...cleanuparrNotes(cleanuparr, mapped, conflicts, clientRows));

    return {
        clients: clientRows,
        indexers: indexerRows,
        ...(sets.length > 0 ? { cleanuparr: sets } : {}),
        notes
    };
}
