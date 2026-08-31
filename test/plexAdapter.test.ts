import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MultiUserServiceConfig } from '../src/config/schema.ts';
import { logger } from '../src/core/logger.ts';
import { PlexAdapter } from '../src/services/plex.ts';
import { jsonResponse, serving } from './helpers/serve.ts';

const read = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/plex', name), 'utf8'));

// Hand-built and unverified — nobody on this side runs Plex. See
// docs/superpowers/plans/2026-08-31-plex-adapter.md.
const IDENTITY = read('unverified-identity.json');
const ACCOUNTS = read('unverified-accounts.json');

const config = (over: Partial<MultiUserServiceConfig> = {}): MultiUserServiceConfig => ({
    url: 'http://192.0.2.10:32400',
    api_key: 'tok',
    timeout_ms: 10_000,
    allow_other_users: false,
    permissions: { safe_write: false, destructive: false },
    ...over
});

const plex = (routes: Record<string, unknown>, over: Partial<MultiUserServiceConfig> = {}) => {
    const adapter = new PlexAdapter(config(over), serving(routes));
    return { adapter };
};

describe('PlexAdapter', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reads the server version', async () => {
        const { adapter } = plex({ '/identity': IDENTITY });
        expect(await adapter.getVersion()).toBe('1.43.3.10896');
    });

    it('throws when /identity has no version field', async () => {
        const { adapter } = plex({ '/identity': { MediaContainer: {} } });
        await expect(adapter.getVersion()).rejects.toThrow(/version/);
    });

    it('reports exactly one user, the token owner, however many accounts the server lists', async () => {
        const { adapter } = plex({ '/identity': IDENTITY, '/accounts': ACCOUNTS });
        expect(await adapter.listUsers()).toEqual([{ id: '1', name: 'Bartus' }]);
    });

    it('falls back to default_user when the owner account has no usable name', async () => {
        const blank = { MediaContainer: { Account: [{ id: 1, name: '' }] } };
        const { adapter } = plex({ '/accounts': blank }, { default_user: 'Bartus' });
        expect(await adapter.listUsers()).toEqual([{ id: '1', name: 'Bartus' }]);
    });

    it('falls back to default_user when the owner row is missing entirely', async () => {
        const noOwner = { MediaContainer: { Account: [{ id: 2, name: 'Guest' }] } };
        const { adapter } = plex({ '/accounts': noOwner }, { default_user: 'Bartus' });
        expect(await adapter.listUsers()).toEqual([{ id: '1', name: 'Bartus' }]);
    });

    it('logs the unverified fallback exactly once across repeated calls', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
        const blank = { MediaContainer: { Account: [{ id: 1, name: '' }] } };
        const { adapter } = plex({ '/accounts': blank }, { default_user: 'Bartus' });

        await adapter.listUsers();
        await adapter.listUsers();

        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('names the config key when the owner cannot be identified and nothing is configured', async () => {
        const blank = { MediaContainer: { Account: [{ id: 1, name: '' }] } };
        const { adapter } = plex({ '/accounts': blank });
        await expect(adapter.listUsers()).rejects.toThrow(/default_user/);
    });

    it('returns a diagnosis rather than throwing when the server is unreachable', async () => {
        const { adapter } = plex({});
        const d = await adapter.testConnection();
        expect(d.ok).toBe(false);
        expect(d.service).toBe('plex');
    });

    it('returns a passing diagnosis with the reported version when the server answers', async () => {
        const { adapter } = plex({ '/identity': IDENTITY });
        const d = await adapter.testConnection();
        expect(d.ok).toBe(true);
        expect(d.version).toBe('1.43.3.10896');
    });

    describe('playback', () => {
        const SESSIONS = {
            MediaContainer: {
                Metadata: [
                    {
                        ratingKey: '1234',
                        type: 'episode',
                        title: 'Pilot',
                        grandparentTitle: 'Some Show',
                        parentIndex: 1,
                        index: 1,
                        duration: 2_700_000,
                        viewOffset: 600_000,
                        User: { id: '1', title: 'Bartus' },
                        Player: { title: 'Living Room TV' }
                    }
                ]
            }
        };

        // onDeck carries no per-user field (see the doc comment on
        // getPlayback), so an empty page is a legitimate stub for every
        // getPlayback case below that isn't itself testing onDeck.
        const EMPTY_MEDIA_CONTAINER = { MediaContainer: {} };

        it('reports what is playing now, with position and completion in seconds', async () => {
            const { adapter } = plex({ '/status/sessions': SESSIONS, '/library/onDeck': EMPTY_MEDIA_CONTAINER });
            const [entry] = await adapter.getPlayback({ id: '1', name: 'Bartus' });

            expect(entry).toMatchObject({
                service: 'plex',
                itemId: '1234',
                kind: 'now_playing',
                season: 1,
                episode: 1,
                user: 'Bartus',
                positionSeconds: 600,
                runtimeSeconds: 2700,
                percentComplete: 22,
                device: 'Living Room TV'
            });
        });

        it('excludes other users sessions', async () => {
            const other = {
                MediaContainer: {
                    Metadata: [{ ...SESSIONS.MediaContainer.Metadata[0], User: { id: '2', title: 'Guest' } }]
                }
            };
            const { adapter } = plex({ '/status/sessions': other, '/library/onDeck': EMPTY_MEDIA_CONTAINER });
            expect(await adapter.getPlayback({ id: '1', name: 'Bartus' })).toEqual([]);
        });

        it('matches a session whose User.id came back as a JSON number, not a string', async () => {
            // Plex's XML-derived JSON is inconsistent about id types. A strict
            // `===` against the string user id would drop every session and
            // read as "nothing playing" forever — see C1 in the fix report.
            const numericUser = {
                MediaContainer: {
                    Metadata: [{ ...SESSIONS.MediaContainer.Metadata[0], User: { id: 1, title: 'Bartus' } }]
                }
            };
            const { adapter } = plex({ '/status/sessions': numericUser, '/library/onDeck': EMPTY_MEDIA_CONTAINER });
            expect(await adapter.getPlayback({ id: '1', name: 'Bartus' })).toHaveLength(1);
        });

        it('omits the percentage rather than dividing by zero when duration is missing', async () => {
            const noDuration = { MediaContainer: { Metadata: [{ ratingKey: 'x', title: 'X', viewOffset: 1000, User: { id: '1' } }] } };
            const { adapter } = plex({ '/status/sessions': noDuration, '/library/onDeck': EMPTY_MEDIA_CONTAINER });
            expect((await adapter.getPlayback({ id: '1', name: 'Bartus' }))[0]?.percentComplete).toBeUndefined();
        });

        it('fences titles, which carry metadata we did not author', async () => {
            const { adapter } = plex({ '/status/sessions': SESSIONS, '/library/onDeck': EMPTY_MEDIA_CONTAINER });
            const [entry] = await adapter.getPlayback({ id: '1', name: 'Bartus' });
            expect(entry?.title.startsWith('<<untrusted:plex.')).toBe(true);
        });

        it('includes onDeck resume entries in getPlayback, with position, runtime and completion', async () => {
            const onDeck = {
                MediaContainer: {
                    Metadata: [{ ratingKey: 'r1', title: 'Resuming', viewOffset: 300_000, duration: 1_200_000 }]
                }
            };
            const { adapter } = plex({ '/status/sessions': EMPTY_MEDIA_CONTAINER, '/library/onDeck': onDeck });
            const entries = await adapter.getPlayback({ id: '1', name: 'Bartus' });
            expect(entries).toEqual([
                expect.objectContaining({
                    kind: 'resume',
                    itemId: 'r1',
                    positionSeconds: 300,
                    runtimeSeconds: 1200,
                    percentComplete: 25
                })
            ]);
        });

        it('excludes onDeck next-up rows (no viewOffset) from getPlayback', async () => {
            const onDeck = { MediaContainer: { Metadata: [{ ratingKey: 'n1', title: 'Next Episode' }] } };
            const { adapter } = plex({ '/status/sessions': EMPTY_MEDIA_CONTAINER, '/library/onDeck': onDeck });
            expect(await adapter.getPlayback({ id: '1', name: 'Bartus' })).toEqual([]);
        });

        it('turns an epoch lastViewedAt into an ISO timestamp', async () => {
            const history = {
                MediaContainer: { Metadata: [{ ratingKey: 'h1', title: 'A Film', lastViewedAt: 1_787_000_000, accountID: 1 }] }
            };
            const { adapter } = plex({ '/status/sessions/history/all': history });
            const [entry] = await adapter.getWatchHistory({ id: '1', name: 'Bartus' });
            expect(entry?.lastPlayed).toBe(new Date(1_787_000_000_000).toISOString());
        });

        it('filters server-wide history to the resolved user by accountID', async () => {
            // /status/sessions/history/all is server-wide — it carries every
            // account's rows, not just the token owner's. Attributing all of
            // them to `user.name` would report a household guest's viewing as
            // the owner's. See I4.
            const history = {
                MediaContainer: {
                    Metadata: [
                        { ratingKey: 'h1', title: 'Mine', accountID: 1 },
                        { ratingKey: 'h2', title: 'Guest', accountID: 2 }
                    ]
                }
            };
            const { adapter } = plex({ '/status/sessions/history/all': history });
            const entries = await adapter.getWatchHistory({ id: '1', name: 'Bartus' });
            expect(entries.map(e => e.itemId)).toEqual(['h1']);
        });

        it('matches a numeric accountID against the string user id', async () => {
            const history = { MediaContainer: { Metadata: [{ ratingKey: 'h1', title: 'Mine', accountID: 1 }] } };
            const { adapter } = plex({ '/status/sessions/history/all': history });
            expect(await adapter.getWatchHistory({ id: '1', name: 'Bartus' })).toHaveLength(1);
        });

        it('excludes a history row with no accountID rather than guessing whose it is', async () => {
            const history = { MediaContainer: { Metadata: [{ ratingKey: 'h1', title: 'No Account' }] } };
            const { adapter } = plex({ '/status/sessions/history/all': history });
            expect(await adapter.getWatchHistory({ id: '1', name: 'Bartus' })).toEqual([]);
        });

        it('reports onDeck rows with no viewOffset as next up', async () => {
            const onDeck = {
                MediaContainer: {
                    Metadata: [
                        { ratingKey: 'r1', title: 'Resuming', viewOffset: 300_000 },
                        { ratingKey: 'n1', title: 'Next Episode' }
                    ]
                }
            };
            const { adapter } = plex({ '/library/onDeck': onDeck });
            const nextUp = await adapter.getNextUp({ id: '1', name: 'Bartus' });
            expect(nextUp).toEqual([expect.objectContaining({ kind: 'next_up', itemId: 'n1' })]);
        });

        it('excludes onDeck rows with a non-zero viewOffset from next up — those are resumes', async () => {
            const onDeck = { MediaContainer: { Metadata: [{ ratingKey: 'r1', title: 'Resuming', viewOffset: 300_000 }] } };
            const { adapter } = plex({ '/library/onDeck': onDeck });
            expect(await adapter.getNextUp({ id: '1', name: 'Bartus' })).toEqual([]);
        });
    });

    describe('library', () => {
        const SECTIONS = { MediaContainer: { Directory: [{ key: '1', type: 'movie' }, { key: '2', type: 'show' }] } };
        const page = (items: unknown[]) => ({ MediaContainer: { Metadata: items } });
        const withPaging = (start: number, extra = '') => `?${extra}includeGuids=1&X-Plex-Container-Start=${start}&X-Plex-Container-Size=500`;

        it('contributes items from both a movie section and a show section', async () => {
            const { adapter } = plex({
                '/library/sections': SECTIONS,
                [`/library/sections/1/all${withPaging(0)}`]: page([{ ratingKey: 'm1', title: 'A Movie', type: 'movie' }]),
                [`/library/sections/2/all${withPaging(0)}`]: page([{ ratingKey: 's1', title: 'A Show', type: 'show' }])
            });
            const items = await adapter.listUserLibrary({ id: '1', name: 'Bartus' });
            expect(items.map(i => i.kind).sort()).toEqual(['movie', 'series']);
        });

        it('maps a positive viewCount to watched, and no viewCount to unwatched', async () => {
            const { adapter } = plex({
                '/library/sections': { MediaContainer: { Directory: [{ key: '1', type: 'movie' }] } },
                [`/library/sections/1/all${withPaging(0)}`]: page([
                    { ratingKey: 'm1', title: 'Watched', viewCount: 3 },
                    { ratingKey: 'm2', title: 'Unwatched' }
                ])
            });
            const items = await adapter.listUserLibrary({ id: '1', name: 'Bartus' });
            expect(items.find(i => i.title.includes('Watched'))?.playback?.watched).toBe(true);
            expect(items.find(i => i.title.includes('Unwatched'))?.playback?.watched).toBe(false);
        });

        it('marks a series watched only when every episode has been seen', async () => {
            // viewCount>0 is a movie's semantics; a show's own completion
            // counters are viewedLeafCount/leafCount. See I6.
            const { adapter } = plex({
                '/library/sections': { MediaContainer: { Directory: [{ key: '2', type: 'show' }] } },
                [`/library/sections/2/all${withPaging(0)}`]: page([
                    { ratingKey: 's1', title: 'Fully Watched', viewedLeafCount: 10, leafCount: 10 },
                    { ratingKey: 's2', title: 'Partly Watched', viewedLeafCount: 3, leafCount: 10 }
                ])
            });
            const items = await adapter.listUserLibrary({ id: '1', name: 'Bartus' });
            expect(items.find(i => i.title.includes('Fully'))?.playback?.watched).toBe(true);
            expect(items.find(i => i.title.includes('Partly'))?.playback?.watched).toBe(false);
        });

        it('omits watched for a series with no leaf counts, rather than guessing from viewCount', async () => {
            const { adapter } = plex({
                '/library/sections': { MediaContainer: { Directory: [{ key: '2', type: 'show' }] } },
                [`/library/sections/2/all${withPaging(0)}`]: page([{ ratingKey: 's1', title: 'Unknown', viewCount: 5 }])
            });
            const [item] = await adapter.listUserLibrary({ id: '1', name: 'Bartus' });
            expect(item?.playback?.watched).toBeUndefined();
        });

        it('carries external ids from Guid into IndexInput.ids', async () => {
            const { adapter } = plex({
                '/library/sections': { MediaContainer: { Directory: [{ key: '1', type: 'movie' }] } },
                [`/library/sections/1/all${withPaging(0)}`]: page([
                    { ratingKey: 'm1', title: 'A Movie', Guid: [{ id: 'tmdb://603' }, { id: 'imdb://tt0133093' }] }
                ])
            });
            const [item] = await adapter.listUserLibrary({ id: '1', name: 'Bartus' });
            expect(item?.ids).toEqual({ tmdb: 603, imdb: 'tt0133093' });
        });

        it('reads a library longer than one page to the end', async () => {
            const fullPage = Array.from({ length: 500 }, (_, i) => ({ ratingKey: `m${i}`, title: `Movie ${i}` }));
            const shortPage = Array.from({ length: 10 }, (_, i) => ({ ratingKey: `m${500 + i}`, title: `Movie ${500 + i}` }));
            const { adapter } = plex({
                '/library/sections': { MediaContainer: { Directory: [{ key: '1', type: 'movie' }] } },
                [`/library/sections/1/all${withPaging(0)}`]: page(fullPage),
                [`/library/sections/1/all${withPaging(500)}`]: page(shortPage)
            });
            const items = await adapter.listUserLibrary({ id: '1', name: 'Bartus' });
            expect(items).toHaveLength(510);
        });

        it('throws instead of looping forever when the server ignores the pagination window', async () => {
            // A server that ignores X-Plex-Container-Start/Size as query
            // parameters — Jellyfin does exactly this to a param it does not
            // recognise — would otherwise hand back the whole library on
            // every call, so `rows.length < PAGE_SIZE` never fires. See C2.
            const fullPage = Array.from({ length: 500 }, (_, i) => ({ ratingKey: `m${i}`, title: `Movie ${i}` }));
            const fetchImpl = (async (input: string | URL | Request) => {
                const raw = input instanceof Request ? input.url : String(input);
                const url = new URL(raw);
                if (url.pathname === '/library/sections') {
                    return jsonResponse({ MediaContainer: { Directory: [{ key: '1', type: 'movie' }] } });
                }
                if (url.pathname === '/library/sections/1/all') return jsonResponse(page(fullPage));
                return jsonResponse({ message: 'not found' }, 404);
            }) as unknown as typeof fetch;

            const adapter = new PlexAdapter(config(), fetchImpl);
            await expect(adapter.listUserLibrary({ id: '1', name: 'Bartus' })).rejects.toThrow(/paging|advance|ignor/i);
        }, 2000);

        it('aggregates per-season watch state onto the owning series, joined by external id', async () => {
            const { adapter } = plex({
                '/library/sections': { MediaContainer: { Directory: [{ key: '2', type: 'show' }] } },
                [`/library/sections/2/all${withPaging(0)}`]: page([
                    { ratingKey: 's1', title: 'A Show', Guid: [{ id: 'tvdb://121361' }] }
                ]),
                [`/library/sections/2/all${withPaging(0, 'type=4&')}`]: page([
                    { ratingKey: 'e1', grandparentRatingKey: 's1', parentIndex: 1, viewCount: 1 },
                    { ratingKey: 'e2', grandparentRatingKey: 's1', parentIndex: 1, viewCount: 0 }
                ])
            });
            const [series] = await adapter.listUserSeasons({ id: '1', name: 'Bartus' });
            expect(series).toMatchObject({ ids: { tvdb: 121361 }, seasons: [{ season: 1, watched: 1 }] });
        });

        it('drops a series with no external id — it could never join', async () => {
            const { adapter } = plex({
                '/library/sections': { MediaContainer: { Directory: [{ key: '2', type: 'show' }] } },
                [`/library/sections/2/all${withPaging(0)}`]: page([{ ratingKey: 's1', title: 'No Ids' }]),
                [`/library/sections/2/all${withPaging(0, 'type=4&')}`]: page([
                    { ratingKey: 'e1', grandparentRatingKey: 's1', parentIndex: 1, viewCount: 1 }
                ])
            });
            expect(await adapter.listUserSeasons({ id: '1', name: 'Bartus' })).toEqual([]);
        });
    });

    describe('search, details and scan state', () => {
        it('returns nothing for a source Plex cannot serve', async () => {
            const { adapter } = plex({});
            expect(await adapter.search('fight club', 'indexers')).toEqual([]);
        });

        it('maps a library search hit with its id, year and external ids', async () => {
            const results = {
                MediaContainer: {
                    Metadata: [
                        { ratingKey: '603', type: 'movie', title: 'The Matrix', year: 1999, Guid: [{ id: 'tmdb://603' }] },
                        { ratingKey: 'x', type: 'episode', title: 'Not a movie or show' }
                    ]
                }
            };
            const { adapter } = plex({ '/search?query=matrix': results });
            const hits = await adapter.search('matrix', 'library');
            expect(hits).toEqual([
                { service: 'plex', source: 'library', kind: 'movie', id: '603', title: expect.stringContaining('The Matrix'), year: 1999, ids: { tmdb: 603 } }
            ]);
        });

        it('refuses a non-numeric id before any network call', async () => {
            const fetchImpl = vi.fn(serving({}));
            const adapter = new PlexAdapter(config(), fetchImpl);
            await expect(adapter.getMediaDetails('not-a-rating-key')).rejects.toThrow(/rating key/);
            expect(fetchImpl).not.toHaveBeenCalled();
        });

        it('fences the summary and file path, which are metadata we did not author', async () => {
            const detail = {
                MediaContainer: {
                    Metadata: [
                        {
                            ratingKey: '603',
                            type: 'movie',
                            title: 'The Matrix',
                            summary: 'A hacker learns the truth.',
                            Media: [{ Part: [{ file: '/movies/The Matrix (1999).mkv', size: 123 }] }]
                        }
                    ]
                }
            };
            const { adapter } = plex({ '/library/metadata/603': detail });
            const details = await adapter.getMediaDetails('603');
            expect(details.overview?.startsWith('<<untrusted:plex.summary>>')).toBe(true);
            expect(details.path?.startsWith('<<untrusted:plex.file>>')).toBe(true);
            expect(details.sizeBytes).toBe(123);
        });

        it('answers kind: item for anything Plex does not call movie or show', async () => {
            // diagnose/evidence.ts uses `kind` to restrict its index scan; a
            // wrong kind silently misses real hits. An episode ratingKey
            // must not come back reading as a movie. See I7.
            const detail = { MediaContainer: { Metadata: [{ ratingKey: '1234', type: 'episode', title: 'Pilot' }] } };
            const { adapter } = plex({ '/library/metadata/1234': detail });
            expect((await adapter.getMediaDetails('1234')).kind).toBe('item');
        });

        it('answers kind: series for a show', async () => {
            const detail = { MediaContainer: { Metadata: [{ ratingKey: '5', type: 'show', title: 'A Show' }] } };
            const { adapter } = plex({ '/library/metadata/5': detail });
            expect((await adapter.getMediaDetails('5')).kind).toBe('series');
        });

        it('reports a scan as running when /activities lists a library-shaped activity', async () => {
            const { adapter } = plex({ '/activities': { MediaContainer: { Activity: [{ type: 'library.update.section' }] } } });
            expect((await adapter.getScanState()).running).toBe(true);
        });

        it('reports no scan running when /activities is empty', async () => {
            const { adapter } = plex({ '/activities': { MediaContainer: { Activity: [] } } });
            expect((await adapter.getScanState()).running).toBe(false);
        });

        it('does not report a running scan for an unrelated activity', async () => {
            const { adapter } = plex({ '/activities': { MediaContainer: { Activity: [{ type: 'media.generate.bif' }] } } });
            expect((await adapter.getScanState()).running).toBe(false);
        });
    });
});
