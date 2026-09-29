import type { Context, Hono } from 'hono';
import { listInstances } from '../config/instances.ts';
import { LEVELS, logFields } from '../core/logs.ts';
import { buildStackHealth } from '../tools/stackHealth.ts';
import { mcpEndpoint } from '../web/origin.ts';
import { API_BASE, apiError } from './http.ts';
import type { ApiDeps } from './index.ts';

const MAX_LOG_RECORDS = 300;
const DEFAULT_LOG_RECORDS = 100;

const wholeNumber = (value: string | undefined): number | undefined | null => {
    if (value === undefined) return undefined;
    return /^\d+$/.test(value) ? Number(value) : null;
};

export function registerReads(app: Hono, deps: ApiDeps): void {
    const { runtime, logs, version } = deps;

    app.get(`${API_BASE}/system/status`, c =>
        c.json({ appName: 'arr-mcp', version, mcpUrl: mcpEndpoint(c.req.url, c.req.header('x-forwarded-proto')) ?? null })
    );

    app.get(`${API_BASE}/health`, async c => {
        const snapshot = runtime.current;
        const types = new Map(listInstances(snapshot.config).map(i => [i.id, i.type]));
        const { services } = await buildStackHealth(snapshot.adapters, { detail: 'minimal', limit: 50 });
        return c.json(
            services
                .map(d => ({
                    app: d.service,
                    type: types.get(d.service) ?? null,
                    ok: d.ok,
                    latencyMs: d.latency_ms,
                    ...(d.version === undefined ? {} : { version: d.version }),
                    ...(d.error === undefined ? {} : { error: d.error })
                }))
                .sort((a, b) => a.app.localeCompare(b.app))
        );
    });

    app.get(`${API_BASE}/log`, (c: Context) => {
        const level = c.req.query('level') ?? 'trace';
        if (!Object.hasOwn(LEVELS, level)) {
            return apiError(c, 400, `level must be one of ${Object.keys(LEVELS).join(', ')}.`);
        }
        const afterId = wholeNumber(c.req.query('afterId'));
        if (afterId === null) return apiError(c, 400, 'afterId must be a whole number.');
        const parsedLimit = wholeNumber(c.req.query('limit'));
        const limit = parsedLimit === undefined ? DEFAULT_LOG_RECORDS : parsedLimit;
        if (limit === null || limit < 1 || limit > MAX_LOG_RECORDS) {
            return apiError(c, 400, `limit must be between 1 and ${MAX_LOG_RECORDS}.`);
        }

        const appFilter = c.req.query('app');
        const records = logs
            .recent({
                minLevel: LEVELS[level as keyof typeof LEVELS],
                ...(appFilter === undefined ? {} : { service: appFilter }),
                ...(afterId === undefined ? {} : { afterId }),
                limit
            })
            .map(r => ({
                id: r.id,
                at: r.at,
                level: r.levelName,
                app: r.service,
                message: r.msg,
                fields: Object.fromEntries(logFields(r.fields))
            }));
        return c.json({ records });
    });
}
