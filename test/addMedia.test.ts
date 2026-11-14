import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ServiceInstance } from '../src/config/instances.ts';
import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, ConfigByService, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { ShelfmarkAdapter } from '../src/services/shelfmark.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { WhisparrAdapter } from '../src/services/whisparr.ts';
import { registerAddMedia } from '../src/tools/addMedia.ts';
import { registerGrabRelease } from '../src/tools/grabRelease.ts';
import type { CrossChecker } from '../src/tools/crossChecks.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { jsonResponse } from './helpers/serve.ts';

const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const tiered = (safe_write: boolean, destructive = false): ConfigByService['radarr'] =>
    ({ ...keyed(7878), permissions: { safe_write, destructive } }) as ConfigByService['radarr'];

const ONE_PROFILE = [{ id: 4, name: 'HD-1080p' }];
const MANY_PROFILES = [
    { id: 4, name: 'HD-1080p' },
    { id: 5, name: 'Ultra-HD' }
];
const ONE_FOLDER = [{ path: '/movies', freeSpace: 2_000_000_000_000 }];
const MANY_FOLDERS = [
    { path: '/movies', freeSpace: 2_000_000_000_000 },
    { path: '/movies-4k', freeSpace: 500_000_000_000 }
];

const TAGS = [
    { id: 1, label: '4k' },
    { id: 2, label: 'kids' }
];

/** `id: 0` is what both services report for something not in the library. */
const NEW_MOVIE = [{ id: 0, title: 'The Matrix', year: 1999, tmdbId: 603 }];
const EXISTING_MOVIE = [{ id: 88, title: 'The Matrix', year: 1999, tmdbId: 603 }];

function stack(
    opts: {
        profiles?: unknown;
        folders?: unknown;
        lookup?: unknown;
        created?: unknown;
        tags?: unknown;
        resource?: 'movie' | 'series';
    } = {}
) {
    const sent: { path: string; search: string; method: string; body: Record<string, unknown> | undefined }[] = [];
    const resource = opts.resource ?? 'movie';

    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        sent.push({
            path: url.pathname,
            search: url.search,
            method,
            body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
        });

        if (url.pathname === '/api/v3/qualityprofile') return jsonResponse(opts.profiles ?? ONE_PROFILE);
        if (url.pathname === '/api/v3/rootfolder') return jsonResponse(opts.folders ?? ONE_FOLDER);
        if (url.pathname === '/api/v3/tag') return jsonResponse(opts.tags ?? TAGS);

        // Both services answer the term search with an array — including an
        // empty one for an id that resolves to nothing, which is exactly why
        // the term form is preferred over Radarr's by-id endpoint (that one
        // answers 500). Verified against a live Radarr 6.3.0.
        if (url.pathname === `/api/v3/${resource}/lookup`) return jsonResponse(opts.lookup ?? NEW_MOVIE);
        if (url.pathname === '/api/v3/movie/lookup/tmdb') {
            throw new Error('the dedicated by-id endpoint must not be used — it 500s on an unknown id');
        }
        if (url.pathname === `/api/v3/${resource}` && method === 'POST') {
            return jsonResponse(opts.created ?? { id: 91, title: 'The Matrix' });
        }
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    return { impl, sent };
}

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(
    opts: Parameters<typeof stack>[0] & {
        permissions?: Partial<Record<ServiceId, AnyServiceConfig>>;
        /** Named instances, for the tests that are about which instance a write hits. */
        instances?: ServiceInstance[];
        adapters?: ServiceAdapter[];
        crossChecks?: CrossChecker;
    } = {}
) {
    const s = stack(opts);
    const adapters = opts.adapters ?? [new RadarrAdapter(keyed(7878), s.impl)];

    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    const invalidate = vi.fn();
    const audit = WriteAudit.ephemeral();
    registerAddMedia(
        server as never,
        {
            permissions: permissionSourceFrom(
                opts.instances ?? instancesOf(opts.permissions ?? { radarr: tiered(true), sonarr: tiered(true) })
            ),
            confirm: new ConfirmTokens(),
            audit,
            library: { invalidate } as unknown as LibraryLoader,
            ...(opts.crossChecks === undefined ? {} : { crossChecks: opts.crossChecks })
        },
        adapters
    );

    return { call: (a: Record<string, unknown>) => call(a), sent: s.sent, audit, invalidate };
}

const posted = (h: ReturnType<typeof harness>) => h.sent.find(x => x.method === 'POST')?.body;

describe('add_media previews', () => {
    it('names the film, the folder and the profile', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ service: 'radarr', external_id: '603', dry_run: true });

        expect(structuredContent.summary).toContain('The Matrix');
        expect(structuredContent.summary).toContain('1999');
        expect(structuredContent.effects.join(' ')).toContain('HD-1080p');
        expect(structuredContent.effects.join(' ')).toContain('/movies');
    });

    it('reports free space, because that is what a bad root folder costs', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ service: 'radarr', external_id: '603', dry_run: true });
        expect(structuredContent.effects.join(' ')).toContain('GB free');
    });

    // "Add" reads much cheaper than it is.
    it('says a search will start', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ service: 'radarr', external_id: '603', dry_run: true });
        expect(structuredContent.effects.join(' ')).toContain('disk space and bandwidth');
    });

    it('says nothing will download when search_now is false', async () => {
        const h = harness();
        const { structuredContent } = await h.call({
            service: 'radarr',
            external_id: '603',
            search_now: false,
            dry_run: true
        });
        expect(structuredContent.effects.join(' ')).toContain('Does not search yet');
    });

    it('adds nothing on a dry run', async () => {
        const h = harness();
        await h.call({ service: 'radarr', external_id: '603', dry_run: true });
        expect(h.sent.filter(s => s.method === 'POST')).toHaveLength(0);
    });
});

describe('add_media choosing a profile and folder', () => {
    it('uses the only profile and folder without asking', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ service: 'radarr', external_id: '603', dry_run: true });
        expect(structuredContent.effects.join(' ')).toContain('HD-1080p');
    });

    // Picking the first of several would be a guess presented as a decision.
    it('refuses to guess between several profiles, and lists them', async () => {
        const h = harness({ profiles: MANY_PROFILES });
        await expect(h.call({ service: 'radarr', external_id: '603', dry_run: true })).rejects.toThrow(
            /HD-1080p.*Ultra-HD|Ultra-HD.*HD-1080p/
        );
    });

    it('refuses to guess between several root folders, and lists them', async () => {
        const h = harness({ folders: MANY_FOLDERS });
        await expect(h.call({ service: 'radarr', external_id: '603', dry_run: true })).rejects.toThrow(
            /movies-4k/
        );
    });

    it('accepts a profile by name, case-insensitively', async () => {
        const h = harness({ profiles: MANY_PROFILES });
        const { structuredContent } = await h.call({
            service: 'radarr',
            external_id: '603',
            quality_profile: 'ultra-hd',
            root_folder: '/movies',
            dry_run: true
        });
        expect(structuredContent.effects.join(' ')).toContain('Ultra-HD');
    });

    /**
     * The live regression, and the most expensive bug in this phase.
     *
     * Asking for profile id 8 selected HD-1080p (id 4), because the old
     * predicate let the name branch fire on a digit — "hd-1080p" contains "8".
     * A real film was added and a 1080p release grabbed against an explicit
     * request for 2160p, with the preview stating the wrong profile in prose
     * that read entirely plausible.
     */
    it('treats a numeric request as an id only, never as part of a name', async () => {
        const h = harness({
            profiles: [
                { id: 4, name: 'HD-1080p' },
                { id: 8, name: '2160p Balanced' }
            ]
        });

        const { structuredContent } = await h.call({
            service: 'radarr',
            external_id: '603',
            quality_profile: '8',
            dry_run: true
        });

        expect(structuredContent.effects.join(' ')).toContain('2160p Balanced');
        expect(structuredContent.effects.join(' ')).not.toContain('HD-1080p');
    });

    // "2160p Balanced" is a prefix of "2160p Balanced NL".
    it('refuses an ambiguous name rather than taking whichever comes first', async () => {
        const h = harness({
            profiles: [
                { id: 8, name: '2160p Balanced' },
                { id: 12, name: '2160p Balanced NL' }
            ]
        });

        await expect(
            h.call({ service: 'radarr', external_id: '603', quality_profile: 'Balanced', dry_run: true })
        ).rejects.toThrow(/matches more than one/);
    });

    it('lets an exact name win over an option that merely contains it', async () => {
        const h = harness({
            profiles: [
                { id: 8, name: '2160p Balanced' },
                { id: 12, name: '2160p Balanced NL' }
            ]
        });

        const { structuredContent } = await h.call({
            service: 'radarr',
            external_id: '603',
            quality_profile: '2160p Balanced',
            dry_run: true
        });

        const effects = structuredContent.effects.join(' ');
        expect(effects).toContain('2160p Balanced');
        expect(effects).not.toContain('NL');
    });

    it('accepts a profile by id', async () => {
        const h = harness({ profiles: MANY_PROFILES });
        const { structuredContent } = await h.call({
            service: 'radarr',
            external_id: '603',
            quality_profile: '5',
            root_folder: '/movies',
            dry_run: true
        });
        expect(structuredContent.effects.join(' ')).toContain('Ultra-HD');
    });

    it('lists the options when the named profile does not exist', async () => {
        const h = harness({ profiles: MANY_PROFILES });
        await expect(
            h.call({ service: 'radarr', external_id: '603', quality_profile: 'SD', dry_run: true })
        ).rejects.toThrow(/Available:/);
    });

    it('says so when the service has no profiles at all', async () => {
        const h = harness({ profiles: [] });
        await expect(h.call({ service: 'radarr', external_id: '603', dry_run: true })).rejects.toThrow(
            /no quality profile configured/
        );
    });
});

describe('add_media applying', () => {
    it('adds nothing until confirmed, then posts', async () => {
        const h = harness();
        const first = await h.call({ service: 'radarr', external_id: '603' });
        expect(h.sent.filter(s => s.method === 'POST')).toHaveLength(0);

        const second = await h.call({
            service: 'radarr',
            external_id: '603',
            confirm: first.structuredContent.confirm_token
        });

        expect(second.structuredContent.applied).toBe(true);
        expect(second.structuredContent.result).toEqual({ id: 91, title: expect.stringContaining('The Matrix') });
        expect(h.invalidate).toHaveBeenCalledTimes(1);
    });

    it('posts the resolved profile, folder and search flag', async () => {
        const h = harness();
        const first = await h.call({ service: 'radarr', external_id: '603' });
        await h.call({ service: 'radarr', external_id: '603', confirm: first.structuredContent.confirm_token });

        const body = posted(h);
        expect(body).toMatchObject({
            tmdbId: 603,
            qualityProfileId: 4,
            rootFolderPath: '/movies',
            monitored: true,
            addOptions: { searchForMovie: true }
        });
    });

    // A fenced path is not a directory.
    it('posts the raw root folder path, never the fenced display form', async () => {
        const h = harness();
        const first = await h.call({ service: 'radarr', external_id: '603' });
        await h.call({ service: 'radarr', external_id: '603', confirm: first.structuredContent.confirm_token });

        expect(posted(h)?.rootFolderPath).toBe('/movies');
        expect(JSON.stringify(posted(h))).not.toContain('untrusted');
    });

    it('sets minimumAvailability so a new film does not grab a cinema recording', async () => {
        const h = harness();
        const first = await h.call({ service: 'radarr', external_id: '603' });
        await h.call({ service: 'radarr', external_id: '603', confirm: first.structuredContent.confirm_token });
        expect(posted(h)?.minimumAvailability).toBe('released');
    });

    // The token commits to the resolved choices, not the requested strings.
    it('will not let a token previewed for one profile add with another', async () => {
        const h = harness({ profiles: MANY_PROFILES, folders: MANY_FOLDERS });
        const preview = await h.call({
            service: 'radarr',
            external_id: '603',
            quality_profile: 'HD-1080p',
            root_folder: '/movies'
        });

        const swapped = await h.call({
            service: 'radarr',
            external_id: '603',
            quality_profile: 'Ultra-HD',
            root_folder: '/movies-4k',
            confirm: preview.structuredContent.confirm_token
        });

        expect(swapped.structuredContent.applied).toBe(false);
        expect(h.sent.filter(s => s.method === 'POST')).toHaveLength(0);
    });

    it('is refused without safe_write', async () => {
        const h = harness({ permissions: { radarr: tiered(false) } });
        await expect(h.call({ service: 'radarr', external_id: '603' })).rejects.toThrow(
            /services\.radarr\.permissions\.safe_write: true/
        );
    });
});

describe('add_media when it is already there', () => {
    it('short-circuits rather than creating a duplicate', async () => {
        const h = harness({ lookup: EXISTING_MOVIE });
        const { structuredContent, content } = await h.call({ service: 'radarr', external_id: '603' });

        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.confirm_token).toBeUndefined();
        expect(content[0]?.text).toContain('already in radarr');
        expect(h.sent.filter(s => s.method === 'POST')).toHaveLength(0);
    });

    /**
     * The race: added between the preview and the confirmation.
     *
     * The harness re-runs `plan` on the confirming call, so this is caught
     * there and comes back as the same "already there" no-op rather than as an
     * error — which is the better outcome, and the reason `plan` is not
     * skipped once a token exists. The adapter's own guard (asserted below)
     * remains the backstop for a change landing inside a single call.
     */
    it('reports it as already there rather than duplicating, when it appears in between', async () => {
        let lookups = 0;
        const impl = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === '/api/v3/qualityprofile') return jsonResponse(ONE_PROFILE);
            if (url.pathname === '/api/v3/rootfolder') return jsonResponse(ONE_FOLDER);
            if (url.pathname === '/api/v3/movie/lookup') {
                lookups += 1;
                return jsonResponse(lookups === 1 ? NEW_MOVIE : EXISTING_MOVIE);
            }
            if ((init?.method ?? 'GET') === 'POST') return jsonResponse({ id: 91, title: 'The Matrix' });
            return jsonResponse({ message: 'not found' }, 404);
        }) as unknown as typeof fetch;

        const h = harness({ adapters: [new RadarrAdapter(keyed(7878), impl)] });
        const first = await h.call({ service: 'radarr', external_id: '603' });

        const second = await h.call({
            service: 'radarr',
            external_id: '603',
            confirm: first.structuredContent.confirm_token
        });

        expect(second.structuredContent.noop).toBe(true);
        expect(second.structuredContent.applied).toBe(false);
        expect(h.sent.filter(s => s.method === 'POST')).toHaveLength(0);
    });

    // The backstop, exercised directly: reachable only if the state changes
    // inside a single call, which the tool level cannot reproduce.
    it('the adapter itself refuses to post a duplicate', async () => {
        const s = stack({ lookup: EXISTING_MOVIE });
        const adapter = new RadarrAdapter(keyed(7878), s.impl);

        await expect(
            adapter.addMedia({
                externalId: '603',
                qualityProfileId: 4,
                rootFolderPath: '/movies',
                monitored: true,
                searchNow: true
            })
        ).rejects.toThrow(/already in radarr/);
        expect(s.sent.filter(x => x.method === 'POST')).toHaveLength(0);
    });
});

describe('add_media on Sonarr', () => {
    it('looks up and posts by tvdb id, with season folders', async () => {
        const s = stack({
            resource: 'series',
            lookup: [{ id: 0, title: 'Alien: Earth', year: 2025, tvdbId: 424207 }],
            created: { id: 12, title: 'Alien: Earth' }
        });
        const h = harness({ adapters: [new SonarrAdapter(keyed(8989), s.impl)] });

        const first = await h.call({ service: 'sonarr', external_id: '424207' });
        await h.call({ service: 'sonarr', external_id: '424207', confirm: first.structuredContent.confirm_token });

        const lookup = s.sent.find(x => x.path === '/api/v3/series/lookup');
        expect(lookup?.search).toContain('tvdb:424207');

        const body = s.sent.find(x => x.method === 'POST')?.body;
        expect(body).toMatchObject({
            tvdbId: 424207,
            seasonFolder: true,
            addOptions: { searchForMissingEpisodes: true }
        });
    });

    /**
     * Radarr's dedicated `/movie/lookup/tmdb` answers an unknown id with a
     * **500**, which would surface as "radarr upstream error" — blaming the
     * service for what is really a wrong id. The term form answers `[]`.
     * Probed against a live Radarr 6.3.0; the fake throws if the by-id
     * endpoint is ever called, so a future refactor cannot quietly switch back.
     */
    it('looks Radarr up by term, not via the by-id endpoint that 500s', async () => {
        const h = harness();
        await h.call({ service: 'radarr', external_id: '603', dry_run: true });

        expect(h.sent.some(x => x.path === '/api/v3/movie/lookup' && x.search.includes('tmdb:603'))).toBe(true);
    });

    it('rejects a non-numeric external id before calling anything', async () => {
        const h = harness();
        await expect(h.call({ service: 'radarr', external_id: 'matrix', dry_run: true })).rejects.toThrow(
            /is not a tmdb id/
        );
    });

    it('explains the id mix-up when the lookup matches nothing', async () => {
        const h = harness({ lookup: [] });
        await expect(h.call({ service: 'radarr', external_id: '999999999', dry_run: true })).rejects.toThrow(
            /Radarr takes TMDB, Sonarr takes TVDB/
        );
    });
});

// Whisparr keeps Sonarr's `series` resource and TVDB id, confirmed against a
// live-captured `series/lookup` fixture — so the shape here is Sonarr's,
// down to `seasonFolder: true`.
describe('add_media on Whisparr', () => {
    const whisparrHarness = (opts: Parameters<typeof stack>[0] = {}) => {
        const s = stack({ resource: 'series', ...opts });
        return {
            s,
            h: harness({
                adapters: [new WhisparrAdapter(keyed(6969), s.impl)],
                permissions: { whisparr: tiered(true) }
            })
        };
    };

    it('looks up and posts by tvdb id, with season folders', async () => {
        const { s, h } = whisparrHarness({
            lookup: [{ id: 0, title: 'Site 1', year: 2020, tvdbId: 1001 }],
            created: { id: 12, title: 'Site 1' }
        });

        const first = await h.call({ service: 'whisparr', external_id: '1001' });
        await h.call({ service: 'whisparr', external_id: '1001', confirm: first.structuredContent.confirm_token });

        // `tpdb:`, not `tvdb:` — Whisparr V2 renamed the exact-id prefix, and
        // it's the only term that resolves by id rather than falling through
        // to a ranked text search.
        const lookup = s.sent.find(x => x.path === '/api/v3/series/lookup');
        expect(lookup?.search).toBe('?term=tpdb:1001');

        const body = s.sent.find(x => x.method === 'POST')?.body;
        expect(body).toMatchObject({
            tvdbId: 1001,
            seasonFolder: true,
            addOptions: { searchForMissingEpisodes: true }
        });
    });

    it('refuses series_type, which Whisparr has no numbering scheme for', async () => {
        const { h } = whisparrHarness({ lookup: [{ id: 0, title: 'Site 1', year: 2020, tvdbId: 1001 }] });
        await expect(
            h.call({ service: 'whisparr', external_id: '1001', series_type: 'anime', dry_run: true })
        ).rejects.toThrow(/series_type/);
    });
});

/**
 * Permissions are granted per instance, and the write gate has to look up the
 * *resolved* instance id rather than the bare service type.
 *
 * This is unit-tested rather than verified against a live server because
 * `registerWriteTool` runs `plan()` before `checkPermission` — `plan` reads
 * quality profiles and root folders from the service, so against an unreachable
 * host the call fails at the network before the permission gate is ever
 * reached. A live check therefore cannot see this, and getting it wrong would
 * mean either denying a permitted write or, far worse, permitting a denied one.
 */
describe('add_media across two Radarr instances', () => {
    const bothInstances = (hdSafeWrite: boolean, fourKSafeWrite: boolean): ServiceInstance[] => [
        { id: 'radarr/hd', type: 'radarr', name: 'hd', config: tiered(hdSafeWrite) },
        { id: 'radarr/4k', type: 'radarr', name: '4k', config: tiered(fourKSafeWrite) }
    ];

    const twoRadarrs = (impl: typeof fetch): ServiceAdapter[] => [
        new RadarrAdapter({ ...keyed(7878), name: 'hd' }, impl),
        new RadarrAdapter({ ...keyed(7879), name: '4k' }, impl)
    ];

    it('refuses to guess which Radarr, and names both', async () => {
        const s = stack();
        const h = harness({ adapters: twoRadarrs(s.impl), instances: bothInstances(true, true) });

        await expect(h.call({ service: 'radarr', external_id: '603' })).rejects.toThrow(/2 instances/);
    });

    it('checks the permission of the instance actually named, not the service', async () => {
        const s = stack();
        const opts = { adapters: twoRadarrs(s.impl), instances: bothInstances(true, false) };

        const allowed = await harness(opts).call({ service: 'radarr', instance: 'hd', external_id: '603' });
        expect(allowed.structuredContent.permission.allowed).toBe(true);
        expect(allowed.structuredContent.service).toBe('radarr/hd');

        // A denied live write throws rather than returning a verdict — the
        // refusal is the result.
        await expect(
            harness(opts).call({ service: 'radarr', instance: '4k', external_id: '603', confirm: 'x' })
        ).rejects.toThrow(/disabled for radarr\/4k/);
    });

    /**
     * `services.radarr/4k.permissions` is the string an id-shaped remedy builds,
     * and it names a key that cannot exist — a named instance lives inside a
     * list. Someone following it would edit nothing, the write would stay
     * refused, and the remedy would look broken rather than misread.
     */
    it('points at a YAML path that exists for a named instance', async () => {
        const s = stack();
        const opts = { adapters: twoRadarrs(s.impl), instances: bothInstances(true, false) };

        await expect(
            harness(opts).call({ service: 'radarr', instance: '4k', external_id: '603', confirm: 'x' })
        ).rejects.toThrow(/`name: 4k` entry under `services.radarr`/);
    });

    it('names the instance in the summary, for an add and for a title already there', async () => {
        const fresh = harness({ adapters: twoRadarrs(stack().impl), instances: bothInstances(true, true) });
        const add = await fresh.call({ service: 'radarr', instance: '4k', external_id: '603' });
        expect(add.structuredContent.summary).toMatch(/ to radarr\/4k\.$/);

        const there = harness({ adapters: twoRadarrs(stack({ lookup: EXISTING_MOVIE }).impl), instances: bothInstances(true, true) });
        const same = await there.call({ service: 'radarr', instance: '4k', external_id: '603' });
        expect(same.structuredContent.noop).toBe(true);
        expect(same.structuredContent.summary).toMatch(/ is already in radarr\/4k \(id \d+\)\.$/);
    });

    it('names the instance in the audit row, so two Radarrs stay distinguishable', async () => {
        const s = stack();
        const h = harness({ adapters: twoRadarrs(s.impl), instances: bothInstances(true, true) });

        await h.call({ service: 'radarr', instance: '4k', external_id: '603' });

        const [row] = h.audit.recent(1) as { service: string }[];
        expect(row?.service).toBe('radarr/4k');
    });
});


/**
 * The options the tool had no way to express, so "add this series but only
 * future seasons" or "not the other profile" meant raw HTTP beside arr-mcp.
 */
describe('add_media options', () => {
    const sonarrStack = () =>
        stack({
            resource: 'series',
            lookup: [{ id: 0, title: 'Alien: Earth', year: 2025, tvdbId: 424207 }],
            created: { id: 12, title: 'Alien: Earth' }
        });

    const confirmSonarr = async (args: Record<string, unknown>) => {
        const s = sonarrStack();
        const h = harness({ adapters: [new SonarrAdapter(keyed(8989), s.impl)] });
        const first = await h.call({ service: 'sonarr', external_id: '424207', ...args });
        await h.call({
            service: 'sonarr',
            external_id: '424207',
            ...args,
            confirm: first.structuredContent.confirm_token
        });
        return s.sent.find(x => x.method === 'POST')?.body;
    };

    const confirmWhisparr = async (args: Record<string, unknown>) => {
        const s = stack({
            resource: 'series',
            lookup: [{ id: 0, title: 'Site 1', year: 2020, tvdbId: 1001 }],
            created: { id: 12, title: 'Site 1' }
        });
        const h = harness({
            adapters: [new WhisparrAdapter(keyed(6969), s.impl)],
            permissions: { whisparr: tiered(true) }
        });
        const first = await h.call({ service: 'whisparr', external_id: '1001', ...args });
        await h.call({
            service: 'whisparr',
            external_id: '1001',
            ...args,
            confirm: first.structuredContent.confirm_token
        });
        return s.sent.find(x => x.method === 'POST')?.body;
    };

    it('sends the Sonarr monitor mode in addOptions', async () => {
        expect(await confirmSonarr({ monitor: 'future' })).toMatchObject({
            addOptions: { monitor: 'future', searchForMissingEpisodes: true }
        });
    });

    it('sends the Sonarr rule for new seasons on the series', async () => {
        expect(await confirmSonarr({ monitor_new_items: 'none' })).toMatchObject({ monitorNewItems: 'none' });
    });

    it('refuses `new` on Sonarr and the rule on Whisparr', async () => {
        await expect(confirmSonarr({ monitor_new_items: 'new' })).rejects.toMatchObject({ detail: '`new` is a Lidarr rule' });
        await expect(confirmWhisparr({ monitor_new_items: 'none' })).rejects.toThrow(/monitor_new_items is a Lidarr and Sonarr option/);
    });

    it('leaves addOptions.monitor out when none was asked for', async () => {
        const body = (await confirmSonarr({})) as { addOptions: Record<string, unknown> };
        expect(body.addOptions.monitor).toBeUndefined();
    });

    it('sends the series type', async () => {
        expect(await confirmSonarr({ series_type: 'anime' })).toMatchObject({ seriesType: 'anime' });
    });

    // Whisparr's own MonitorTypes enum has no `lastSeason` — it calls the same
    // concept `latestSeason`. The tool keeps one word across both services and
    // renames it at the wire boundary.
    it('renames lastSeason to Whisparr\'s own latestSeason on the wire', async () => {
        expect(await confirmWhisparr({ monitor: 'lastSeason' })).toMatchObject({
            addOptions: { monitor: 'latestSeason' }
        });
    });

    it('passes other monitor modes to Whisparr unchanged', async () => {
        expect(await confirmWhisparr({ monitor: 'future' })).toMatchObject({
            addOptions: { monitor: 'future' }
        });
    });

    it('refuses pilot on Whisparr — a site has no pilot scene', async () => {
        const s = stack({
            resource: 'series',
            lookup: [{ id: 0, title: 'Site 1', year: 2020, tvdbId: 1001 }]
        });
        const h = harness({
            adapters: [new WhisparrAdapter(keyed(6969), s.impl)],
            permissions: { whisparr: tiered(true) }
        });
        await expect(
            h.call({ service: 'whisparr', external_id: '1001', monitor: 'pilot', dry_run: true })
        ).rejects.toThrow(/pilot/);
        expect(s.sent.filter(x => x.method === 'POST')).toHaveLength(0);
    });

    it('refuses a monitor mode on Radarr rather than dropping it silently', async () => {
        const h = harness();
        await expect(
            h.call({ service: 'radarr', external_id: '603', monitor: 'future', dry_run: true })
        ).rejects.toThrow(/sonarr/i);
    });

    it('refuses minimum_availability on Sonarr, naming what to use instead', async () => {
        const s = sonarrStack();
        const h = harness({ adapters: [new SonarrAdapter(keyed(8989), s.impl)] });
        await expect(
            h.call({ service: 'sonarr', external_id: '424207', minimum_availability: 'announced', dry_run: true })
        ).rejects.toThrow(/monitor/i);
    });

    it('overrides Radarr minimum availability when asked', async () => {
        const h = harness();
        const first = await h.call({ service: 'radarr', external_id: '603', minimum_availability: 'announced' });
        await h.call({
            service: 'radarr',
            external_id: '603',
            minimum_availability: 'announced',
            confirm: first.structuredContent.confirm_token
        });
        expect(posted(h)?.minimumAvailability).toBe('announced');
    });

    it('still defaults Radarr to released', async () => {
        const h = harness();
        const first = await h.call({ service: 'radarr', external_id: '603' });
        await h.call({ service: 'radarr', external_id: '603', confirm: first.structuredContent.confirm_token });
        expect(posted(h)?.minimumAvailability).toBe('released');
    });

    it('resolves tag labels to the ids the service holds', async () => {
        const h = harness();
        const args = { service: 'radarr', external_id: '603', tags: ['4k'] };
        const first = await h.call(args);
        await h.call({ ...args, confirm: first.structuredContent.confirm_token });
        expect(posted(h)?.tags).toEqual([1]);
    });

    it('refuses an unknown tag, listing the ones that exist, and creates nothing', async () => {
        const h = harness();
        await expect(
            h.call({ service: 'radarr', external_id: '603', tags: ['nope'], dry_run: true })
        ).rejects.toThrow(/4k/);
        expect(h.sent.filter(x => x.method === 'POST')).toHaveLength(0);
    });

    it('names the options it will use in the preview', async () => {
        const s = sonarrStack();
        const h = harness({ adapters: [new SonarrAdapter(keyed(8989), s.impl)] });
        const { structuredContent } = await h.call({
            service: 'sonarr',
            external_id: '424207',
            monitor: 'future',
            dry_run: true
        });
        expect(structuredContent.effects.join(' ')).toMatch(/future/);
    });
});

describe('add_media cross-checks', () => {
    const quiet = () => vi.fn<CrossChecker>(async () => ({ warnings: [], unchecked: [] }));

    it('asks the acquire checks about the film, by the TMDB id it was given', async () => {
        const crossChecks = quiet();
        const h = harness({ crossChecks });

        await h.call({ service: 'radarr', external_id: '603', dry_run: true });

        expect(crossChecks).toHaveBeenCalledTimes(1);
        const [subject, profile] = crossChecks.mock.calls[0] ?? [];
        expect(profile).toBe('acquire');
        expect(subject).toMatchObject({ kind: 'movie', ids: { tmdb: 603 } });
        expect(subject?.label).toContain('The Matrix');
        // Not in the library yet, so there is no *arr id to match a queue row on.
        expect(subject?.acquisition).toBeUndefined();
    });

    it('asks as a series by TVDB id for Sonarr', async () => {
        const crossChecks = quiet();
        const s = stack({ resource: 'series', lookup: [{ id: 0, title: 'Alien: Earth', year: 2025, tvdbId: 424207 }] });
        const h = harness({ adapters: [new SonarrAdapter(keyed(8989), s.impl)], crossChecks });

        await h.call({ service: 'sonarr', external_id: '424207', dry_run: true });

        expect(crossChecks.mock.calls[0]?.[0]).toMatchObject({ kind: 'series', ids: { tvdb: 424207 } });
    });

    it('does not ask about a Whisparr site', async () => {
        const crossChecks = quiet();
        const s = stack({ resource: 'series', lookup: [{ id: 0, title: 'Site 1', year: 2020, tvdbId: 1001 }] });
        const h = harness({
            adapters: [new WhisparrAdapter(keyed(6969), s.impl)],
            permissions: { whisparr: tiered(true) },
            crossChecks
        });

        const { structuredContent } = await h.call({ service: 'whisparr', external_id: '1001', dry_run: true });

        expect(structuredContent.summary).toContain('Site 1');
        expect(crossChecks).not.toHaveBeenCalled();
    });

    it('does not ask when the title is already there', async () => {
        const crossChecks = quiet();
        const h = harness({ lookup: EXISTING_MOVIE, crossChecks });

        await h.call({ service: 'radarr', external_id: '603', dry_run: true });

        expect(crossChecks).not.toHaveBeenCalled();
    });

    // The recorded Sonarr lookup: Breaking Bad carries a TMDB id, Breaking Band has none (0).
    const SERIES_LOOKUP = JSON.parse(readFileSync('test/fixtures/sonarr/series-lookup.json', 'utf8')) as {
        title: string;
        tvdbId: number;
        tmdbId: number;
    }[];

    it('gives a series the TMDB id its lookup carries, so Reclaimerr can be asked', async () => {
        const crossChecks = quiet();
        const bb = SERIES_LOOKUP[0];
        const s = stack({ resource: 'series', lookup: [bb] });
        const h = harness({ adapters: [new SonarrAdapter(keyed(8989), s.impl)], crossChecks });

        await h.call({ service: 'sonarr', external_id: String(bb?.tvdbId), dry_run: true });

        expect(crossChecks.mock.calls[0]?.[0].ids).toEqual({ tvdb: bb?.tvdbId, tmdb: bb?.tmdbId });
    });

    it('leaves out a TMDB id the lookup reports as 0', async () => {
        const crossChecks = quiet();
        const band = SERIES_LOOKUP[1];
        const s = stack({ resource: 'series', lookup: [band] });
        const h = harness({ adapters: [new SonarrAdapter(keyed(8989), s.impl)], crossChecks });

        await h.call({ service: 'sonarr', external_id: String(band?.tvdbId), dry_run: true });

        expect(crossChecks.mock.calls[0]?.[0].ids).toEqual({ tvdb: band?.tvdbId });
    });

    // A subject folded into the token would break it when the title changes in between.
    it('asks only on the preview, and a title that changed does not void the token', async () => {
        const crossChecks = quiet();
        const lookup = [{ ...NEW_MOVIE[0] }];
        const h = harness({ lookup, crossChecks });

        const first = await h.call({ service: 'radarr', external_id: '603' });
        lookup[0] = { ...NEW_MOVIE[0], title: 'Renamed' } as (typeof lookup)[0];
        const second = await h.call({ service: 'radarr', external_id: '603', confirm: first.structuredContent.confirm_token });

        expect(second.structuredContent.applied).toBe(true);
        expect(crossChecks).toHaveBeenCalledTimes(1);
    });
});

describe('add_media adopting an existing folder (#535)', () => {
    const effects = (r: { structuredContent: WriteToolResult }) => JSON.stringify(r.structuredContent);

    it('adopts the folder under its own root, with search off, and posts the path', async () => {
        const h = harness({ folders: MANY_FOLDERS });
        const first = await h.call({ service: 'radarr', external_id: '603', path: '/movies-4k/The Matrix (1999)' });
        expect(effects(first)).toContain('Adopts the existing folder');
        expect(effects(first)).not.toContain('Check first');
        await h.call({ service: 'radarr', external_id: '603', path: '/movies-4k/The Matrix (1999)', confirm: first.structuredContent.confirm_token });
        expect(posted(h)).toMatchObject({ rootFolderPath: '/movies-4k', path: '/movies-4k/The Matrix (1999)', addOptions: { searchForMovie: false } });
    });

    it('still searches when asked to', async () => {
        const h = harness();
        const first = await h.call({ service: 'radarr', external_id: '603', path: '/movies/The Matrix (1999)', search_now: true });
        await h.call({ service: 'radarr', external_id: '603', path: '/movies/The Matrix (1999)', search_now: true, confirm: first.structuredContent.confirm_token });
        expect(posted(h)).toMatchObject({ addOptions: { searchForMovie: true } });
    });

    it('refuses a folder outside every root, or outside the root named', async () => {
        await expect(harness().call({ service: 'radarr', external_id: '603', path: '/downloads/The Matrix' })).rejects.toThrow(/not a folder directly inside/);
        await expect(harness().call({ service: 'radarr', external_id: '603', path: '/movies' })).rejects.toThrow(/not a folder directly inside/);
        await expect(harness().call({ service: 'radarr', external_id: '603', path: '/movies/../etc' })).rejects.toThrow(/not a folder directly inside/);
        await expect(harness().call({ service: 'radarr', external_id: '603', path: '/movies/./The Matrix' })).rejects.toThrow(/not a folder directly inside/);
        await expect(harness().call({ service: 'radarr', external_id: '603', path: '/movies/A/The Matrix' })).rejects.toThrow(/not a folder directly inside/);
        await expect(harness().call({ service: 'radarr', external_id: '603', path: '/moviesX/The Matrix' })).rejects.toThrow(/not a folder directly inside/);
        await expect(
            harness({ folders: MANY_FOLDERS }).call({ service: 'radarr', external_id: '603', path: '/movies/The Matrix', root_folder: '/movies-4k' })
        ).rejects.toThrow(/not a folder directly inside/);
    });

    it('warns when the folder name disagrees with the title', async () => {
        const h = harness();
        expect(effects(await h.call({ service: 'radarr', external_id: '603', path: '/movies/The Matrix (2003)' }))).toContain('says 2003, the lookup 1999');
        expect(effects(await h.call({ service: 'radarr', external_id: '603', path: '/movies/The Matrix {tmdb-604}' }))).toContain('carries id 604, not 603');
        expect(effects(await h.call({ service: 'radarr', external_id: '603', path: '/movies/Idiots' }))).toContain('does not match the title');
        expect(effects(await h.call({ service: 'radarr', external_id: '603', path: '/movies/Matrix [tmdbid-603]' }))).not.toContain('Check first');
    });
});

/**
 * Adding a book. MOCK-ONLY for the grab itself: the bodies are Shelfmark's
 * recorded ones (test/fixtures/shelfmark), but no live Shelfmark has been asked
 * to queue a release through `add_media`, the same standing as the default grab
 * in `grab_release`.
 */
describe('add_media on Shelfmark', () => {
    const BOOK_ID = 'googlebooks:5neBQgAACAAJ';
    const recorded = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/shelfmark', `${name}.json`), 'utf8'));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    type Answers = Record<string, () => Response>;
    function bookHarness(opts: { answers?: Answers; grimmory?: boolean } = {}) {
        const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            const answer = opts.answers?.[path];
            if (answer !== undefined) return answer();
            return json(recorded(path === '/api/releases/download' ? 'download' : path.replace('/api/', '').replace('/', '-')));
        });
        const config = ConfigSchema.parse({
            auth: { bearer_token: 'a'.repeat(64) },
            services: { shelfmark: { url: 'http://shelfmark:8084', permissions: { safe_write: true } } }
        }).services.shelfmark as AnyServiceConfig;
        const shelfmark = new ShelfmarkAdapter(config as never, fetchImpl as typeof fetch);
        const adapters = [shelfmark, ...(opts.grimmory === true ? [{ type: 'grimmory', id: 'grimmory' } as unknown as ServiceAdapter] : [])];
        const h = harness({ adapters, permissions: { shelfmark: config } });
        const downloads = () =>
            fetchImpl.mock.calls
                .filter(c => new URL(String(c[0])).pathname === '/api/releases/download')
                .map(c => JSON.parse((c[1] as RequestInit).body as string) as { source_id: string });
        /** grab_release over the same adapter and fetch, to compare what each sends. */
        const grab = () => {
            let call: Call = () => Promise.reject(new Error('not registered'));
            registerGrabRelease(
                { registerTool: (_n: string, c: { inputSchema: z.ZodObject }, handler: Call) => (call = a => handler(c.inputSchema.parse(a) as Record<string, unknown>)) } as never,
                {
                    permissions: permissionSourceFrom(instancesOf({ shelfmark: config })),
                    confirm: new ConfirmTokens(),
                    audit: WriteAudit.ephemeral(),
                    library: { invalidate: vi.fn() } as unknown as LibraryLoader
                },
                [shelfmark]
            );
            return (a: Record<string, unknown>) => call(a);
        };
        return { ...h, shelfmark, fetchImpl, downloads, grab };
    }
    const hashOf = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

    it('takes the id a book search returned, and previews the most-downloaded release', async () => {
        const h = bookHarness();
        const [hit] = await h.shelfmark.search('dutch', 'discover');
        expect(hit).toMatchObject({ source: 'discover', kind: 'book', id: BOOK_ID });

        const { structuredContent } = await h.call({ service: 'shelfmark', external_id: hit?.id });

        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.summary).toContain('Queue the book');
        expect(structuredContent.summary).toContain('The Dutch Republic');
        // The id is for the model's next call, not for the person reading the preview.
        expect(structuredContent.summary).not.toContain(BOOK_ID);
        const releases = h.fetchImpl.mock.calls.filter(c => new URL(String(c[0])).pathname === '/api/releases');
        expect(releases.length).toBeGreaterThan(0);
        const asked = new URL(String(releases[0]?.[0])).searchParams;
        // The search's id is `<provider>:<book_id>`, and the release listing takes it apart the same way.
        expect(`${asked.get('provider')}:${asked.get('book_id')}`).toBe(hit?.id);
        expect(h.downloads()).toEqual([]);
    });

    it('names the Bookdrop and import_download only when Grimmory is configured', async () => {
        const without = (await bookHarness().call({ service: 'shelfmark', external_id: BOOK_ID })).structuredContent.effects.join(' ');
        expect(without).not.toContain('import_download');
        const withGrimmory = (await bookHarness({ grimmory: true }).call({ service: 'shelfmark', external_id: BOOK_ID })).structuredContent.effects.join(' ');
        expect(withGrimmory).toContain('Bookdrop');
        expect(withGrimmory).toContain('import_download');
        expect(withGrimmory).toContain('library is not checked');
    });

    it('sends the same download as grab_release for that id, and it is the most-downloaded row', async () => {
        const viaAdd = bookHarness();
        const preview = await viaAdd.call({ service: 'shelfmark', external_id: BOOK_ID });
        const applied = await viaAdd.call({ service: 'shelfmark', external_id: BOOK_ID, confirm: preview.structuredContent.confirm_token });
        expect(applied.structuredContent.applied).toBe(true);
        expect(viaAdd.invalidate).toHaveBeenCalled();

        const viaGrab = bookHarness();
        const grab = viaGrab.grab();
        const grabPreview = await grab({ service: 'shelfmark', id: BOOK_ID });
        await grab({ service: 'shelfmark', id: BOOK_ID, confirm: grabPreview.structuredContent.confirm_token });

        expect(viaAdd.downloads()).toHaveLength(1);
        expect(viaAdd.downloads()).toEqual(viaGrab.downloads());
        const top = (await viaAdd.shelfmark.findReleases({ id: BOOK_ID }))[0];
        expect(hashOf(viaAdd.downloads()[0]?.source_id as string)).toBe(top?.guid?.split(':')[1]);
    });

    describe('when the release is already queued', () => {
        /** The recorded queue task, keyed by the top release's source_id the way Shelfmark keys its tasks. */
        async function queuedTop(bucket: 'queued' | 'error' = 'queued', retryAvailable?: boolean) {
            const probe = bookHarness();
            const top = (await probe.shelfmark.findReleases({ id: BOOK_ID }))[0];
            const raw = (recorded('releases') as { releases: { source_id: string }[] }).releases.find(r => hashOf(r.source_id) === top?.guid?.split(':')[1]);
            const status = recorded('status') as Record<string, Record<string, Record<string, unknown>>>;
            const [task] = Object.values(status).flatMap(tasks => Object.values(tasks));
            const row = { ...task, status: bucket, ...(retryAvailable === undefined ? {} : { retry_available: retryAvailable }) };
            return { ...status, [bucket]: { [raw?.source_id as string]: row } };
        }

        /** The queue and the activity snapshot both holding the failed copy, as Shelfmark reports one. */
        async function failedTop(retryAvailable: boolean) {
            const queue = await queuedTop('error', retryAvailable);
            return bookHarness({
                answers: {
                    '/api/status': () => json(queue),
                    '/api/activity/snapshot': () => json({ status: { error: queue.error } }),
                    '/api/activity/history': () => json([])
                }
            });
        }

        it('is a no-op with nothing to confirm, and sends nothing', async () => {
            const queue = await queuedTop();
            const h = bookHarness({ answers: { '/api/status': () => json(queue) } });
            const { structuredContent } = await h.call({ service: 'shelfmark', external_id: BOOK_ID });
            expect(structuredContent.summary).toContain('already queued');
            expect(structuredContent.noop).toBe(true);
            expect(h.downloads()).toEqual([]);
        });

        it('says a failed copy in the queue failed and points to retry_download with its id', async () => {
            const h = await failedTop(true);
            const { structuredContent } = await h.call({ service: 'shelfmark', external_id: BOOK_ID });
            const top = (await h.shelfmark.findReleases({ id: BOOK_ID }))[0];
            expect(structuredContent.summary).toContain('already failed');
            expect(structuredContent.summary).toContain(`retry_download with id "${top?.guid?.split(':')[1]}"`);
            expect(structuredContent.summary).not.toContain('already queued');
            expect(structuredContent.noop).toBe(true);
            expect(h.downloads()).toEqual([]);
        });

        it('points to grab_release instead when Shelfmark says the failed copy cannot be retried', async () => {
            const h = await failedTop(false);
            const { structuredContent } = await h.call({ service: 'shelfmark', external_id: BOOK_ID });
            expect(structuredContent.summary).toContain('cannot be retried');
            expect(structuredContent.summary).toContain('grab_release');
            expect(structuredContent.summary).not.toContain('retry_download');
            expect(structuredContent.noop).toBe(true);
            expect(h.downloads()).toEqual([]);
        });

        it.each([
            ['the snapshot read fails', () => json({ error: 'boom' }, 500)],
            ['the row is outside the snapshot', () => json({ status: {} })]
        ])('does not claim it cannot be retried when %s, and still names retry_download', async (_case, snapshot) => {
            const queue = await queuedTop('error', true);
            const h = bookHarness({
                answers: { '/api/status': () => json(queue), '/api/activity/snapshot': snapshot, '/api/activity/history': () => json([]) }
            });
            const { structuredContent } = await h.call({ service: 'shelfmark', external_id: BOOK_ID });
            const top = (await h.shelfmark.findReleases({ id: BOOK_ID }))[0];
            expect(structuredContent.summary).toContain('already failed');
            expect(structuredContent.summary).not.toContain('cannot be retried');
            expect(structuredContent.summary).toContain(`retry_download with id "${top?.guid?.split(':')[1]}" may run it again`);
            expect(structuredContent.noop).toBe(true);
            expect(h.downloads()).toEqual([]);
        });

        it('previews a grab when the queue holds another book, and says the queue was checked', async () => {
            const h = bookHarness();
            const { structuredContent } = await h.call({ service: 'shelfmark', external_id: BOOK_ID });
            expect(structuredContent.noop).not.toBe(true);
            expect(structuredContent.effects.join(' ')).toContain('queue has no copy');
        });

        it('still previews, saying so, when the queue cannot be read', async () => {
            const h = bookHarness({ answers: { '/api/status': () => json({ error: 'This API key is read-only' }, 403) } });
            const { structuredContent } = await h.call({ service: 'shelfmark', external_id: BOOK_ID });
            expect(structuredContent.noop).not.toBe(true);
            expect(structuredContent.effects.join(' ')).toContain('Could not read');
        });
    });

    it('rejects the token when the top release is a different one at confirm, and grabs nothing', async () => {
        const releases = (recorded('releases') as { releases: Record<string, unknown>[] }).releases;
        let listing = releases;
        const h = bookHarness({ answers: { '/api/releases': () => json({ releases: listing }) } });
        const preview = await h.call({ service: 'shelfmark', external_id: BOOK_ID });

        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(Date.now() + 10 * 60_000);
            listing = [{ ...releases[0], source_id: 'someone-else', title: 'Another edition', extra: { downloads: 9_999_999 } }, ...releases];
            const confirmed = await h.call({ service: 'shelfmark', external_id: BOOK_ID, confirm: preview.structuredContent.confirm_token });
            expect(confirmed.structuredContent.applied).toBe(false);
            expect(confirmed.structuredContent.confirm_error).toBeDefined();
            expect(confirmed.structuredContent.summary).toContain('Another edition');
            expect(h.downloads()).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        ['monitor', { monitor: 'all' }],
        ['quality_profile', { quality_profile: 'HD' }],
        ['root_folder', { root_folder: '/books' }],
        ['tags', { tags: ['kids'] }],
        ['minimum_availability', { minimum_availability: 'released' }],
        ['series_type', { series_type: 'anime' }],
        ['metadata_profile', { metadata_profile: 'Standard' }],
        ['monitor_new_items', { monitor_new_items: 'all' }],
        ['path', { path: '/books/x' }],
        ['monitored', { monitored: false }],
        ['search_now', { search_now: false }]
    ])('refuses %s, an *arr option, naming it, with a remedy and no call to Shelfmark', async (option, extra) => {
        const h = bookHarness();
        await expect(h.call({ service: 'shelfmark', external_id: BOOK_ID, ...extra })).rejects.toMatchObject({
            kind: 'NotFound',
            detail: `${option} is not a book option`,
            remedy: expect.stringContaining('book')
        });
        expect(h.fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses an id that is not a book id, as Shelfmark and not as an *arr, without grabbing', async () => {
        const h = bookHarness();
        const err = await h.call({ service: 'shelfmark', external_id: '603' }).then(() => undefined, (e: unknown) => e as { kind: string; service: string; message: string });
        expect(err).toMatchObject({ kind: 'NotFound', service: 'shelfmark' });
        expect(err?.message).not.toMatch(/radarr|tmdb/i);
        expect(h.downloads()).toEqual([]);
    });
});
