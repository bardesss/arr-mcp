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
