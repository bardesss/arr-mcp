import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.ts';
import { classifyFetchError } from '../src/core/errors.ts';
import { hostsOf, redactHosts, secretsOf } from '../scripts/lib/redact.ts';

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
