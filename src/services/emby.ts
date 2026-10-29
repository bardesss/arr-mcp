import type { ConfigByService } from '../config/schema.ts';
import { MediaBrowserAdapter, type MediaBrowserDialect } from './mediaBrowser.ts';

/**
 * Emby: Jellyfin's ancestor, and the same API apart from what this table says.
 * Every entry was checked against a live Emby 4.10.2.0, and again against
 * 4.9.5.0 and 4.9.1.80, where the two web client labels were checked in the
 * client's string files. Its own swagger has no `/UserItems/Resume`,
 * `/UserPlayedItems` or GET `/Items/{id}`, so those reads use the older
 * per-user forms. The `MediaBrowser Token` header and paths without the
 * `/emby` prefix both work, so the auth and every other request are
 * Jellyfin's.
 */
export const EMBY: MediaBrowserDialect = {
    type: 'emby',
    /** `/Items/{id}?userId=` answers 404. */
    item: (userId, itemId) => `/Users/${encodeURIComponent(userId)}/Items/${itemId}`,
    /**
     * With no `MediaTypes`, this route answers an empty page even when a
     * film is part-watched. With it, Emby also puts the next unwatched
     * episode of a series in progress here, at position zero: its own
     * Continue Watching row holds both. `resumable` keeps the part-watched
     * rows, and `nextUp` reports the rest.
     */
    resume: userId => `/Users/${encodeURIComponent(userId)}/Items/Resume?MediaTypes=Video&Limit=500`,
    resumable: item => (item.UserData?.PlaybackPositionTicks ?? 0) > 0,
    /**
     * Without `LegacyNextUp=true` this answers an empty page for a user with a
     * next episode waiting; with it, that episode. An invented parameter in
     * its place changes nothing, so the name is real. Query names are
     * case-insensitive here.
     */
    nextUp: userId => `/Shows/NextUp?userId=${encodeURIComponent(userId)}&LegacyNextUp=true`,
    /** The user is in the path, so there is no query parameter to misspell. */
    played: (userId, itemId) => `/Users/${encodeURIComponent(userId)}/PlayedItems/${itemId}`,
    /**
     * Item ids are integers (`12`), while user ids are 32 hex as in Jellyfin.
     * So the check cannot tell an Emby id from a Radarr or Sonarr one, as
     * Jellyfin's can: it still refuses anything else before a request goes out.
     */
    itemId: { pattern: /^\d+$/, described: 'digits only', likeArrIds: true },
    /**
     * Left out unless `Fields` names it: on the test server, `Fields=Path,
     * ProviderIds,Settings` gave Detour no year, and the same with
     * `ProductionYear` added gave 1945.
     */
    yearField: ',ProductionYear',
    /**
     * Emby ignores `type` on this route: an invented value returns every entry.
     * `hasUserId` does filter. A stop is `playback.stop`, logged with a
     * `playback.start` before it, so the type is tested here instead, and a
     * history read pages until it holds as many stops as Jellyfin's one read. A
     * song's stop is `playback.stop` too (seen live), so not `filtered`. Emby
     * 4.8.11.0 logged `VideoPlaybackStopped` or `AudioPlaybackStopped` with no
     * `ItemId`, and an upgraded server keeps those entries as they were: they
     * are not stops here, since nothing in them names the item.
     */
    stops: { route: '/System/ActivityLog/Entries?hasUserId=true', isStop: entry => entry.Type === 'playback.stop', filtered: false },
    logUserIds: 'internal',
    /**
     * Emby answers 204 as soon as it has set the ids, and refreshes after: in
     * the test server's log, the 204 came about half a second before the
     * refresh it started completed. So a read straight after can still be the
     * old metadata, and the repair is waited on like a queued one.
     */
    identifySettles: false,
    /**
     * Each case on the test server's Detour and One Step Beyond, beside an
     * unlocked control: the identify cleared the film's item lock and its
     * title's field lock and overwrote the title, and did the same to the
     * series' own locks. Episode field locks held. An episode locked as a
     * whole kept its title but lost its provider ids. A season's own lock
     * held. Emby's plain refresh kept every lock. See
     * `MediaBrowserAdapter.identifyLockLoss`.
     */
    identifyKeepsLocks: false,
    /** 4.10.2.0's labels: Api Keys (`/apikeys`) is under Advanced in its server menu. 4.9.1.80 and 4.9.5.0 ship the same strings. */
    apiKeys: 'Manage Emby Server → Advanced → Api Keys in Emby',
    /** Likewise: its Edit Metadata dialog has no Enabled Fields section, and a lock beside each field. */
    unlock: 'Edit Metadata, then clear "Lock this item to prevent future changes", or the lock beside the field'
};

export class EmbyAdapter extends MediaBrowserAdapter {
    constructor(config: ConfigByService['emby'], fetchImpl: typeof fetch = fetch) {
        super(EMBY, config, fetchImpl);
    }
}
