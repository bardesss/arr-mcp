import type { Context, Hono } from 'hono';
import { instanceId, listInstances } from '../config/instances.ts';
import type { ServiceId } from '../config/schema.ts';
import { logger } from '../core/logger.ts';
import { LoginThrottle } from '../core/loginThrottle.ts';
import type { Runtime } from '../core/runtime.ts';
import { constantTimeEquals } from '../core/secrets.ts';
import type { PlayHistory, WebhookPlay } from '../core/playHistory.ts';
import type { WebhookEvents } from '../core/webhookEvents.ts';
import { parseArrWebhook, WEBHOOK_SERVICES } from '../services/arrWebhook.ts';
import { parseJellyfinPlay } from '../services/jellyfinWebhook.ts';
import { PlexAdapter } from '../services/plex.ts';
import { parsePlexPlay } from '../services/plexWebhook.ts';
import { originOf } from './routes.ts';

const CHALLENGE = { 'www-authenticate': 'Basic realm="arr-mcp webhooks"' };

function basicPassword(header: string | undefined): string | undefined {
    if (header === undefined || !/^Basic\s/i.test(header)) return undefined;
    const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return colon === -1 ? undefined : decoded.slice(colon + 1);
}

export function registerWebhookRoutes(app: Hono, deps: { runtime: Runtime; events: WebhookEvents; plays?: PlayHistory | undefined }): void {
    const { runtime, events, plays } = deps;
    const throttle = new LoginThrottle();

    const receive = async (c: Context): Promise<Response> => {
        // Read per request, so turning this on in the config UI needs no restart.
        const webhooks = runtime.config.webhooks;
        if (webhooks?.enabled !== true || webhooks.secret === undefined) return c.notFound();

        const presented = basicPassword(c.req.header('authorization'));
        if (presented === undefined || !constantTimeEquals(presented, webhooks.secret)) {
            // Checked after the secret, never instead of it: refusing the right secret
            // during a block would let anyone cost you real events by sending wrong
            // ones, and a random secret this long is not something a block protects.
            // What the block buys is a quiet log.
            if (throttle.blockedFor() > 0) return c.text('too many failed attempts', 429);
            logger.warn({ path: c.req.path, ...originOf(c), presented: presented !== undefined }, 'rejected a webhook');
            throttle.recordFailure();
            return throttle.blockedFor() > 0
                ? c.text('too many failed attempts', 429)
                : c.text('unauthorized', 401, CHALLENGE);
        }
        throttle.recordSuccess();

        const type = c.req.param('type') as ServiceId;
        if (type === 'jellyfin') return receivePlay(c, instanceId(type, c.req.param('name')));
        if (type === 'plex') return receivePlexPlay(c, instanceId(type, c.req.param('name')));
        const kind = Object.hasOwn(WEBHOOK_SERVICES, type) ? WEBHOOK_SERVICES[type] : undefined;
        const id = instanceId(type, c.req.param('name'));
        if (kind === undefined || !listInstances(runtime.config).some(i => i.id === id)) return c.notFound();

        let body: unknown;
        try {
            body = JSON.parse(await c.req.text());
        } catch {
            return c.text('the body is not JSON', 400);
        }
        const eventType = (body as { eventType?: unknown } | null)?.eventType;
        if (typeof eventType !== 'string') return c.text('no eventType', 400);

        const entry = parseArrWebhook(id, kind, body, new Date().toISOString());
        if (entry === undefined) {
            // A Test is the only well-formed thing parsed to nothing, and it is
            // the *arr's check that this connection works.
            return eventType === 'Test' ? c.text('ok') : c.text('no usable eventType', 400);
        }

        try {
            events.record(entry, webhooks.retention_days);
        } catch (err) {
            // Still 200: an *arr turns off a connection that keeps failing, and our
            // disk trouble should not cost every event after it is fixed.
            logger.error({ err, service: id }, 'could not store a webhook event');
        }
        return c.text('ok');
    };

    /**
     * A Jellyfin Webhook plugin playback stop, recorded in the play store the
     * moment it happens, so a title watched and deleted before the next hourly
     * sync is still kept. Everything else the plugin sends is answered 200 and
     * dropped, so a destination with more notification types ticked keeps working.
     */
    const receivePlay = async (c: Context, id: string): Promise<Response> => {
        if (plays === undefined || mediaServer(id) === undefined) return c.notFound();

        // "Send All Properties" posts a form (seen live on 12.4.0); a JSON
        // template posts JSON. Told apart by the body, since a destination's
        // own headers can claim either.
        const raw = await c.req.text();
        let body: unknown;
        try {
            body = raw.trimStart().startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
        } catch {
            return c.text('the body is neither JSON nor a form', 400);
        }
        if (typeof (body as { NotificationType?: unknown } | null)?.NotificationType !== 'string') return c.text('no NotificationType', 400);

        const play = parseJellyfinPlay(id, body);
        return play === undefined ? c.text('ok') : keep(c, plays, id, play);
    };

    /**
     * A Plex webhook. Plex sends `media.scrobble` when it counts a play as
     * watched: past 90% of a film or an episode by default, at a track's end.
     * Everything else it sends, from every server the account plays on, is
     * answered 200 and dropped. The body is a multipart form: the JSON is its
     * `payload` part, and the `thumb` part some events carry is parsed with it
     * but not used. `?music=1` keeps tracks too, since a Plex webhook is only a
     * URL and has no other place to choose that.
     */
    const receivePlexPlay = async (c: Context, id: string): Promise<Response> => {
        const adapter = mediaServer(id);
        if (plays === undefined || !(adapter instanceof PlexAdapter)) return c.notFound();

        let form: Record<string, unknown>;
        try {
            form = await c.req.parseBody();
        } catch {
            return c.text('the form could not be read', 400);
        }
        const part = form['payload'];
        if (typeof part !== 'string') return c.text('no payload part', 400);
        let body: unknown;
        try {
            body = JSON.parse(part);
        } catch {
            return c.text('the payload is not JSON', 400);
        }
        const event = (body as { event?: unknown } | null)?.event;
        if (typeof event !== 'string') return c.text('no event', 400);
        // Everything the payload answers by itself comes first, so only a play
        // that would be kept costs a request.
        const found = parsePlexPlay(id, body, { music: c.req.query('music') === '1' });
        if (found === undefined) return c.text('ok');

        let server: string;
        try {
            server = await adapter.machineIdentifier();
        } catch (err) {
            // Not kept, so the next scrobble asks again.
            logger.warn({ err, service: id }, 'could not read the Plex server id, so a webhook play was not stored');
            return c.text('ok');
        }
        // Plex posts the plays of every server the account owns to this URL.
        return found.server === server ? keep(c, plays, id, found.play) : c.text('ok');
    };

    /** The configured media server with this instance id. */
    const mediaServer = (id: string) => {
        const { primary, secondary } = runtime.current.tools.mediaServers;
        return [primary, secondary].find(s => s?.adapter.id === id)?.adapter;
    };

    const keep = (c: Context, store: PlayHistory, id: string, play: WebhookPlay): Response => {
        try {
            store.record(id, { id: play.userId }, [play.record]);
        } catch (err) {
            // Still 200, as for the *arrs: the next hourly sync reads a film or
            // an episode anyway, though not a track.
            logger.error({ err, service: id }, 'could not store a webhook play');
        }
        return c.text('ok');
    };

    app.post('/webhooks/:type/:name?', receive);
}
