import type { Context, Hono } from 'hono';
import { instanceId, listInstances } from '../config/instances.ts';
import type { ServiceId } from '../config/schema.ts';
import { logger } from '../core/logger.ts';
import { LoginThrottle } from '../core/loginThrottle.ts';
import type { Runtime } from '../core/runtime.ts';
import { constantTimeEquals } from '../core/session.ts';
import type { WebhookEvents } from '../core/webhookEvents.ts';
import { parseArrWebhook, WEBHOOK_SERVICES } from '../services/arrWebhook.ts';
import { originOf } from './routes.ts';

const CHALLENGE = { 'www-authenticate': 'Basic realm="arr-mcp webhooks"' };

function basicPassword(header: string | undefined): string | undefined {
    if (header === undefined || !/^Basic\s/i.test(header)) return undefined;
    const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return colon === -1 ? undefined : decoded.slice(colon + 1);
}

export function registerWebhookRoutes(app: Hono, deps: { runtime: Runtime; events: WebhookEvents }): void {
    const { runtime, events } = deps;
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

    app.post('/webhooks/:type/:name?', receive);
}
