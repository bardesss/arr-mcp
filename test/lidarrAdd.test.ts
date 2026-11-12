import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { unfenced } from '../src/core/titleMatch.ts';
import { LidarrAdapter } from '../src/services/lidarr.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { hasMediaAdd, hasMetadataProfiles, type ServiceAdapter } from '../src/services/types.ts';
import { registerAddMedia } from '../src/tools/addMedia.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { buildSearchMedia } from '../src/tools/searchMedia.ts';
import { buildInstanceOptions } from '../src/tools/instanceOptions.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { instancesOf } from './helpers/instances.ts';

/**
 * Adding a Lidarr artist, and the lookup it adds from. `artist-lookup-mbid.json`
 * (an exact-id lookup) and `artist-add.json` (the add's response) were captured
 * on a Lidarr 3.1.6.5079 test instance and anonymised: placeholder name,
 * genre, overview and links, a synthetic MusicBrainz id, no images, invented
 * ids and paths, zero ratings and statistics, and fixed dates. The monitoring
 * fields are as captured. `rootfolder.json` and `metadataprofile.json` are
 * the committed upstream captures.
 */

const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/lidarr', `${name}.json`), 'utf8')) as unknown;

const LOOKUP = fixture('artist-lookup-mbid') as Record<string, unknown>[];
const CREATED = fixture('artist-add') as Record<string, unknown>;
const ROOTS = fixture('rootfolder') as Record<string, unknown>[];
const METADATA = fixture('metadataprofile') as Record<string, unknown>[];
const MBID = '00000000-0000-4000-8000-000000000101';
const QUALITY = [
    { id: 1, name: 'Quality profile 1' },
    { id: 2, name: 'Quality profile 2' }
];

const config = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

type Sent = { method: string; path: string; search: string; body: Record<string, unknown> | undefined };

function lidarr(routes: Record<string, unknown> = {}) {
    const all: Record<string, unknown> = {
        '/api/v1/artist/lookup': LOOKUP,
        '/api/v1/artist': CREATED,
        '/api/v1/qualityprofile': QUALITY,
        '/api/v1/rootfolder': ROOTS,
        '/api/v1/metadataprofile': METADATA,
        '/api/v1/tag': [],
        ...routes
    };
    const sent: Sent[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        sent.push({
            method: init?.method ?? 'GET',
            path: url.pathname,
            search: url.search,
            body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
        });
        if (!(url.pathname in all)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
        return new Response(JSON.stringify(all[url.pathname]), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { adapter: new LidarrAdapter(config(8686), impl), sent };
}

describe('LidarrAdapter adding an artist', () => {
    it('claims adding and metadata profiles', () => {
        const { adapter } = lidarr();
        expect(hasMediaAdd(adapter)).toBe(true);
        expect(hasMetadataProfiles(adapter)).toBe(true);
    });

    it('looks the artist up by its exact MusicBrainz id', async () => {
        const { adapter, sent } = lidarr();
        const candidate = await adapter.lookupForAdd(MBID);

        expect(sent.map(s => `${s.path}${s.search}`)).toEqual([`/api/v1/artist/lookup?term=lidarr:${MBID}`]);
        expect(unfenced(candidate.title)).toBe('Artist 1');
        expect(candidate.existingId).toBeUndefined();
    });

    it('reports an artist already in the library by its id', async () => {
        const { adapter } = lidarr({ '/api/v1/artist/lookup': [{ ...LOOKUP[0], id: 101 }] });
        expect((await adapter.lookupForAdd(MBID)).existingId).toBe(101);
    });

    // `ArtistRepository.FindById` also matches an id the artist used to have,
    // and answers with the artist under its current one.
    it('reports an artist already there under an id it used to have', async () => {
        const merged = { ...LOOKUP[0], id: 101, foreignArtistId: '00000000-0000-4000-8000-000000000102' };
        const { adapter } = lidarr({ '/api/v1/artist/lookup': [merged] });
        expect((await adapter.lookupForAdd(MBID)).existingId).toBe(101);
        await expect(
            adapter.addMedia({ externalId: MBID, qualityProfileId: 2, metadataProfileId: 1, rootFolderPath: '/music/', monitored: true, searchNow: false })
        ).rejects.toThrow(/already in lidarr/);
    });

    it('skips a lookup row that is not an object', async () => {
        const { adapter } = lidarr({ '/api/v1/artist/lookup': [null, 7, LOOKUP[0]] });
        expect((await adapter.search('artist', 'discover')).map(h => h.id)).toEqual([MBID]);
        const empty = lidarr({ '/api/v1/artist/lookup': [null] }).adapter;
        await expect(empty.lookupForAdd(MBID)).rejects.toThrow(/matched nothing/);
    });

    it('refuses an id that is not a GUID before any request', async () => {
        const { adapter, sent } = lidarr();
        await expect(adapter.lookupForAdd('12345')).rejects.toThrow(/is not a MusicBrainz artist id/);
        expect(sent).toHaveLength(0);
    });

    it('refuses an answer for a different artist, or none', async () => {
        await expect(lidarr({ '/api/v1/artist/lookup': [] }).adapter.lookupForAdd(MBID)).rejects.toThrow(/matched nothing/);
        const other = [{ ...LOOKUP[0], foreignArtistId: '00000000-0000-4000-8000-000000000102' }];
        await expect(lidarr({ '/api/v1/artist/lookup': other }).adapter.lookupForAdd(MBID)).rejects.toThrow(/matched nothing/);
    });

    it('posts the lookup back with the chosen profiles, folder and monitoring, without its id or path', async () => {
        const { adapter, sent } = lidarr({ '/api/v1/artist/lookup': [{ ...LOOKUP[0], id: 0, path: '/music/Artist 1' }] });
        const added = await adapter.addMedia({
            externalId: MBID,
            qualityProfileId: 2,
            metadataProfileId: 1,
            rootFolderPath: '/music/',
            monitored: true,
            searchNow: false,
            monitor: 'latest',
            monitorNewItems: 'none',
            tagIds: [3]
        });

        const post = sent.find(s => s.method === 'POST');
        expect(post?.path).toBe('/api/v1/artist');
        expect(post?.body).toMatchObject({
            foreignArtistId: MBID,
            qualityProfileId: 2,
            metadataProfileId: 1,
            rootFolderPath: '/music/',
            monitored: true,
            monitorNewItems: 'none',
            tags: [3],
            addOptions: { monitor: 'latest', searchForMissingAlbums: false }
        });
        expect(post?.body).not.toHaveProperty('id');
        expect(post?.body).not.toHaveProperty('path');
        expect(added.id).toBe(101);
        expect(unfenced(added.title)).toBe('Artist 1');
    });

    it('refuses an add with no metadata profile, which Lidarr requires', async () => {
        const { adapter, sent } = lidarr();
        await expect(
            adapter.addMedia({ externalId: MBID, qualityProfileId: 2, rootFolderPath: '/music/', monitored: true, searchNow: false })
        ).rejects.toThrow(/needs a metadata profile/);
        expect(sent).toHaveLength(0);
    });

    it('refuses to add an artist that arrived since the preview', async () => {
        const { adapter, sent } = lidarr({ '/api/v1/artist/lookup': [{ ...LOOKUP[0], id: 101 }] });
        await expect(
            adapter.addMedia({ externalId: MBID, qualityProfileId: 2, metadataProfileId: 1, rootFolderPath: '/music/', monitored: true, searchNow: false })
        ).rejects.toThrow(/already in lidarr/);
        expect(sent.some(s => s.method === 'POST')).toBe(false);
    });

    it('reads the root folder\'s default metadata profile and the metadata profiles', async () => {
        const { adapter } = lidarr();
        const [folder] = await adapter.listRootFolders();
        const profiles = await adapter.listMetadataProfiles();

        expect(folder?.defaultMetadataProfileId).toBe(1);
        expect(profiles.map(p => [p.id, p.name])).toEqual([
            [1, 'Standard'],
            [2, 'None']
        ]);
    });

    it('treats a default of 0 as none', async () => {
        const { adapter } = lidarr({ '/api/v1/rootfolder': [{ ...ROOTS[0], defaultMetadataProfileId: 0 }] });
        const [folder] = await adapter.listRootFolders();
        expect(folder).not.toHaveProperty('defaultMetadataProfileId');
    });

    // `search_media` discover advertises `imdb:tt…` for films. Lidarr would run it as
    // text and answer an artist called "imdb".
    it('answers nothing, without asking, for another service\'s id', async () => {
        const { adapter, sent } = lidarr();
        for (const query of ['imdb:tt0000001', 'tmdb:1', 'TVDB:1']) {
            expect(await adapter.search(query, 'discover')).toEqual([]);
        }
        expect(sent).toHaveLength(0);
    });

    // `get_instance_options` lists every instance that can add, which takes in
    // Lidarr: these are the names `add_media` insists on.
    it('shows up in get_instance_options', async () => {
        const { adapter } = lidarr({ '/api/v1/system/status': { version: '3.1.6.5079' } });
        const result = await buildInstanceOptions([adapter], {}, () => {});

        expect(result.map(o => [o.instance, o.qualityProfiles.map(p => p.id), o.rootFolders.length])).toEqual([['lidarr', [1, 2], 1]]);
    });

    it('answers search_media discover with artists to add, keyed by MusicBrainz id', async () => {
        // As Lidarr 2.1.3 sends an artist already in the library: all-zero statistics.
        const inLibrary = { ...LOOKUP[0], id: 102, foreignArtistId: '00000000-0000-4000-8000-000000000102', monitored: true, statistics: { trackFileCount: 0 } };
        const { adapter, sent } = lidarr({ '/api/v1/artist/lookup': [LOOKUP[0], inLibrary] });
        const result = await buildSearchMedia([adapter], { source: 'discover', query: 'artist', detail: 'full', limit: 10 });

        expect(sent.map(s => `${s.path}${s.search}`)).toEqual(['/api/v1/artist/lookup?term=artist']);
        expect(result.items.map(h => [h.kind, h.id, h.ids.mbid])).toEqual([
            ['artist', MBID, MBID],
            ['artist', '102', '00000000-0000-4000-8000-000000000102']
        ]);
        expect(result.items[0]).not.toHaveProperty('monitored');
        expect(result.items[1]).toMatchObject({ monitored: true });
        // The lookup's statistics are not the library's, so it says nothing about files.
        expect(result.items[1]).not.toHaveProperty('hasFile');
    });
});

type Call = (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; structuredContent: WriteToolResult }>;

const permissive = (port: number): AnyServiceConfig =>
    ({ ...config(port), permissions: { safe_write: true, destructive: false } }) as AnyServiceConfig;

function addMedia(adapters: ServiceAdapter[]) {
    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, c: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(c.inputSchema.parse(args) as Record<string, unknown>);
        }
    };
    const services: Partial<Record<ServiceId, AnyServiceConfig>> = { lidarr: permissive(8686), radarr: permissive(7878), sonarr: permissive(8989) };
    registerAddMedia(
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

const base = { service: 'lidarr', external_id: MBID, quality_profile: '2', search_now: false };

describe('add_media on Lidarr', () => {
    it('uses the root folder\'s default metadata profile, says so, and posts it', async () => {
        const { adapter, sent } = lidarr();
        const call = addMedia([adapter]);
        const first = await call(base);

        expect(first.structuredContent.effects.join(' ')).toContain('metadata profile');
        expect(first.structuredContent.effects.join(' ')).toContain("the root folder's default");

        await call({ ...base, confirm: first.structuredContent.confirm_token });
        expect(sent.find(s => s.method === 'POST')?.body).toMatchObject({ metadataProfileId: 1, qualityProfileId: 2 });
    });

    it('takes a named metadata profile over the default', async () => {
        const { adapter, sent } = lidarr();
        const call = addMedia([adapter]);
        const first = await call({ ...base, metadata_profile: 'None' });
        await call({ ...base, metadata_profile: 'None', confirm: first.structuredContent.confirm_token });

        expect(sent.find(s => s.method === 'POST')?.body).toMatchObject({ metadataProfileId: 2 });
    });

    it('refuses, listing them, when there is no default and several profiles', async () => {
        const { adapter } = lidarr({
            '/api/v1/rootfolder': [{ ...ROOTS[0], defaultMetadataProfileId: 0 }],
            '/api/v1/metadataprofile': [...METADATA, { id: 3, name: 'Metadata profile 3' }]
        });
        await expect(addMedia([adapter])(base)).rejects.toThrow(/several metadata profiles and none was named/);
    });

    // Every Lidarr has the reserved `None` profile, which gives an artist no
    // albums (`MetadataProfileService`, `SkyHookProxy.FilterAlbums`).
    it('leaves the reserved None profile out unless it is named', async () => {
        const noDefault = { '/api/v1/rootfolder': [{ ...ROOTS[0], defaultMetadataProfileId: 0 }] };
        const { adapter } = lidarr(noDefault);
        const chosen = (await addMedia([adapter])({ ...base, search_now: true })).structuredContent.effects.join(' ');
        expect(chosen).toMatch(/metadata profile .*Standard.* \(id 1\)\./);
        expect(chosen).not.toContain('no albums');

        const onlyNone = lidarr({ ...noDefault, '/api/v1/metadataprofile': METADATA.filter(p => p.name === 'None') }).adapter;
        await expect(addMedia([onlyNone])(base)).rejects.toThrow(/has only its reserved None metadata profile, which gives an artist no albums/);

        const named = (await addMedia([adapter])({ ...base, search_now: true, metadata_profile: 'None' })).structuredContent.effects.join(' ');
        expect(named).toMatch(/metadata profile .*None.* \(id 2\), which gives the artist no albums\./);
        expect(named).toContain('The None metadata profile gives the artist no albums, so nothing is searched.');
        expect(named).not.toContain('Starts searching');

        // No line about which albums are monitored, since there are none.
        const noAlbums = (
            await addMedia([adapter])({ ...base, metadata_profile: 'None', monitor: 'first', monitor_new_items: 'new' })
        ).structuredContent.effects.join(' ');
        expect(noAlbums).not.toContain('"first" set of albums');
        // Albums from a later profile change are flagged by the rule, and `new`
        // has nothing to compare with, so every one is monitored.
        expect(noAlbums).toContain('If its metadata profile changes later, every album that brings is monitored: `new` compares with the albums it already has, and it has none.');
        expect(noAlbums).not.toContain('Albums Lidarr discovers later');
        const said = async (rule: string) =>
            (await addMedia([adapter])({ ...base, metadata_profile: 'None', monitor_new_items: rule })).structuredContent.effects.join(' ');
        // Up to 3.2.0.5144 every released album is searched; later builds only those from the last 180 days.
        const all = await said('all');
        expect(all).toContain('every album that brings is monitored (`all`). Lidarr then searches the released ones while the artist is monitored');
        expect(all).toContain('in Lidarr newer than 3.2.0.5144, only those released in the last 180 days; older ones wait for RSS sync or trigger_search');
        expect(all).toContain("at its next disk scan when Lidarr's 'Rescan Artist Folder after Refresh' setting skips that rescan");
        expect(await said('none')).toContain('the albums that brings are not monitored (`none`).');
        expect(noAlbums).not.toContain('it is added with');
        expect(noAlbums).toContain('The None metadata profile gives the artist no albums, so nothing is searched.');
        expect(noAlbums).not.toContain('Use trigger_search');
        const unmonitoredNone = (await addMedia([adapter])({ ...base, metadata_profile: 'None', monitored: false })).structuredContent.effects.join(' ');
        // Monitoring it alone grabs nothing either, so no "until you monitor it".
        expect(unmonitoredNone).toContain(
            'Adds it unmonitored, and the None metadata profile gives it no albums, so monitoring it alone grabs nothing: it needs monitored albums first, from another metadata profile or an album added in Lidarr.'
        );
        expect(unmonitoredNone).not.toContain('until you monitor it');
        expect(unmonitoredNone).not.toContain('trigger_search');

        const monitoredNone = (await addMedia([adapter])({ ...base, metadata_profile: 'None' })).structuredContent.effects.join(' ');
        expect(monitoredNone).toContain(
            'Monitors the artist, but the None metadata profile gives it no albums, so nothing is grabbed until it has monitored ones, from another metadata profile or an album added in Lidarr.'
        );
        expect(monitoredNone).not.toContain('grabs its monitored albums');

        const folderNone = lidarr({ '/api/v1/rootfolder': [{ ...ROOTS[0], defaultMetadataProfileId: 2 }] }).adapter;
        expect((await addMedia([folderNone])(base)).structuredContent.effects.join(' ')).toContain(
            "(id 2), the root folder's default, which gives the artist no albums."
        );
    });

    it('uses the only metadata profile when there is just one', async () => {
        const { adapter } = lidarr({
            '/api/v1/rootfolder': [{ ...ROOTS[0], defaultMetadataProfileId: 0 }],
            '/api/v1/metadataprofile': [METADATA[0]]
        });
        const { structuredContent } = await addMedia([adapter])(base);
        expect(structuredContent.effects.join(' ')).toMatch(/metadata profile .*\(id 1\)/);
        expect(structuredContent.effects.join(' ')).not.toContain("the root folder's default");
    });

    it('passes monitor and monitor_new_items through to the add', async () => {
        const { adapter, sent } = lidarr();
        const call = addMedia([adapter]);
        const args = { ...base, monitor: 'first', monitor_new_items: 'new' };
        const first = await call(args);
        expect(first.structuredContent.effects.join(' ')).toContain('"first" set of albums');
        await call({ ...args, confirm: first.structuredContent.confirm_token });

        expect(sent.find(s => s.method === 'POST')?.body).toMatchObject({ monitorNewItems: 'new', addOptions: { monitor: 'first' } });
    });

    it('says what each new-album rule will do', async () => {
        const said = async (rule: string) =>
            (await addMedia([lidarr().adapter])({ ...base, monitor_new_items: rule })).structuredContent.effects.join(' ');

        expect(await said('all')).toContain('Albums Lidarr discovers later are monitored.');
        expect(await said('new')).toContain('only when released on or after the newest album it already has');
        expect(await said('none')).toContain('Albums Lidarr discovers later are not monitored.');
    });

    // Lidarr's search on add is `MissingAlbumSearchCommand`: monitored albums of
    // a monitored artist, released, with a track missing. RSS sync reads the
    // artist's flag, but a search started by hand does not.
    it('says what the search on add looks for, and that an unmonitored artist is still searchable by hand', async () => {
        const said = async (args: Record<string, unknown>) =>
            (await addMedia([lidarr().adapter])({ ...base, search_now: true, ...args })).structuredContent.effects.join(' ');

        const monitored = await said({});
        expect(monitored).toContain('Starts searching for its monitored albums that are already released and missing a track');
        expect(monitored).toContain('Monitors the artist, so Lidarr grabs its monitored albums when a matching release appears.');
        expect(monitored).not.toContain('Monitors it, so it will be grabbed');

        const unmonitored = await said({ monitored: false });
        expect(unmonitored).toContain("Lidarr's RSS sync and its own automatic searches grab nothing for it until you monitor it");
        expect(unmonitored).toContain(
            "A search started with trigger_search skips that check, so it can still grab the artist's monitored albums, or any album it names."
        );
        expect(unmonitored).toContain("Lidarr's search on add skips an unmonitored artist, so nothing is searched yet.");
        expect(unmonitored).not.toContain('Starts searching');
        expect(unmonitored).not.toContain('nothing will be grabbed until you monitor it');

        expect(await said({ monitored: false, monitor: 'none' })).toContain('so nothing is searched yet');
        const future = await said({ monitor: 'future' });
        expect(future).toContain('`future` monitors none of those, so nothing is searched yet.');
        expect(future).not.toContain('Starts searching');

        expect(await said({ search_now: false })).toContain('Does not search yet.');
    });

    // The first refresh flags every album by `monitorNewItems`; `monitor`
    // then overrides that, but `future`, `missing` and `existing` only for
    // released albums.
    it('says the rule for new albums also sets the albums an artist is added with', async () => {
        const said = async (args: Record<string, unknown>) =>
            (await addMedia([lidarr().adapter])({ ...base, search_now: true, ...args })).structuredContent.effects.join(' ');

        const none = await said({ monitor_new_items: 'none' });
        expect(none).toContain('Monitors none of its albums: with no `monitor`');
        expect(none).toContain('none is monitored, so nothing is searched yet.');
        expect(none).not.toContain('Starts searching');

        expect(await said({ monitor_new_items: 'new' })).toContain('Monitors every album it is added with');
        expect(await said({ monitor: 'missing', monitor_new_items: 'none' })).toContain(
            'An album with no files that is not yet released or has no release date starts unmonitored, by the `none` rule: `missing` sets only albums with files and released ones.'
        );
        const futureNone = await said({ monitor: 'future', monitor_new_items: 'none' });
        expect(futureNone).toContain('Monitors no album, now or later');
        expect(futureNone).not.toContain('"future" set of albums');
        // Left out, the rule is `all`, so an unreleased album stays monitored.
        expect(await said({ monitor: 'existing' })).toContain(
            'An album with no files that is not yet released or has no release date stays monitored, by the `all` rule: `existing` sets only albums with files and released ones.'
        );
        expect(await said({ monitor: 'future' })).toContain('"future" set of albums');

        for (const args of [{}, { monitor_new_items: 'all' }, { monitor: 'first', monitor_new_items: 'none' }, { monitor: 'all', monitor_new_items: 'new' }]) {
            const text = await said(args);
            expect(text).not.toContain('it is added with');
            expect(text).not.toContain('starts unmonitored');
            expect(text).not.toContain('Monitors no album, now or later');
            expect(text).not.toContain('stays monitored');
            expect(text).toContain('Starts searching');
        }
    });

    it('says the artist may have been added when Lidarr answers without an id', async () => {
        const { adapter } = lidarr({ '/api/v1/artist': {} });
        await expect(
            adapter.addMedia({ externalId: MBID, qualityProfileId: 2, metadataProfileId: 1, rootFolderPath: '/music/', monitored: true, searchNow: false })
        ).rejects.toThrow(/returned no id.*may still have been added/);
    });

    // Lidarr's add turns `none` into an unmonitored artist too, against the
    // default `monitored: true`.
    it('refuses monitor "none" unless monitored: false is given with it', async () => {
        const { adapter, sent } = lidarr();
        await expect(addMedia([adapter])({ ...base, monitor: 'none' })).rejects.toThrow(/adds the artist itself unmonitored/);
        expect(sent).toHaveLength(0);

        const allowed = lidarr();
        const call = addMedia([allowed.adapter]);
        const args = { ...base, monitor: 'none', monitored: false };
        const first = await call(args);
        await call({ ...args, confirm: first.structuredContent.confirm_token });
        expect(allowed.sent.find(s => s.method === 'POST')?.body).toMatchObject({ monitored: false, addOptions: { monitor: 'none' } });
    });

    it('refuses the season-based monitor modes on Lidarr', async () => {
        for (const monitor of ['firstSeason', 'lastSeason', 'pilot']) {
            await expect(addMedia([lidarr().adapter])({ ...base, monitor })).rejects.toThrow(/is not a Lidarr monitor mode/);
        }
    });

    it('refuses a non-GUID external id before any request', async () => {
        const { adapter, sent } = lidarr();
        await expect(addMedia([adapter])({ ...base, external_id: '12345' })).rejects.toThrow(/is not a MusicBrainz artist id/);
        expect(sent).toHaveLength(0);
    });

    it('names the artist in the remedy for a series option', async () => {
        await expect(addMedia([lidarr().adapter])({ ...base, series_type: 'anime' })).rejects.toThrow(/An artist has no numbering scheme/);
    });
});

describe('add_media keeps Lidarr\'s options on Lidarr', () => {
    const notFound = (async () => new Response(JSON.stringify({ message: 'not found' }), { status: 404 })) as unknown as typeof fetch;
    const radarr = () => new RadarrAdapter(config(7878), notFound);
    const film = { service: 'radarr', external_id: '603', quality_profile: '4' };

    it('refuses metadata_profile and monitor_new_items elsewhere', async () => {
        await expect(addMedia([radarr()])({ ...film, metadata_profile: 'Standard' })).rejects.toThrow(/metadata_profile is a Lidarr option/);
        await expect(addMedia([radarr()])({ ...film, monitor_new_items: 'none' })).rejects.toThrow(/monitor_new_items is a Lidarr option/);
    });

    it('refuses first and latest elsewhere, with a remedy that fits the service', async () => {
        const sonarr = new SonarrAdapter({ ...config(8989) }, notFound);
        await expect(addMedia([sonarr])({ service: 'sonarr', external_id: '101', quality_profile: '4', monitor: 'latest' })).rejects.toThrow(
            /latest is a Lidarr monitor mode.*firstSeason/
        );
        await expect(addMedia([radarr()])({ ...film, monitor: 'latest' })).rejects.toThrow(/monitor mode is a Sonarr, Whisparr or Lidarr option.*Films have no seasons/);
    });

    // `Number()` reads all three as integers.
    it('refuses an external id that is not a plain integer', async () => {
        for (const external_id of ['1e2', '0x10', ' 603']) {
            await expect(addMedia([radarr()])({ ...film, external_id })).rejects.toThrow(/is not a tmdb id/);
        }
    });
});
