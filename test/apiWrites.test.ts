import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, closeApi, json, seedApi, stack } from './helpers/apiStack.ts';

beforeEach(async () => {
    await seedApi();
});

afterEach(() => {
    vi.restoreAllMocks();
    closeApi();
});

const etag = async () => (await api('/settings/mcp')).headers.get('etag') as string;

describe('the write pipeline', () => {
    it('refuses a non-JSON body with 415', async () => {
        const res = await api('/settings/imdb', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'on' });
        expect(res.status).toBe(415);
    });

    it('refuses malformed JSON with a {message} 400, not a JSON-RPC error', async () => {
        const res = await api('/settings/imdb', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: '{nope'
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ message: 'The request body is not valid JSON.' });
    });

    it('refuses malformed JSON on POST the same way', async () => {
        const res = await api('/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ message: 'The request body is not valid JSON.' });
    });

    it('applies a write with a current If-Match, weak or strong', async () => {
        const tag = await etag();
        expect((await api('/settings/imdb', json('PUT', { enabled: true }, { 'if-match': tag }))).status).toBe(200);
        const next = await etag();
        expect(next).not.toBe(tag);
        expect((await api('/settings/imdb', json('PUT', { enabled: false }, { 'if-match': `W/${next}` }))).status).toBe(200);
    });

    it('refuses a stale If-Match with 412 and changes nothing', async () => {
        const stale = await etag();
        await api('/settings/imdb', json('PUT', { enabled: true }));
        const res = await api('/settings/imdb', json('PUT', { enabled: false }, { 'if-match': stale }));
        expect(res.status).toBe(412);
        expect(stack.runtime.config.metadata?.imdb?.enabled).toBe(true);
    });

    it('refuses with 412 when config.yaml changed on disk', async () => {
        const path = join(stack.dir, 'config.yaml');
        const text = await readFile(path, 'utf8');
        await writeFile(path, `# edited by hand\n${text.replace('allowed_hosts: []', 'allowed_hosts: [edited.example.com]')}`, 'utf8');
        const res = await api('/settings/imdb', json('PUT', { enabled: true }));
        expect(res.status).toBe(412);
    });

    it('carries the new ETag on the write response', async () => {
        const res = await api('/settings/imdb', json('PUT', { enabled: true }));
        expect(res.headers.get('etag')).toBe(await etag());
    });
});
