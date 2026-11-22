import { isOutage } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import type { PlayHistory, PlayRecord } from '../core/playHistory.ts';
import type { ExternalIds, MergedItem } from '../core/resolver.ts';
import { normaliseTitle } from '../core/titleMatch.ts';
import type { SearchHit } from '../services/types.ts';
import type { LibraryLoader } from './library.ts';
import type { MediaServers } from './mediaServers.ts';

export type Exclusion = 'owned' | 'watched';

type SeenFilter = {
    /** Why a hit was left out, or `undefined` to keep it. */
    verdict(hit: SearchHit): Exclusion | undefined;
    /** Services that did not answer, so a kept hit may still be owned or watched. */
    degraded: string[];
};

export type SeenDeps = { library: LibraryLoader; mediaServers: MediaServers; plays?: PlayHistory | undefined };

const ID_KEYS = ['imdb', 'tmdb', 'tvdb'] as const;

const idKeys = (ids: Pick<ExternalIds, (typeof ID_KEYS)[number]> | undefined): string[] =>
    ID_KEYS.flatMap(k => (ids?.[k] === undefined ? [] : [`${k}:${ids[k]}`]));

const titleKey = (title: string, year?: number): string => `${normaliseTitle(title)}|${year ?? ''}`;

const watchedInLibrary = (item: MergedItem): boolean => {
    const p = item.playback;
    if (p === undefined) return false;
    return p.watched === true || (p.playCount ?? 0) > 0 || p.lastPlayed !== undefined;
};

/**
 * What `discover_media`'s `exclude` filters against, for the default user: the
 * library snapshot every other reader shares, its played flags, and the play
 * store, which is the only place a title watched and since deleted survives.
 *
 * A stored play matches on its ids where it has them. A deleted film without
 * them matches on title and a year either side, the gap between a festival
 * premiere and a release date, and an episode on its series title.
 */
export async function buildSeenFilter(
    deps: SeenDeps | undefined,
    opts: { exclude: readonly Exclusion[]; kind: 'movie' | 'series' }
): Promise<SeenFilter> {
    const wantOwned = opts.exclude.includes('owned');
    const wantWatched = opts.exclude.includes('watched');
    if (deps === undefined || (!wantOwned && !wantWatched)) return { verdict: () => undefined, degraded: [] };

    const snapshot = await deps.library.load();
    const degraded = [...snapshot.degraded];
    const playedIds = new Set<string>();
    const playedTitles = new Set<string>();

    const primary = deps.mediaServers.primary;
    if (wantWatched && primary !== undefined && primary.identity !== undefined && deps.plays !== undefined) {
        // Same rule as get_playback: a user lookup refused rather than
        // unreachable is the caller's to fix, so only an outage degrades. The
        // store read itself only ever degrades, as the played flags still answer.
        let userId: string | undefined;
        try {
            userId = (await primary.identity.resolve(undefined)).id;
        } catch (err) {
            if (!isOutage(err)) throw err;
        }
        try {
            if (userId === undefined) throw new Error('media server user could not be resolved');
            for (const record of deps.plays.read(primary.adapter.id, userId)) addPlayed(record, opts.kind, playedIds, playedTitles);
        } catch (err) {
            logger.warn({ service: primary.adapter.id, err }, 'play history read failed; excluding watched from the library alone');
            if (!degraded.includes(primary.adapter.id)) degraded.push(primary.adapter.id);
        }
    }

    const verdict = (hit: SearchHit): Exclusion | undefined => {
        const item = snapshot.index.find(hit.ids, opts.kind);
        // Watched before owned: of the two, "you have seen it" is the reason worth reporting.
        if (wantWatched && item !== undefined && watchedInLibrary(item)) return 'watched';
        if (wantWatched && idKeys(hit.ids).some(k => playedIds.has(k))) return 'watched';
        if (wantOwned && item !== undefined) return 'owned';
        if (!wantWatched) return undefined;
        if (opts.kind === 'series') return playedTitles.has(titleKey(hit.title)) ? 'watched' : undefined;
        if (hit.year === undefined) return undefined;
        return [hit.year, hit.year - 1, hit.year + 1].some(y => playedTitles.has(titleKey(hit.title, y))) ? 'watched' : undefined;
    };

    return { verdict, degraded };
}

function addPlayed(record: PlayRecord, kind: 'movie' | 'series', ids: Set<string>, titles: Set<string>): void {
    if (record.kind !== (kind === 'movie' ? 'movie' : 'episode')) return;
    for (const k of idKeys(record.ids)) ids.add(k);
    if (kind === 'series') {
        if (record.entry.seriesTitle !== undefined) titles.add(titleKey(record.entry.seriesTitle));
    } else if (record.year !== undefined) {
        titles.add(titleKey(record.entry.title, record.year));
    }
}
