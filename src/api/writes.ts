import type { Hono } from 'hono';
import * as z from 'zod/v4';
import { setImdb } from '../config/edits.ts';
import { addCandidate, removeInstance, updateInstance } from '../config/mutate.ts';
import { logger } from '../core/logger.ts';
import { buildAdapters } from '../services/registry.ts';
import { originOf } from '../web/routes.ts';
import { AppBody, fieldsFromBody, NewAppBody, TestAppBody } from './bodies.ts';
import { parseWith, readObject } from './body.ts';
import { API_BASE, apiError, withEtag } from './http.ts';
import type { ApiDeps } from './index.ts';
import { appResource, findInstance, imdbSettings } from './resources.ts';
import { applyWrite } from './write.ts';

const ImdbBody = z.strictObject({
    enabled: z.boolean(),
    ingestedAt: z.unknown().optional(),
    titles: z.unknown().optional(),
    ratings: z.unknown().optional()
});

/** `radarr/4k` into the two path segments `findInstance` takes. */
const splitId = (id: string): [string, string | undefined] => {
    const slash = id.indexOf('/');
    return slash === -1 ? [id, undefined] : [id.slice(0, slash), id.slice(slash + 1)];
};

export function registerWrites(app: Hono, deps: ApiDeps): void {
    const { runtime } = deps;

    app.put(`${API_BASE}/settings/imdb`, async c => {
        const raw = await readObject(c);
        if (raw instanceof Response) return raw;
        const body = parseWith(c, ImdbBody, raw);
        if (body instanceof Response) return body;
        const config = await applyWrite(c, deps, 'IMDb dataset settings', current => setImdb(current, body.enabled));
        if (config instanceof Response) return config;
        return withEtag(c, config, imdbSettings(config, runtime.dataset));
    });

    app.post(`${API_BASE}/app/test`, async c => {
        const raw = await readObject(c);
        if (raw instanceof Response) return raw;
        const body = parseWith(c, TestAppBody, raw);
        if (body instanceof Response) return body;

        try {
            const config = runtime.config;
            const existing = body.id === undefined ? undefined : findInstance(config, ...splitId(body.id));
            if (body.id !== undefined && existing === undefined) return apiError(c, 404, 'No such app.');
            if (existing === undefined && body.type === undefined) return apiError(c, 400, 'Send the id of an app, or a type.');

            const { candidate, target } =
                existing !== undefined
                    ? { candidate: updateInstance(config, existing.id, fieldsFromBody(body, existing)), target: existing.id }
                    : addCandidate(config, {
                          type: body.type as NonNullable<typeof body.type>,
                          name: body.name ?? undefined,
                          renameExistingTo: body.renameExistingTo,
                          fields: fieldsFromBody(body, undefined)
                      });

            const adapter = buildAdapters(candidate).find(a => a.id === target);
            if (adapter === undefined) return apiError(c, 400, `${target} is not configured.`);
            const d = await adapter.testConnection();
            logger.info({ ...originOf(c), service: target, ok: d.ok }, 'connection tested from the management API');
            return c.json(
                {
                    ok: d.ok,
                    app: target,
                    latencyMs: d.latency_ms,
                    ...(d.version === undefined ? {} : { version: d.version }),
                    ...(d.error === undefined ? {} : { error: d.error })
                },
                d.ok ? 200 : 400
            );
        } catch (err) {
            return apiError(c, 400, (err as Error).message);
        }
    });

    app.post(`${API_BASE}/app`, async c => {
        const raw = await readObject(c);
        if (raw instanceof Response) return raw;
        const body = parseWith(c, NewAppBody, raw);
        if (body instanceof Response) return body;
        const name = body.name ?? undefined;

        const config = await applyWrite(c, deps, `added ${body.type}${name === undefined ? '' : `/${name}`}`, current =>
            addCandidate(current, {
                type: body.type,
                name,
                renameExistingTo: body.renameExistingTo,
                fields: fieldsFromBody(body, undefined)
            }).candidate
        );
        if (config instanceof Response) return config;
        const created = findInstance(config, body.type, name);
        return withEtag(c, config, created === undefined ? {} : appResource(created), 201);
    });

    app.put(`${API_BASE}/app/:type/:name?`, async c => {
        const instance = findInstance(runtime.config, c.req.param('type'), c.req.param('name'));
        if (instance === undefined) return apiError(c, 404, 'No such app.');
        const raw = await readObject(c);
        if (raw instanceof Response) return raw;
        const body = parseWith(c, AppBody, raw);
        if (body instanceof Response) return body;

        const config = await applyWrite(c, deps, `saved ${instance.id}`, current => {
            const fresh = findInstance(current, instance.type, instance.name);
            if (fresh === undefined) throw new Error(`${instance.id} is not configured.`);
            return updateInstance(current, fresh.id, fieldsFromBody(body, fresh));
        });
        if (config instanceof Response) return config;
        const saved = findInstance(config, instance.type, instance.name);
        return withEtag(c, config, saved === undefined ? {} : appResource(saved));
    });

    app.delete(`${API_BASE}/app/:type/:name?`, async c => {
        const instance = findInstance(runtime.config, c.req.param('type'), c.req.param('name'));
        if (instance === undefined) return apiError(c, 404, 'No such app.');
        const config = await applyWrite(c, deps, `removed ${instance.id}`, current => removeInstance(current, instance.id));
        if (config instanceof Response) return config;
        return withEtag(c, config, {});
    });
}
