import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { unfenced } from '../src/core/titleMatch.ts';
import { scopeText } from '../src/mcp/toolSurface.ts';
import { LidarrAdapter } from '../src/services/lidarr.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { hasMediaUpdate, type ServiceAdapter } from '../src/services/types.ts';
import { WhisparrAdapter } from '../src/services/whisparr.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerUpdateMedia } from '../src/tools/updateMedia.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { instancesOf } from './helpers/instances.ts';

/**
 * `update_media` on a Lidarr artist, written through the Artist Editor.
 * `artist-editor-update.json` is the editor's answer to an update, captured on
 * a Lidarr 3.1.6.5079 test instance and anonymised as `artist-add.json` is,
 * with invented profile ids and its embedded album left out.
 */

const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/lidarr', `${name}.json`), 'utf8')) as unknown;

const UPDATED = fixture('artist-editor-update') as Record<string, unknown>[];
const ARTIST = { ...UPDATED[0], qualityProfileId: 1, metadataProfileId: 1, monitored: true, tags: [] };
const METADATA = fixture('metadataprofile');
const QUALITY = [
    { id: 1, name: 'Quality profile 1' },
    { id: 11, name: 'Quality profile 11' }
];

const config = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

type Sent = { method: string; path: string; body: Record<string, unknown> | undefined };

function lidarr(routes: Record<string, unknown> = {}, cfg: KeyedServiceConfig = config(8686)) {
    const all: Record<string, unknown> = {
        '/api/v1/artist/101': ARTIST,
        '/api/v1/artist/editor': UPDATED,
        '/api/v1/qualityprofile': QUALITY,
        '/api/v1/metadataprofile': METADATA,
        '/api/v1/tag': [{ id: 1, label: 'tag-1' }],
        ...routes
    };
    const sent: Sent[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        sent.push({
            method: init?.method ?? 'GET',
            path: url.pathname,
            body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
        });
        if (!(url.pathname in all)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
        return new Response(JSON.stringify(all[url.pathname]), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { adapter: new LidarrAdapter(cfg as never, impl), sent };
}

describe('LidarrAdapter updating an artist', () => {
    it('claims updating', () => {
        expect(hasMediaUpdate(lidarr().adapter)).toBe(true);
    });

    it('reads the artist itself, metadata profile and tags included', async () => {
        const { adapter, sent } = lidarr();
        const state = await adapter.readForUpdate('101');

        expect(sent.map(s => s.path)).toEqual(['/api/v1/artist/101']);
        expect(state).toMatchObject({ monitored: true, qualityProfileId: 1, metadataProfileId: 1, monitorNewItems: 'new', tagIds: [] });
        expect(unfenced(state.title)).toBe('Artist 1');
    });

    // `PUT /artist/{id}` would queue a MoveArtist on every call.
    it('writes only the fields given, through the Artist Editor, and reports what it answered', async () => {
        const { adapter, sent } = lidarr();
        const state = await adapter.updateMedia('101', { qualityProfileId: 11, metadataProfileId: 12, monitored: false, tagIds: [1], moveFiles: true });

        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ method: 'PUT', path: '/api/v1/artist/editor' });
        expect(sent[0]?.body).toEqual({
            artistIds: [101],
            monitored: false,
            qualityProfileId: 11,
            metadataProfileId: 12,
            tags: [1],
            applyTags: 'replace',
            moveFiles: false
        });
        expect(state).toMatchObject({ monitored: false, qualityProfileId: 11, metadataProfileId: 12, tagIds: [1] });
    });

    it('moves files only alongside a new root folder', async () => {
        const { adapter, sent } = lidarr();
        await adapter.updateMedia('101', { rootFolderPath: '/music/Folder 2/', moveFiles: true });
        expect(sent[0]?.body).toEqual({ artistIds: [101], rootFolderPath: '/music/Folder 2/', moveFiles: true });
    });

    it('reads the artist back when the editor answers something else', async () => {
        const { adapter, sent } = lidarr({ '/api/v1/artist/editor': {} });
        const state = await adapter.updateMedia('101', { monitored: false, moveFiles: false });

        expect(sent.map(s => `${s.method} ${s.path}`)).toEqual(['PUT /api/v1/artist/editor', 'GET /api/v1/artist/101']);
        expect(state.qualityProfileId).toBe(1);
    });

    it('reads the artist back when the editor answers a list without it', async () => {
        const { adapter, sent } = lidarr({ '/api/v1/artist/editor': [{ ...UPDATED[0], id: 102 }] });
        await adapter.updateMedia('101', { monitored: false, moveFiles: false });
        expect(sent.map(s => `${s.method} ${s.path}`)).toEqual(['PUT /api/v1/artist/editor', 'GET /api/v1/artist/101']);
    });

    it('refuses a non-integer id before any request', async () => {
        const { adapter, sent } = lidarr();
        await expect(adapter.updateMedia('artist-1', { monitored: false, moveFiles: false })).rejects.toThrow(/is not a lidarr artist id/);
        expect(sent).toHaveLength(0);
    });
});

type Call = (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; structuredContent: WriteToolResult }>;

const permissive = (port: number, destructive: boolean): AnyServiceConfig =>
    ({ ...config(port), permissions: { safe_write: true, destructive } }) as AnyServiceConfig;

function updateMedia(
    adapters: ServiceAdapter[],
    destructive = true,
    override?: Partial<Record<ServiceId, AnyServiceConfig>>
) {
    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, c: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(c.inputSchema.parse(args) as Record<string, unknown>);
        }
    };
    const services: Partial<Record<ServiceId, AnyServiceConfig>> = override ?? {
        lidarr: permissive(8686, destructive),
        radarr: permissive(7878, destructive)
    };
    registerUpdateMedia(
        server as never,
        {
            permissions: permissionSourceFrom(instancesOf(services)),
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: { invalidate: vi.fn() } as unknown as LibraryLoader
        },
        adapters
    );
    return (args: Record<string, unknown>) => call(args);
}

describe('update_media on Lidarr', () => {
    // The Lidarr text is scoped, so a stack with no Lidarr is not told about it.
    it('names Lidarr in the description only when a Lidarr is configured', () => {
        let description = '';
        const server = {
            registerTool(_n: string, c: { description: string }) {
                description = c.description;
            }
        };
        registerUpdateMedia(
            server as never,
            { permissions: permissionSourceFrom(instancesOf({})), confirm: new ConfirmTokens(), audit: WriteAudit.ephemeral(), library: {} as LibraryLoader },
            []
        );
        const on = (...types: ServiceId[]) => scopeText(description, { configured: new Set(types), hideUnusable: false });
        expect(on('radarr')).not.toContain('Lidarr');
        expect(on('lidarr')).toContain("already in Lidarr: quality profile, root folder, monitoring, tags, Lidarr's metadata profile");
        expect(on('lidarr')).toContain('On Lidarr, `id` is an artist; omit it with `monitored` or `monitor_new_items` to set every artist');
    });

    // The editor publishes no ArtistEditedEvent, so no refresh follows.
    it('switches the metadata profile, saying it applies at the next refresh', async () => {
        const { adapter, sent } = lidarr();
        const call = updateMedia([adapter]);
        const first = await call({ service: 'lidarr', id: '101', metadata_profile: 'None' });

        const said = first.structuredContent.effects.join(' ');
        expect(said).toContain('Switches the metadata profile from');
        expect(said).toContain("applies it at the artist's next refresh, which this does not start");

        await call({ service: 'lidarr', id: '101', metadata_profile: 'None', confirm: first.structuredContent.confirm_token });
        expect(sent.find(s => s.method === 'PUT')?.body).toEqual({ artistIds: [101], metadataProfileId: 2, moveFiles: false });
    });

    // A refresh after a narrower profile deletes albums the tool cannot put
    // back as they were, so only that field needs the destructive tier.
    it('needs the destructive tier for a metadata profile, and only safe_write without one', async () => {
        const safeOnly = updateMedia([lidarr().adapter], false);
        await expect(safeOnly({ service: 'lidarr', id: '101', metadata_profile: 'None' })).rejects.toThrow(
            /permissions\.destructive: true/
        );
        const profile = await safeOnly({ service: 'lidarr', id: '101', quality_profile: 'Quality profile 11' });
        expect(profile.structuredContent.tier).toBe('safe');

        const both = await updateMedia([lidarr().adapter])({ service: 'lidarr', id: '101', metadata_profile: 'None' });
        expect(both.structuredContent.tier).toBe('destructive');
    });

    // `None` empties the album list, so the refresh removes every album
    // without files that was not added by hand, and a switch back re-adds them.
    it('says None removes the albums at the next refresh, and a switch back re-adds them as new', async () => {
        const { structuredContent } = await updateMedia([lidarr().adapter])({ service: 'lidarr', id: '101', metadata_profile: 'None' });
        const said = structuredContent.effects.join(' ');
        expect(said).toContain('None lists no albums for the artist, so that refresh removes every album without files that was not added by hand');
        expect(said).toContain('switching back later brings them in again as new albums, flagged by `monitor_new_items` rather than as they are now');
        expect(said).not.toContain('Albums it brings in');
    });

    const BROADER = [...(METADATA as object[]), { id: 3, name: 'Everything' }];
    it.each([
        ['all', 'Albums it brings in are monitored (`monitor_new_items` is `all`). Lidarr then searches the released ones'],
        ['new', 'monitored when released on or after the newest dated album the artist already has that the new profile also lists, and every one when there is none (`monitor_new_items` is `new`). Lidarr then searches'],
        ['none', 'Albums it brings in are not monitored (`monitor_new_items` is `none`).']
    ])('says what %s does with the albums another profile brings in', async (rule, text) => {
        const { adapter } = lidarr({ '/api/v1/artist/101': { ...ARTIST, monitorNewItems: rule }, '/api/v1/metadataprofile': BROADER });
        const said = (await updateMedia([adapter])({ service: 'lidarr', id: '101', metadata_profile: 'Everything' })).structuredContent.effects.join(' ');
        expect(said).toContain(
            'Any album the new profile leaves out is removed then, unless it has files or was added by hand, and switching back later brings it in again as a new album, without its old flag.'
        );
        expect(said).toContain(text);
        if (rule === 'none') expect(said).not.toContain('searches');
        else expect(said).toContain("at the rescan after that refresh, or at its next disk scan when Lidarr's 'Rescan Artist Folder after Refresh' setting skips that rescan");
    });

    // Moving off None words the artist's albums like any other switch: the
    // editor starts no refresh, and a refresh under None keeps some albums.
    it('words a switch away from None like any other', async () => {
        const { adapter } = lidarr({ '/api/v1/artist/101': { ...ARTIST, metadataProfileId: 2, monitorNewItems: 'new' } });
        const said = (await updateMedia([adapter])({ service: 'lidarr', id: '101', metadata_profile: 'Standard' })).structuredContent.effects.join(' ');
        expect(said).toContain('Switches the metadata profile from <<untrusted:lidarr.name>>None');
        expect(said).toContain('Any album the new profile leaves out is removed then');
        expect(said).toContain('every one when there is none (`monitor_new_items` is `new`)');
    });

    it('names the rule generically when Lidarr does not report it', async () => {
        const { monitorNewItems: _, ...noRule } = ARTIST as Record<string, unknown>;
        const { adapter } = lidarr({ '/api/v1/artist/101': noRule, '/api/v1/metadataprofile': BROADER });
        const said = (await updateMedia([adapter])({ service: 'lidarr', id: '101', metadata_profile: 'Everything' })).structuredContent.effects.join(' ');
        expect(said).toContain("Albums it brings in are flagged by the artist's rule for new albums, `monitor_new_items`.");
    });

    it('names the current profile by id when it is not in the list, and generically when Lidarr reports none', async () => {
        const byId = lidarr({ '/api/v1/artist/101': { ...ARTIST, metadataProfileId: 9 } });
        const first = await updateMedia([byId.adapter])({ service: 'lidarr', id: '101', metadata_profile: 'Standard' });
        expect(first.structuredContent.effects.join(' ')).toContain('Switches the metadata profile from profile id 9 to');

        const { metadataProfileId: _, ...noProfile } = ARTIST as Record<string, unknown>;
        const none = lidarr({ '/api/v1/artist/101': noProfile });
        const second = await updateMedia([none.adapter])({ service: 'lidarr', id: '101', metadata_profile: 'Standard' });
        expect(second.structuredContent.effects.join(' ')).toContain('Switches the metadata profile from its current profile to');
    });

    // A scheduled refresh may not come until the artist changes upstream, so
    // the refresh is offered.
    it('says the next refresh may not come on its own, and offers trigger_scan on the artist once applied', async () => {
        const { adapter } = lidarr();
        const call = updateMedia([adapter]);
        const first = await call({ service: 'lidarr', id: '101', metadata_profile: 'None' });
        const said = first.structuredContent.effects.join(' ');
        expect(said).toContain(
            "Lidarr applies it at the artist's next refresh, which this does not start and which may not come until the artist changes upstream; trigger_scan with its `id` refreshes it now, and is offered once this is applied."
        );
        // The outcome only: how Lidarr picks the artists is in docs/tools.md.
        expect(said).not.toContain('metadata server');
        expect(said).not.toContain('3.1.5.5066');

        const done = await call({ service: 'lidarr', id: '101', metadata_profile: 'None', confirm: first.structuredContent.confirm_token });
        expect(done.structuredContent.next_steps).toEqual([
            {
                tool: 'trigger_scan',
                arguments: { service: 'lidarr', id: '101' },
                why: "Refreshes the artist now, and rescans every root folder unless Lidarr's 'Rescan Artist Folder after Refresh' is set to Never, so Lidarr applies the new metadata profile, with the album changes the preview described."
            }
        ]);
        expect(done.content[0]?.text).toContain('Next: trigger_scan {"service":"lidarr","id":"101"}');
    });

    it('names the instance in the offered step', async () => {
        const named = { ...config(8686), permissions: { safe_write: true, destructive: true }, name: 'two' } as unknown as AnyServiceConfig;
        const { adapter } = lidarr({}, named as KeyedServiceConfig);
        const call = updateMedia([adapter], true, { lidarr: named });
        const args = { service: 'lidarr', instance: 'two', id: '101', metadata_profile: 'None' };
        const first = await call(args);
        const done = await call({ ...args, confirm: first.structuredContent.confirm_token });
        expect(done.structuredContent.next_steps?.[0]?.arguments).toEqual({ service: 'lidarr', instance: 'two', id: '101' });
    });

    it('names the instance in the summary, for a change and for a no-op', async () => {
        const named = { ...config(8686), permissions: { safe_write: true, destructive: true }, name: 'two' } as unknown as AnyServiceConfig;
        const { adapter } = lidarr({}, named as KeyedServiceConfig);
        const call = updateMedia([adapter], true, { lidarr: named });

        const change = await call({ service: 'lidarr', instance: 'two', id: '101', metadata_profile: 'None' });
        expect(change.structuredContent.summary).toMatch(/ in lidarr\/two\.$/);
        const same = await call({ service: 'lidarr', instance: 'two', id: '101', metadata_profile: 'Standard' });
        expect(same.structuredContent.noop).toBe(true);
        expect(same.structuredContent.summary).toMatch(/ is already set that way in lidarr\/two\.$/);
    });

    // The refresh rescans the root folders, which can drop the records of
    // files that have not reached the new folder yet.
    it('offers no refresh after a move_files: false change in the same call, and says why', async () => {
        const { adapter } = lidarr({
            '/api/v1/rootfolder': [
                { id: 1, path: '/music', freeSpace: 2_000_000_000_000 },
                { id: 2, path: '/data/music', freeSpace: 500_000_000_000 }
            ]
        });
        const call = updateMedia([adapter]);
        const args = { service: 'lidarr', id: '101', metadata_profile: 'None', root_folder: '/data/music', move_files: false };
        const first = await call(args);
        expect(first.structuredContent.effects.join(' ')).toContain(
            "trigger_scan with its `id` refreshes it now, but is not offered here, since it also rescans the root folders: run it once the files are in the new root folder."
        );
        const done = await call({ ...args, confirm: first.structuredContent.confirm_token });
        expect(done.structuredContent.next_steps).toBeUndefined();
    });

    it('still offers the refresh when the same call moves the files to a new root folder', async () => {
        const { adapter } = lidarr({
            '/api/v1/rootfolder': [
                { id: 1, path: '/music', freeSpace: 2_000_000_000_000 },
                { id: 2, path: '/data/music', freeSpace: 500_000_000_000 }
            ]
        });
        const call = updateMedia([adapter]);
        const args = { service: 'lidarr', id: '101', metadata_profile: 'None', root_folder: '/data/music', move_files: true };
        const first = await call(args);
        expect(first.structuredContent.effects.join(' ')).toContain('and is offered once this is applied.');
        const done = await call({ ...args, confirm: first.structuredContent.confirm_token });
        expect(done.structuredContent.next_steps?.[0]?.tool).toBe('trigger_scan');
    });

    it('offers no refresh, and sends no metadata profile, when the profile does not change', async () => {
        const { adapter, sent } = lidarr();
        const call = updateMedia([adapter]);
        const args = { service: 'lidarr', id: '101', metadata_profile: 'Standard', quality_profile: 'Quality profile 11' };
        const first = await call(args);
        const done = await call({ ...args, confirm: first.structuredContent.confirm_token });
        expect(done.structuredContent.next_steps).toBeUndefined();
        expect(sent.find(s => s.method === 'PUT')?.body).toEqual({ artistIds: [101], qualityProfileId: 11, moveFiles: false });
    });

    it('is a no-op when the metadata profile is already that one', async () => {
        const { structuredContent } = await updateMedia([lidarr().adapter])({ service: 'lidarr', id: '101', metadata_profile: 'Standard' });
        expect(structuredContent.noop).toBe(true);
    });

    // The artist flag is not the album flag.
    it('says unmonitoring the artist leaves the albums\' own flags alone, and trigger_search still grabs', async () => {
        const { structuredContent } = await updateMedia([lidarr().adapter])({ service: 'lidarr', id: '101', monitored: false });
        const said = structuredContent.effects.join(' ');
        expect(said).toContain('RSS sync and its own searches skip it. The albums keep their own flags');
        expect(said).toContain('trigger_search can still grab the monitored ones');
    });

    // The editor starts no refresh, and a refresh under None keeps the albums
    // with files or added by hand, so the artist on None still has albums.
    it('words monitoring an artist on None as on any profile, reading only the artist', async () => {
        const { adapter, sent } = lidarr({ '/api/v1/artist/101': { ...ARTIST, monitored: false, metadataProfileId: 2 } });
        const said = (await updateMedia([adapter])({ service: 'lidarr', id: '101', monitored: true })).structuredContent.effects.join(' ');
        expect(said).toContain('for the albums that are monitored');
        expect(sent.map(s => s.path)).toEqual(['/api/v1/artist/101']);
    });

    it('points the artist at a new root folder without moving it when move_files is false', async () => {
        const { adapter, sent } = lidarr({
            '/api/v1/rootfolder': [
                { id: 1, path: '/music', freeSpace: 2_000_000_000_000 },
                { id: 2, path: '/data/music', freeSpace: 500_000_000_000 }
            ]
        });
        const call = updateMedia([adapter]);
        const args = { service: 'lidarr', id: '101', root_folder: '/data/music', move_files: false };
        const first = await call(args);
        const said = first.structuredContent.effects.join(' ');
        expect(said).toContain(
            "without moving anything. If the artist's current folder is still on disk, Lidarr also rewrites every track file's recorded path to the new root folder while the files stay where they are. It keeps counting them as present, and a library scan before they are moved there can drop their records."
        );
        expect(said).toContain(
            "Switching back restores the artist's folder but not those paths, since Lidarr skips the move when the folder it moves from is not on disk."
        );
        expect(said).not.toContain('missing');
        await call({ ...args, confirm: first.structuredContent.confirm_token });
        expect(sent.find(s => s.method === 'PUT')?.body).toEqual({ artistIds: [101], rootFolderPath: '/data/music', moveFiles: false });
    });

    it('says monitoring the artist grabs only for monitored albums', async () => {
        const { adapter } = lidarr({ '/api/v1/artist/101': { ...ARTIST, monitored: false } });
        const { structuredContent } = await updateMedia([adapter])({ service: 'lidarr', id: '101', monitored: true });
        expect(structuredContent.effects.join(' ')).toContain('grabs automatically for <<untrusted');
        expect(structuredContent.effects.join(' ')).toContain('for the albums that are monitored');
        expect(structuredContent.effects.join(' ')).not.toContain('again');
    });

    it('names the artist in the remedy for a series option', async () => {
        await expect(updateMedia([lidarr().adapter])({ service: 'lidarr', id: '101', series_type: 'anime' })).rejects.toThrow(
            /An artist has no numbering scheme/
        );
    });

    it('names albums in the remedy for minimum_availability, refuses a book field as unknown, and names artists in the no-update remedy', async () => {
        const call = updateMedia([lidarr().adapter]);
        await expect(call({ service: 'lidarr', id: '101', minimum_availability: 'released' })).rejects.toThrow(
            'Lidarr has no availability threshold. Use set_monitoring to choose which albums.'
        );
        expect(() => call({ service: 'lidarr', id: '101', title: 'x' })).toThrow(/Unknown argument\(s\): title/);

        const notFound = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
        const whisparr = updateMedia([new WhisparrAdapter(config(6969), notFound)]);
        await expect(whisparr({ service: 'whisparr', id: '1', monitored: false })).rejects.toThrow(
            'Radarr manages films, Sonarr series and Lidarr artists.'
        );
    });

    it('is a no-op when the artist is already monitored, and sends quality profile and tags through the tool', async () => {
        expect((await updateMedia([lidarr().adapter])({ service: 'lidarr', id: '101', monitored: true })).structuredContent.noop).toBe(true);

        const { adapter, sent } = lidarr();
        const call = updateMedia([adapter]);
        const args = { service: 'lidarr', id: '101', quality_profile: 'Quality profile 11', tags: ['tag-1'] };
        const first = await call(args);
        await call({ ...args, confirm: first.structuredContent.confirm_token });
        expect(sent.find(s => s.method === 'PUT')?.body).toEqual({
            artistIds: [101],
            qualityProfileId: 11,
            tags: [1],
            applyTags: 'replace',
            moveFiles: false
        });
    });

    it('refuses metadata_profile on a service that has none', async () => {
        const notFound = (async () => new Response(JSON.stringify({ message: 'not found' }), { status: 404 })) as unknown as typeof fetch;
        await expect(
            updateMedia([new RadarrAdapter(config(7878), notFound)])({ service: 'radarr', id: '5', metadata_profile: 'Standard' })
        ).rejects.toThrow(/metadata_profile is a Lidarr option/);
    });
});
