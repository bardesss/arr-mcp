import type { ServiceInstance } from '../src/config/instances.ts';
import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { registerAddMedia } from '../src/tools/addMedia.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { jsonResponse } from './helpers/serve.ts';

const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const tiered = (safe_write: boolean, destructive = false): AnyServiceConfig =>
    ({ ...keyed(7878), permissions: { safe_write, destructive } }) as AnyServiceConfig;

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
            library: { invalidate } as unknown as LibraryLoader
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

        await expect(h.call({ service: 'radarr', external_id: '550' })).rejects.toThrow(/2 instances/);
    });

    it('checks the permission of the instance actually named, not the service', async () => {
        const s = stack();
        const opts = { adapters: twoRadarrs(s.impl), instances: bothInstances(true, false) };

        const allowed = await harness(opts).call({ service: 'radarr', instance: 'hd', external_id: '550' });
        expect(allowed.structuredContent.permission.allowed).toBe(true);
        expect(allowed.structuredContent.service).toBe('radarr/hd');

        // A denied live write throws rather than returning a verdict — the
        // refusal is the result.
        await expect(
            harness(opts).call({ service: 'radarr', instance: '4k', external_id: '550', confirm: 'x' })
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
            harness(opts).call({ service: 'radarr', instance: '4k', external_id: '550', confirm: 'x' })
        ).rejects.toThrow(/`name: 4k` entry under `services.radarr`/);
    });

    it('names the instance in the audit row, so two Radarrs stay distinguishable', async () => {
        const s = stack();
        const h = harness({ adapters: twoRadarrs(s.impl), instances: bothInstances(true, true) });

        await h.call({ service: 'radarr', instance: '4k', external_id: '550' });

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

    it('sends the Sonarr monitor mode in addOptions', async () => {
        expect(await confirmSonarr({ monitor: 'future' })).toMatchObject({
            addOptions: { monitor: 'future', searchForMissingEpisodes: true }
        });
    });

    it('leaves addOptions.monitor out when none was asked for', async () => {
        const body = (await confirmSonarr({})) as { addOptions: Record<string, unknown> };
        expect(body.addOptions.monitor).toBeUndefined();
    });

    it('sends the series type', async () => {
        expect(await confirmSonarr({ series_type: 'anime' })).toMatchObject({ seriesType: 'anime' });
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
