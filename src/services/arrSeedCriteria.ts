import type { ServiceHttp } from '../core/http.ts';
import type { IndexerSeedCriteria } from './types.ts';

type RawField = { name?: string; value?: unknown };
type RawIndexer = { name?: string; protocol?: string; privacy?: string; fields?: RawField[] };

/**
 * The *arrs nest seed settings under `seedCriteria.`, Prowlarr under
 * `torrentBaseSettings.`, and name the pack field differently. Unset values
 * come back absent rather than null.
 */
const LAYOUT = {
    arr: { path: '/api/v3/indexer', prefix: 'seedCriteria.', pack: 'seasonPackSeedTime' },
    prowlarr: { path: '/api/v1/indexer', prefix: 'torrentBaseSettings.', pack: 'packSeedTime' }
} as const;

export async function readSeedCriteria(
    http: ServiceHttp,
    service: string,
    kind: keyof typeof LAYOUT
): Promise<IndexerSeedCriteria[]> {
    const { path, prefix, pack } = LAYOUT[kind];
    const indexers = await http.get<RawIndexer[]>(path);

    return (Array.isArray(indexers) ? indexers : [])
        .filter(i => i.protocol === 'torrent')
        .map(i => {
            const field = (name: string): number | undefined => {
                const value = i.fields?.find(f => f.name === `${prefix}${name}`)?.value;
                return typeof value === 'number' ? value : undefined;
            };
            const ratio = field('seedRatio');
            const minutes = field('seedTime');
            const packMinutes = field(pack);

            return {
                service,
                indexer: i.name ?? 'unnamed',
                ...(typeof i.privacy === 'string' ? { privacy: i.privacy } : {}),
                ...(ratio === undefined ? {} : { seedRatio: ratio }),
                ...(minutes === undefined ? {} : { seedTimeSeconds: minutes * 60 }),
                ...(packMinutes === undefined ? {} : { packSeedTimeSeconds: packMinutes * 60 })
            };
        });
}
