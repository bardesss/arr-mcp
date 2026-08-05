import { describe, expect, it } from 'vitest';
import type { MergedItem } from '../src/core/resolver.ts';
import { buildChain, type Evidence } from '../src/tools/diagnose/chain.ts';

/**
 * Unlike `Partial<MergedItem>`, this lets a caller override a field to
 * `undefined` explicitly — e.g. `item({ acquisition: undefined })` for
 * "nothing manages it" — which `Partial<MergedItem>` cannot type under
 * `exactOptionalPropertyTypes` (its optional fields accept omission, not an
 * explicit `undefined` value).
 */
type ItemOverride = { [K in keyof MergedItem]?: MergedItem[K] | undefined };

const item = (over: ItemOverride = {}): MergedItem => {
    const merged: Record<string, unknown> = {
        kind: 'movie',
        title: '<<untrusted:radarr.title>>Some Film<</untrusted>>',
        year: 2026,
        ids: { tmdb: 550 },
        acquisition: { service: 'radarr', monitored: true, hasFile: true },
        playback: { user: 'Someone', watched: false },
        presence: 'both',
        ...over
    };
    // A field overridden to `undefined` should clear it back to "not
    // present", not leave the key assigned to `undefined` — the latter is
    // exactly what `exactOptionalPropertyTypes` exists to forbid.
    for (const key of Object.keys(merged)) {
        if (merged[key] === undefined) delete merged[key];
    }
    return merged as MergedItem;
};

/** Everything looked at, nothing wrong: the baseline every case perturbs. */
const healthy = (over: Partial<Evidence> = {}): Evidence => ({
    item: item(),
    request: null,
    queue: [],
    rejections: [],
    scan: { service: 'jellyfin', lastCompleted: '2026-08-05T02:00:00Z' },
    jellyfinConfigured: true,
    degraded: [],
    ...over
});

const stepFor = (d: ReturnType<typeof buildChain>, stage: string) => d.steps.find(s => s.stage === stage);

describe('buildChain — a healthy item', () => {
    it('reports every stage ok or skipped', () => {
        const d = buildChain('some film', healthy());
        expect(d.steps.every(s => s.status === 'ok' || s.status === 'skipped')).toBe(true);
    });

    it('verdicts as playable, and is certain about it', () => {
        const d = buildChain('some film', healthy());
        expect(d.verdict).toMatchObject({ stage: 'playable', certain: true });
    });

    it('reports the resolved item so the caller can check it matched the right thing', () => {
        const d = buildChain('some film', healthy());
        expect(d.resolved).toMatchObject({ title: item().title, year: 2026, ids: { tmdb: 550 } });
    });

    it('walks the stages in pipeline order', () => {
        expect(buildChain('some film', healthy()).steps.map(s => s.stage)).toEqual([
            'resolve',
            'request',
            'managed',
            'file',
            'queue',
            'indexers',
            'library',
            'scan'
        ]);
    });
});

describe('buildChain — each stage blocking in isolation', () => {
    it('stops at resolve when nothing knows the item', () => {
        const d = buildChain('nonexistent', { ...healthy(), item: undefined });
        expect(d.verdict.stage).toBe('resolve');
        expect(d.verdict.remedy).toMatch(/search_media|request/i);
        // No point reporting on stages that could not even be attempted.
        expect(stepFor(d, 'managed')?.status).toBe('skipped');
    });

    it('stops at request when it was declined', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: undefined, presence: 'jellyfin_only' }),
            request: { status: 'declined' }
        });
        expect(d.verdict.stage).toBe('request');
        expect(d.verdict.summary).toMatch(/declined/i);
    });

    it('reports a pending request as the blockage, not the missing file', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: undefined, presence: 'jellyfin_only' }),
            request: { status: 'pending' }
        });
        expect(d.verdict.stage).toBe('request');
        expect(d.verdict.remedy).toMatch(/approve/i);
    });

    it('stops at managed when nothing is managing it', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: undefined, presence: 'jellyfin_only' })
        });
        expect(d.verdict.stage).toBe('managed');
        expect(d.verdict.summary).toMatch(/not managed|Radarr|Sonarr/i);
    });

    it('stops at managed when it is present but unmonitored', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: false, hasFile: false } })
        });
        expect(d.verdict.stage).toBe('managed');
        expect(d.verdict.remedy).toMatch(/monitor/i);
    });

    it('stops at file when nothing explains the absence', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } })
        });
        expect(d.verdict.stage).toBe('file');
    });

    it('stops at library when the *arr has a file Jellyfin cannot see', () => {
        // §4.2: this is the broken import, and the reason the phase exists.
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ presence: 'arr_only', playback: undefined })
        });
        expect(d.verdict.stage).toBe('library');
        expect(d.verdict.summary).toMatch(/Jellyfin/);
    });

    it('blames the scan when the library is missing it and no scan has run since', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ presence: 'arr_only', playback: undefined }),
            scan: { service: 'jellyfin', running: true }
        });
        expect(stepFor(d, 'scan')?.detail).toMatch(/running/i);
    });
});

describe('buildChain — a symptom never outranks its cause', () => {
    const noFile = item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } });

    it('blames the stalled download rather than the missing file', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: noFile,
            queue: [
                {
                    service: 'sabnzbd',
                    id: '1',
                    title: 'Some.Film.2026',
                    status: 'stalled',
                    errorMessage: 'no connection to news server'
                }
            ]
        });
        expect(d.verdict.stage).toBe('queue');
        expect(d.verdict.summary).toMatch(/stalled|news server/i);
    });

    it('reports an active download as the explanation, with what it is waiting on', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: noFile,
            queue: [{ service: 'radarr', id: '1', title: 'Some.Film.2026', status: 'downloading', etaSeconds: 600 }]
        });
        expect(d.verdict.stage).toBe('queue');
        expect(d.verdict.summary).toMatch(/downloading/i);
        // Downloading is not a fault: nothing to fix, so nothing to suggest.
        expect(d.verdict.remedy).toBeUndefined();
    });

    it('blames a failing indexer when nothing is downloading', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: noFile,
            rejections: [{ indexer: 'Indexer 1', at: '2026-08-05T09:00:00Z', reason: 'query failed', query: 'Some Film' }]
        });
        expect(d.verdict.stage).toBe('indexers');
    });

    it('still reports the file step as blocked, because it is true', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: noFile,
            queue: [{ service: 'radarr', id: '1', title: 'Some.Film.2026', status: 'downloading' }]
        });
        expect(stepFor(d, 'file')?.status).toBe('blocked');
    });
});

describe('buildChain — certainty', () => {
    it('is uncertain when a stage before the verdict could not be checked', () => {
        // §6.1: with Jellyfin unreachable, diagnose must not report "it is not
        // in Jellyfin". It reports that it could not look.
        const d = buildChain('some film', {
            item: item({ presence: 'arr_only', playback: undefined }),
            request: null,
            queue: [],
            rejections: undefined,
            scan: undefined,
            jellyfinConfigured: true,
            degraded: ['jellyfin', 'prowlarr']
        });

        expect(d.verdict.certain).toBe(false);
        expect(d.verdict.summary).toMatch(/could not check|prowlarr/i);
    });

    it('names the services it could not reach', () => {
        const d = buildChain('some film', { ...healthy(), scan: undefined, degraded: ['jellyfin'] });
        expect(d.degraded).toEqual(['jellyfin']);
    });

    it('stays certain when the unknown stage comes after the verdict', () => {
        // The verdict is "nothing is managing it". Whether a scan has run since
        // cannot change that, so an unreachable Jellyfin costs no confidence.
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: undefined, presence: 'jellyfin_only' }),
            scan: undefined,
            degraded: ['jellyfin']
        });
        expect(d.verdict.stage).toBe('managed');
        expect(d.verdict.certain).toBe(true);
    });

    it('never claims playable while a stage is unknown', () => {
        const d = buildChain('some film', { ...healthy(), scan: undefined, degraded: ['jellyfin'] });
        if (d.verdict.stage === 'playable') expect(d.verdict.certain).toBe(false);
    });

    it('is uncertain about a resolve failure when a library service was down', () => {
        // "We do not have it" and "we could not look" are different answers.
        const d = buildChain('some film', {
            item: undefined,
            request: null,
            queue: [],
            rejections: [],
            scan: undefined,
            jellyfinConfigured: true,
            degraded: ['radarr']
        });
        expect(d.verdict).toMatchObject({ stage: 'resolve', certain: false });
    });
});

describe('buildChain — a stack without Jellyfin', () => {
    const noJellyfin = (over: Partial<Evidence> = {}): Evidence =>
        healthy({ jellyfinConfigured: false, scan: undefined, ...over });

    it('skips the library stage rather than reporting it unknown', () => {
        // "Jellyfin cannot see it" would be a lie about a service the user
        // never configured, and `unknown` would cost confidence for no reason.
        const d = buildChain('some film', noJellyfin({ item: item({ presence: 'arr_only', playback: undefined }) }));
        expect(stepFor(d, 'library')?.status).toBe('skipped');
        expect(stepFor(d, 'scan')?.status).toBe('skipped');
    });

    it('stays certain, and verdicts on the file being present', () => {
        const d = buildChain('some film', noJellyfin({ item: item({ presence: 'arr_only', playback: undefined }) }));
        expect(d.verdict).toMatchObject({ stage: 'playable', certain: true });
    });
});

describe('buildChain — fencing', () => {
    it('composes fenced titles without unwrapping them', () => {
        const d = buildChain('some film', healthy());
        expect(d.resolved?.title).toContain('<<untrusted:radarr.title>>');
        expect(JSON.stringify(d).match(/<<\/untrusted>>/g)?.length).toBeGreaterThan(0);
    });

    it('carries a queue error message through fenced', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } }),
            queue: [
                {
                    service: 'sabnzbd',
                    id: '1',
                    // Must plausibly match the item's title — queueStep's
                    // `mentions()` heuristic exists precisely to ignore
                    // unrelated queue entries, so a title that could not
                    // match anything would defeat the fencing check below.
                    title: 'Some.Film.2026',
                    status: 'failed',
                    errorMessage: '<<untrusted:sabnzbd.fail_message>>unpack failed<</untrusted>>'
                }
            ]
        });
        expect(d.verdict.summary).toContain('<<untrusted:sabnzbd.fail_message>>');
    });
});
