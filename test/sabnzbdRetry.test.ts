import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { ServiceError } from '../src/core/errors.ts';
import { SabnzbdAdapter } from '../src/services/sabnzbd.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * SABnzbd retry and unlock, against a fake that records every request. The
 * shapes follow SABnzbd's own source at 3.0.0 and develop: queue `filename` is
 * the plain name with labels beside it, `mode=retry` answers a new nzo_id, and
 * 3.x ignores `nzo_ids` on reads.
 */

const config: KeyedServiceConfig = {
    url: 'http://192.0.2.10:8080',
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive: false }
};

type Recorded = { method: string; url: string; body: string | undefined; params: URLSearchParams };
type Slot = Record<string, unknown>;
type Handler = (params: URLSearchParams, calls: Recorded[]) => unknown;

/** Every request, with URL and form fields merged into `params` the way
 *  SABnzbd's cherrypy handler merges them. */
const recording = (handler: Handler) => {
    const requests: Recorded[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const body = typeof init?.body === 'string' ? init.body : undefined;
        const params = new URL(url).searchParams;
        for (const [k, v] of new URLSearchParams(body ?? '')) params.set(k, v);
        const recorded = { method: init?.method ?? 'GET', url, body, params };
        requests.push(recorded);
        return jsonResponse(handler(params, requests));
    }) as unknown as typeof fetch;
    return { adapter: new SabnzbdAdapter(config, impl), requests };
};

/** A client whose queue and history are fixed, answering writes with `writes`. */
const fixed = (queue: Slot[], history: Slot[], writes: Handler = () => ({ status: true })) =>
    recording((params, calls) => {
        const mode = params.get('mode');
        if (mode === 'queue' && !params.get('name')) return { queue: { slots: queue } };
        if (mode === 'history') return { history: { slots: history } };
        return writes(params, calls);
    });

const writesIn = (requests: Recorded[]) =>
    requests.filter(r => r.method === 'POST' || r.params.has('name') || r.params.get('mode') === 'retry');

const caught = async (p: Promise<unknown>): Promise<ServiceError> => {
    try {
        await p;
    } catch (e) {
        return e as ServiceError;
    }
    throw new Error('expected a rejection');
};

const failed: Slot = { nzo_id: 'SABnzbd_nzo_old', name: 'Some.Movie.2020', status: 'Failed', fail_message: 'Unpacking failed' };

describe('sabnzbd findRetryTarget', () => {
    it('refuses a completed history job without sending anything', async () => {
        const { adapter, requests } = fixed([], [{ ...failed, status: 'Completed' }]);

        const error = await caught(adapter.findRetryTarget('SABnzbd_nzo_old', { hasPassword: false }));

        expect(error.kind).toBe('NotFound');
        expect(error.message).toMatch(/only a failed download can be retried/);
        expect(writesIn(requests)).toHaveLength(0);
    });

    it('refuses an id in neither queue nor history, naming Remove Failed', async () => {
        const { adapter } = fixed([], [failed]);

        const error = await caught(adapter.findRetryTarget('SABnzbd_nzo_gone', { hasPassword: false }));

        expect(error.kind).toBe('NotFound');
        expect(error.remedy).toMatch(/Remove Failed/);
    });

    // 3.x ignores nzo_ids and answers the whole queue, so the match is local.
    it('filters the reads itself, since 3.0.0 ignores nzo_ids', async () => {
        const { adapter, requests } = fixed([{ nzo_id: 'other', filename: 'x', status: 'Downloading' }], [failed]);

        const target = await adapter.findRetryTarget('SABnzbd_nzo_old', { hasPassword: false });

        expect(target).toMatchObject({ method: 'retry', where: 'history', id: 'SABnzbd_nzo_old' });
        expect(target.reason).toContain('Unpacking failed');
        const history = requests.find(r => r.params.get('mode') === 'history');
        expect(history?.params.get('nzo_ids')).toBe('SABnzbd_nzo_old');
        expect(history?.params.has('limit')).toBe(false);
    });

    it('refuses a queue job that has not failed', async () => {
        const { adapter } = fixed([{ nzo_id: 'q1', filename: 'Show.S01E01', status: 'Downloading', labels: [] }], []);

        await expect(adapter.findRetryTarget('q1', { hasPassword: false })).rejects.toThrow(/still in the queue/);
    });

    it('refuses an encrypted queue job when no password is given', async () => {
        const { adapter } = fixed([{ nzo_id: 'q1', filename: 'Show.S01E01', status: 'Paused', labels: ['ENCRYPTED'] }], []);

        const error = await caught(adapter.findRetryTarget('q1', { hasPassword: false }));

        expect(error.kind).toBe('NotFound');
        expect(error.remedy).toMatch(/password/);
    });

    it('targets an encrypted queue job with a password as unlock', async () => {
        const { adapter } = fixed([{ nzo_id: 'q1', filename: 'ENCRYPTED / Show.S01E01', status: 'Paused' }], []);

        const target = await adapter.findRetryTarget('q1', { hasPassword: true });

        expect(target).toMatchObject({ method: 'unlock', where: 'queue', id: 'q1', downloadId: 'q1' });
        expect(target.title).toContain('Show.S01E01');
        expect(target.title).not.toContain('ENCRYPTED');
    });

    // 3.0.0 and later: the label is its own field and the filename is plain.
    it('recognises the ENCRYPTED label, whatever its case', async () => {
        const { adapter } = fixed([{ nzo_id: 'q1', filename: 'Show.S01E01', status: 'Paused', labels: ['Encrypted'] }], []);

        await expect(adapter.findRetryTarget('q1', { hasPassword: true })).resolves.toMatchObject({ method: 'unlock' });
    });

    // The label is translated: on a non-English UI a paused job may be
    // encrypted with no way to tell from the API.
    it('refuses a paused job it cannot confirm is encrypted, pointing at SABnzbd\'s own UI', async () => {
        const { adapter } = fixed([{ nzo_id: 'q1', filename: 'Show.S01E01', status: 'Paused', labels: ['VERSCHLÜSSELT'] }], []);

        const error = await caught(adapter.findRetryTarget('q1', { hasPassword: true }));

        expect(error.kind).toBe('NotFound');
        expect(error.remedy).toMatch(/could not be confirmed/);
        expect(error.remedy).toMatch(/non-English/);
        expect(error.remedy).toMatch(/SABnzbd's own/);
    });
});

describe('sabnzbd runRetry', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('retries a failed job by POST, with the password only in the body', async () => {
        let retried = false;
        const { adapter, requests } = recording(params => {
            const mode = params.get('mode');
            if (mode === 'retry') {
                retried = true;
                return { status: true, nzo_id: 'SABnzbd_nzo_new' };
            }
            if (mode === 'queue') {
                return { queue: { slots: retried ? [{ nzo_id: 'SABnzbd_nzo_new', filename: 'Some.Movie.2020', status: 'Downloading' }] : [] } };
            }
            if (mode === 'history') return { history: { slots: retried ? [] : [failed] } };
            return { status: false };
        });

        const outcome = await adapter.runRetry('SABnzbd_nzo_old', { method: 'retry', password: 'hunter2' });

        const post = requests.find(r => r.params.get('mode') === 'retry');
        expect(post?.method).toBe('POST');
        expect(post?.url).not.toContain('hunter2');
        expect(new URLSearchParams(post?.body).get('password')).toBe('hunter2');
        expect(new URLSearchParams(post?.body).get('value')).toBe('SABnzbd_nzo_old');
        expect(requests.every(r => !r.url.includes('hunter2'))).toBe(true);
        expect(outcome).toMatchObject({ id: 'SABnzbd_nzo_new', state: 'downloading' });
        expect(outcome.target).toMatchObject({ method: 'retry', id: 'SABnzbd_nzo_old' });
        expect(JSON.stringify(outcome)).not.toContain('hunter2');
    });

    it('reports a retry that failed again as finished with a failed event', async () => {
        let retried = false;
        const { adapter } = recording(params => {
            const mode = params.get('mode');
            if (mode === 'retry') {
                retried = true;
                return { status: true, nzo_id: 'new' };
            }
            if (mode === 'queue') return { queue: { slots: [] } };
            return { history: { slots: retried ? [{ ...failed, nzo_id: 'new' }] : [failed] } };
        });

        const outcome = await adapter.runRetry('SABnzbd_nzo_old', { method: 'retry' });

        expect(outcome).toMatchObject({ id: 'new', state: 'finished', event: 'failed' });
        expect(outcome.status).toContain('Failed');
    });

    it('unlocks an encrypted queue job: rename with value3, then resume, and watches it leave Paused', async () => {
        let resumed = false;
        const { adapter, requests } = recording(params => {
            const mode = params.get('mode');
            const name = params.get('name');
            if (mode === 'queue' && name === 'rename') return { status: true };
            if (mode === 'queue' && name === 'resume') {
                resumed = true;
                return { status: true, nzo_ids: ['q1'] };
            }
            if (mode === 'queue') {
                return {
                    queue: {
                        slots: [
                            {
                                nzo_id: 'q1',
                                filename: 'ENCRYPTED / Show.S01E01',
                                status: resumed ? 'Downloading' : 'Paused',
                                labels: ['ENCRYPTED']
                            }
                        ]
                    }
                };
            }
            return { history: { slots: [] } };
        });

        const outcome = await adapter.runRetry('q1', { method: 'unlock', password: 'hunter2' });

        const rename = requests.find(r => r.params.get('name') === 'rename');
        expect(rename?.method).toBe('POST');
        expect(rename?.url).not.toContain('hunter2');
        const form = new URLSearchParams(rename?.body);
        expect(form.get('value')).toBe('q1');
        expect(form.get('value2')).toBe('Show.S01E01');
        expect(form.get('value3')).toBe('hunter2');
        const resume = requests.find(r => r.params.get('name') === 'resume');
        expect(resume?.method).toBe('GET');
        expect(resume?.params.get('value')).toBe('q1');
        expect(requests.indexOf(rename as Recorded)).toBeLessThan(requests.indexOf(resume as Recorded));
        expect(outcome).toMatchObject({ id: 'q1', state: 'downloading' });
        expect(outcome.target).toMatchObject({ method: 'unlock' });
    });

    it('reports status:false as UpstreamError without echoing the password', async () => {
        const { adapter } = fixed([], [failed], () => ({ status: false, error: 'bad password hunter2' }));

        const error = await caught(adapter.runRetry('SABnzbd_nzo_old', { method: 'retry', password: 'hunter2' }));

        expect(error.kind).toBe('UpstreamError');
        expect(error.message).not.toContain('hunter2');
        expect(error.remedy ?? '').not.toContain('hunter2');
    });

    it('refuses a method the preview did not decide', async () => {
        const { adapter, requests } = fixed([], [failed]);

        await expect(adapter.runRetry('SABnzbd_nzo_old', { method: 'unlock', password: 'x' })).rejects.toThrow();
        expect(writesIn(requests)).toHaveLength(0);
    });

    it('errors when the new job never appears', async () => {
        vi.useFakeTimers();
        const { adapter, requests } = fixed([], [failed], () => ({ status: true, nzo_id: 'never' }));

        const outcome = expect(adapter.runRetry('SABnzbd_nzo_old', { method: 'retry' })).rejects.toThrow(/never/);
        await vi.runAllTimersAsync();
        await outcome;

        const afterSend = requests.slice(requests.findIndex(r => r.params.get('mode') === 'retry') + 1);
        expect(afterSend.filter(r => r.params.get('mode') === 'queue')).toHaveLength(20);
    });
});
