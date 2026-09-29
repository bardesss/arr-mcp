import { logger } from '../core/logger.ts';
import {
    hasSeedCriteria,
    hasSeedLimits,
    type ClientSeedLimits,
    type IndexerSeedCriteria,
    type ServiceAdapter
} from '../services/types.ts';

export type SeedingRules = {
    clients: ClientSeedLimits[];
    indexers: IndexerSeedCriteria[];
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

    const [clients, indexers] = await Promise.all([
        Promise.all(adapters.filter(hasSeedLimits).map(a => read(a.id, () => a.getSeedLimits()))),
        Promise.all(adapters.filter(hasSeedCriteria).map(a => read(a.id, () => a.getSeedCriteria())))
    ]);

    const prowlarrIds = new Set(adapters.filter(a => a.type === 'prowlarr').map(a => a.id));
    const clientRows = clients.filter((c): c is ClientSeedLimits => c !== undefined);
    const indexerRows = indexers
        .flatMap(i => i ?? [])
        .sort((a, b) => a.service.localeCompare(b.service) || a.indexer.localeCompare(b.indexer));
    clientRows.sort((a, b) => a.service.localeCompare(b.service));

    return { clients: clientRows, indexers: indexerRows, notes: notesFor(clientRows, indexerRows, prowlarrIds) };
}
