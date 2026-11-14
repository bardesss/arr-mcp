import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import type { MergedItem } from '../src/core/resolver.ts';
import { unfenced } from '../src/core/titleMatch.ts';
import { LidarrAdapter } from '../src/services/lidarr.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { HISTORY_EVENT_TYPES, hasTagRepair } from '../src/services/types.ts';
import { registerFixMetadata, type RepairTiming } from '../src/tools/fixMetadata.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { instancesOf } from './helpers/instances.ts';

/**
 * Retagging a Lidarr artist's files through `fix_metadata`, and `retagged` in
 * `get_history`. `retag.json` is Lidarr 3.1.6.5079's retag preview, captured
 * on a test instance and anonymised: the first three files, with invented ids,
 * paths and tag values, and Lidarr's own field names as captured. A tag the
 * file lacked has no `oldValue`, as Lidarr sent it.
 * `config-metadataprovider.json` is the same instance's tag settings, which
 * carry nothing but Lidarr's defaults.
 */

const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/lidarr', `${name}.json`), 'utf8')) as unknown;

const RETAG = fixture('retag') as Record<string, unknown>[];
const SETTINGS = fixture('config-metadataprovider') as Record<string, unknown>;
const ARTIST = { id: 101, artistName: 'Artist 1', monitored: true, statistics: { trackFileCount: 3, albumCount: 1 } };

const config: KeyedServiceConfig = {
    url: 'http://192.0.2.10:8686',
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive: true }
};

type Sent = { method: string; path: string; search: string; body: Record<string, unknown> | undefined };

/**
 * `previews` answers successive retag previews: before, then after the retag.
 * `byAlbum` answers a retag preview asked for one album, by its id. `name`
 * makes it a named instance, `lidarr/<name>`.
 */
function lidarr(opts: { previews?: unknown[]; settings?: unknown; command?: unknown; queued?: unknown; byAlbum?: Record<string, unknown>; name?: string } = {}) {
    const previews = [...(opts.previews ?? [RETAG, []])];
    const sent: Sent[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        sent.push({ method, path: url.pathname, search: url.search, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined });
        const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        if (url.pathname === '/api/v1/artist/101') return json(ARTIST);
        const album = url.searchParams.get('albumId');
        if (url.pathname === '/api/v1/retag' && album !== null && opts.byAlbum !== undefined) return json(opts.byAlbum[album] ?? []);
        if (url.pathname === '/api/v1/retag') return json(previews.length > 1 ? previews.shift() : previews[0]);
        if (url.pathname === '/api/v1/config/metadataprovider') return json(opts.settings === undefined ? SETTINGS : opts.settings);
        if (url.pathname === '/api/v1/command' && method === 'POST') return json(opts.queued ?? { id: 41, name: 'RetagFiles', status: 'queued' });
        if (url.pathname === '/api/v1/command/41') return json(opts.command ?? { id: 41, name: 'RetagFiles', status: 'completed' });
        return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }) as unknown as typeof fetch;
    return { adapter: new LidarrAdapter(opts.name === undefined ? config : { ...config, name: opts.name }, impl), sent };
}

describe('LidarrAdapter retagging', () => {
    it('claims tag repair', () => {
        expect(hasTagRepair(lidarr().adapter)).toBe(true);
    });

    it('reads the captured preview, an absent old value as empty', async () => {
        const { adapter, sent } = lidarr();
        const files = await adapter.previewRetag('101');

        expect(sent.map(s => `${s.path}${s.search}`)).toEqual(['/api/v1/retag?artistId=101']);
        expect(files.map(f => f.trackFileId)).toEqual([1001, 1002, 1003]);
        expect(files.map(f => f.albumId)).toEqual([102, 102, 102]);
        expect(unfenced(files[0]?.path ?? '')).toBe('/music/Artist 1/Album 1/Track 1.mp3');
        const [format, , , , genres] = files[0]?.changes ?? [];
        expect(format?.field).toBe('Media Format');
        expect(unfenced(format?.oldValue ?? 'x')).toBe('');
        expect(unfenced(genres?.oldValue ?? '')).toBe('oldValue 1.5');
        expect(unfenced(genres?.newValue ?? '')).toBe('newValue 1.5');
    });

    it('reads the tag settings', async () => {
        expect(await lidarr().adapter.readTagSettings()).toEqual({ scrubAudioTags: false, writeAudioTags: 'no' });
    });

    // Off is the value that drops the scrub warning, so a setting Lidarr did not report is not read as off.
    it('reads a tag setting Lidarr did not report as unknown', async () => {
        expect(await lidarr({ settings: {} }).adapter.readTagSettings()).toEqual({ scrubAudioTags: undefined, writeAudioTags: 'unknown' });
        expect(await lidarr({ settings: null }).adapter.readTagSettings()).toEqual({ scrubAudioTags: undefined, writeAudioTags: 'unknown' });
    });

    it('posts RetagFiles for the files and waits for it to settle', async () => {
        const { adapter, sent } = lidarr();
        const row = await adapter.retagFiles('101', [1001, 1003]);

        expect(sent.find(s => s.method === 'POST')?.body).toEqual({ name: 'RetagFiles', artistId: 101, files: [1001, 1003] });
        expect(sent.some(s => s.path === '/api/v1/command/41')).toBe(true);
        expect(row).toMatchObject({ settled: true, status: 'completed' });
    });

    // Queued, so it can still run: not a failed write, and no id to name.
    it('reports a retag Lidarr queued without an id as unsettled, naming no command', async () => {
        const { adapter, sent } = lidarr({ queued: { name: 'RetagFiles', status: 'queued' } });
        const row = await adapter.retagFiles('101', [1001]);

        expect(row).toEqual({ settled: false, reason: expect.stringMatching(/returned no command id/) as unknown });
        expect(sent.some(s => s.path.startsWith('/api/v1/command/'))).toBe(false);
    });
});

describe('retagged in get_history', () => {
    // Agreed in #399: after `subtitle`.
    it('sits after subtitle', () => {
        expect(HISTORY_EVENT_TYPES.indexOf('retagged')).toBe(HISTORY_EVENT_TYPES.indexOf('subtitle') + 1);
    });

    it('sends Lidarr code 9 for event_type retagged, and reads the row back as retagged', async () => {
        const sent: URL[] = [];
        const row = { id: 5, eventType: 'trackFileRetagged', date: '2024-01-02T00:00:00Z', sourceTitle: 'lidarr item 1', artistId: 101 };
        const impl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            sent.push(url);
            const page = Number(url.searchParams.get('page') ?? '1');
            return new Response(JSON.stringify({ page, totalRecords: 1, records: page === 1 ? [row] : [] }), {
                headers: { 'content-type': 'application/json' }
            });
        }) as unknown as typeof fetch;

        const { items } = await new LidarrAdapter(config, impl).readHistory({ eventType: 'retagged' });

        expect(sent[0]?.searchParams.getAll('eventType')).toEqual(['9']);
        expect(items.map(i => [i.event, i.rawEvent])).toEqual([['retagged', 'trackFileRetagged']]);
    });
});

describe('a type a service has no code for', () => {
    // No Radarr row maps to `retagged`, `subtitle` or a Cleanuparr type, so a
    // local filter would read the whole history to find nothing.
    it('is answered without reading, except unknown', async () => {
        const sent: string[] = [];
        const impl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            sent.push(url.pathname);
            return new Response(JSON.stringify({ page: 1, totalRecords: 0, records: [] }), { headers: { 'content-type': 'application/json' } });
        }) as unknown as typeof fetch;
        const radarr = new RadarrAdapter({ ...config, url: 'http://192.0.2.10:7878' }, impl);

        for (const eventType of ['retagged', 'subtitle', 'strike'] as const) {
            expect(await radarr.readHistory({ eventType })).toEqual({ items: [], total: 0 });
        }
        expect(sent).toEqual([]);

        await radarr.readHistory({ eventType: 'unknown' });
        expect(sent).toContain('/api/v3/history');
    });
});

type Call = (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; structuredContent: WriteToolResult }>;

const instant: RepairTiming = { pollMs: 0, waitMs: 0, sleep: async () => {} };

function fixMetadata(adapters: LidarrAdapter | readonly LidarrAdapter[], hits: MergedItem | MergedItem[] = []) {
    const music = [adapters].flat();
    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, c: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(c.inputSchema.parse(args) as Record<string, unknown>);
        }
    };
    const loader = {
        load: async () => ({ index: { search: () => [hits].flat(), all: () => [] }, degraded: [] }),
        invalidate: vi.fn()
    } as unknown as LibraryLoader;
    registerFixMetadata(
        server as never,
        {
            permissions: permissionSourceFrom(music.flatMap(a => instancesOf({ lidarr: (a.instance === undefined ? config : { ...config, name: a.instance }) as AnyServiceConfig }))),
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: loader
        },
        {},
        loader,
        instant,
        undefined,
        music
    );
    return (args: Record<string, unknown>) => call(args);
}

describe('fix_metadata on a Lidarr artist', () => {
    it('previews each file whose tags differ, field by field', async () => {
        const { structuredContent } = await fixMetadata(lidarr().adapter)({ id: 'lidarr:101' });

        expect(structuredContent.target).toBe('lidarr:101');
        expect(structuredContent.tier).toBe('destructive');
        expect(structuredContent.summary).toContain("Rewrite the embedded tags in 3 of");
        const said = structuredContent.effects.join('\n');
        expect(said).toContain('Track 1.mp3');
        expect(said).toContain('(#1001)');
        expect(said).toContain('Media Format (empty) →');
        expect(said).toContain('Irreversible');
        expect(said).toContain('Runs regardless of Lidarr\'s Tag Audio Files with Metadata setting (now `no`)');
        expect(said).not.toContain('Scrub Existing Tags');
        // Lidarr's preview never lists such a file, so there is nothing to say about one.
        expect(said).not.toContain('more than one track');
    });

    it('leads with the scrub when Lidarr will delete every other tag', async () => {
        const { structuredContent } = await fixMetadata(lidarr({ settings: { ...SETTINGS, scrubAudioTags: true } }).adapter)({ id: 'lidarr:101' });
        expect(structuredContent.effects[0]).toContain('Scrub Existing Tags setting is on');
        expect(structuredContent.effects[0]).toContain('deleted from these files first');

        const one = await fixMetadata(lidarr({ settings: { ...SETTINGS, scrubAudioTags: true } }).adapter)({ id: 'lidarr:101', files: [1002] });
        expect(one.structuredContent.effects[0]).toContain('deleted from this file first');
        expect(one.structuredContent.effects.join('\n')).toContain('after its next scan of this file;');
    });

    it('warns of the scrub when Lidarr does not report the setting', async () => {
        const { structuredContent } = await fixMetadata(lidarr({ settings: {} }).adapter)({ id: 'lidarr:101' });
        expect(structuredContent.effects[0]).toContain('did not say whether its Scrub Existing Tags setting is on');
    });

    it('narrows to the files named, and refuses one with no differences', async () => {
        const { structuredContent } = await fixMetadata(lidarr().adapter)({ id: 'lidarr:101', files: [1002] });
        expect(structuredContent.summary).toContain('1 of');

        await expect(fixMetadata(lidarr().adapter)({ id: 'lidarr:101', files: [1999] })).rejects.toThrow(/track file 1999 has no tag differences/);
        await expect(fixMetadata(lidarr().adapter)({ id: 'lidarr:101', files: [1001, 1998, 1999] })).rejects.toThrow(
            /track files 1998, 1999 have no tag differences/
        );
        // The remedy reads right for one file and for several.
        await expect(fixMetadata(lidarr().adapter)({ id: 'lidarr:101', files: [1999] })).rejects.toMatchObject({ remedy: expect.stringContaining('Either its tags') });
        await expect(fixMetadata(lidarr().adapter)({ id: 'lidarr:101', files: [1998, 1999] })).rejects.toMatchObject({ remedy: expect.stringContaining('Either their tags') });
        await expect(fixMetadata(lidarr().adapter)({ id: 'lidarr:101', files: [1999] })).rejects.toMatchObject({
            remedy: expect.stringContaining('or Lidarr leaves it out of its retag preview, as it does any file linked to several tracks')
        });
    });

    it('is a no-op when every file already carries Lidarr\'s tags', async () => {
        const { structuredContent } = await fixMetadata(lidarr({ previews: [[]] }).adapter)({ id: 'lidarr:101' });
        expect(structuredContent.noop).toBe(true);
        // Not "every file carries Lidarr's tags": the preview leaves some files out.
        expect(structuredContent.summary).toContain('leaves out a file linked to several tracks or to none');
    });

    it('names the instance in the summary, for a retag and for a no-op', async () => {
        const retag = await fixMetadata(lidarr({ name: 'flac' }).adapter)({ id: 'lidarr/flac:101' });
        expect(retag.structuredContent.summary).toMatch(/^Rewrite the embedded tags in 3 of .*'s files from lidarr\/flac's metadata /);
        const same = await fixMetadata(lidarr({ name: 'flac', previews: [[]] }).adapter)({ id: 'lidarr/flac:101' });
        expect(same.structuredContent.noop).toBe(true);
        expect(same.structuredContent.summary).toMatch(/^lidarr\/flac's retag preview lists no file under .* whose tags differ /);
    });

    it('retags exactly the previewed files and checks them with a fresh preview', async () => {
        // Preview, the confirm's own plan, then the check after the retag.
        const { adapter, sent } = lidarr({ previews: [RETAG, RETAG, []] });
        const call = fixMetadata(adapter);
        const first = await call({ id: 'lidarr:101', files: [1001, 1003] });
        const second = await call({ id: 'lidarr:101', files: [1001, 1003], confirm: first.structuredContent.confirm_token });

        expect(sent.find(s => s.method === 'POST')?.body).toEqual({ name: 'RetagFiles', artistId: 101, files: [1001, 1003] });
        expect(second.structuredContent.result).toMatchObject({ verified: true, filesBefore: 2, filesStillDiffering: 0 });
        // The preview and the confirm's plan read the artist; the check, only the album those files are on.
        expect(sent.filter(s => s.path === '/api/v1/retag').map(s => s.search)).toEqual(['?artistId=101', '?artistId=101', '?artistId=101&albumId=102']);
    });

    it('says NOT FIXED when the files still differ after the command', async () => {
        const call = fixMetadata(lidarr({ previews: [RETAG, RETAG, RETAG] }).adapter);
        const first = await call({ id: 'lidarr:101' });
        const second = await call({ id: 'lidarr:101', confirm: first.structuredContent.confirm_token });

        expect(second.structuredContent.result).toMatchObject({ verified: false, filesStillDiffering: 3 });
        const note = String((second.structuredContent.result as { note: string }).note);
        expect(note).toContain('NOT FIXED');
        expect(note).not.toContain('several tracks');
        expect(note).not.toContain('Scrub Existing Tags');
    });

    it('checks each album the bound files are on, once, and counts what each still lists', async () => {
        const twoAlbums = RETAG.map((r, i) => (i === 2 ? { ...r, albumId: 103 } : r));
        // Album 102 is clean after the retag; album 103 still lists its file.
        const { adapter, sent } = lidarr({ previews: [twoAlbums, twoAlbums], byAlbum: { '102': [], '103': [twoAlbums[2]] } });
        const call = fixMetadata(adapter);
        const first = await call({ id: 'lidarr:101' });
        const second = await call({ id: 'lidarr:101', confirm: first.structuredContent.confirm_token });

        expect(sent.filter(s => s.path === '/api/v1/retag').map(s => s.search)).toEqual([
            '?artistId=101',
            '?artistId=101',
            '?artistId=101&albumId=102',
            '?artistId=101&albumId=103'
        ]);
        expect(second.structuredContent.result).toMatchObject({ verified: false, filesBefore: 3, filesStillDiffering: 1 });
    });

    // A row with no album cannot narrow the check, so the check reads the whole artist.
    it('checks the whole artist when a previewed file came without an album, or with 0', async () => {
        for (const albumId of [undefined, 0]) {
            const noAlbum = RETAG.map((r, i) => (i === 0 ? { ...r, albumId } : r));
            const { adapter, sent } = lidarr({ previews: [noAlbum, noAlbum, []] });
            const call = fixMetadata(adapter);
            const first = await call({ id: 'lidarr:101' });
            const second = await call({ id: 'lidarr:101', confirm: first.structuredContent.confirm_token });

            expect(sent.filter(s => s.path === '/api/v1/retag').map(s => s.search)).toEqual(['?artistId=101', '?artistId=101', '?artistId=101']);
            expect(second.structuredContent.result).toMatchObject({ verified: true, filesStillDiffering: 0 });
        }
    });

    // The notes are built from counts, so they must read right for one file too.
    it('words the result for a single file', async () => {
        const fixed = fixMetadata(lidarr({ previews: [RETAG, RETAG, []] }).adapter);
        const a = await fixed({ id: 'lidarr:101', files: [1002] });
        const b = await fixed({ id: 'lidarr:101', files: [1002], confirm: a.structuredContent.confirm_token });
        expect(String((b.structuredContent.result as { note: string }).note)).toContain('Retagged: a fresh retag preview no longer lists the file as differing');

        const stuck = fixMetadata(lidarr({ previews: [RETAG, RETAG, RETAG] }).adapter);
        const c = await stuck({ id: 'lidarr:101', files: [1002] });
        const d = await stuck({ id: 'lidarr:101', files: [1002], confirm: c.structuredContent.confirm_token });
        expect(String((d.structuredContent.result as { note: string }).note)).toContain('1 of 1 file still differs');
    });

    it('says NOT VERIFIED, not NOT FIXED, when the command failed but no file differs', async () => {
        const call = fixMetadata(lidarr({ previews: [RETAG, RETAG, []], command: { id: 41, name: 'RetagFiles', status: 'failed' } }).adapter);
        const first = await call({ id: 'lidarr:101' });
        const second = await call({ id: 'lidarr:101', confirm: first.structuredContent.confirm_token });

        expect(second.structuredContent.result).toMatchObject({ verified: false, status: 'failed', filesStillDiffering: 0 });
        expect(String((second.structuredContent.result as { note: string }).note)).toContain(
            "NOT VERIFIED: Lidarr's RetagFiles command ended failed, though a fresh retag preview no longer lists any of the 3 files"
        );
    });

    // Once Lidarr has queued it, the retag can still run: not a failed write, and no check yet.
    it('says NOT VERIFIED when Lidarr queued the retag but the wait for it failed', async () => {
        const { adapter, sent } = lidarr({ previews: [RETAG, RETAG, []], queued: { name: 'RetagFiles', status: 'queued' } });
        const call = fixMetadata(adapter);
        const first = await call({ id: 'lidarr:101' });
        const second = await call({ id: 'lidarr:101', confirm: first.structuredContent.confirm_token });

        expect(second.structuredContent.result).toMatchObject({ verified: false, status: 'unknown', filesBefore: 3 });
        const note = String((second.structuredContent.result as { note: string }).note);
        expect(note).toContain('NOT VERIFIED: Lidarr queued RetagFiles, and arr-mcp stopped waiting for it');
        expect(note).toContain('Do not confirm it again');
        // The preview and the confirm's own plan only: none after the POST.
        expect(sent.filter(s => s.path === '/api/v1/retag')).toHaveLength(2);
    });

    // The token binds the setting that decides whether other tags are wiped.
    it('rejects the token when Scrub Existing Tags is switched on after the preview', async () => {
        const opts: { previews: unknown[]; settings: unknown } = { previews: [RETAG, RETAG], settings: SETTINGS };
        const { adapter, sent } = lidarr(opts);
        const call = fixMetadata(adapter);
        const first = await call({ id: 'lidarr:101' });
        opts.settings = { ...SETTINGS, scrubAudioTags: true };
        const second = await call({ id: 'lidarr:101', confirm: first.structuredContent.confirm_token });

        expect(second.structuredContent.applied).toBe(false);
        expect(second.structuredContent.confirm_error).toContain('or what this call acts on has changed since that preview');
        // The new warning reaches a client that reads the text alone.
        expect(second.content[0]?.text).toContain('Scrub Existing Tags setting is on');
        expect(sent.some(s => s.method === 'POST')).toBe(false);
    });

    it('says a file NOT FIXED with Scrub on may have lost its tags', async () => {
        const call = fixMetadata(lidarr({ previews: [RETAG, RETAG, RETAG], settings: { ...SETTINGS, scrubAudioTags: true } }).adapter);
        const first = await call({ id: 'lidarr:101' });
        const second = await call({ id: 'lidarr:101', confirm: first.structuredContent.confirm_token });

        expect(String((second.structuredContent.result as { note: string }).note)).toContain('a file it could not write may now have none');
    });

    // The write has happened and the token is spent, so the read's error alone would not say that.
    it('says NOT VERIFIED when the check after the retag cannot be read', async () => {
        const call = fixMetadata(lidarr({ previews: [RETAG, RETAG, { message: 'not a list' }] }).adapter);
        const first = await call({ id: 'lidarr:101' });
        const second = await call({ id: 'lidarr:101', confirm: first.structuredContent.confirm_token });

        expect(second.structuredContent.result).toMatchObject({ verified: false, status: 'completed', filesBefore: 3 });
        const note = String((second.structuredContent.result as { note: string }).note);
        expect(note).toContain("NOT VERIFIED: Lidarr's RetagFiles command ended completed");
        expect(note).toContain('did not return an array');
    });

    it('says NOT FIXED with the status when the command does not complete', async () => {
        const call = fixMetadata(lidarr({ previews: [RETAG, RETAG, RETAG], command: { id: 41, name: 'RetagFiles', status: 'failed', message: 'Fixture message 1' } }).adapter);
        const first = await call({ id: 'lidarr:101' });
        const second = await call({ id: 'lidarr:101', confirm: first.structuredContent.confirm_token });

        const note = String((second.structuredContent.result as { note: string }).note);
        expect(second.structuredContent.result).toMatchObject({ verified: false, status: 'failed' });
        expect(note).toContain('RetagFiles command ended failed');
        expect(unfenced(note)).toContain('Fixture message 1');
    });

    it('refuses `user` with a lidarr id, and files without one', async () => {
        const call = fixMetadata(lidarr().adapter);
        await expect(call({ id: 'lidarr:101', user: 'user-1' })).rejects.toThrow(/`user` picks whose media-server view/);
        // No media server here, so the permission check refuses a non-Lidarr
        // write first; `dry_run` plans it anyway, which is where this refusal is.
        await expect(call({ query: 'Album 1', files: [1001], dry_run: true })).rejects.toThrow(/`files` is for music only/);
    });

    it('refuses an artist asked for by name, naming the lidarr id to use', async () => {
        const artist = { kind: 'artist', title: 'Artist 1', ids: {}, acquisition: { service: 'lidarr', id: '101' }, presence: 'arr_only' } as unknown as MergedItem;
        await expect(fixMetadata(lidarr().adapter, artist)({ query: 'Artist 1', dry_run: true })).rejects.toThrow(/call fix_metadata with id "lidarr:101"/);
    });

    // The item the resolver would refuse, so a book ranked first does not send the
    // caller to the film-and-series refusal.
    it('refuses an artist ranked behind a book the same way', async () => {
        const book = { kind: 'book', title: 'Artist 1', ids: {}, acquisition: { service: 'grimmory', id: '7' }, presence: 'unknown' } as unknown as MergedItem;
        const artist = { kind: 'artist', title: 'Artist 1', ids: {}, acquisition: { service: 'lidarr', id: '101' }, presence: 'arr_only' } as unknown as MergedItem;
        await expect(fixMetadata(lidarr().adapter, [book, artist])({ query: 'Artist 1', dry_run: true })).rejects.toThrow(/call fix_metadata with id "lidarr:101"/);
    });

    // The service is matched to a configured Lidarr, not read from its name.
    it('names no id for an artist no configured Lidarr manages', async () => {
        const artist = { kind: 'artist', title: 'Artist 1', ids: {}, acquisition: { service: 'lidarr/other', id: '101' }, presence: 'arr_only' } as unknown as MergedItem;
        await expect(fixMetadata(lidarr().adapter, artist)({ query: 'Artist 1', dry_run: true })).rejects.toThrow(/is an artist no Lidarr manages/);
    });

    // Read as a media-server item, such an id was checked against the media
    // server's permissions (here none is configured, so "jellyfin is not
    // configured") and, on a dry run, looked up there. Refused before either.
    describe('with an id written as a Lidarr artist\'s that no configured Lidarr matches', () => {
        it('refuses it before any request, naming the ids the configured Lidarr takes, and still previews one it matches', async () => {
            const { adapter, sent } = lidarr({ name: 'flac' });
            const call = fixMetadata(adapter);
            for (const dry_run of [false, true]) {
                await expect(call({ id: 'lidarr:101', dry_run })).rejects.toMatchObject({
                    kind: 'NotFound',
                    service: 'lidarr',
                    message: 'lidarr not found: no Lidarr is configured as "lidarr". Give the artist as `lidarr/flac:<artistId>`, from its `acquisition.service` and `acquisition.id`.'
                });
            }
            expect(sent).toEqual([]);

            const { structuredContent } = await call({ id: 'lidarr/flac:101' });
            expect(structuredContent.service).toBe('lidarr/flac');
            expect(structuredContent.target).toBe('lidarr/flac:101');
            expect(structuredContent.summary).toContain('Rewrite the embedded tags in 3 of');
        });

        it('names every configured Lidarr', async () => {
            const flac = lidarr({ name: 'flac' });
            const mp3 = lidarr({ name: 'mp3' });
            await expect(fixMetadata([flac.adapter, mp3.adapter])({ id: 'lidarr/hifi:101' })).rejects.toThrow(
                'no Lidarr is configured as "lidarr/hifi". Give the artist as `lidarr/flac:<artistId>` or `lidarr/mp3:<artistId>`,'
            );
            expect([...flac.sent, ...mp3.sent]).toEqual([]);
        });

        it('says so when it names a configured Lidarr but no artist', async () => {
            const { adapter, sent } = lidarr({ name: 'flac' });
            const call = fixMetadata(adapter);
            for (const id of ['lidarr/flac', 'lidarr/flac:']) {
                await expect(call({ id })).rejects.toThrow(`"${id}" names no artist. Give the artist as \`lidarr/flac:<artistId>\`,`);
            }
            const unnamed = lidarr();
            await expect(fixMetadata(unnamed.adapter)({ id: 'lidarr' })).rejects.toThrow('"lidarr" names no artist. Give the artist as `lidarr:<artistId>`,');
            expect([...sent, ...unnamed.sent]).toEqual([]);
        });

        // Instance names are matched in any case (`resolveInstance`, and config
        // refuses two that differ only in case), so the prefix is too.
        it('matches the prefix in any case, and refuses only a name no Lidarr has in any case', async () => {
            const one = lidarr({ previews: [RETAG, RETAG, []] });
            const unnamed = fixMetadata(one.adapter);
            const first = await unnamed({ id: 'Lidarr:101' });
            expect(first.structuredContent.target).toBe('lidarr:101');
            // Confirmed with the id as the configured instance writes it: the token binds the target, not the spelling.
            const second = await unnamed({ id: 'lidarr:101', confirm: first.structuredContent.confirm_token });
            expect(second.structuredContent.applied).toBe(true);
            expect(one.sent.find(s => s.method === 'POST')?.body).toEqual({ name: 'RetagFiles', artistId: 101, files: [1001, 1002, 1003] });
            const { adapter, sent } = lidarr({ name: 'flac' });
            const call = fixMetadata(adapter);
            const named = await call({ id: 'LIDARR/FLAC:101' });
            expect(named.structuredContent.service).toBe('lidarr/flac');
            expect(named.structuredContent.target).toBe('lidarr/flac:101');
            await expect(call({ id: 'Lidarr/Flac' })).rejects.toThrow('"Lidarr/Flac" names no artist. Give the artist as `lidarr/flac:<artistId>`,');
            const before = sent.length;
            await expect(call({ id: 'Lidarr/hifi:101' })).rejects.toThrow('no Lidarr is configured as "Lidarr/hifi". Give the artist as `lidarr/flac:<artistId>`,');
            expect(sent).toHaveLength(before);
        });

        it('says when no Lidarr is configured at all', async () => {
            const call = fixMetadata([]);
            await expect(call({ id: 'lidarr:101' })).rejects.toMatchObject({
                kind: 'NotFound',
                message: 'lidarr not found: no Lidarr is configured. Add a services.lidarr block to config.yaml and restart.'
            });
            await expect(call({ query: 'Album 1', files: [1001], dry_run: true })).rejects.toThrow('`files` is for music only, and no Lidarr is configured.');
        });

        it('names the configured Lidarr when `files` comes with another id', async () => {
            await expect(fixMetadata(lidarr({ name: 'flac' }).adapter)({ query: 'Album 1', files: [1001], dry_run: true })).rejects.toThrow(
                '`files` is for music only, with `id` as `lidarr/flac:<artistId>`.'
            );
        });
    });
});
