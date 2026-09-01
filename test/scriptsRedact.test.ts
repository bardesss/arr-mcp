import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.ts';
import { classifyFetchError } from '../src/core/errors.ts';
import {
    anonymisePlexHistory,
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

    it('replaces a configured host with the anonymous host', () => {
        expect(redact('http://192.168.1.20:7878/api', secrets, hosts)).toContain('service.example.test');
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
