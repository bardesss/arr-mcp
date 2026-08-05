import { describe, expect, it } from 'vitest';
import { ServiceError, classifyFetchError, classifyHttpStatus } from '../src/core/errors.ts';

describe('ServiceError.toModelText', () => {
    it('produces actionable text naming the service, cause, and target', () => {
        const err = new ServiceError('Unreachable', 'bazarr', 'connection refused at 192.168.1.20:6767');
        expect(err.toModelText()).toBe('bazarr unreachable: connection refused at 192.168.1.20:6767');
    });

    it('appends the remedy when one is known', () => {
        const err = new ServiceError('AuthFailed', 'radarr', 'HTTP 401 at /api/v3/system/status', {
            remedy: 'The API key is wrong. Radarr → Settings → General.'
        });
        expect(err.toModelText()).toBe(
            'radarr auth failed: HTTP 401 at /api/v3/system/status — The API key is wrong. Radarr → Settings → General.'
        );
    });

    it('never leaks a stack trace into model-facing text', () => {
        const err = new ServiceError('UpstreamError', 'radarr', 'boom');
        expect(err.toModelText()).not.toContain('at ');
        expect(err.toModelText()).not.toContain(import.meta.url);
    });

    it('preserves the original error as cause for logs without exposing it to the model', () => {
        const original = new Error('socket hang up');
        const err = new ServiceError('Timeout', 'sonarr', 'no response', { cause: original });
        expect(err.cause).toBe(original);
        expect(err.toModelText()).not.toContain('socket hang up');
    });
});

/**
 * The MCP SDK's own catch around a tool handler reads `error.message`, not
 * `toModelText()` — nothing in this codebase calls `toModelText()` in a
 * throwing path. A remedy that lives only there never reaches a caller. The
 * remedy therefore has to live in `.message` itself, which every catcher of a
 * thrown Error already reads.
 */
describe('ServiceError.message', () => {
    it('includes the remedy, since .message is what a thrown error is caught as', () => {
        const err = new ServiceError('AuthFailed', 'radarr', 'HTTP 401 at /api/v3/system/status', {
            remedy: 'The API key is wrong. Radarr → Settings → General.'
        });
        expect(err.message).toBe(
            'radarr auth failed: HTTP 401 at /api/v3/system/status — The API key is wrong. Radarr → Settings → General.'
        );
    });

    it('matches toModelText() exactly — one sanctioned string, not two that can drift', () => {
        const err = new ServiceError('AuthFailed', 'radarr', 'HTTP 401 at /api/v3/system/status', {
            remedy: 'The API key is wrong. Radarr → Settings → General.'
        });
        expect(err.message).toBe(err.toModelText());
    });

    it('omits the trailing dash when there is no remedy', () => {
        const err = new ServiceError('UpstreamError', 'radarr', 'boom');
        expect(err.message).toBe('radarr upstream error: boom');
    });
});

describe('classifyHttpStatus', () => {
    it.each([
        [401, 'AuthFailed'],
        [403, 'AuthFailed'],
        [404, 'NotFound'],
        [429, 'RateLimited'],
        [500, 'UpstreamError'],
        [502, 'UpstreamError']
    ])('maps HTTP %i to %s', (status, kind) => {
        expect(classifyHttpStatus(status, 'radarr', 'http://h/api')?.kind).toBe(kind);
    });

    it('returns undefined for a success status', () => {
        expect(classifyHttpStatus(200, 'radarr', 'http://h/api')).toBeUndefined();
    });

    it('returns undefined for a 3xx redirect', () => {
        expect(classifyHttpStatus(302, 'radarr', 'http://h/api')).toBeUndefined();
    });

    it('gives a 404 the wrong-base-path remedy, not a generic message', () => {
        expect(classifyHttpStatus(404, 'radarr', 'http://h/api/v3/system/status')?.remedy).toMatch(/base path/i);
    });

    it('gives a 404 on Radarr’s real get-by-id path a missing-item remedy, not the base-path one', () => {
        // The reported bug, live: GET /api/v3/movie/{id} for an id that does
        // not exist. Nothing about the base URL is wrong here.
        const remedy = classifyHttpStatus(404, 'radarr', 'http://h/api/v3/movie/999999')?.remedy;
        expect(remedy).not.toMatch(/base path/i);
        expect(remedy).toMatch(/id/i);
    });

    it('gives a 404 on Sonarr’s real get-by-id path the same missing-item remedy', () => {
        const remedy = classifyHttpStatus(404, 'sonarr', 'http://h/api/v3/series/42')?.remedy;
        expect(remedy).not.toMatch(/base path/i);
        expect(remedy).toMatch(/id/i);
    });

    it('keeps the base-path remedy for a 404 on a collection endpoint with no id', () => {
        // GET /api/v3/movie (the collection itself, no trailing id) 404ing
        // means the base path is wrong — that route always exists.
        expect(classifyHttpStatus(404, 'radarr', 'http://h/api/v3/movie')?.remedy).toMatch(/base path/i);
    });

    it('hedges rather than guessing when the trailing path segment is neither an id nor a collection name', () => {
        // A GUID-shaped segment (letters and digits both) is not confidently
        // either shape from the path alone.
        const remedy = classifyHttpStatus(404, 'jellyfin', 'http://h/Users/8a1e21b1a1b04c1b8a1e21b1a1b04c1b')?.remedy;
        expect(remedy).toMatch(/id/i);
        expect(remedy).toMatch(/base path|url/i);
    });

    it('names the path but not the host in the detail, so keys in query strings cannot leak', () => {
        const err = classifyHttpStatus(401, 'radarr', 'http://h:7878/api/v3/system/status?apikey=secret');
        expect(err?.detail).toContain('/api/v3/system/status');
        expect(err?.detail).not.toContain('secret');
    });
});

describe('classifyFetchError', () => {
    it('maps DNS failure to Unreachable with a DNS remedy', () => {
        const e = Object.assign(new Error('getaddrinfo ENOTFOUND nope'), { code: 'ENOTFOUND' });
        const out = classifyFetchError(e, 'radarr', 'http://nope:7878');
        expect(out.kind).toBe('Unreachable');
        expect(out.remedy).toMatch(/hostname/i);
    });

    it('maps connection refused to Unreachable', () => {
        const e = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        expect(classifyFetchError(e, 'radarr', 'http://h:7878').kind).toBe('Unreachable');
    });

    it('maps an AbortError to Timeout', () => {
        const e = Object.assign(new Error('aborted'), { name: 'AbortError' });
        expect(classifyFetchError(e, 'radarr', 'http://h:7878').kind).toBe('Timeout');
    });

    it('maps a TimeoutError to Timeout', () => {
        const e = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
        expect(classifyFetchError(e, 'radarr', 'http://h:7878').kind).toBe('Timeout');
    });

    it('maps a firewall-blocked connection to a remedy that names the firewall', () => {
        // Windows reports this as EACCES on connect, which reads like a
        // permission problem and sends people looking in the wrong place.
        const e = Object.assign(new TypeError('fetch failed'), {
            cause: { code: 'EACCES', message: 'connect EACCES 192.168.1.20:7878' }
        });
        const out = classifyFetchError(e, 'radarr', 'http://192.168.1.20:7878');

        expect(out.kind).toBe('Unreachable');
        expect(out.remedy).toMatch(/firewall/i);
    });

    it('maps an unroutable address to Unreachable with a routing remedy', () => {
        const e = Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } });
        const out = classifyFetchError(e, 'radarr', 'http://10.9.9.9:7878');

        expect(out.kind).toBe('Unreachable');
        expect(out.remedy).toMatch(/not reachable|network/i);
    });

    it('maps a connect timeout to Unreachable, not Timeout, so reads do not retry a dead address', () => {
        const e = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
        expect(classifyFetchError(e, 'radarr', 'http://10.9.9.9:7878').kind).toBe('Unreachable');
    });

    it('surfaces the underlying cause rather than undici’s opaque "fetch failed"', () => {
        const e = Object.assign(new TypeError('fetch failed'), {
            cause: { code: 'ESOMETHINGNEW', message: 'connect ESOMETHINGNEW 192.168.1.20:7878' }
        });
        const out = classifyFetchError(e, 'radarr', 'http://192.168.1.20:7878');

        expect(out.detail).toContain('ESOMETHINGNEW');
        expect(out.detail).not.toBe('fetch failed at 192.168.1.20:7878');
    });

    it('maps a TLS certificate failure to Unreachable with a TLS remedy', () => {
        const e = Object.assign(new Error('self-signed'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
        expect(classifyFetchError(e, 'radarr', 'https://h:7878').remedy).toMatch(/certificate/i);
    });

    it('reads the error code from a nested cause, as undici reports it', () => {
        const e = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        expect(classifyFetchError(e, 'radarr', 'http://h:7878').remedy).toMatch(/listening/i);
    });

    it('falls back to Unreachable for an unrecognised failure without throwing', () => {
        const out = classifyFetchError({ weird: true }, 'radarr', 'http://h:7878');
        expect(out.kind).toBe('Unreachable');
        expect(out.toModelText()).toContain('radarr');
    });

    it('does not throw when the url is unparseable', () => {
        const e = Object.assign(new Error('nope'), { code: 'ECONNREFUSED' });
        expect(() => classifyFetchError(e, 'radarr', 'not a url')).not.toThrow();
    });
});
