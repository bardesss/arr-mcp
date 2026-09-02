import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.ts';
import { classifyFetchError } from '../src/core/errors.ts';
import {
    anonymisePlexAccounts,
    anonymisePlexHistory,
    createAccountIdMapper,
    hostsInAuthorityPosition,
    hostsOf,
    neutralisePlexWatchState,
    redact,
    redactHosts,
    redactPlexSessions,
    replaceIfString,
    secretsOf
} from '../scripts/lib/redact.ts';

const TOKEN = 'a'.repeat(64);

const configWith = (url: string) =>
    ConfigSchema.parse({
        auth: { bearer_token: TOKEN, password_hash: 'scrypt$00$11' },
        services: { radarr: { url, api_key: 'k' } }
    });

/**
 * The shape the flat `(service as { url: string }).url` cast could not see:
 * radarr as a *list* of named instances. Every host and key below was invisible
 * to redaction, so the refuse-to-write gate had nothing to match on.
 */
const multiInstanceConfig = () =>
    ConfigSchema.parse({
        auth: { bearer_token: TOKEN, password_hash: 'scrypt$00$11' },
        services: {
            radarr: [
                { name: 'hd', url: 'http://192.168.1.20:7878', api_key: 'hdkey' },
                { name: '4k', url: 'http://192.168.1.21:7878', api_key: 'fourkkey' }
            ],
            sabnzbd: { url: 'http://192.168.1.30:8080', api_key: 'sabkey' }
        }
    });

describe('hostsOf', () => {
    it('extracts both the host and the bare hostname of every configured service', () => {
        const config = configWith('http://192.168.1.20:7878');
        expect(hostsOf(config)).toEqual(expect.arrayContaining(['192.168.1.20:7878', '192.168.1.20']));
    });

    it('sorts longest first, so a host:port match wins before the bare hostname inside it', () => {
        const hosts = hostsOf(configWith('http://192.168.1.20:7878'));
        expect(hosts.indexOf('192.168.1.20:7878')).toBeLessThan(hosts.indexOf('192.168.1.20'));
    });

    it('extracts the host of every instance of a multi-instance service', () => {
        expect(hostsOf(multiInstanceConfig())).toEqual(
            expect.arrayContaining(['192.168.1.20:7878', '192.168.1.21:7878'])
        );
    });

    it('still extracts hosts of single-block services alongside them', () => {
        expect(hostsOf(multiInstanceConfig())).toEqual(expect.arrayContaining(['192.168.1.30:8080']));
    });

    it('redacts a message naming the second instance, which the flat cast missed entirely', () => {
        expect(redactHosts('reached 192.168.1.21:7878', hostsOf(multiInstanceConfig()))).not.toContain('192.168.1.21');
    });
});

describe('secretsOf', () => {
    it('collects the api_key of every instance of a multi-instance service', () => {
        expect(secretsOf(multiInstanceConfig())).toEqual(expect.arrayContaining(['hdkey', 'fourkkey']));
    });

    it('collects credentials of single-block services alongside them', () => {
        expect(secretsOf(multiInstanceConfig())).toContain('sabkey');
    });

    it('collects a password as well as an api_key', () => {
        const config = ConfigSchema.parse({
            auth: { bearer_token: TOKEN, password_hash: 'scrypt$00$11' },
            services: { transmission: { url: 'http://10.0.0.5:9091', username: 'u', password: 'pw' } }
        });
        expect(secretsOf(config)).toContain('pw');
    });
});

describe('redactHosts', () => {
    it('replaces every occurrence of a configured host', () => {
        const hosts = ['192.168.1.20:7878', '192.168.1.20'];
        expect(redactHosts('reached 192.168.1.20:7878 twice: 192.168.1.20:7878', hosts)).not.toContain('192.168.1.20');
    });

    it('leaves text with no configured host untouched', () => {
        expect(redactHosts('5 of 5 indexer(s).', ['192.168.1.20:7878'])).toBe('5 of 5 indexer(s).');
    });

    /**
     * The exact scenario the review flagged: `classifyFetchError` deliberately
     * embeds the host in `ServiceError.message` for a live connectivity
     * failure (`src/core/errors.ts`) — the case scripts/integration.ts never
     * exercised in its first live run, because every configured service was
     * reachable. Reproduced here with the same ECONNREFUSED shape
     * `test/errors.test.ts` uses, so the host-in-message premise is not
     * assumed — it is the same fixture the errors suite already trusts.
     */
    it('strips the host classifyFetchError deliberately embeds in a live connectivity failure', () => {
        const config = configWith('http://192.168.1.20:7878');
        const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        const err = classifyFetchError(cause, 'radarr', 'http://192.168.1.20:7878');

        expect(err.message).toContain('192.168.1.20:7878'); // the premise: it really is embedded
        expect(redactHosts(err.message, hostsOf(config))).not.toContain('192.168.1.20');
    });
});

/**
 * The pipeline that stands between a live credential and a public repository.
 * It had no test at all: the review found the multi-instance hole above only
 * by reading it, and nothing here would have caught a regression.
 */
describe('redact', () => {
    const secrets = ['hdkey'];
    const hosts = ['192.168.1.20:7878', '192.168.1.20'];

    it('replaces an exact secret wherever it appears in a string', () => {
        expect(redact('key=hdkey', secrets, hosts)).toBe('key=__REDACTED__');
    });

    it('replaces a value by key name even when the value was never in the config', () => {
        expect(redact({ api_key: 'somethingelse' }, secrets, hosts)).toEqual({ api_key: '__REDACTED__' });
    });

    it('redacts a session id, which rotates and looks exactly like a credential', () => {
        expect(redact({ 'session-id': 'abc' }, secrets, hosts)).toEqual({ 'session-id': '__REDACTED__' });
    });

    it('recurses into nested objects and arrays', () => {
        expect(redact({ outer: [{ inner: { api_key: 'x' } }] }, secrets, hosts)).toEqual({
            outer: [{ inner: { api_key: '__REDACTED__' } }]
        });
    });

    it('rewrites a private IPv4 address that was never a configured host', () => {
        expect(redact('seeded from 10.1.2.3', secrets, hosts)).toBe('seeded from 192.0.2.10');
    });

    it('leaves a version-shaped number alone, which a blanket IPv4 pattern would have eaten', () => {
        expect(redact('version 4.0.14.2939', secrets, hosts)).toBe('version 4.0.14.2939');
    });

    /**
     * I4: a Plex transcode URL nests one address inside another via
     * percent-encoding (`%2F127.0.0.1%3A32400`). The old pattern anchored on
     * `\b`, and the `F`/`1` boundary right before the literal is word-to-word
     * (both `\w`), so `\b` never fired there and the address survived intact.
     */
    it('rewrites a private IPv4 literal immediately after a percent-encoded slash, where \\b does not fire', () => {
        const out = redact('url=http%3A%2F%2F127.0.0.1%3A32400%2Fphoto', secrets, hosts) as string;
        expect(out).not.toContain('127.0.0.1');
    });

    // PRIVATE_IPV4 is IPv4-only. Unproven against a live server (nobody who
    // ran capture had IPv6 anywhere in a response), but a ULA, link-local or
    // loopback literal reaching a public fixture is the failure this exists
    // to prevent, so it is covered here anyway. See G4.
    it('rewrites a unique-local IPv6 address (fc00::/7)', () => {
        expect(redact('seeded from fd12:3456:789a:1::1', secrets, hosts)).not.toContain('fd12:3456:789a:1::1');
    });

    it('rewrites a link-local IPv6 address (fe80::/10)', () => {
        expect(redact('seeded from fe80::abcd:1234:5678:9abc', secrets, hosts)).not.toContain('fe80::abcd:1234:5678:9abc');
    });

    /**
     * N2: fe80::/10 runs from fe80 through febf — the old pattern hardcoded
     * the literal `fe80` first hextet, so fe81/fe90/fea0/febf (any other
     * value in the same /10) sailed straight through unredacted.
     */
    it('rewrites every first-hextet value in the fe80::/10 range, not only the literal fe80', () => {
        expect(redact('seeded from fe81::1', secrets, hosts)).not.toContain('fe81::1');
        expect(redact('seeded from fe90::1', secrets, hosts)).not.toContain('fe90::1');
        expect(redact('seeded from fea0::1', secrets, hosts)).not.toContain('fea0::1');
        expect(redact('seeded from febf::1', secrets, hosts)).not.toContain('febf::1');
    });

    it('leaves fe70:: and fec0:: alone — just outside the fe80::/10 range', () => {
        expect(redact('seeded from fe70::1', secrets, hosts)).toBe('seeded from fe70::1');
        expect(redact('seeded from fec0::1', secrets, hosts)).toBe('seeded from fec0::1');
    });

    it('rewrites the IPv6 loopback literal', () => {
        expect(redact('seeded from ::1', secrets, hosts)).not.toContain('::1');
    });

    it('leaves a global unicast IPv6 address alone, same treatment as a public IPv4', () => {
        expect(redact('seeded from 2001:db8:85a3::8a2e:370:7334', secrets, hosts)).toBe('seeded from 2001:db8:85a3::8a2e:370:7334');
    });

    it('replaces a configured host with the anonymous host', () => {
        expect(redact('http://192.168.1.20:7878/api', secrets, hosts)).toContain('service.example.test');
    });

    /**
     * B1: a Docker service named `plex` (the common name for the container)
     * makes the old blind substring replace rewrite every `plex://` guid and
     * every brand name containing "plex" — measured on the tester's server as
     * 500 guids corrupted plus `Aniplex` becoming `Aniservice.example.test`.
     * The fix anchors on authority position (`(?<=\/\/|@)` + a delimiter
     * lookahead) instead of matching the host anywhere in the string.
     */
    describe('a configured host that collides with a Plex guid scheme (B1)', () => {
        const plexHosts = ['plex'];

        it('redacts the host only when it sits in authority position, leaving a same-named guid scheme alone', () => {
            const payload = {
                guid: 'plex://movie/5d776b8e96b655001fe14e31',
                configured: 'http://plex:32400/library/sections',
                studio: 'Aniplex'
            };
            const out = redact(payload, [], plexHosts) as typeof payload;
            expect(out.guid).toBe('plex://movie/5d776b8e96b655001fe14e31');
            expect(out.configured).not.toContain('plex:32400');
            expect(out.configured).toContain('service.example.test');
            expect(out.studio).toBe('Aniplex');
        });

        it('redacts a host that appears after an embedded-credential @, not only after //', () => {
            expect(redact('scheme://user@plex:32400/x', [], plexHosts)).not.toContain('@plex:32400');
        });

        it('does not redact the host when it is not in authority position at all', () => {
            expect(redact('the word plex appears here', [], plexHosts)).toBe('the word plex appears here');
        });
    });

    it('escapes regex metacharacters in a host, so a dotted IP does not also match a look-alike', () => {
        const ipHosts = ['192.168.7.37'];
        expect(redact('http://192a168x7y37/api', [], ipHosts)).toBe('http://192a168x7y37/api');
        expect(redact('http://192.168.7.37/api', [], ipHosts)).toContain('service.example.test');
    });

    it('leaves an empty or null value at a secret key alone, so shape is preserved', () => {
        expect(redact({ api_key: '' }, secrets, hosts)).toEqual({ api_key: '' });
        expect(redact({ api_key: null }, secrets, hosts)).toEqual({ api_key: null });
    });

    it('leaves ordinary values untouched', () => {
        expect(redact({ title: 'The Fellowship of the Ring', year: 2001 }, secrets, hosts)).toEqual({
            title: 'The Fellowship of the Ring',
            year: 2001
        });
    });
});

/**
 * C1: `capture-fixtures.ts`'s write-refusal gate used to be a blind substring
 * check (`serialised.includes(host)`) while `redact()` above had already
 * moved to authority-position matching — so a host named `plex` tripped the
 * gate on ordinary text like `agent: "tv.plex.agents.movie"` or
 * `scanner: "Plex Movie"`, refusing to write every endpoint after the first.
 * `hostsInAuthorityPosition` is what the gate calls instead, built from the
 * exact pattern `redactAuthorities` replaces on, so the two cannot disagree.
 */
describe('hostsInAuthorityPosition (C1: gate and scrubber share one predicate)', () => {
    it('is false for a host appearing only as a Plex agent identifier, not in authority position', () => {
        const serialised = JSON.stringify({ agent: 'tv.plex.agents.movie', scanner: 'Plex Movie', studio: 'Aniplex' });
        expect(hostsInAuthorityPosition(serialised, ['plex'])).toBe(false);
    });

    it('is true for a host that survived in authority position', () => {
        expect(hostsInAuthorityPosition('http://plex:32400/x', ['plex'])).toBe(true);
    });

    it('is false when there are no configured hosts', () => {
        expect(hostsInAuthorityPosition('http://plex:32400/x', [])).toBe(false);
    });

    it('never fires on what redact() itself leaves behind, for the exact payload that broke the old gate', () => {
        const payload = {
            agent: 'tv.plex.agents.movie',
            scanner: 'Plex Movie',
            studio: 'Aniplex',
            configured: 'http://plex:32400/library/sections'
        };
        const out = JSON.stringify(redact(payload, [], ['plex']));
        expect(hostsInAuthorityPosition(out, ['plex'])).toBe(false);
    });
});

/**
 * `ondeck` (resume list) and `history` (complete watch history) were captured
 * with no anonymiser at all before this fix — a stranger's viewing habits
 * would have gone straight into a public repository. Both shapes are
 * `MediaContainer.Metadata`, same as `PlexAdapter#paged` and `/status/sessions`.
 */
describe('neutralisePlexWatchState', () => {
    const onDeck = (rows: Record<string, unknown>[]) => ({ MediaContainer: { size: rows.length, Metadata: rows } });

    it('replaces viewOffset, viewCount and lastViewedAt rather than leaving the real values', () => {
        const body = onDeck([{ ratingKey: '1', viewOffset: 842_193, viewCount: 4, lastViewedAt: 1_735_689_600 }]);
        const [row] = (neutralisePlexWatchState(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect(row?.viewOffset).not.toBe(842_193);
        expect(row?.viewCount).not.toBe(4);
        expect(row?.lastViewedAt).not.toBe(1_735_689_600);
    });

    it('replaces viewedLeafCount, which is a per-account episode-progress counter', () => {
        const body = onDeck([{ ratingKey: '1', viewedLeafCount: 7, leafCount: 10 }]);
        const [row] = (neutralisePlexWatchState(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect(row?.viewedLeafCount).not.toBe(7);
    });

    it('keeps every neutralised key present with its original type, not stripped', () => {
        const body = onDeck([{ ratingKey: '1', viewOffset: 1, viewCount: 1, lastViewedAt: 1, viewedLeafCount: 1 }]);
        const [row] = (neutralisePlexWatchState(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect(typeof row?.viewOffset).toBe('number');
        expect(typeof row?.viewCount).toBe('number');
        expect(typeof row?.lastViewedAt).toBe('number');
        expect(typeof row?.viewedLeafCount).toBe('number');
    });

    it('leaves a key absent when the real row never had it, preserving shape', () => {
        const body = onDeck([{ ratingKey: '1', title: 'A Film' }]);
        const [row] = (neutralisePlexWatchState(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect('viewOffset' in (row as object)).toBe(false);
        expect('lastViewedAt' in (row as object)).toBe(false);
    });

    it('leaves ratingKey, title and accountID untouched — the adapter filters history on accountID', () => {
        const body = onDeck([{ ratingKey: '1', title: 'A Film', accountID: 7, viewCount: 1 }]);
        const [row] = (neutralisePlexWatchState(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect(row?.ratingKey).toBe('1');
        expect(row?.title).toBe('A Film');
        expect(row?.accountID).toBe(7);
    });

    it('is a no-op on a body with no Metadata array, like /identity or /activities', () => {
        const body = { MediaContainer: { version: '1.32.0' } };
        expect(neutralisePlexWatchState(body)).toEqual(body);
    });

    // History rows are documented and widely observed to carry `viewedAt`,
    // not `lastViewedAt` — if the anonymiser only checked the latter, a real
    // watch timestamp would sail straight into a public fixture. Both
    // spellings are handled so the anonymiser does not depend on a guess.
    it('replaces viewedAt as well as lastViewedAt, since a live server may send either', () => {
        const body = onDeck([{ ratingKey: '1', viewedAt: 1_735_689_600 }]);
        const [row] = (neutralisePlexWatchState(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect(row?.viewedAt).not.toBe(1_735_689_600);
        expect(typeof row?.viewedAt).toBe('number');
    });

    it('replaces deviceID, which names the real playback device', () => {
        const body = onDeck([{ ratingKey: '1', deviceID: 'a1b2c3d4-real-device' }]);
        const [row] = (neutralisePlexWatchState(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect(row?.deviceID).not.toBe('a1b2c3d4-real-device');
    });
});

/**
 * `/status/sessions/history/all` and `/library/onDeck` are records, not
 * listings — a row exists only because someone watched or is watching that
 * title. `neutralisePlexWatchState` alone leaves the real title standing next
 * to a fake timestamp, which is still the tester's complete viewing record.
 * `anonymisePlexHistory` additionally breaks the row-to-title association.
 */
describe('anonymisePlexHistory', () => {
    const history = (rows: Record<string, unknown>[]) => ({ MediaContainer: { Metadata: rows } });

    it('does not let a real title survive into the anonymised output', () => {
        const body = history([{ ratingKey: '1', title: 'The Real Movie Title', accountID: 1, viewedAt: 1_735_689_600 }]);
        const out = JSON.stringify(anonymisePlexHistory(body));
        expect(out).not.toContain('The Real Movie Title');
    });

    it('replaces title, grandparentTitle and parentTitle with deterministic synthetic values', () => {
        const body = history([
            { ratingKey: '1', title: 'Episode Title', grandparentTitle: 'Series Title', parentTitle: 'Season Title' }
        ]);
        const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect(row?.title).not.toBe('Episode Title');
        expect(row?.grandparentTitle).not.toBe('Series Title');
        expect(row?.parentTitle).not.toBe('Season Title');
        expect(typeof row?.title).toBe('string');
    });

    it('scrubs thumb, art and key, which can carry a real slug', () => {
        const body = history([
            { ratingKey: '1', thumb: '/library/metadata/1/thumb/123', art: '/library/metadata/1/art/123', key: '/library/metadata/1' }
        ]);
        const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect(row?.thumb).not.toBe('/library/metadata/1/thumb/123');
        expect(row?.art).not.toBe('/library/metadata/1/art/123');
        expect(row?.key).not.toBe('/library/metadata/1');
    });

    it('still neutralises watch-state numbers, same as neutralisePlexWatchState', () => {
        const body = history([{ ratingKey: '1', viewOffset: 842_193, viewCount: 4 }]);
        const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect(row?.viewOffset).not.toBe(842_193);
        expect(row?.viewCount).not.toBe(4);
    });

    it('keeps ratingKey and accountID untouched — the adapter filters and joins on them', () => {
        const body = history([{ ratingKey: '1', title: 'A Film', accountID: 7 }]);
        const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect(row?.ratingKey).toBe('1');
        expect(row?.accountID).toBe(7);
    });

    it('keeps every scrubbed key present with its original type, not stripped', () => {
        const body = history([{ ratingKey: '1', title: 'A Film', thumb: '/x' }]);
        const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect('title' in (row as object)).toBe(true);
        expect('thumb' in (row as object)).toBe(true);
    });

    it('leaves a key absent when the real row never had it, preserving shape', () => {
        const body = history([{ ratingKey: '1' }]);
        const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect('title' in (row as object)).toBe(false);
        expect('grandparentTitle' in (row as object)).toBe(false);
    });

    it('is a no-op on a body with no Metadata array', () => {
        const body = { MediaContainer: { version: '1.32.0' } };
        expect(anonymisePlexHistory(body)).toEqual(body);
    });

    /**
     * B2: the tester's server carried real values in every one of these on
     * top of the four title fields already handled — a fixed top-level key
     * list drifts the moment Plex adds a field, so these are reached by
     * recursing into the row rather than by naming each one again.
     */
    describe('fields beyond the original top-level four (B2)', () => {
        it('scrubs titleSort, grandparentSlug, summary and studio', () => {
            const body = history([
                {
                    ratingKey: '1',
                    titleSort: 'Real Sort Title',
                    grandparentSlug: 'real-series-slug',
                    summary: 'A real plot summary that names the show.',
                    studio: 'Real Studio Name'
                }
            ]);
            const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
                .MediaContainer.Metadata;
            expect(row?.titleSort).not.toBe('Real Sort Title');
            expect(row?.grandparentSlug).not.toBe('real-series-slug');
            expect(row?.summary).not.toBe('A real plot summary that names the show.');
            expect(row?.studio).not.toBe('Real Studio Name');
            expect(typeof row?.summary).toBe('string');
        });

        it('scrubs grandparentArt and grandparentTheme, thumb-like fields beyond the ones already named', () => {
            const body = history([
                { ratingKey: '1', grandparentArt: '/library/metadata/9/art/1', grandparentTheme: '/library/metadata/9/theme/1' }
            ]);
            const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
                .MediaContainer.Metadata;
            expect(row?.grandparentArt).not.toBe('/library/metadata/9/art/1');
            expect(row?.grandparentTheme).not.toBe('/library/metadata/9/theme/1');
        });

        it('scrubs Media[].Part[].file, which routinely encodes series, season, episode title and release group', () => {
            const realPath = '/tv/Real Show Name/Season 01/Real Show Name - S01E02 - Real Episode Title [RLSGRP].mkv';
            const body = history([{ ratingKey: '1', Media: [{ Part: [{ file: realPath, size: 123 }] }] }]);
            const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
                .MediaContainer.Metadata;
            const media = row?.Media as { Part: { file?: unknown; size?: unknown }[] }[];
            expect(media).toHaveLength(1);
            expect(media[0]?.Part).toHaveLength(1);
            expect(media[0]?.Part[0]?.file).not.toBe(realPath);
            // size is not identifying — preserved so the fixture still contracts getMediaDetails' sizeBytes mapping.
            expect(media[0]?.Part[0]?.size).toBe(123);
        });

        it('scrubs cast and crew names nested in Role, Director, Writer and Producer', () => {
            const body = history([
                {
                    ratingKey: '1',
                    Role: [{ tag: 'Real Actor Name', thumb: 'https://example/real-actor.jpg', role: 'Character Name' }],
                    Director: [{ tag: 'Real Director Name' }],
                    Writer: [{ tag: 'Real Writer Name' }],
                    Producer: [{ tag: 'Real Producer Name' }]
                }
            ]);
            const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
                .MediaContainer.Metadata;
            const role = (row?.Role as Record<string, unknown>[])[0];
            expect(role?.tag).not.toBe('Real Actor Name');
            expect(role?.thumb).not.toBe('https://example/real-actor.jpg');
            expect((row?.Director as Record<string, unknown>[])[0]?.tag).not.toBe('Real Director Name');
            expect((row?.Writer as Record<string, unknown>[])[0]?.tag).not.toBe('Real Writer Name');
            expect((row?.Producer as Record<string, unknown>[])[0]?.tag).not.toBe('Real Producer Name');
        });

        it('leaves Genre tags alone — a category name, not personal data', () => {
            const body = history([{ ratingKey: '1', Genre: [{ tag: 'Action' }, { tag: 'Comedy' }] }]);
            const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
                .MediaContainer.Metadata;
            expect((row?.Genre as Record<string, unknown>[]).map(g => g.tag)).toEqual(['Action', 'Comedy']);
        });

        it('scrubs Guid ids while preserving the scheme, so a real tmdb/imdb/tvdb id does not survive', () => {
            const body = history([{ ratingKey: '1', Guid: [{ id: 'imdb://tt1234567' }, { id: 'tmdb://98765' }] }]);
            const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
                .MediaContainer.Metadata;
            const guids = row?.Guid as Record<string, unknown>[];
            expect(guids[0]?.id).not.toBe('imdb://tt1234567');
            expect(guids[0]?.id).toMatch(/^imdb:\/\//);
            expect(guids[1]?.id).not.toBe('tmdb://98765');
            expect(guids[1]?.id).toMatch(/^tmdb:\/\//);
        });

        it('preserves array length and other fields on a Media/Part row untouched by the walk', () => {
            const body = history([
                { ratingKey: '1', Media: [{ container: 'mkv', videoResolution: '1080', Part: [{ file: '/x.mkv', size: 1, duration: 5000 }] }] }
            ]);
            const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
                .MediaContainer.Metadata;
            const media = (row?.Media as Record<string, unknown>[])[0];
            expect(media?.container).toBe('mkv');
            expect(media?.videoResolution).toBe('1080');
            expect(((media?.Part as Record<string, unknown>[])[0] as Record<string, unknown>).duration).toBe(5000);
        });
    });
});

/**
 * C3: `anonymiseNested` rewrote `Guid[].id` but not the top-level lowercase
 * `guid`/`parentGuid`/`grandparentGuid` — a `plex://` guid resolves to a
 * title through plex.tv, and the legacy `com.plexapp.agents.*` form names an
 * external id directly, so either re-links a row `anonymisePlexHistory`
 * exists to sever from what it names.
 */
describe('anonymisePlexHistory scrubs top-level guid fields (C3)', () => {
    const history = (rows: Record<string, unknown>[]) => ({ MediaContainer: { Metadata: rows } });

    it('does not let a real plex:// guid survive, while keeping the scheme', () => {
        const body = history([{ ratingKey: '1', guid: 'plex://episode/5d9c0863bd2f6a001f6a3fa0' }]);
        const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect(row?.guid).not.toBe('plex://episode/5d9c0863bd2f6a001f6a3fa0');
        expect(row?.guid).toMatch(/^plex:\/\//);
    });

    it('does not let a real legacy-agent guid survive', () => {
        const body = history([{ ratingKey: '1', guid: 'com.plexapp.agents.thetvdb://121361/1/2?lang=en' }]);
        const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect(row?.guid).not.toBe('com.plexapp.agents.thetvdb://121361/1/2?lang=en');
    });

    it('scrubs parentGuid and grandparentGuid the same way', () => {
        const body = history([{ ratingKey: '1', parentGuid: 'plex://season/abc123', grandparentGuid: 'plex://show/def456' }]);
        const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect(row?.parentGuid).not.toBe('plex://season/abc123');
        expect(row?.grandparentGuid).not.toBe('plex://show/def456');
    });

    it('leaves a key absent when the real row never had it, preserving shape', () => {
        const body = history([{ ratingKey: '1' }]);
        const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect('guid' in (row as object)).toBe(false);
    });
});

/**
 * I2: `Image` entries (`{alt: <title>, type, url: /library/metadata/...}`)
 * were not reached at all — `alt` is the title again, and `url` is a slug
 * that can carry a real id, the same class of leak `thumb`/`art`/`key`
 * already get.
 */
describe('anonymisePlexHistory scrubs Image alt/url (I2)', () => {
    const history = (rows: Record<string, unknown>[]) => ({ MediaContainer: { Metadata: rows } });

    it('scrubs Image[].alt and Image[].url', () => {
        const body = history([
            { ratingKey: '1', Image: [{ alt: 'The Real Movie Title', type: 'coverPoster', url: '/library/metadata/1/thumb/123' }] }
        ]);
        const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        const image = (row?.Image as Record<string, unknown>[])[0];
        expect(image?.alt).not.toBe('The Real Movie Title');
        expect(image?.url).not.toBe('/library/metadata/1/thumb/123');
        expect(image?.type).toBe('coverPoster');
    });
});

/**
 * Minor: `Collection[].tag` and `Label[].tag` are user-authored names, the
 * same class of thing `Role[].tag` already gets scrubbed as — unlike
 * `Genre[].tag`, which is taxonomy and stays untouched.
 */
describe('anonymisePlexHistory scrubs Collection and Label tags', () => {
    const history = (rows: Record<string, unknown>[]) => ({ MediaContainer: { Metadata: rows } });

    it('scrubs Collection[].tag and Label[].tag while leaving Genre[].tag alone', () => {
        const body = history([
            {
                ratingKey: '1',
                Collection: [{ tag: 'My Personal Collection' }],
                Label: [{ tag: 'My Personal Label' }],
                Genre: [{ tag: 'Action' }]
            }
        ]);
        const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect((row?.Collection as Record<string, unknown>[])[0]?.tag).not.toBe('My Personal Collection');
        expect((row?.Label as Record<string, unknown>[])[0]?.tag).not.toBe('My Personal Label');
        expect((row?.Genre as Record<string, unknown>[])[0]?.tag).toBe('Action');
    });
});

/**
 * Minor: the Guid synthetic id used to be `tmdb://fixture-1` — a non-numeric
 * suffix that made `externalIds()` (src/services/plex.ts) return `{}` for
 * that row, since it requires digits-only after a `tmdb`/`tvdb` scheme.
 */
describe('anonymisePlexHistory produces a numeric synthetic Guid id', () => {
    const history = (rows: Record<string, unknown>[]) => ({ MediaContainer: { Metadata: rows } });

    it('replaces a tmdb Guid id with a purely numeric synthetic value', () => {
        const body = history([{ ratingKey: '1', Guid: [{ id: 'tmdb://98765' }] }]);
        const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        const guid = (row?.Guid as Record<string, unknown>[])[0];
        expect(guid?.id).toMatch(/^tmdb:\/\/\d+$/);
    });
});

/**
 * Minor: `anonymiseNested`'s counter used to be reset to `{ n: 0 }` per row,
 * so every row's title collapsed onto the same placeholder — a fixture with
 * several history rows read as one indistinguishable row repeated.
 */
describe('anonymisePlexHistory gives distinguishable placeholders across rows', () => {
    const history = (rows: Record<string, unknown>[]) => ({ MediaContainer: { Metadata: rows } });

    it('does not give two different rows the same synthetic title', () => {
        const body = history([
            { ratingKey: '1', title: 'Real Title One' },
            { ratingKey: '2', title: 'Real Title Two' }
        ]);
        const rows = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect(rows[0]?.title).not.toBe(rows[1]?.title);
    });
});

describe('redactPlexSessions', () => {
    const sessions = (rows: Record<string, unknown>[]) => ({ MediaContainer: { Metadata: rows } });

    it('replaces User.title, a viewer username, alongside the IP it already redacted', () => {
        const body = sessions([
            { ratingKey: '1', User: { id: '7', title: 'realname99' }, Player: { remotePublicAddress: '81.4.2.10' } }
        ]);
        const [row] = (redactPlexSessions(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        const user = row?.User as Record<string, unknown>;
        expect(user.title).not.toBe('realname99');
        expect((row?.Player as Record<string, unknown>).remotePublicAddress).not.toBe('81.4.2.10');
    });

    it('replaces User.thumb, which can embed an account identifier in a Plex avatar URL', () => {
        const body = sessions([{ ratingKey: '1', User: { id: '7', thumb: 'https://plex.tv/users/abc123/avatar' } }]);
        const [row] = (redactPlexSessions(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect((row?.User as Record<string, unknown>).thumb).not.toBe('https://plex.tv/users/abc123/avatar');
    });

    it('leaves User.id untouched — the adapter resolves the current session by matching on it', () => {
        const body = sessions([{ ratingKey: '1', User: { id: '7', title: 'realname99' } }]);
        const [row] = (redactPlexSessions(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect((row?.User as Record<string, unknown>).id).toBe('7');
    });

    it('still redacts a row with only a Player, no User, as before', () => {
        const body = sessions([{ ratingKey: '1', Player: { remotePublicAddress: '81.4.2.10' } }]);
        const [row] = (redactPlexSessions(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect((row?.Player as Record<string, unknown>).remotePublicAddress).not.toBe('81.4.2.10');
    });

    /**
     * I1: a session is a "currently watching" record, the same class of thing
     * `anonymisePlexHistory` treats a history/onDeck row as — but
     * `redactPlexSessions` scrubbed only `User`/`Player.remotePublicAddress`,
     * leaving the row's own title, file path and cast, plus the device's
     * name and stable id, to pass straight through untouched.
     */
    it('scrubs the row itself: title, grandparentTitle and summary', () => {
        const body = sessions([{ ratingKey: '1', title: 'Real Episode', grandparentTitle: 'Real Show', summary: 'A real plot.' }]);
        const [row] = (redactPlexSessions(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect(row?.title).not.toBe('Real Episode');
        expect(row?.grandparentTitle).not.toBe('Real Show');
        expect(row?.summary).not.toBe('A real plot.');
    });

    it('scrubs Media[].Part[].file on a session row', () => {
        const realPath = '/tv/Real Show/Season 01/Real Show - S01E01.mkv';
        const body = sessions([{ ratingKey: '1', Media: [{ Part: [{ file: realPath, size: 123 }] }] }]);
        const [row] = (redactPlexSessions(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        const media = row?.Media as { Part: { file?: unknown; size?: unknown }[] }[];
        expect(media[0]?.Part[0]?.file).not.toBe(realPath);
        expect(media[0]?.Part[0]?.size).toBe(123);
    });

    it('scrubs Role cast names on a session row', () => {
        const body = sessions([{ ratingKey: '1', Role: [{ tag: 'Real Actor Name' }] }]);
        const [row] = (redactPlexSessions(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect((row?.Role as Record<string, unknown>[])[0]?.tag).not.toBe('Real Actor Name');
    });

    it("scrubs Player.title, typically the viewer's device name", () => {
        const body = sessions([{ ratingKey: '1', Player: { title: "Firstname's iPhone" } }]);
        const [row] = (redactPlexSessions(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect((row?.Player as Record<string, unknown>).title).not.toBe("Firstname's iPhone");
    });

    it('scrubs Player.machineIdentifier, a stable device id', () => {
        const body = sessions([{ ratingKey: '1', Player: { machineIdentifier: 'abc-real-device-uuid' } }]);
        const [row] = (redactPlexSessions(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect((row?.Player as Record<string, unknown>).machineIdentifier).not.toBe('abc-real-device-uuid');
    });
});

/**
 * The tester's live `/accounts` returned 103 accounts, 102 with `name: ''`.
 * `replaceIfString` checks `typeof value === 'string'`, not truthiness, so an
 * empty string is still replaced — an implementation that checked `a.name ?`
 * instead would leave every one of those 102 blank and call it anonymised.
 */
describe('an anonymiser handling a blank name (regression for the /accounts edge case)', () => {
    it('replaces an empty string the same as any other string value', () => {
        expect(replaceIfString('', 'Account 1')).toBe('Account 1');
    });
});

/**
 * The tester's live `/accounts` carried three rows with real plex.tv account
 * ids next to names that `anonymisePlexAccounts` already replaced — `name`
 * was never the whole problem. `User.id` (sessions) and `accountID` (history)
 * are deliberately left as-is by `redactPlexSessions`/`anonymisePlexHistory`
 * because the adapter's tests join on them, but the *values* backing that
 * join don't have to be the tester's real ids — a stable mapping keeps every
 * join working while a random per-occurrence one would break it. See G2.
 */
describe('createAccountIdMapper', () => {
    it('keeps the owner at id 1 — PlexAdapter#listUsers matches on it exactly', () => {
        const mapId = createAccountIdMapper();
        expect(mapId(1)).toBe(1);
    });

    it('maps a real id to something other than itself', () => {
        const mapId = createAccountIdMapper();
        expect(mapId(78901234)).not.toBe(78901234);
    });

    it('maps the same real id to the same synthetic id on repeated calls', () => {
        const mapId = createAccountIdMapper();
        const first = mapId(78901234);
        expect(mapId(78901234)).toBe(first);
        expect(mapId(78901234)).toBe(first);
    });

    it('maps two different real ids to two different synthetic ids', () => {
        const mapId = createAccountIdMapper();
        expect(mapId(78901234)).not.toBe(mapId(55555555));
    });

    /**
     * N1: the counter started at 1001 and incremented once per distinct
     * non-owner id, so the nth distinct non-owner id survived unchanged
     * whenever its real value was exactly 1000 + n. Reproduced with the
     * tester's own example: a first id (any value) claims synthetic 1001,
     * then a second real id of exactly 1002 collided with its own synthetic.
     */
    it('never produces a synthetic id equal to the real id it was given', () => {
        const mapId = createAccountIdMapper();
        mapId(4000); // 1st distinct non-owner id
        const second = mapId(1002); // 2nd distinct non-owner id — old code: 1000+2 = 1002
        expect(second).not.toBe(1002);
    });

    it('maps every real (positive) id to a negative synthetic id, which can never collide with one', () => {
        const mapId = createAccountIdMapper();
        expect(mapId(4000)).toBeLessThan(0);
        expect(mapId(1002)).toBeLessThan(0);
        expect(mapId(999999999)).toBeLessThan(0);
    });
});

describe('anonymisePlexAccounts', () => {
    const accounts = (rows: Record<string, unknown>[]) => ({ MediaContainer: { Account: rows } });

    it('replaces a real account id with the mapped synthetic one', () => {
        const mapId = createAccountIdMapper();
        const body = accounts([{ id: 78901234, name: 'A Real Name' }]);
        const [row] = (anonymisePlexAccounts(body, mapId) as { MediaContainer: { Account: Record<string, unknown>[] } })
            .MediaContainer.Account;
        expect(row?.id).toBe(mapId(78901234));
        expect(row?.id).not.toBe(78901234);
    });

    it('still replaces name, as before', () => {
        const mapId = createAccountIdMapper();
        const body = accounts([{ id: 2, name: 'Guest' }]);
        const [row] = (anonymisePlexAccounts(body, mapId) as { MediaContainer: { Account: Record<string, unknown>[] } })
            .MediaContainer.Account;
        expect(row?.name).not.toBe('Guest');
    });

    it('leaves the owner row (id 1) mapped to itself', () => {
        const mapId = createAccountIdMapper();
        const body = accounts([{ id: 1, name: 'Bartus' }]);
        const [row] = (anonymisePlexAccounts(body, mapId) as { MediaContainer: { Account: Record<string, unknown>[] } })
            .MediaContainer.Account;
        expect(row?.id).toBe(1);
    });

    // N4: a stricter `typeof a.id === 'number'` check than `mappedId` (which
    // also accepts a numeric string) meant a string-valued id survived here
    // unmapped, while User.id/accountID elsewhere already handled either shape.
    it('maps a string-valued id the same as a numeric one', () => {
        const mapId = createAccountIdMapper();
        const body = accounts([{ id: '78901234', name: 'A Real Name' }]);
        const [row] = (anonymisePlexAccounts(body, mapId) as { MediaContainer: { Account: Record<string, unknown>[] } })
            .MediaContainer.Account;
        expect(row?.id).not.toBe('78901234');
        expect(row?.id).toBe(String(mapId(78901234)));
    });

    /**
     * C2: `key`/`thumb` carried real plex.tv identities the mapper/name scrub
     * never touched — `key` re-embeds the exact real id `id` above just
     * remapped, and `thumb` is a stable `plex.tv/users/<uuid>/avatar` URL,
     * for this account and every other shared user on the server.
     */
    it('blanks key, which re-embeds the real account id as /accounts/<id>', () => {
        const mapId = createAccountIdMapper();
        const body = accounts([{ id: 78901234, name: 'A Real Name', key: '/accounts/78901234' }]);
        const [row] = (anonymisePlexAccounts(body, mapId) as { MediaContainer: { Account: Record<string, unknown>[] } })
            .MediaContainer.Account;
        expect(row?.key).not.toBe('/accounts/78901234');
    });

    it('blanks thumb, a stable plex.tv account avatar URL', () => {
        const mapId = createAccountIdMapper();
        const body = accounts([{ id: 2, name: 'Guest', thumb: 'https://plex.tv/users/abc123-uuid/avatar?c=1700000000' }]);
        const [row] = (anonymisePlexAccounts(body, mapId) as { MediaContainer: { Account: Record<string, unknown>[] } })
            .MediaContainer.Account;
        expect(row?.thumb).not.toBe('https://plex.tv/users/abc123-uuid/avatar?c=1700000000');
    });
});

describe('redactPlexSessions with an id mapper', () => {
    const sessions = (rows: Record<string, unknown>[]) => ({ MediaContainer: { Metadata: rows } });

    it('replaces User.id with the mapped synthetic id when a mapper is given', () => {
        const mapId = createAccountIdMapper();
        const body = sessions([{ ratingKey: '1', User: { id: '78901234', title: 'realname99' } }]);
        const [row] = (redactPlexSessions(body, mapId) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect((row?.User as Record<string, unknown>).id).toBe(String(mapId(78901234)));
    });

    it('leaves User.id untouched when no mapper is given, as before', () => {
        const body = sessions([{ ratingKey: '1', User: { id: '7', title: 'realname99' } }]);
        const [row] = (redactPlexSessions(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect((row?.User as Record<string, unknown>).id).toBe('7');
    });
});

describe('anonymisePlexHistory with an id mapper', () => {
    const history = (rows: Record<string, unknown>[]) => ({ MediaContainer: { Metadata: rows } });

    it('replaces accountID with the mapped synthetic id when a mapper is given', () => {
        const mapId = createAccountIdMapper();
        const body = history([{ ratingKey: '1', title: 'A Film', accountID: 78901234 }]);
        const [row] = (anonymisePlexHistory(body, mapId) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect(row?.accountID).toBe(mapId(78901234));
    });

    it('leaves accountID untouched when no mapper is given, as before', () => {
        const body = history([{ ratingKey: '1', title: 'A Film', accountID: 7 }]);
        const [row] = (anonymisePlexHistory(body) as { MediaContainer: { Metadata: Record<string, unknown>[] } })
            .MediaContainer.Metadata;
        expect(row?.accountID).toBe(7);
    });
});

describe('one mapper shared across accounts, sessions and history — the join the tester flagged', () => {
    it('maps the same real account id to the same synthetic id in all three fixtures', () => {
        const mapId = createAccountIdMapper();
        const REAL = 78901234;

        const accountsOut = anonymisePlexAccounts({ MediaContainer: { Account: [{ id: REAL, name: 'Real' }] } }, mapId) as {
            MediaContainer: { Account: Record<string, unknown>[] };
        };
        const sessionsOut = redactPlexSessions(
            { MediaContainer: { Metadata: [{ ratingKey: '1', User: { id: REAL, title: 'realname99' } }] } },
            mapId
        ) as { MediaContainer: { Metadata: Record<string, unknown>[] } };
        const historyOut = anonymisePlexHistory(
            { MediaContainer: { Metadata: [{ ratingKey: '1', title: 'A Film', accountID: REAL }] } },
            mapId
        ) as { MediaContainer: { Metadata: Record<string, unknown>[] } };

        const fromAccounts = accountsOut.MediaContainer.Account[0]?.id;
        const fromSessions = (sessionsOut.MediaContainer.Metadata[0]?.User as Record<string, unknown>).id;
        const fromHistory = historyOut.MediaContainer.Metadata[0]?.accountID;

        expect(String(fromAccounts)).toBe(String(fromSessions));
        expect(String(fromAccounts)).toBe(String(fromHistory));
        expect(String(fromAccounts)).not.toBe(String(REAL));
    });
});
