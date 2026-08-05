import { describe, expect, it } from 'vitest';
import { fenceText } from '../src/core/fence.ts';
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

const fence = (title: string): string => fenceText(title, { service: 'radarr', field: 'title' });

const item = (over: ItemOverride = {}): MergedItem => {
    const merged: Record<string, unknown> = {
        kind: 'movie',
        title: fence('Some Film'),
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
    queue: { items: [], partial: [] },
    queueConfigured: true,
    rejections: [],
    prowlarrConfigured: true,
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

    it('reports an indeterminate Seerr status as blocking, never as ok', () => {
        // I5: Overseerr's own FAILED (and anything else the adapter cannot
        // map to pending/approved/declined) comes through as 'unknown'. That
        // must not fall through to "The request is unknown." reported `ok`.
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: undefined, presence: 'jellyfin_only' }),
            request: { status: 'unknown' }
        });
        expect(d.verdict.stage).toBe('request');
        expect(stepFor(d, 'request')?.status).toBe('blocked');
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

    it('blames the scan, not the library, when a scan is running and the library is missing it', () => {
        // I6: the same symptom-vs-cause argument applied to queue/file below
        // applies here — a scan already running *is why* the library does not
        // show it yet, and outranks blaming the library stage itself.
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ presence: 'arr_only', playback: undefined }),
            scan: { service: 'jellyfin', running: true }
        });
        expect(d.verdict.stage).toBe('scan');
        expect(d.verdict.summary).toMatch(/running/i);
        expect(stepFor(d, 'library')?.status).toBe('blocked');
    });
});

describe('buildChain — a symptom never outranks its cause', () => {
    const noFile = item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } });

    it('blames the stalled download rather than the missing file', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: noFile,
            queue: {
                items: [
                    {
                        service: 'sabnzbd',
                        id: '1',
                        title: 'Some.Film.2026',
                        status: 'stalled',
                        errorMessage: 'no connection to news server'
                    }
                ],
                partial: []
            }
        });
        expect(d.verdict.stage).toBe('queue');
        expect(d.verdict.summary).toMatch(/stalled|news server/i);
        // I1: a stalled download is the single most actionable failure in the
        // whole chain — it must never be the one case with no remedy.
        expect(d.verdict.remedy).toMatch(/download client|retry|remove/i);
    });

    it('reports an active download as the explanation, with what it is waiting on', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: noFile,
            queue: { items: [{ service: 'radarr', id: '1', title: 'Some.Film.2026', status: 'downloading', etaSeconds: 600 }], partial: [] }
        });
        expect(d.verdict.stage).toBe('queue');
        expect(d.verdict.summary).toMatch(/downloading/i);
        // Downloading is not a fault: nothing to fix, so nothing to suggest.
        // (I1: this must fail if the "no remedy for downloading" rule is
        // deleted — it does, because REMEDIES no longer has a static `queue`
        // entry for `remedy` to fall back to.)
        expect(d.verdict.remedy).toBeUndefined();
    });

    it('treats a completed-but-unimported download as its own kind of block, not "still downloading"', () => {
        // I2: `completed` is Radarr/Sonarr's status for a download waiting on
        // import — the broken import itself, most of the time. A regex over
        // stall/fail/error/paused reads "complete" as none of those and
        // reports "Still downloading.", which is actively misleading.
        const d = buildChain('some film', {
            ...healthy(),
            item: noFile,
            queue: { items: [{ service: 'radarr', id: '1', title: 'Some.Film.2026', status: 'completed' }], partial: [] }
        });
        expect(d.verdict.stage).toBe('queue');
        expect(d.verdict.summary).not.toMatch(/still downloading/i);
        expect(d.verdict.summary).toMatch(/import/i);
        expect(d.verdict.remedy).toMatch(/import/i);
    });

    it.each(['downloadClientUnavailable', 'warning', 'delay'])(
        'classifies Radarr/Sonarr queue status %s as a fault, not "still downloading"',
        status => {
            const d = buildChain('some film', {
                ...healthy(),
                item: noFile,
                queue: { items: [{ service: 'radarr', id: '1', title: 'Some.Film.2026', status }], partial: [] }
            });
            expect(d.verdict.stage).toBe('queue');
            expect(d.verdict.summary).not.toMatch(/still downloading/i);
        }
    );

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
            queue: { items: [{ service: 'radarr', id: '1', title: 'Some.Film.2026', status: 'downloading' }], partial: [] }
        });
        expect(stepFor(d, 'file')?.status).toBe('blocked');
    });
});

describe('buildChain — a symptom does not outrank a chain that is not actually broken (C1)', () => {
    it('does not let an unrelated queue row (a quality upgrade in flight) outrank a file already on disk', () => {
        const d = buildChain('some film', {
            ...healthy(),
            // item() defaults to hasFile: true.
            queue: { items: [{ service: 'radarr', id: '1', title: 'Some.Film.2026', status: 'downloading', etaSeconds: 600 }], partial: [] }
        });
        expect(d.verdict).toMatchObject({ stage: 'playable', certain: true });
    });

    it('does not let a stale indexer rejection outrank a file already on disk', () => {
        const d = buildChain('some film', {
            ...healthy(),
            rejections: [{ indexer: 'Indexer 1', at: '2020-01-01T00:00:00Z', reason: 'query failed', query: 'Some Film' }]
        });
        expect(d.verdict).toMatchObject({ stage: 'playable', certain: true });
    });

    it('does not let a running scan outrank a library that already has it', () => {
        const d = buildChain('some film', { ...healthy(), scan: { service: 'jellyfin', running: true } });
        expect(d.verdict).toMatchObject({ stage: 'playable', certain: true });
    });
});

describe('buildChain — title matching (I3)', () => {
    const noFileFor = (title: string, year: number): MergedItem =>
        item({ title: fence(title), year, acquisition: { service: 'radarr', monitored: true, hasFile: false } });

    const shortTitleCases: Array<[title: string, year: number, release: string]> = [
        ['Up', 2009, 'Up.2009.1080p.BluRay'],
        ['Top Gun', 1986, 'Top.Gun.1986.720p'],
        ['Se7en', 1995, 'Se7en.1995.1080p']
    ];

    it.each(shortTitleCases)('matches a short title (%s) that a >3-character word filter would starve', (title, year, release) => {
        const d = buildChain(title, {
            ...healthy(),
            item: noFileFor(title, year),
            queue: { items: [{ service: 'radarr', id: '1', title: release, status: 'downloading' }], partial: [] }
        });
        expect(d.verdict.stage).toBe('queue');
    });

    it('does not match a different film in the same franchise when the years disagree', () => {
        const d = buildChain('dune', {
            ...healthy(),
            item: noFileFor('Dune', 2021),
            queue: { items: [{ service: 'radarr', id: '1', title: 'Dune.Part.Two.2024.1080p', status: 'downloading' }], partial: [] }
        });
        // The queue row is correctly ignored as unrelated, so nothing
        // explains the missing file, and the verdict falls through to it.
        expect(d.verdict.stage).toBe('file');
    });

    it('does not match a pluralised sibling title', () => {
        const d = buildChain('alien', {
            ...healthy(),
            item: noFileFor('Alien', 1979),
            queue: { items: [{ service: 'radarr', id: '1', title: 'Aliens.1986.1080p', status: 'downloading' }], partial: [] }
        });
        expect(d.verdict.stage).toBe('file');
    });

    it('does not match an unrelated title sharing only a common word', () => {
        const d = buildChain('toy story', {
            ...healthy(),
            item: noFileFor('Toy Story', 1995),
            queue: { items: [{ service: 'radarr', id: '1', title: 'American.Horror.Story.S01E01', status: 'downloading' }], partial: [] }
        });
        expect(d.verdict.stage).toBe('file');
    });
});

describe('buildChain — certainty', () => {
    it('is uncertain when a stage before the verdict could not be checked', () => {
        // A real, blocked verdict (library) with an earlier stage on its
        // certainty path (request) unreachable — the mechanism this test
        // name describes, exercised against an actual blocking stage rather
        // than the no-verdict/playable path (see the dedicated test below).
        const d = buildChain('some film', {
            item: item({ presence: 'arr_only', playback: undefined }),
            request: undefined,
            queue: { items: [], partial: [] },
            queueConfigured: true,
            rejections: [],
            prowlarrConfigured: true,
            scan: { service: 'jellyfin', lastCompleted: '2026-08-05T02:00:00Z' },
            jellyfinConfigured: true,
            degraded: ['seerr']
        });

        expect(d.verdict.stage).toBe('library');
        expect(d.verdict.certain).toBe(false);
        expect(d.verdict.summary).toMatch(/could not check|seerr/i);
    });

    it('is uncertain about a playable verdict, and hedges the claim rather than asserting Jellyfin availability (C2)', () => {
        // §6.1 / C2: certain: false must not just ride along under an
        // unqualified positive claim. Reproduced with the shape review found
        // it with: library unreachable, presence arr_only.
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ presence: 'arr_only', playback: undefined }),
            degraded: ['jellyfin']
        });

        expect(d.verdict.stage).toBe('playable');
        expect(d.verdict.certain).toBe(false);
        expect(d.verdict.summary).not.toMatch(/is available in jellyfin/i);
        expect(d.verdict.summary).toMatch(/could not|jellyfin/i);
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

    it('stays certain about a missing-file verdict when only the library side is unreachable', () => {
        // Symmetric with the case above, one branch over: the verdict is
        // "nothing downloading, no indexer failure" (file). Jellyfin being
        // unreachable is downstream of that answer, not upstream of it.
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } }),
            degraded: ['jellyfin']
        });
        expect(d.verdict.stage).toBe('file');
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
            queue: { items: [], partial: [] },
            queueConfigured: true,
            rejections: [],
            prowlarrConfigured: true,
            scan: undefined,
            jellyfinConfigured: true,
            degraded: ['radarr']
        });
        expect(d.verdict).toMatchObject({ stage: 'resolve', certain: false });
    });
});

describe('buildChain — verdict order is pinned, not incidental (I7)', () => {
    it('request outranks managed when both are blocked', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: undefined, presence: 'jellyfin_only' }),
            request: { status: 'declined' }
        });
        expect(d.verdict.stage).toBe('request');
    });

    it('managed outranks the queue/file group when both are blocked', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: undefined, presence: 'jellyfin_only' }),
            queue: { items: [{ service: 'sabnzbd', id: '1', title: 'Some.Film.2026', status: 'downloading' }], partial: [] }
        });
        expect(d.verdict.stage).toBe('managed');
    });

    it('queue outranks indexers when both are blocked: a live queue row is current, a rejection is historical', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } }),
            queue: { items: [{ service: 'sabnzbd', id: '1', title: 'Some.Film.2026', status: 'stalled', errorMessage: 'x' }], partial: [] },
            rejections: [{ indexer: 'Indexer 1', at: '2026-08-05T09:00:00Z', reason: 'query failed', query: 'Some Film' }]
        });
        expect(d.verdict.stage).toBe('queue');
    });

    it('indexers outranks file when both are blocked', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } }),
            rejections: [{ indexer: 'Indexer 1', at: '2026-08-05T09:00:00Z', reason: 'query failed', query: 'Some Film' }]
        });
        expect(d.verdict.stage).toBe('indexers');
    });

    it('library outranks scan when only library is blocked (scan itself is fine)', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ presence: 'arr_only', playback: undefined })
        });
        expect(d.verdict.stage).toBe('library');
    });

    it('scan outranks library when both are blocked', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ presence: 'arr_only', playback: undefined }),
            scan: { service: 'jellyfin', running: true }
        });
        expect(d.verdict.stage).toBe('scan');
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

describe('buildChain — a stack without a download client or Prowlarr', () => {
    it('skips the queue stage rather than reporting it unknown', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } }),
            queue: undefined,
            queueConfigured: false
        });
        expect(stepFor(d, 'queue')?.status).toBe('skipped');
    });

    it('skips the indexers stage rather than reporting it unknown', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } }),
            rejections: undefined,
            prowlarrConfigured: false
        });
        expect(stepFor(d, 'indexers')?.status).toBe('skipped');
    });

    it('does not claim "no indexer reported a failure" about a service the user does not run', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } }),
            queue: undefined,
            queueConfigured: false,
            rejections: undefined,
            prowlarrConfigured: false
        });
        expect(d.verdict.stage).toBe('file');
        expect(d.verdict.remedy).not.toMatch(/no indexer reported a failure/i);
        expect(d.verdict.remedy).not.toMatch(/nothing is downloading/i);
    });

    it('does not report a queue as merely empty when one of several clients could not be reached (partial read)', () => {
        // The planned collector: one flaky torrent client must not erase rows
        // a different, healthy client already returned.
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } }),
            queue: { items: [], partial: ['transmission'] }
        });
        expect(stepFor(d, 'queue')?.status).toBe('unknown');
        expect(d.verdict.certain).toBe(false);
    });

    it('still reports a genuine blockage found on a client that did answer, even when another client in the same read failed', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } }),
            queue: {
                items: [{ service: 'sabnzbd', id: '1', title: 'Some.Film.2026', status: 'stalled', errorMessage: 'x' }],
                partial: ['transmission']
            }
        });
        expect(d.verdict.stage).toBe('queue');
        // A hole elsewhere in the same stage cannot undo evidence already in hand.
        expect(d.verdict.certain).toBe(true);
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
            queue: {
                items: [
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
                ],
                partial: []
            }
        });
        expect(d.verdict.summary).toContain('<<untrusted:sabnzbd.fail_message>>');
    });
});
