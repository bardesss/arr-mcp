import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { ServiceError } from '../src/core/errors.ts';
import { logger } from '../src/core/logger.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { WhisparrAdapter } from '../src/services/whisparr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { registerFixProfile } from '../src/tools/fixProfile.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { floorFindings, languagePreferenceFindings } from '../src/tools/profileIssues/rules.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { instancesOf } from './helpers/instances.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * Only Radarr 6.4.4 was captured live (a throwaway copy of a profile, read
 * and PUT; see test/fixtures/radarr/qualityprofile-*.json). Sonarr and
 * Whisparr share the same code over the same `/api/v3/qualityprofile/{id}`
 * path, so their tests below replay the Radarr shapes: they prove the path and
 * the body, not a Sonarr or Whisparr answer.
 */
const fixture = <T>(name: string): T =>
    JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/radarr', name), 'utf8')) as T;

type FormatItem = { format: number; name: string; score: number };
type Profile = { id: number; name: string; minFormatScore: number; formatItems: FormatItem[] } & Record<string, unknown>;

const RECORDED = fixture<Profile>('qualityprofile-detail.json');
const POSITIVE_TOTAL = RECORDED.formatItems.reduce((sum, f) => (f.score > 0 ? sum + f.score : sum), 0);
const CHEAPEST = Math.min(...RECORDED.formatItems.filter(f => f.score > 0).map(f => f.score));
const HEADROOM = POSITIVE_TOTAL - CHEAPEST;

/** The recorded profile with a different floor: the scores and everything else stay as recorded. */
const withFloor = (minFormatScore: number): Profile => ({ ...structuredClone(RECORDED), minFormatScore });

const keyed = (port: number, destructive = true): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive }
});

type Served = { impl: typeof fetch; puts: Array<{ path: string; body: Profile }>; profile: Profile };

/** One profile on a fake *arr: GET list and detail, PUT echoed back with 202 as Radarr answers. */
function serving(initial: Profile, opts: { putAnswer?: () => Response; detail?: () => Profile; others?: Profile[] } = {}): Served {
    const state = { profile: initial, puts: [] as Served['puts'] };
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        const detail = `/api/v3/qualityprofile/${state.profile.id}`;
        if (method === 'PUT' && url.pathname === detail) {
            const body = JSON.parse(String(init?.body)) as Profile;
            state.puts.push({ path: url.pathname, body });
            if (opts.putAnswer !== undefined) return opts.putAnswer();
            state.profile = body;
            return jsonResponse(body, 202);
        }
        if (method === 'GET' && url.pathname === '/api/v3/qualityprofile') return jsonResponse([state.profile, ...(opts.others ?? [])]);
        if (method === 'GET' && url.pathname === detail) return jsonResponse(opts.detail?.() ?? state.profile);
        if (method === 'GET' && (url.pathname === '/api/v3/customformat' || url.pathname === '/api/v3/language')) {
            return jsonResponse([]);
        }
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    return {
        impl,
        puts: state.puts,
        get profile() {
            return state.profile;
        },
        set profile(p: Profile) {
            state.profile = p;
        }
    };
}

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

type PfArr = { id: number; name: string; count: number; enabled?: boolean };

/** Profilarr's status as the adapter reports it: a per-arr count of synced quality profiles, never which. */
const profilarrDouble = (opts: { arrs?: PfArr[]; fails?: boolean } = {}) => {
    const arrs = opts.arrs ?? [{ id: 1, name: 'radarr', count: 1 }];
    return {
        type: 'profilarr',
        id: 'profilarr',
        status: async () => {
            if (opts.fails === true) throw new Error('profilarr is down');
            return {
                version: '2.2.0',
                // Database counts are not what is asked: they say how many profiles exist, not how many reach this arr.
                databases: [{ id: 1, name: 'db', enabled: true, lastSyncedAt: null, counts: { customFormats: 1, qualityProfiles: 9, regularExpressions: 0, delayProfiles: 0 } }],
                arrs: arrs.map(a => ({ id: a.id, name: a.name, type: 'radarr', enabled: a.enabled ?? true, syncedQualityProfiles: a.count, drift: null }))
            };
        },
        listArrs: async () => arrs.map(a => ({ id: a.id, name: a.name, type: 'radarr', url: `http://192.0.2.10:${7000 + a.id}` }))
    } as unknown as ServiceAdapter;
};
function harness(
    served: Served,
    opts: { destructive?: boolean; extra?: ServiceAdapter[]; adapter?: 'radarr' | 'sonarr' | 'whisparr'; name?: string } = {}
) {
    const config = { ...keyed(7878, opts.destructive ?? true), ...(opts.name === undefined ? {} : { name: opts.name }) };
    const adapter: ServiceAdapter =
        opts.adapter === 'sonarr'
            ? new SonarrAdapter(config, served.impl)
            : opts.adapter === 'whisparr'
              ? new WhisparrAdapter(config, served.impl)
              : new RadarrAdapter(config, served.impl);
    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, c: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(c.inputSchema.parse(args) as Record<string, unknown>);
        }
    };
    const audit = WriteAudit.ephemeral();
    registerFixProfile(
        server as never,
        {
            permissions: permissionSourceFrom(
                instancesOf({ [adapter.type]: config } as unknown as Partial<Record<ServiceId, AnyServiceConfig>>)
            ),
            confirm: new ConfirmTokens(),
            audit,
            library: { invalidate: vi.fn() } as unknown as LibraryLoader
        },
        [adapter, ...(opts.extra ?? [])]
    );
    return { call: (a: Record<string, unknown>) => call(a), audit };
}

const ARGS = { service: 'radarr', profile: RECORDED.name, finding: 'unreachable_floor' };

describe('the findings carry the fix as data', () => {
    const input = (minFormatScore: number, scores: number[]) => ({
        name: 'P',
        minFormatScore,
        formatItems: scores.map((score, i) => ({ name: `f${i}`, score }))
    });

    it('sets an unreachable floor to the total less the cheapest positive format', () => {
        const [finding] = floorFindings(input(500, [100, 40, 60, -30]));
        expect(finding?.kind).toBe('unreachable_floor');
        expect(finding?.change).toEqual({ minFormatScore: 160 });
    });

    it('does the same for a knife-edge floor', () => {
        const [finding] = floorFindings(input(200, [100, 40, 60]));
        expect(finding?.kind).toBe('knife_edge_floor');
        expect(finding?.change).toEqual({ minFormatScore: 160 });
    });

    it('lands strictly under the total and under the floor it replaces, so the fix raises no finding of its own', () => {
        for (const floor of [201, 200]) {
            const change = floorFindings(input(floor, [100, 40, 60]))[0]?.change;
            expect(change?.minFormatScore).toBeLessThan(floor);
            expect(floorFindings(input(change?.minFormatScore ?? -1, [100, 40, 60]))).toEqual([]);
        }
    });

    it('carries no change when fewer than two formats score positively, and never says "below 0"', () => {
        for (const scores of [[100], [100, -50], []]) {
            const [finding] = floorFindings(input(200, scores));
            expect(finding?.change).toBeUndefined();
            expect(finding?.remedy).not.toMatch(/below 0/);
        }
    });

    it('names in the remedy the number it would apply', () => {
        for (const floor of [500, 200]) {
            const [finding] = floorFindings(input(floor, [100, 40, 60]));
            expect(finding?.remedy).toContain(`to ${finding?.change?.minFormatScore}`);
        }
    });

    it('carries no change on a finding that is only likely', () => {
        const formats = [{ name: 'Dutch', specifications: [{ implementation: 'LanguageSpecification', negate: false, required: false, fields: [{ name: 'value', value: 1 }] }] }];
        const found = languagePreferenceFindings({ name: 'P', minFormatScore: 0, formatItems: [{ name: 'Dutch', score: 10 }] }, formats);
        expect(found).toHaveLength(1);
        expect(found[0]?.change).toBeUndefined();
    });
});

describe('fix_profile', () => {
    it('previews the change without writing', async () => {
        const served = serving(withFloor(POSITIVE_TOTAL + 1000));
        const { call } = harness(served);

        const { structuredContent: preview } = await call(ARGS);

        expect(preview.applied).toBe(false);
        expect(preview.confirm_token).toBeDefined();
        expect(preview.tier).toBe('destructive');
        expect(preview.summary).toContain(String(HEADROOM));
        expect(served.puts).toHaveLength(0);
    });

    it('applies minFormatScore and nothing else', async () => {
        const before = withFloor(POSITIVE_TOTAL + 1000);
        const served = serving(before);
        const { call } = harness(served);

        const { structuredContent: preview } = await call(ARGS);
        const { structuredContent: applied } = await call({ ...ARGS, confirm: preview.confirm_token });

        expect(applied.applied).toBe(true);
        expect(served.puts).toHaveLength(1);
        expect(served.puts[0]?.path).toBe(`/api/v3/qualityprofile/${RECORDED.id}`);
        // The profile as read, field for field, with the one number changed.
        expect(served.puts[0]?.body).toEqual({ ...before, minFormatScore: HEADROOM });
    });

    it('fixes a knife-edge floor the same way, and finds the profile by id', async () => {
        const served = serving(withFloor(POSITIVE_TOTAL));
        const { call } = harness(served);
        const args = { service: 'radarr', profile: String(RECORDED.id), finding: 'knife_edge_floor' };

        const { structuredContent: preview } = await call(args);
        await call({ ...args, confirm: preview.confirm_token });

        expect(served.puts[0]?.body.minFormatScore).toBe(HEADROOM);
    });

    it.each(['sonarr', 'whisparr'] as const)('reaches %s over the same v3 path (replayed from the Radarr capture)', async adapter => {
        const served = serving(withFloor(POSITIVE_TOTAL + 1));
        const { call } = harness(served, { adapter });
        const args = { ...ARGS, service: adapter };

        const { structuredContent: preview } = await call(args);
        await call({ ...args, confirm: preview.confirm_token });

        expect(served.puts[0]?.path).toBe(`/api/v3/qualityprofile/${RECORDED.id}`);
        expect(served.puts[0]?.body.minFormatScore).toBe(HEADROOM);
    });

    it('refuses a finding that no longer holds', async () => {
        const served = serving(withFloor(HEADROOM));
        const { call } = harness(served);

        await expect(call(ARGS)).rejects.toThrow(/no longer|does not (hold|have)/i);
        expect(served.puts).toHaveLength(0);
    });

    it('refuses a finding of another kind than the profile has', async () => {
        const served = serving(withFloor(POSITIVE_TOTAL + 1));
        const { call } = harness(served);

        await expect(call({ ...ARGS, finding: 'knife_edge_floor' })).rejects.toThrow(/knife_edge_floor/);
    });

    it.each(['language_preferred_not_required', 'profilarr_drift'])('rejects %s in the schema, so only the two floor kinds can be asked for', async finding => {
        const served = serving(withFloor(POSITIVE_TOTAL + 1));
        const { call } = harness(served);

        expect(() => call({ ...ARGS, finding })).toThrow(/unreachable_floor|knife_edge_floor/);
        expect(served.puts).toHaveLength(0);
    });

    it('refuses an unknown profile, listing the ones there are', async () => {
        const served = serving(withFloor(POSITIVE_TOTAL + 1));
        const { call } = harness(served);

        await expect(call({ ...ARGS, profile: 'Nope' })).rejects.toThrow(/Nope.*arr-mcp capture copy/s);
    });

    it('refuses a profile with one positive format, whose floor would drop its only requirement', async () => {
        const one = withFloor(100);
        one.formatItems = [{ format: 1, name: 'x265', score: 100 }];
        const { call } = harness(serving(one));

        await expect(call({ ...ARGS, finding: 'knife_edge_floor' })).rejects.toThrow(/fewer than two/);
    });

    describe('Profilarr syncs quality profiles to the instance', () => {
        const others = (n: number): Profile[] => Array.from({ length: n }, (_, i) => ({ ...structuredClone(RECORDED), id: 100 + i, name: `other ${i}` }));

        it('refuses when it syncs every profile the instance holds', async () => {
            const served = serving(withFloor(POSITIVE_TOTAL + 1));
            const { call } = harness(served, { extra: [profilarrDouble({ arrs: [{ id: 1, name: 'radarr', count: 1 }] })] });

            const refusal = call(ARGS);

            await expect(refusal).rejects.toThrow(/Profilarr syncs all 1 quality profiles/);
            await expect(refusal).rejects.toThrow(/Make the change in Profilarr/);
            expect(served.puts).toHaveLength(0);
        });

        it('previews with a warning first when it syncs some of them, and still applies', async () => {
            const served = serving(withFloor(POSITIVE_TOTAL + 1), { others: others(2) });
            const { call } = harness(served, { extra: [profilarrDouble({ arrs: [{ id: 1, name: 'radarr', count: 1 }] })] });

            const { structuredContent: preview } = await call(ARGS);

            expect(preview.effects[0]).toMatch(/Profilarr syncs 1 of the 3 profiles on radarr and does not say which/);
            expect(preview.effects[0]).toContain(String(POSITIVE_TOTAL + 1));
            await call({ ...ARGS, confirm: preview.confirm_token });
            expect(served.puts).toHaveLength(1);
        });

        it('goes ahead without a warning when the per-arr count is 0, however many profiles the databases hold', async () => {
            const served = serving(withFloor(POSITIVE_TOTAL + 1));
            const { call } = harness(served, { extra: [profilarrDouble({ arrs: [{ id: 1, name: 'radarr', count: 0 }] })] });

            const { structuredContent: preview } = await call(ARGS);

            expect(preview.confirm_token).toBeDefined();
            expect(preview.effects.some(e => e.includes('Profilarr'))).toBe(false);
        });

        it('goes ahead when Profilarr is switched off for the instance', async () => {
            const { call } = harness(serving(withFloor(POSITIVE_TOTAL + 1)), { extra: [profilarrDouble({ arrs: [{ id: 1, name: 'radarr', count: 1, enabled: false }] })] });

            expect((await call(ARGS)).structuredContent.confirm_token).toBeDefined();
        });

        it('goes ahead when the count belongs to another configured instance', async () => {
            const served = serving(withFloor(POSITIVE_TOTAL + 1));
            const fourK = new RadarrAdapter({ ...keyed(7879), name: '4k' }, served.impl);
            const pf = profilarrDouble({ arrs: [{ id: 1, name: 'hd', count: 0 }, { id: 2, name: '4k', count: 5 }] });
            const { call } = harness(served, { name: 'hd', extra: [fourK, pf] });

            expect((await call({ ...ARGS, instance: 'hd' })).structuredContent.confirm_token).toBeDefined();
        });

        it('refuses rather than fail open when an enabled entry matches no configured instance', async () => {
            const served = serving(withFloor(POSITIVE_TOTAL + 1));
            const { call } = harness(served, { extra: [profilarrDouble({ arrs: [{ id: 1, name: 'somewhere-else', count: 0 }] })] });

            await expect(call(ARGS)).rejects.toThrow(/matches no configured instance/);
            expect(served.puts).toHaveLength(0);
        });

        it('lets the matched entry decide when an unmatched one of the same type sits beside it', async () => {
            // The stray's own count would refuse; only the matched entry's count may decide.
            const stray = { id: 1, name: 'somewhere-else', count: 1 };
            const goes = harness(serving(withFloor(POSITIVE_TOTAL + 1)), { extra: [profilarrDouble({ arrs: [stray, { id: 2, name: 'radarr', count: 0 }] })] });
            expect((await goes.call(ARGS)).structuredContent.confirm_token).toBeDefined();

            const served = serving(withFloor(POSITIVE_TOTAL + 1));
            const refused = harness(served, { extra: [profilarrDouble({ arrs: [stray, { id: 2, name: 'radarr', count: 1 }] })] });
            await expect(refused.call(ARGS)).rejects.toThrow(/Profilarr syncs all 1 quality profiles/);
            expect(served.puts).toHaveLength(0);
        });

        it('refuses when Profilarr cannot be asked, rather than guessing', async () => {
            const served = serving(withFloor(POSITIVE_TOTAL + 1));
            const { call } = harness(served, { extra: [profilarrDouble({ fails: true })] });
            const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

            await expect(call(ARGS)).rejects.toThrow(/could not (check|ask|read)/i);
            expect(served.puts).toHaveLength(0);
            expect(warn).toHaveBeenCalled();
            warn.mockRestore();
        });
    });
    it('binds the confirm token to the profile as previewed', async () => {
        const served = serving(withFloor(POSITIVE_TOTAL + 1000));
        const { call } = harness(served);

        const { structuredContent: preview } = await call(ARGS);
        // Someone rescored a format between preview and confirm.
        const changed = structuredClone(served.profile);
        const scored = changed.formatItems.find(f => f.score > 0);
        if (scored === undefined) throw new Error('the recorded profile scores nothing');
        scored.score += 1;
        served.profile = changed;

        const { structuredContent: retry } = await call({ ...ARGS, confirm: preview.confirm_token });

        expect(retry.applied).toBe(false);
        expect(retry.confirm_error).toBeDefined();
        expect(retry.confirm_token).not.toBe(preview.confirm_token);
        expect(served.puts).toHaveLength(0);
    });

    it('re-reads the profile at apply, and refuses to overwrite a floor changed since the plan', async () => {
        // The list the plan reads and the detail the apply reads disagree: someone edited between the two.
        const served = serving(withFloor(POSITIVE_TOTAL + 1000), { detail: () => withFloor(POSITIVE_TOTAL + 5) });
        const { call } = harness(served);

        const { structuredContent: preview } = await call(ARGS);
        const failure = call({ ...ARGS, confirm: preview.confirm_token });

        await expect(failure).rejects.toThrow(/changed/);
        expect(served.puts).toHaveLength(0);
    });

    it('is refused without the destructive permission, and writes nothing', async () => {
        const served = serving(withFloor(POSITIVE_TOTAL + 1));
        const { call } = harness(served, { destructive: false });

        await expect(call(ARGS)).rejects.toThrow(/destructive/);
        expect(served.puts).toHaveLength(0);
    });

    it('surfaces the arr\'s validation message when the PUT is refused (replayed from the recorded 400)', async () => {
        const refused = fixture<unknown>('qualityprofile-put-unsatisfiable.json');
        const served = serving(withFloor(POSITIVE_TOTAL + 1), { putAnswer: () => jsonResponse(refused, 400) });
        const { call } = harness(served);

        const { structuredContent: preview } = await call(ARGS);
        const failure = call({ ...ARGS, confirm: preview.confirm_token });

        await expect(failure).rejects.toBeInstanceOf(ServiceError);
        await expect(failure).rejects.toThrow(/Minimum Custom Format Score can never be satisfied/);
    });
});

describe('updateQualityProfile on the recorded Radarr exchange', () => {
    it('sends the profile as read and accepts the 202', async () => {
        const request = fixture<Profile>('qualityprofile-put-request.json');
        const sent: Array<{ method: string; path: string; body: unknown }> = [];
        const impl = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            sent.push({ method: init?.method ?? 'GET', path: url.pathname, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
            return jsonResponse(fixture<unknown>('qualityprofile-put.json'), 202);
        }) as unknown as typeof fetch;

        await new RadarrAdapter(keyed(7878), impl).updateQualityProfile(request);

        expect(sent).toEqual([{ method: 'PUT', path: `/api/v3/qualityprofile/${request.id}`, body: request }]);
    });

    it('reads one profile by id', async () => {
        const impl = (async (input: string | URL | Request) => {
            expect(new URL(String(input)).pathname).toBe(`/api/v3/qualityprofile/${RECORDED.id}`);
            return jsonResponse(RECORDED);
        }) as unknown as typeof fetch;

        const read = await new RadarrAdapter(keyed(7878), impl).readQualityProfile(RECORDED.id);

        expect(read).toEqual(RECORDED);
    });

    it('reports the arr\'s own validation message on a 400, not just the status', async () => {
        const request = fixture<Profile>('qualityprofile-put-unsatisfiable-request.json');
        const impl = (async () => jsonResponse(fixture<unknown>('qualityprofile-put-unsatisfiable.json'), 400)) as unknown as typeof fetch;

        const failure = new RadarrAdapter(keyed(7878), impl).updateQualityProfile(request);

        await expect(failure).rejects.toMatchObject({ status: 400 });
        await expect(failure).rejects.toThrow(/Minimum Custom Format Score can never be satisfied/);
    });

    it('lists the profile ids get_profile_issues needs to name a profile', async () => {
        const list = fixture<Profile[]>('qualityprofile.json');
        const impl = (async (input: string | URL | Request) => {
            const path = new URL(String(input)).pathname;
            return jsonResponse(path === '/api/v3/qualityprofile' ? list : []);
        }) as unknown as typeof fetch;

        const data = await new RadarrAdapter(keyed(7878), impl).readProfileDiagnostics();

        expect(data.profiles.map(p => p.id)).toEqual(list.map(p => p.id));
    });
});
