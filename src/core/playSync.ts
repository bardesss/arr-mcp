import { logger } from './logger.ts';
import { playsFrom, type PlayHistory } from './playHistory.ts';
import type { MediaServers } from '../tools/mediaServers.ts';

/**
 * Hourly is far inside the shortest window a play can fall out of (Jellyfin's
 * 30-day activity log), and a library read once an hour is cheap. The first
 * run waits a minute so startup is not slowed by a library read.
 */
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_SYNC_MS = 60 * 1000;

/**
 * Reads each media server's history and library for its default user and
 * records what was watched. The first run for a server and user reads the
 * whole history; every later run reads only the newest rows. A server that
 * fails is logged and skipped: the next run tries again, the full read too
 * if that was the one that failed, and nothing already stored is lost.
 *
 * Only the default user: it is the one every tool answers for unless told
 * otherwise. Any other user's plays are recorded when `get_playback` reads
 * their history.
 */
export async function syncPlays(servers: MediaServers, store: PlayHistory): Promise<void> {
    for (const choice of [servers.primary, servers.secondary]) {
        if (choice?.identity === undefined) continue;
        const { adapter, identity } = choice;
        try {
            const user = await identity.resolve();
            const full = store.needsBackfill(adapter.id, user.id);
            let truncated = false;
            const [history, library] = await Promise.all([
                adapter.getWatchHistory(user, full ? { full: true, onTruncated: () => (truncated = true) } : {}),
                adapter.listUserLibrary(user)
            ]);
            const plays = playsFrom(adapter.id, user, history, library);
            // Plex's history keeps every play, so its full read stands in for
            // what is stored, and rebuilding from it is what drops rows 2.3
            // stored wrongly: music tracks, and a film stored twice around its
            // deletion. Jellyfin's log forgets after 30 days, so its rows stay.
            // A read cut short at its backstop is not the whole history, so it
            // adds to what is stored instead of replacing it.
            store.record(adapter.id, user, plays, { replace: full && !truncated && adapter.type === 'plex' });
            const at = new Date().toISOString();
            if (full) store.markBackfilled(adapter.id, user.id, at);
            store.markSynced(adapter.id, at);
            logger.debug({ service: adapter.id, plays: plays.length, full }, 'play history synced');
        } catch (err) {
            logger.warn({ service: adapter.id, err }, 'play history sync failed; trying again next hour');
        }
    }
}

/**
 * Runs `syncPlays` against whatever media servers the config has at each tick,
 * so a config reload is picked up without restarting the loop. Returns a stop
 * that also waits for a run in flight, so the store is not closed under it.
 */
export function startPlaySync(
    current: () => MediaServers,
    store: PlayHistory,
    opts: { intervalMs?: number; firstMs?: number } = {}
): () => Promise<void> {
    let stopped = false;
    let running: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined;

    const schedule = (ms: number) => {
        timer = setTimeout(() => {
            running = syncPlays(current(), store).finally(() => {
                running = undefined;
                if (!stopped) schedule(opts.intervalMs ?? SYNC_INTERVAL_MS);
            });
        }, ms);
        timer.unref();
    };
    schedule(opts.firstMs ?? FIRST_SYNC_MS);

    return async () => {
        stopped = true;
        clearTimeout(timer);
        await running;
    };
}
