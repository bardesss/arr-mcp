import { describe, expect, it } from 'vitest';
import { fenceText } from '../src/core/fence.ts';
import { LibraryIndex, type ExternalIds, type IndexInput, type MergedItem } from '../src/core/resolver.ts';
import { unfenced } from '../src/core/titleMatch.ts';

// Production adapters fence every title before it reaches the resolver
// (radarr.ts and sonarr.ts write it as `<service>.title`, jellyfin.ts as
// `jellyfin.Name`) — bare-string fixtures are what let the search tiebreak
// bug (fixed alongside these factories) hide from every existing test.
// These factories fence too, so the merge and search tests below exercise
// what the resolver actually receives.
const fenceArr = (title: string, service: string = 'radarr'): string => fenceText(title, { service, field: 'title' });
const fenceJelly = (title: string): string => fenceText(title, { service: 'jellyfin', field: 'Name' });

/** Strips the fence so a test can assert against the human-readable title. */
const plainTitle = (item?: MergedItem): string => unfenced(item?.title ?? '');

const arr = (over: Partial<IndexInput> = {}): IndexInput => {
    const { title, ...rest } = over;
    return {
        kind: 'movie',
        title: fenceArr(title ?? 'Some Film', rest.acquisition?.service ?? 'radarr'),
        year: 2026,
        ids: { tmdb: 550 },
        acquisition: { service: 'radarr', monitored: true, hasFile: true },
        ...rest
    };
};

const jelly = (over: Partial<IndexInput> = {}): IndexInput => {
    const { title, ...rest } = over;
    return {
        kind: 'movie',
        title: fenceJelly(title ?? 'Some Film'),
        year: 2026,
        ids: { tmdb: 550 },
        playback: { user: 'Bartus', watched: true },
        ...rest
    };
};

describe('LibraryIndex merging', () => {
    it('merges an *arr and a Jellyfin record sharing a tmdb id', () => {
        const index = LibraryIndex.build([arr(), jelly()]);

        expect(index.size()).toBe(1);
        const item = index.find({ tmdb: 550 });
        expect(item?.acquisition?.service).toBe('radarr');
        expect(item?.playback?.watched).toBe(true);
        expect(item?.presence).toBe('both');
    });

    it('merges series on tvdb', () => {
        const index = LibraryIndex.build([
            arr({ kind: 'series', ids: { tvdb: 292157 }, acquisition: { service: 'sonarr', monitored: true, hasFile: true } }),
            jelly({ kind: 'series', ids: { tvdb: 292157 } })
        ]);

        expect(index.size()).toBe(1);
        expect(index.find({ tvdb: 292157 })?.presence).toBe('both');
    });

    it('merges on imdb when that is the only shared id', () => {
        // Radarr knows tmdb and imdb; Jellyfin knows only imdb.
        const index = LibraryIndex.build([
            arr({ ids: { tmdb: 550, imdb: 'tt0137523' } }),
            jelly({ ids: { imdb: 'tt0137523' } })
        ]);

        expect(index.size()).toBe(1);
        expect(index.find({ tmdb: 550 })?.presence).toBe('both');
        expect(index.find({ imdb: 'tt0137523' })?.presence).toBe('both');
    });

    it('keeps records with no shared id separate', () => {
        // No evidence they are the same item. Merging on title similarity is
        // how a remake gets fused with its original.
        const index = LibraryIndex.build([arr({ ids: { tmdb: 550 } }), jelly({ ids: { tmdb: 999 } })]);
        expect(index.size()).toBe(2);
    });

    it('does not merge a film with a series that shares an id number', () => {
        // tmdb 550 and tvdb 550 are unrelated namespaces.
        const index = LibraryIndex.build([
            arr({ kind: 'movie', ids: { tmdb: 550 } }),
            arr({ kind: 'series', ids: { tvdb: 550 } })
        ]);
        expect(index.size()).toBe(2);
    });

    it('finds a merged item by any of its ids', () => {
        const index = LibraryIndex.build([arr({ ids: { tmdb: 550, imdb: 'tt0137523' } }), jelly({ ids: { imdb: 'tt0137523' } })]);

        expect(index.find({ tmdb: 550 })).toBeDefined();
        expect(index.find({ imdb: 'tt0137523' })).toBeDefined();
        expect(index.find({ tmdb: 111 })).toBeUndefined();
    });

    it('fuses two already-separate groups when a later record bridges them on different ids', () => {
        // A Radarr record known only by tmdb, a duplicate Jellyfin library
        // copy known only by imdb — no shared id yet, so they form two
        // groups — and a second Jellyfin copy that carries both ids. That
        // third record cannot be reconciled with only one of the two
        // existing groups: keeping the first match and discarding the
        // second would silently orphan it (still counted in `all()`, no
        // longer reachable by its own id, `presence` computed from half
        // the evidence). Both groups must fuse into one.
        const index = LibraryIndex.build([
            arr({ ids: { tmdb: 1 } }),
            jelly({ ids: { imdb: 'tt9' } }),
            jelly({ ids: { tmdb: 1, imdb: 'tt9' } })
        ]);

        expect(index.size()).toBe(1);
        expect(index.all()).toHaveLength(1);

        const byTmdb = index.find({ tmdb: 1 });
        const byImdb = index.find({ imdb: 'tt9' });
        expect(byTmdb).toBeDefined();
        expect(byTmdb).toBe(byImdb);
        expect(byTmdb?.presence).toBe('both');
    });

    it('returns undefined for an empty id set rather than an arbitrary item', () => {
        const index = LibraryIndex.build([arr()]);
        expect(index.find({})).toBeUndefined();
    });

    it('lets a caller who knows the kind reach a series when a film shares its numeric id', () => {
        // TMDB's movie and TV id spaces are separate, but a recaptured Jellyfin
        // fixture shows a Series carrying a numeric Tmdb id too — so the two
        // can collide by coincidence. Without `kind`, find() scans movie keys
        // first and the series is unreachable.
        const index = LibraryIndex.build([
            arr({ kind: 'movie', title: 'The Film', ids: { tmdb: 224372 } }),
            arr({ kind: 'series', title: 'The Series', ids: { tmdb: 224372 }, acquisition: { service: 'sonarr', monitored: true, hasFile: true } })
        ]);

        expect(plainTitle(index.find({ tmdb: 224372 }, 'movie'))).toBe('The Film');
        expect(plainTitle(index.find({ tmdb: 224372 }, 'series'))).toBe('The Series');
        // Unspecified kind keeps today's behaviour: first match wins, movie first.
        expect(plainTitle(index.find({ tmdb: 224372 }))).toBe('The Film');
    });
});

describe('LibraryIndex byKey coherence after a bridging fuse', () => {
    // Three records: an *arr-only film known by tmdb, a Jellyfin-only record
    // known by tvdb+imdb, and a second Jellyfin record that bridges them by
    // carrying both. The bridge forces two already-separate groups to fuse
    // mid-build — exactly the shape that used to leave a stale `#byKey` entry
    // pointing at a group no longer present in `#items`.
    const bridged = () =>
        LibraryIndex.build([
            arr({ ids: { tmdb: 1 } }),
            jelly({ ids: { tvdb: 5, imdb: 'tt7' } }),
            jelly({ ids: { tmdb: 1, tvdb: 5, imdb: 'tt9' } })
        ]);

    it('fuses into exactly one item', () => {
        const index = bridged();
        expect(index.size()).toBe(1);
        expect(index.all()).toHaveLength(1);
    });

    it('finds the fused item by every id it still carries, and never a ghost for one it does not', () => {
        const index = bridged();
        const [item] = index.all();

        expect(index.find({ tmdb: 1 })).toBe(item);
        expect(index.find({ tvdb: 5 })).toBe(item);
        expect(index.find({ imdb: 'tt9' })).toBe(item);

        // tt7 belonged to the record that got absorbed; the survivor's ids no
        // longer include it (the bridge's tt9 supersedes it on merge), so a
        // coherent index must not answer for it with an object `all()` does
        // not contain.
        expect(index.find({ imdb: 'tt7' })).toBeUndefined();
    });

    it('reports presence that matches the evidence the fused item actually holds', () => {
        const index = bridged();
        const [item] = index.all();

        expect(item?.presence).toBe('both');
        expect(item?.acquisition).toBeDefined();
        expect(item?.playback).toBeDefined();
    });
});

describe('LibraryIndex — a spliced-out ghost must not win a later merge', () => {
    it("does not let record four's evidence vanish into an object outside items()", () => {
        // Same bridging shape as above, plus a fourth record whose only shared
        // id (`imdb: 'tt7'`) is exactly the key that stopped belonging to any
        // live item once the third record's bridge fused it away. Mid-build,
        // `#byKey` still maps that key to the spliced-out ghost. If that ghost
        // were allowed to win as `matches[0]`, `mergeInto` would write this
        // record's `playback` into an object `items` does not contain — no
        // new item gets created (`matches.length` is not zero), so the
        // evidence is not lost as a stale-but-visible ghost, it is lost
        // outright: nowhere in `all()`, and `find` on either of its own ids
        // resolves to nothing.
        const index = LibraryIndex.build([
            arr({ ids: { tmdb: 1 } }),
            jelly({ ids: { tvdb: 5, imdb: 'tt7' } }),
            jelly({ ids: { tmdb: 1, tvdb: 5, imdb: 'tt9' } }),
            jelly({ ids: { tmdb: 77, imdb: 'tt7' }, playback: { user: 'ReviewerFour', watched: true } })
        ]);

        expect(index.find({ tmdb: 77 })).toBeDefined();
        expect(index.all().some(i => i.playback?.user === 'ReviewerFour')).toBe(true);
    });
});

describe('LibraryIndex invariants', () => {
    // Two properties a coherent index must always hold, checked against every
    // id any *input* record ever mentioned — not just the ids the final
    // merged items still carry. A ghost is by definition reachable only
    // through a key some now-absorbed record used to own, so checking just
    // the survivors' own ids (which is all a per-item loop over `all()` could
    // see) would never exercise the bug this guards against.
    const assertCoherent = (inputs: readonly IndexInput[]): void => {
        const index = LibraryIndex.build(inputs);
        const all = index.all();

        for (const item of all) {
            // The full biconditional, not just "presence implies fields": an
            // item holding both fields must be labelled `both`, not merely
            // `arr_only` or `jellyfin_only` with the other field's presence
            // left unchecked — a one-directional version of this passes for
            // an item mislabelled `arr_only` despite carrying `playback` too.
            const expectedPresence =
                item.acquisition !== undefined && item.playback !== undefined
                    ? 'both'
                    : item.acquisition !== undefined
                      ? 'arr_only'
                      : item.playback !== undefined
                        ? 'jellyfin_only'
                        : 'unknown';
            expect(item.presence).toBe(expectedPresence);
        }

        const everyId: ExternalIds[] = [];
        for (const input of inputs) {
            if (input.ids.tmdb !== undefined) everyId.push({ tmdb: input.ids.tmdb });
            if (input.ids.tvdb !== undefined) everyId.push({ tvdb: input.ids.tvdb });
            if (input.ids.imdb !== undefined) everyId.push({ imdb: input.ids.imdb });
        }

        for (const ids of everyId) {
            const found = index.find(ids);
            // Undefined is fine — a superseded id is allowed to stop
            // resolving. What is never fine is resolving to an object `all()`
            // does not contain.
            if (found !== undefined) expect(all).toContain(found);
        }
    };

    it('holds for the bridging-fuse reproduction', () => {
        assertCoherent([
            arr({ ids: { tmdb: 1 } }),
            jelly({ ids: { tvdb: 5, imdb: 'tt7' } }),
            jelly({ ids: { tmdb: 1, tvdb: 5, imdb: 'tt9' } })
        ]);
    });

    it('holds for a plain merge, disjoint records, and an empty build', () => {
        assertCoherent([arr(), jelly()]);
        assertCoherent([arr({ ids: { tmdb: 550 } }), jelly({ ids: { tmdb: 999 } })]);
        assertCoherent([]);
    });
});

describe('LibraryIndex presence', () => {
    it('classifies an *arr-only item', () => {
        expect(LibraryIndex.build([arr()]).find({ tmdb: 550 })?.presence).toBe('arr_only');
    });

    it('classifies a Jellyfin-only item', () => {
        expect(LibraryIndex.build([jelly()]).find({ tmdb: 550 })?.presence).toBe('jellyfin_only');
    });

    it('classifies a merged item as both', () => {
        expect(LibraryIndex.build([arr(), jelly()]).find({ tmdb: 550 })?.presence).toBe('both');
    });

    it('is what makes a broken import visible', () => {
        // arr_only *with a file* is the signature §8 calls out: the *arr
        // believes the file is on disk and Jellyfin cannot see it.
        const item = LibraryIndex.build([arr({ acquisition: { service: 'radarr', monitored: true, hasFile: true } })]).find({ tmdb: 550 });

        expect(item?.presence).toBe('arr_only');
        expect(item?.acquisition?.hasFile).toBe(true);
    });
});

describe('LibraryIndex presence — a degraded or unconfigured Jellyfin must not assert arr_only (whole-phase review, item 1)', () => {
    // Reproduction: a whole library read with Jellyfin contributing nothing
    // (degraded, or never configured) used to report every *arr-managed item
    // as `arr_only` — which `get_library`'s own description reads as "Jellyfin
    // cannot see a file the *arr believes is on disk", a broken-import claim
    // for every row, when Jellyfin was in fact never asked at all.
    it('reports unknown, not arr_only, for an *arr-only item when jellyfinGathered is false', () => {
        const index = LibraryIndex.build([arr()], { jellyfinGathered: false });
        expect(index.find({ tmdb: 550 })?.presence).toBe('unknown');
    });

    it('still reports arr_only for the same item when Jellyfin was actually gathered (the healthy case)', () => {
        const index = LibraryIndex.build([arr()], { jellyfinGathered: true });
        expect(index.find({ tmdb: 550 })?.presence).toBe('arr_only');
    });

    it('defaults jellyfinGathered to true, so a caller that omits it keeps reporting arr_only', () => {
        // Every other call site in this codebase (and every other test in this
        // file) does not pass BuildOptions at all — the default must not
        // silently start reporting `unknown` everywhere.
        const index = LibraryIndex.build([arr()]);
        expect(index.find({ tmdb: 550 })?.presence).toBe('arr_only');
    });

    it('reports the whole library as unknown, not just items that also lack playback', () => {
        const index = LibraryIndex.build([arr({ ids: { tmdb: 1 } }), arr({ ids: { tmdb: 2 } })], {
            jellyfinGathered: false
        });
        for (const item of index.all()) expect(item.presence).toBe('unknown');
    });

    it('does not downgrade an item with genuine evidence from both halves', () => {
        // Real playback evidence beats a degraded-build flag meant for the
        // items that have no such evidence.
        const index = LibraryIndex.build([arr(), jelly()], { jellyfinGathered: false });
        expect(index.find({ tmdb: 550 })?.presence).toBe('both');
    });

    it('leaves jellyfin_only untouched by jellyfinGathered — that claim never depended on the *arr half', () => {
        const index = LibraryIndex.build([jelly()], { jellyfinGathered: false });
        expect(index.find({ tmdb: 550 })?.presence).toBe('jellyfin_only');
    });
});

describe('LibraryIndex merge details', () => {
    it('prefers the *arr title, which is the managed one', () => {
        const index = LibraryIndex.build([
            arr({ title: 'Some Film' }),
            jelly({ title: 'Some Film (Director&apos;s Cut)' })
        ]);
        expect(plainTitle(index.find({ tmdb: 550 }))).toBe('Some Film');
    });

    it('prefers the *arr title even when the Jellyfin record merges in first', () => {
        // The test above feeds arr() first, so its title is already correct
        // before jelly() merges in — that passes through mergeInto's no-op
        // branch (`target.title === ''` is false) and would still pass even
        // if the *arr-wins rule were deleted. Reversing the input order is
        // what actually exercises the rule: only mergeInto reading `input`'s
        // `acquisition` can make the second, *arr record's title win here.
        const index = LibraryIndex.build([
            jelly({ title: "Some Film (Director's Cut)" }),
            arr({ title: 'Some Film' })
        ]);
        expect(plainTitle(index.find({ tmdb: 550 }))).toBe('Some Film');
    });

    it('takes a year from whichever record has one', () => {
        // `exactOptionalPropertyTypes` distinguishes "absent" from "present but
        // undefined", so blanking out the default's year needs a real `delete`
        // (an absent key) rather than `{ year: undefined }` (which the type
        // system rejects as an explicit-undefined value for a `number` field).
        const arrWithoutYear = arr();
        delete (arrWithoutYear as { year?: number }).year;

        const index = LibraryIndex.build([arrWithoutYear, jelly({ year: 2026 })]);
        expect(index.find({ tmdb: 550 })?.year).toBe(2026);
    });

    it('unions ids across both halves', () => {
        const index = LibraryIndex.build([arr({ ids: { tmdb: 550 } }), jelly({ ids: { tmdb: 550, imdb: 'tt0137523' } })]);
        expect(index.find({ tmdb: 550 })?.ids).toEqual({ tmdb: 550, imdb: 'tt0137523' });
    });

    it('keeps ratings from the record that has them', () => {
        const index = LibraryIndex.build([arr({ ratings: { imdb: 8.8 } }), jelly()]);
        expect(index.find({ tmdb: 550 })?.ratings).toEqual({ imdb: 8.8 });
    });

    it('takes genres from whichever record has them, since get_library filters on them', () => {
        const index = LibraryIndex.build([arr({ genres: ['Science Fiction'] }), jelly()]);
        expect(index.find({ tmdb: 550 })?.genres).toEqual(['Science Fiction']);
    });
});

describe('LibraryIndex search', () => {
    const index = LibraryIndex.build([
        arr({ title: 'The Matrix', ids: { tmdb: 1 } }),
        arr({ title: 'Matrix Reloaded', ids: { tmdb: 2 } }),
        arr({ title: 'Enter the Matrix', ids: { tmdb: 3 } }),
        arr({ title: 'Blade Runner', ids: { tmdb: 4 } })
    ]);

    it('ranks exact above prefix above substring', () => {
        expect(index.search('matrix').map(i => unfenced(i.title))).toEqual([
            'The Matrix',
            'Matrix Reloaded',
            'Enter the Matrix'
        ]);
    });

    it('excludes non-matches rather than ranking them last', () => {
        expect(index.search('matrix').some(i => unfenced(i.title) === 'Blade Runner')).toBe(false);
    });

    it('returns an empty list for a query matching nothing', () => {
        expect(index.search('zzzz')).toEqual([]);
    });

    it('returns an empty list for an empty or punctuation-only query rather than the whole library', () => {
        expect(index.search('')).toEqual([]);
        expect(index.search('???')).toEqual([]);
    });

    it('matches through a leading article the caller omitted', () => {
        expect(plainTitle(index.search('the matrix')[0])).toBe('The Matrix');
    });

    it('breaks a rank tie by the real title, not by which service fenced it', () => {
        // Both titles are prefix matches for "matrix", so they tie on rank.
        // Every production title is fenced, and the fence prefix carries the
        // *service* name: "<<untrusted:jellyfin..." sorts before
        // "<<untrusted:radarr..." regardless of the title inside, so a
        // tiebreak on the raw fenced string would put "Zulu" ahead of
        // "Alpha" here. Comparing through unfenced() is what fixes that.
        const zulu: IndexInput = {
            kind: 'movie',
            title: fenceText('Matrix Zulu', { service: 'jellyfin', field: 'Name' }),
            ids: { tmdb: 101 }
        };
        const alpha: IndexInput = {
            kind: 'movie',
            title: fenceText('Matrix Alpha', { service: 'radarr', field: 'title' }),
            ids: { tmdb: 102 }
        };

        const tieIndex = LibraryIndex.build([zulu, alpha]);
        expect(tieIndex.search('matrix').map(i => unfenced(i.title))).toEqual(['Matrix Alpha', 'Matrix Zulu']);

        // Neither input carries acquisition or playback, so this also
        // exercises the 'unknown' presence branch — pinned here rather than
        // left merely reached, so a regression to 'jellyfin_only' (the old
        // fallthrough) would show up as a failure, not just as a branch this
        // test happened to execute in passing.
        for (const item of tieIndex.all()) expect(item.presence).toBe('unknown');
    });
});

describe('LibraryIndex.all', () => {
    it('returns every merged item once', () => {
        const index = LibraryIndex.build([arr(), jelly(), arr({ ids: { tmdb: 999 } })]);
        expect(index.all()).toHaveLength(2);
    });

    it('handles an empty input', () => {
        const index = LibraryIndex.build([]);
        expect(index.all()).toEqual([]);
        expect(index.size()).toBe(0);
    });

    it('hands out a snapshot a caller can copy without disturbing the index', () => {
        // A caller that shares a five-minute cached snapshot across tool
        // calls (Phase 3b's LibraryLoader) must not be able to corrupt it.
        // `assertAllIsReadonlyAtCompileTime` below (never invoked — tsc still
        // checks its body) proves the compiler rejects mutating the array
        // `all()` hands out directly. This proves that a caller who instead
        // makes a copy, as `readonly` pushes them to, cannot reach back into
        // the index through it.
        const index = LibraryIndex.build([arr(), jelly()]);
        const copy = [...index.all()];
        copy.sort(() => -1);
        copy.pop();

        expect(index.all()).toHaveLength(1);
        expect(index.size()).toBe(1);
    });
});

describe('season merging', () => {
    const sonarrHalf = {
        kind: 'series' as const,
        title: 'Some Show',
        ids: { tvdb: 292157 },
        acquisition: { service: 'sonarr', monitored: true, hasFile: true },
        seasons: [
            { season: 1, onDisk: 8, aired: 8, total: 8 },
            { season: 2, onDisk: 2, aired: 6, total: 10 }
        ]
    };
    const jellyfinHalf = {
        kind: 'series' as const,
        title: 'Some Show',
        ids: { tvdb: 292157 },
        playback: { user: 'Someone', watched: false },
        seasons: [
            { season: 1, watched: 8, lastPlayed: '2026-08-10T21:00:00Z' },
            { season: 2, watched: 2 }
        ]
    };

    it('joins each half of a season row instead of replacing the row', () => {
        const index = LibraryIndex.build([sonarrHalf, jellyfinHalf]);
        expect(index.find({ tvdb: 292157 })?.seasons).toEqual([
            { season: 1, onDisk: 8, aired: 8, total: 8, watched: 8, lastPlayed: '2026-08-10T21:00:00Z', complete: true },
            { season: 2, onDisk: 2, aired: 6, total: 10, watched: 2, complete: false }
        ]);
    });

    it('merges in either order — neither source may erase the other', () => {
        const forward = LibraryIndex.build([sonarrHalf, jellyfinHalf]).find({ tvdb: 292157 });
        const reverse = LibraryIndex.build([jellyfinHalf, sonarrHalf]).find({ tvdb: 292157 });
        expect(reverse?.seasons).toEqual(forward?.seasons);
    });

    it('leaves complete absent when no Sonarr manages the series', () => {
        // jellyfin_only: a real watched count and no denominator. `false` here
        // would put a finished season on a list of things still to watch.
        const [season] = LibraryIndex.build([jellyfinHalf]).find({ tvdb: 292157 })?.seasons ?? [];
        expect(season).not.toHaveProperty('complete');
    });

    it('leaves complete absent when Jellyfin has never seen the series', () => {
        // arr_only: the mirror case. Denominators, but nothing watched-shaped.
        const [season] = LibraryIndex.build([sonarrHalf]).find({ tvdb: 292157 })?.seasons ?? [];
        expect(season).not.toHaveProperty('complete');
    });

    it('leaves complete absent for a season TVDB reports as empty', () => {
        // 0 >= 0 is true, and "complete" for a season with no episodes is a
        // fiction rather than an answer.
        const empty = { ...jellyfinHalf, seasons: [{ season: 3, watched: 0 }] };
        const denom = { ...sonarrHalf, seasons: [{ season: 3, onDisk: 0, aired: 0, total: 0 }] };
        const [season] = LibraryIndex.build([denom, empty]).find({ tvdb: 292157 })?.seasons ?? [];
        expect(season).not.toHaveProperty('complete');
    });
});

/**
 * Never called — its only job is to be type-checked by `npm run typecheck`.
 * Each line below must fail to compile, proving `LibraryIndex.all()` returns
 * `readonly MergedItem[]` rather than `MergedItem[]`: a caller that sorts or
 * splices the array a five-minute cache handed out would corrupt the index
 * for every later call, and that must be a compile error, not a hope.
 */
function assertAllIsReadonlyAtCompileTime(items: readonly MergedItem[]): void {
    // @ts-expect-error - push is not on a readonly array
    items.push({} as never);
    // @ts-expect-error - sort is not on a readonly array
    items.sort();
    // @ts-expect-error - splice is not on a readonly array
    items.splice(0, 1);
    // @ts-expect-error - index assignment is not on a readonly array
    items[0] = {} as never;
}
void assertAllIsReadonlyAtCompileTime;
