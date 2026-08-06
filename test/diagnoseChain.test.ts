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

/**
 * Every queue fixture used to pass an unfenced release title, while all
 * three adapters actually fence it (`arrQueue.ts`'s `title`, SABnzbd's
 * `filename`, Transmission's `name`). Matching still worked either way — the
 * fence markers are outside the word tokens `mentions()` compares — but an
 * unfenced fixture is not production shape. This fences per-service the same
 * way the real adapter does.
 */
const QUEUE_TITLE_FIELD: Record<string, string> = { radarr: 'title', sonarr: 'title', sabnzbd: 'filename', transmission: 'name' };
const queueTitle = (service: string, title: string): string =>
    fenceText(title, { service: service as Parameters<typeof fenceText>[1]['service'], field: QUEUE_TITLE_FIELD[service] ?? 'title' });

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
    libraryDegraded: [],
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
                        title: queueTitle('sabnzbd', 'Some.Film.2026'),
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
            queue: { items: [{ service: 'radarr', id: '1', title: queueTitle('radarr', 'Some.Film.2026'), status: 'downloading', etaSeconds: 600 }], partial: [] }
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
            queue: { items: [{ service: 'radarr', id: '1', title: queueTitle('radarr', 'Some.Film.2026'), status: 'completed' }], partial: [] }
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
                queue: { items: [{ service: 'radarr', id: '1', title: queueTitle('radarr', 'Some.Film.2026'), status }], partial: [] }
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
            queue: { items: [{ service: 'radarr', id: '1', title: queueTitle('radarr', 'Some.Film.2026'), status: 'downloading' }], partial: [] }
        });
        expect(stepFor(d, 'file')?.status).toBe('blocked');
    });
});

describe('buildChain — a symptom does not outrank a chain that is not actually broken (C1)', () => {
    it('does not let an unrelated queue row (a quality upgrade in flight) outrank a file already on disk', () => {
        const d = buildChain('some film', {
            ...healthy(),
            // item() defaults to hasFile: true.
            queue: { items: [{ service: 'radarr', id: '1', title: queueTitle('radarr', 'Some.Film.2026'), status: 'downloading', etaSeconds: 600 }], partial: [] }
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
            queue: { items: [{ service: 'radarr', id: '1', title: queueTitle('radarr', release), status: 'downloading' }], partial: [] }
        });
        expect(d.verdict.stage).toBe('queue');
    });

    it('does not match a different film in the same franchise when the years disagree', () => {
        const d = buildChain('dune', {
            ...healthy(),
            item: noFileFor('Dune', 2021),
            queue: { items: [{ service: 'radarr', id: '1', title: queueTitle('radarr', 'Dune.Part.Two.2024.1080p'), status: 'downloading' }], partial: [] }
        });
        // The queue row is correctly ignored as unrelated, so nothing
        // explains the missing file, and the verdict falls through to it.
        expect(d.verdict.stage).toBe('file');
    });

    it('does not match a pluralised sibling title', () => {
        const d = buildChain('alien', {
            ...healthy(),
            item: noFileFor('Alien', 1979),
            queue: { items: [{ service: 'radarr', id: '1', title: queueTitle('radarr', 'Aliens.1986.1080p'), status: 'downloading' }], partial: [] }
        });
        expect(d.verdict.stage).toBe('file');
    });

    it('does not match an unrelated title sharing only a common word', () => {
        const d = buildChain('toy story', {
            ...healthy(),
            item: noFileFor('Toy Story', 1995),
            queue: { items: [{ service: 'radarr', id: '1', title: queueTitle('radarr', 'American.Horror.Story.S01E01'), status: 'downloading' }], partial: [] }
        });
        expect(d.verdict.stage).toBe('file');
    });
});

describe('buildChain — certainty', () => {
    it('is uncertain when a stage before the verdict could not be checked', () => {
        // A real, blocked verdict (file — genuinely missing, nothing
        // downloading, no indexer failure) with an earlier stage on its
        // certainty path (request) unreachable — the mechanism this test
        // name describes, exercised against an actual blocking stage rather
        // than the no-verdict/playable path (see the dedicated test below).
        //
        // Deliberately *not* a `library` verdict: once `file` is confirmed
        // `ok`, request/managed are excluded from the certainty path
        // entirely (residual C1) — an unreachable Seerr has no bearing on
        // whether Jellyfin can see a file already confirmed to exist, so it
        // would not be a meaningful "stage before the verdict" example there.
        const d = buildChain('some film', {
            item: item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } }),
            request: undefined,
            queue: { items: [], partial: [] },
            queueConfigured: true,
            rejections: [],
            prowlarrConfigured: true,
            scan: { service: 'jellyfin', lastCompleted: '2026-08-05T02:00:00Z' },
            jellyfinConfigured: true,
            libraryDegraded: [],
            degraded: ['seerr']
        });

        expect(d.verdict.stage).toBe('file');
        expect(d.verdict.certain).toBe(false);
        expect(d.verdict.summary).toMatch(/could not check|seerr/i);
    });

    it('is uncertain about a playable verdict, and hedges the claim rather than asserting Jellyfin availability (C2)', () => {
        // §6.1 / C2: certain: false must not just ride along under an
        // unqualified positive claim. Reproduced with the shape review found
        // it with: library unreachable, presence arr_only. `libraryDegraded`
        // (item 2), not `degraded` — this is a library-read failure, and
        // `libraryStep` reads only `libraryDegraded` now.
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ presence: 'arr_only', playback: undefined }),
            libraryDegraded: ['jellyfin']
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
            libraryDegraded: ['jellyfin']
        });
        expect(d.verdict.stage).toBe('file');
        expect(d.verdict.certain).toBe(true);
    });

    it('never claims playable while the library stage itself is unknown', () => {
        // `libraryDegraded`, not `degraded`: this is the stage that actually
        // bears on "is it playable", so its own uncertainty must retract the
        // claim.
        const d = buildChain('some film', { ...healthy(), scan: undefined, libraryDegraded: ['jellyfin'] });
        if (d.verdict.stage === 'playable') expect(d.verdict.certain).toBe(false);
    });

    it('stays certain about a playable verdict when only an unrelated scan probe failed (item 2)', () => {
        // Reproduction: a failed `getScanState` used to erase a library read
        // that succeeded, because both fed the same flat `degraded` array —
        // here `presence: 'both'` is itself the library evidence (Jellyfin's
        // own playback data, from the same load), and a probe failure on a
        // different endpoint entirely must not retract certainty about it.
        const d = buildChain('some film', { ...healthy(), scan: undefined, degraded: ['jellyfin'] });
        expect(d.verdict).toMatchObject({ stage: 'playable', certain: true });
        expect(stepFor(d, 'library')?.status).toBe('ok');
        expect(stepFor(d, 'scan')?.status).toBe('unknown');
    });

    it('is uncertain about a resolve failure when a library service was down', () => {
        // "We do not have it" and "we could not look" are different answers.
        // `libraryDegraded`, not `degraded`: this models the library *read*
        // itself failing (item 2 of the whole-phase review), which is exactly
        // what leaves an item unresolved here — the top-level certainty check
        // must fold both arrays together, not just `degraded`.
        const d = buildChain('some film', {
            item: undefined,
            request: null,
            queue: { items: [], partial: [] },
            queueConfigured: true,
            rejections: [],
            prowlarrConfigured: true,
            scan: undefined,
            jellyfinConfigured: true,
            libraryDegraded: ['radarr'],
            degraded: []
        });
        expect(d.verdict).toMatchObject({ stage: 'resolve', certain: false });
        expect(d.degraded).toEqual(['radarr']);
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

    it('managed outranks the queue/file group when both are genuinely blocked', () => {
        // Not vacuous: `acquisition: undefined` alone always skips `file`
        // (there is no hasFile to read), so queue/indexers can never compete
        // regardless of ordering — that would make this test pass whether or
        // not "managed first" is actually implemented. `monitored: false`
        // with `hasFile: false` is the fixture where `file` is genuinely
        // `blocked` (not skipped) *and* `managed` is *also* blocked, so
        // queue/indexers really are in contention and the ordering matters.
        const d = buildChain('some film', {
            ...healthy(),
            item: item({
                acquisition: { service: 'radarr', monitored: false, hasFile: false },
                presence: 'arr_only',
                playback: undefined
            }),
            queue: { items: [{ service: 'sabnzbd', id: '1', title: queueTitle('sabnzbd', 'Some.Film.2026'), status: 'downloading' }], partial: [] }
        });
        expect(stepFor(d, 'file')?.status).toBe('blocked');
        expect(stepFor(d, 'queue')?.status).toBe('blocked');
        expect(d.verdict.stage).toBe('managed');
    });

    it('queue outranks indexers when both are blocked: a live queue row is current, a rejection is historical', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } }),
            queue: { items: [{ service: 'sabnzbd', id: '1', title: queueTitle('sabnzbd', 'Some.Film.2026'), status: 'stalled', errorMessage: 'x' }], partial: [] },
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
                items: [{ service: 'sabnzbd', id: '1', title: queueTitle('sabnzbd', 'Some.Film.2026'), status: 'stalled', errorMessage: 'x' }],
                partial: ['transmission']
            }
        });
        expect(d.verdict.stage).toBe('queue');
        // A hole elsewhere in the same stage cannot undo evidence already in hand.
        expect(d.verdict.certain).toBe(true);
    });
});

describe('buildChain — punctuated titles (N3 regression)', () => {
    // Round 1's `mentions()` used `normaliseTitle`, which *deletes*
    // intra-word punctuation ("Spider-Man" → "spiderman"), while a release
    // name is naturally *split* on the same characters
    // ("Spider.Man.2002" → "spider", "man", "2002"). Deleting on one side and
    // splitting on the other means neither ever produces matching tokens —
    // every hyphenated or apostrophed title matched nothing, and the queue
    // and indexer stages went blind for them.
    const noFileFor = (title: string, year: number): MergedItem =>
        item({ title: fence(title), year, acquisition: { service: 'radarr', monitored: true, hasFile: false } });

    const punctuatedCases: Array<[title: string, year: number, release: string]> = [
        ['Spider-Man', 2002, 'Spider.Man.2002.1080p'],
        ['Spider-Man', 2002, 'Spider-Man.2002.1080p'],
        ['WALL-E', 2008, 'WALL.E.2008.1080p'],
        ['Face/Off', 1997, 'Face.Off.1997.1080p'],
        ["Ocean's Eleven", 2001, "Ocean's.Eleven.2001.1080p"]
    ];

    it.each(punctuatedCases)('matches %s against release name %s', (title, year, release) => {
        const d = buildChain(title, {
            ...healthy(),
            item: noFileFor(title, year),
            queue: { items: [{ service: 'radarr', id: '1', title: queueTitle('radarr', release), status: 'downloading' }], partial: [] }
        });
        expect(d.verdict.stage).toBe('queue');
    });
});

describe("buildChain — the year guard ignores the title's own year words (N4)", () => {
    const noFileFor = (title: string, year: number): MergedItem =>
        item({ title: fence(title), year, acquisition: { service: 'radarr', monitored: true, hasFile: false } });

    const titleYearCases: Array<[title: string, year: number, release: string]> = [
        // A naive "first year-shaped token" guard picks 2049 here — the
        // title's own year — and rejects the real release year (2017).
        ['Blade Runner 2049', 2017, 'Blade.Runner.2049.2017.1080p'],
        // Same failure mode with a whole title that is a year.
        ['1917', 2019, '1917.2019.1080p'],
        ['2001: A Space Odyssey', 1968, '2001.A.Space.Odyssey.1968.1080p']
    ];

    it.each(titleYearCases)('matches %s (%i) even though the title itself contains a year-shaped word', (title, year, release) => {
        const d = buildChain(title, {
            ...healthy(),
            item: noFileFor(title, year),
            queue: { items: [{ service: 'radarr', id: '1', title: queueTitle('radarr', release), status: 'downloading' }], partial: [] }
        });
        expect(d.verdict.stage).toBe('queue');
    });

    it('skips the year guard entirely for a series, where the release year is an episode air year', () => {
        const d = buildChain('the simpsons', {
            ...healthy(),
            item: item({
                kind: 'series',
                title: fence('The Simpsons'),
                year: 1989,
                ids: { tvdb: 71663 },
                acquisition: { service: 'sonarr', monitored: true, hasFile: false },
                presence: 'arr_only',
                playback: undefined
            }),
            queue: {
                items: [{ service: 'sonarr', id: '1', title: queueTitle('sonarr', 'The.Simpsons.S32E01.2020'), status: 'downloading' }],
                partial: []
            }
        });
        expect(d.verdict.stage).toBe('queue');
    });
});

describe('buildChain — certainty is not laundered across an unreachable scan (N1)', () => {
    it('is uncertain about a library verdict when scan itself could not be checked, even though scan is not itself blocked', () => {
        // Round 1 only put `scan` on the certainty path when `scan` was
        // *already* `blocked` — the one state that cannot change the
        // verdict. With `library` blocked and `scan` merely `unknown` (could
        // not tell if a scan is running), the verdict stayed `library` with
        // `certain: true` and a remedy to "trigger a scan" — silent about
        // the possibility one is already running, which I6 established
        // outranks it.
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ presence: 'arr_only', playback: undefined }),
            scan: undefined
        });
        expect(d.verdict.stage).toBe('library');
        expect(d.verdict.certain).toBe(false);
        expect(d.verdict.summary).toMatch(/could not check/i);
    });
});

describe('buildChain — the file remedy matches what was actually checked (N2)', () => {
    it('hedges when queue and indexers are configured but unreachable, rather than asserting they were both checked', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } }),
            queue: undefined,
            rejections: undefined,
            degraded: ['sabnzbd', 'prowlarr']
        });
        expect(d.verdict.stage).toBe('file');
        expect(d.verdict.certain).toBe(false);
        // The old wording asserted both were checked; the caveat right next
        // to it says neither could be. The remedy must not contradict it.
        expect(d.verdict.remedy).not.toMatch(/nothing is downloading and no indexer reported a failure/i);
        expect(d.verdict.remedy).toMatch(/could not/i);
    });

    it('hedges specifically about the download client on a partial queue read, crediting indexers for genuinely being checked', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } }),
            queue: { items: [], partial: ['transmission'] }
        });
        expect(d.verdict.stage).toBe('file');
        expect(d.verdict.remedy).not.toMatch(/nothing is downloading and no indexer reported a failure/i);
        expect(d.verdict.remedy).toMatch(/download client/i);
        // Prowlarr genuinely was reachable and found nothing here — it must
        // not be named alongside the download client as also uncheckable.
        expect(d.verdict.remedy).not.toMatch(/indexer manager is configured|prowlarr could not/i);
    });

    it('does not confuse "not configured" with "checked and found nothing" — the original wording still applies when both genuinely were checked', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } })
        });
        expect(d.verdict.stage).toBe('file');
        expect(d.verdict.certain).toBe(true);
        expect(d.verdict.remedy).toMatch(/nothing is downloading and no indexer reported a failure/i);
    });
});

describe('buildChain — request/managed do not outrank a file already confirmed on disk (residual C1)', () => {
    it('does not blame an old declined request when the item is already on disk and visible in Jellyfin', () => {
        const d = buildChain('some film', {
            ...healthy(),
            // item() defaults to hasFile: true, presence: 'both'.
            request: { status: 'declined' }
        });
        expect(d.verdict).toMatchObject({ stage: 'playable', certain: true });
    });

    it('does not blame a pending request (the normal state of a second/4K request) when the item is already playable', () => {
        const d = buildChain('some film', {
            ...healthy(),
            request: { status: 'pending' }
        });
        expect(d.verdict).toMatchObject({ stage: 'playable', certain: true });
    });

    it('does not blame monitoring being off when the item is already on disk and visible in Jellyfin', () => {
        // "every hand-added Jellyfin item diagnoses as blocked" was the
        // failure mode: `monitored: false` alone used to always win.
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: false, hasFile: true } })
        });
        expect(d.verdict).toMatchObject({ stage: 'playable', certain: true });
    });

    it('blames the actual cause (library) rather than monitoring, when the file exists but Jellyfin cannot see it', () => {
        // The worst case: monitored: false + hasFile: true + arr_only used to
        // verdict `managed` with remedy "turn monitoring on" — a wrong
        // remedy, not just a wrong label, while `library` was genuinely
        // blocked and was the real cause.
        const d = buildChain('some film', {
            ...healthy(),
            item: item({
                acquisition: { service: 'radarr', monitored: false, hasFile: true },
                presence: 'arr_only',
                playback: undefined
            })
        });
        expect(d.verdict.stage).toBe('library');
        expect(d.verdict.remedy).not.toMatch(/monitor/i);
        expect(d.verdict.remedy).toMatch(/scan/i);
    });
});

describe('buildChain — a series file signal is ambiguous, so request/managed still compete there (round 3)', () => {
    // Sonarr's own `hasFile` (`src/services/sonarr.ts`: `episodeFileCount >
    // 0`) means "any episode has a file", not "the thing being asked about
    // is on disk" — unlike a movie, where `hasFile` is unambiguous. A show
    // sitting on seasons 1-4 satisfies `fileIsOk` while season 5, the actual
    // question, has never arrived. Excluding request/managed there the same
    // way movies do would silently drop the single most common series
    // diagnosis — "my show stopped getting new episodes because monitoring
    // got turned off" — under a confident "is available in Jellyfin and
    // playable", with no remedy and no mention: the exact failure the aside
    // (N7) exists to prevent, in a stage the aside does not cover.
    const seriesOnDisk = (over: ItemOverride = {}): MergedItem =>
        item({
            kind: 'series',
            title: fence('Some Show'),
            year: 2020,
            ids: { tvdb: 71663 },
            acquisition: { service: 'sonarr', monitored: true, hasFile: true },
            presence: 'both',
            ...over
        });

    it('blames monitoring being off — not "playable" — when seasons 1-4 are on disk and monitoring stopped', () => {
        const d = buildChain('some show', {
            ...healthy(),
            item: seriesOnDisk({ acquisition: { service: 'sonarr', monitored: false, hasFile: true } })
        });
        expect(d.verdict.stage).toBe('managed');
        expect(d.verdict.remedy).toMatch(/monitor/i);
    });

    it('blames the pending request — not "playable" — when seasons 1-4 are on disk and the season 5 request is pending', () => {
        const d = buildChain('some show', {
            ...healthy(),
            item: seriesOnDisk(),
            request: { status: 'pending' }
        });
        expect(d.verdict.stage).toBe('request');
        expect(d.verdict.remedy).toMatch(/approve/i);
    });

    it('leaves a movie in the identical shape verdicting playable — the exclusion is series-specific, not a general regression', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: false, hasFile: true } }),
            request: { status: 'pending' }
        });
        expect(d.verdict).toMatchObject({ stage: 'playable', certain: true });
    });

    it('still mentions, but does not verdict on, a genuinely faulted queue row for a healthy series (N7 continues to apply)', () => {
        const d = buildChain('some show', {
            ...healthy(),
            item: seriesOnDisk(),
            queue: {
                items: [
                    {
                        service: 'sabnzbd',
                        id: '1',
                        title: queueTitle('sabnzbd', 'Some.Show.S05E01.2026'),
                        status: 'stalled',
                        errorMessage: 'x'
                    }
                ],
                partial: []
            }
        });
        expect(d.verdict.stage).toBe('playable');
        expect(d.verdict.summary).toMatch(/stalled/i);
    });
});

describe('buildChain — the queue aside only appears once a file is actually confirmed (round 3)', () => {
    it('does not claim a file already exists in the aside when managed is blocked and there genuinely is no file yet', () => {
        // Round 2's aside was gated on `blocking.stage !== 'queue'` alone,
        // not on whether a file had been confirmed at all — so a `managed`
        // (or `request`) verdict with no file, alongside an unrelated queue
        // row that happens to fault, produced: "radarr has it, but it is
        // not monitored. (Also: Download failed: unpack failed. This does
        // not block the file already on disk…)" — asserting a file that was
        // never confirmed to exist.
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: false, hasFile: false } }),
            queue: {
                items: [
                    {
                        service: 'sabnzbd',
                        id: '1',
                        title: queueTitle('sabnzbd', 'Some.Film.2026'),
                        status: 'failed',
                        errorMessage: 'unpack failed'
                    }
                ],
                partial: []
            }
        });
        expect(d.verdict.stage).toBe('managed');
        expect(d.verdict.summary).not.toMatch(/already on disk/i);
    });
});

describe('buildChain — the haystack is unfenced before tokenising (round 3)', () => {
    it('does not let the fence markup itself — "untrusted", the service id, the field name — become a spurious matching token', () => {
        const d = buildChain('untrusted', {
            ...healthy(),
            item: item({ title: fence('Untrusted'), acquisition: { service: 'radarr', monitored: true, hasFile: false } }),
            queue: {
                // No year-shaped token in this release name: the point is to
                // isolate the fence-vocabulary bug from N4's year guard,
                // which would otherwise reject the match anyway (on a real
                // year mismatch) and mask whether *this* fix did anything.
                items: [{ service: 'sabnzbd', id: '1', title: queueTitle('sabnzbd', 'Completely.Unrelated.Movie.BluRay'), status: 'downloading' }],
                partial: []
            }
        });
        // Genuinely unrelated apart from the fence's own vocabulary, which
        // must not count as a match — before this fix, the needle was
        // unfenced but the haystack was not, so "untrusted" (present in
        // every fenced string) matched every fenced queue row.
        expect(d.verdict.stage).toBe('file');
    });
});

describe('buildChain — queue status classification (N5, N6)', () => {
    const noFile = item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } });

    it.each(['seeding', 'queued to seed'])(
        'classifies Transmission status %s as import-pending (the torrent itself finished), not "still downloading"',
        status => {
            const d = buildChain('some film', {
                ...healthy(),
                item: noFile,
                queue: { items: [{ service: 'transmission', id: '1', title: queueTitle('transmission', 'Some.Film.2026'), status }], partial: [] }
            });
            expect(d.verdict.stage).toBe('queue');
            expect(d.verdict.summary).not.toMatch(/still downloading/i);
            expect(d.verdict.summary).toMatch(/import/i);
            expect(d.verdict.remedy).toMatch(/import/i);
        }
    );

    it('classifies SABnzbd status "propagating" as active (healthy), not a fault', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: noFile,
            queue: { items: [{ service: 'sabnzbd', id: '1', title: queueTitle('sabnzbd', 'Some.Film.2026'), status: 'propagating' }], partial: [] }
        });
        expect(d.verdict.stage).toBe('queue');
        // "Active" is exactly what "propagating" is: no fault, no remedy —
        // "Still downloading" is the correct, healthy description of it.
        expect(d.verdict.remedy).toBeUndefined();
        expect(d.verdict.summary).toMatch(/still downloading/i);
    });

    it('reports an adapter\'s own "unknown" status sentinel as indeterminate, not a fault (I5\'s reasoning, applied to a queue row)', () => {
        // SABnzbd's `(s.status ?? 'unknown').toLowerCase()` and
        // Transmission's `TORRENT_STATUS[...] ?? 'unknown'` fall back to the
        // literal string "unknown" for a status code they cannot map. That
        // is the service answering with something this module cannot
        // classify — the same situation I5 fixed for a Seerr request status.
        const d = buildChain('some film', {
            ...healthy(),
            item: noFile,
            queue: { items: [{ service: 'transmission', id: '1', title: queueTitle('transmission', 'Some.Film.2026'), status: 'unknown' }], partial: [] }
        });
        expect(stepFor(d, 'queue')?.status).toBe('unknown');
        expect(d.verdict.certain).toBe(false);
    });
});

describe('buildChain — a queue fault does not outrank an already-playable file, but is not swallowed either (N7)', () => {
    it('mentions a failing upgrade grab in the playable summary without changing the verdict', () => {
        const d = buildChain('some film', {
            ...healthy(),
            // item() defaults to hasFile: true — a working file already exists.
            queue: {
                items: [
                    {
                        service: 'sabnzbd',
                        id: '1',
                        title: queueTitle('sabnzbd', 'Some.Film.2026'),
                        status: 'failed',
                        errorMessage: 'unpack failed'
                    }
                ],
                partial: []
            }
        });
        expect(d.verdict.stage).toBe('playable');
        expect(d.verdict.summary).toMatch(/unpack failed/i);
    });

    it('does not mention a merely active (non-fault) queue row — that would just be C1 undone', () => {
        const d = buildChain('some film', {
            ...healthy(),
            queue: {
                items: [{ service: 'radarr', id: '1', title: queueTitle('radarr', 'Some.Film.2026'), status: 'downloading', etaSeconds: 600 }],
                partial: []
            }
        });
        expect(d.verdict.stage).toBe('playable');
        expect(d.verdict.summary).not.toMatch(/downloading/i);
    });
});

describe('buildChain — degraded is read the same way for every stage (N8)', () => {
    it('reports indexers as unreachable when Prowlarr is named in degraded, even if rejections happens to be present', () => {
        // `scanStep`/`queueStep` already treat `degraded` (probe reachability
        // — item 2 keeps it separate from `libraryStep`'s `libraryDegraded`)
        // as authoritative over their own dedicated field; `indexerStep` used
        // to only ever consult `ev.rejections === undefined`.
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } }),
            rejections: [],
            degraded: ['prowlarr']
        });
        expect(stepFor(d, 'indexers')?.status).toBe('unknown');
    });

    it('treats a queue-capable service named in degraded as unreachable even when the collector did not also add it to partial', () => {
        const d = buildChain('some film', {
            ...healthy(),
            item: item({ acquisition: { service: 'radarr', monitored: true, hasFile: false } }),
            queue: { items: [], partial: [] },
            degraded: ['sabnzbd']
        });
        expect(stepFor(d, 'queue')?.status).toBe('unknown');
        expect(d.verdict.certain).toBe(false);
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
                        title: queueTitle('sabnzbd', 'Some.Film.2026'),
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
