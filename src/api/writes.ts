import type { Hono } from 'hono';
import * as z from 'zod/v4';
import { setImdb } from '../config/edits.ts';
import { parseWith, readObject } from './body.ts';
import { API_BASE, withEtag } from './http.ts';
import type { ApiDeps } from './index.ts';
import { imdbSettings } from './resources.ts';
import { applyWrite } from './write.ts';

const ImdbBody = z.strictObject({
    enabled: z.boolean(),
    ingestedAt: z.unknown().optional(),
    titles: z.unknown().optional(),
    ratings: z.unknown().optional()
});

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
}
