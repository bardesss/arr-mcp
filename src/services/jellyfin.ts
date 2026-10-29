import type { ConfigByService } from '../config/schema.ts';
import { MediaBrowserAdapter, type MediaBrowserDialect } from './mediaBrowser.ts';

/**
 * Every playback stop Jellyfin logged, newest first. `type` is a real filter:
 * confirmed against a live 12.x with an invented-parameter control, which
 * returned the unfiltered 46k entries against 10k stops. The log is
 * household-wide; `UserId` narrows it, and comes back in the same undashed
 * form as `/Users`.
 *
 * An offline client (AFinity) reports its plays here when it reconnects, often
 * as a lone stop and without the item ever getting `Played`. The log is kept
 * for `ActivityLogRetentionDays` (30 by default), so this reaches no further.
 */
const ACTIVITY_LOG_STOPS = '/System/ActivityLog/Entries?type=VideoPlaybackStopped&hasUserId=true';

export const JELLYFIN: MediaBrowserDialect = {
    type: 'jellyfin',
    item: (userId, itemId) => `/Items/${itemId}?userId=${encodeURIComponent(userId)}`,
    /**
     * `/UserItems/Resume` is the documented way to ask for the resumable
     * set. `/Items?IsResumable=true` looks like the right query but is
     * silently ignored: it returns the entire library, not just
     * resumable items.
     *
     * The older `/Users/{id}/Items/Resume` still answers in Jellyfin 12,
     * but only as `[Obsolete]`, and it is absent from the OpenAPI
     * document, so nothing here would catch its removal.
     *
     * `Limit=500` ensures truncation is decided by `applyLimit` in the
     * contract layer, which reports it, rather than by an undocumented
     * server default page size, which does not.
     */
    resume: userId => `/UserItems/Resume?userId=${encodeURIComponent(userId)}&Limit=500`,
    resumable: () => true,
    nextUp: userId => `/Shows/NextUp?userId=${encodeURIComponent(userId)}`,
    /**
     * `userId` is a query parameter, and Jellyfin ignores parameters it does
     * not recognise: a misspelling here would silently mark the item for
     * whoever the API key belongs to instead. Proved correct by sending an
     * invented parameter alongside and confirming the response was unchanged.
     */
    played: (userId, itemId) => `/UserPlayedItems/${itemId}?userId=${encodeURIComponent(userId)}`,
    itemId: { pattern: /^[0-9a-f]{32}$/, described: '32 hex characters', likeArrIds: false },
    /** Sent unasked, and not one of its `ItemFields`. */
    yearField: '',
    stops: { route: ACTIVITY_LOG_STOPS, isStop: () => true, filtered: true },
    logUserIds: 'users',
    /** Read in the server source: see `MediaBrowserAdapter.repairMetadata`. */
    identifySettles: true,
    /** A locked field or item is never overwritten: see `lockedFields` in mediaBrowser.ts. */
    identifyKeepsLocks: true,
    apiKeys: 'Dashboard → API Keys in Jellyfin',
    unlock: 'Edit metadata, then clear "Lock this item to prevent future metadata changes", or tick the field under Enabled Fields'
};

export class JellyfinAdapter extends MediaBrowserAdapter {
    constructor(config: ConfigByService['jellyfin'], fetchImpl: typeof fetch = fetch) {
        super(JELLYFIN, config, fetchImpl);
    }
}
