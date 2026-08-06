import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.ts';
import { classifyFetchError } from '../src/core/errors.ts';
import { hostsOf, redactHosts } from '../scripts/lib/redact.ts';

const TOKEN = 'a'.repeat(64);

const configWith = (url: string) =>
    ConfigSchema.parse({
        auth: { bearer_token: TOKEN },
        services: { radarr: { url, api_key: 'k' } }
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
