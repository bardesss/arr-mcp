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
 * records what was watched. A server that fails is logged and skipped: the
 * next run tries again, and nothing already stored is lost.
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
            const [history, library] = await Promise.all([adapter.getWatchHistory(user), adapter.listUserLibrary(user)]);
            const plays = playsFrom(adapter.id, user, history, library);
            store.record(adapter.id, user, plays);
            store.markSynced(adapter.id, new Date().toISOString());
            logger.debug({ service: adapter.id, plays: plays.length }, 'play history synced');
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
