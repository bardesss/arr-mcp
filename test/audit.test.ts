import { afterEach, describe, expect, it } from 'vitest';
import { WriteAudit, type AuditRecord } from '../src/core/audit.ts';

type Row = {
    tool: string;
    service: string;
    operation: string;
    tier: string;
    target: string;
    args: string;
    outcome: string;
    detail: string | null;
    settled_at: string | null;
    at: string;
};

const record = (over: Partial<AuditRecord> = {}): AuditRecord => ({
    tool: 'delete_media',
    service: 'radarr',
    operation: 'delete_movie',
    tier: 'destructive',
    target: '5',
    args: { deleteFiles: true },
    ...over
});

let audit: WriteAudit | undefined;
const open = (): WriteAudit => (audit = WriteAudit.ephemeral());

afterEach(() => {
    audit?.close();
    audit = undefined;
});

describe('write audit', () => {
    it('records the intent before the service is called', () => {
        const trail = open();
        trail.begin(record());

        const [row] = trail.recent() as Row[];
        expect(row?.outcome).toBe('attempted');
        expect(row?.tool).toBe('delete_media');
        expect(row?.target).toBe('5');
    });

    it('settles an attempt into its outcome', () => {
        const trail = open();
        const id = trail.begin(record());
        trail.settle(id, 'applied');

        const [row] = trail.recent() as Row[];
        expect(row?.outcome).toBe('applied');
        expect(row?.settled_at).not.toBeNull();
    });

    // The case an after-the-fact-only log cannot show: the process died between
    // calling the service and learning what happened.
    it('leaves a row reading attempted when nothing settles it', () => {
        const trail = open();
        trail.begin(record());
        const [row] = trail.recent() as Row[];
        expect(row?.outcome).toBe('attempted');
        expect(row?.settled_at).toBeNull();
    });

    it('keeps one row per operation rather than appending a second', () => {
        const trail = open();
        const id = trail.begin(record());
        trail.settle(id, 'failed', 'radarr upstream error: HTTP 500');
        expect(trail.recent()).toHaveLength(1);
    });

    it('carries the failure detail so the trail says why', () => {
        const trail = open();
        trail.settle(trail.begin(record()), 'failed', 'radarr upstream error: HTTP 500');
        const [row] = trail.recent() as Row[];
        expect(row?.detail).toContain('HTTP 500');
    });

    it('records denials and dry runs, not only writes that happened', () => {
        const trail = open();
        trail.settle(trail.begin(record()), 'denied', 'destructive writes are disabled for radarr');
        trail.settle(trail.begin(record({ target: '6' })), 'dry_run');

        const outcomes = (trail.recent() as Row[]).map(r => r.outcome);
        expect(outcomes).toEqual(['dry_run', 'denied']);
    });

    it('returns newest first', () => {
        const trail = open();
        trail.begin(record({ target: 'first' }));
        trail.begin(record({ target: 'second' }));
        expect((trail.recent() as Row[])[0]?.target).toBe('second');
    });

    it('honours the limit', () => {
        const trail = open();
        for (let i = 0; i < 5; i += 1) trail.begin(record({ target: String(i) }));
        expect(trail.recent(2)).toHaveLength(2);
    });

    it('stores the arguments as JSON so the trail says what was asked for', () => {
        const trail = open();
        trail.begin(record({ args: { deleteFiles: true, addImportExclusion: false } }));
        const [row] = trail.recent() as Row[];
        expect(JSON.parse(row?.args ?? '{}')).toEqual({ deleteFiles: true, addImportExclusion: false });
    });

    // No write tool takes a credential today; this keeps that true by
    // construction rather than by everyone remembering.
    it('redacts anything credential-shaped that reaches it', () => {
        const trail = open();
        trail.begin(record({ args: { api_key: 'sk-secret', password: 'hunter2', deleteFiles: true } }));

        const [row] = trail.recent() as Row[];
        const args = JSON.parse(row?.args ?? '{}') as Record<string, unknown>;
        expect(args.api_key).toBe('__REDACTED__');
        expect(args.password).toBe('__REDACTED__');
        expect(args.deleteFiles).toBe(true);
        expect(row?.args).not.toContain('hunter2');
    });
});

/**
 * The redactor matched key names at the top level only, so a secret one level
 * down was serialised into a durable row verbatim. The module's stated goal is
 * that no write tool can leak one "by construction".
 */
describe('argument redaction', () => {
    it('redacts a secret nested inside an object argument', () => {
        const trail = open();
        trail.begin(record({ args: { options: { api_key: 'supersecret' } } }));

        const [row] = trail.recent() as Row[];
        expect(row?.args).not.toContain('supersecret');
        expect(row?.args).toContain('__REDACTED__');
    });

    it('redacts a secret nested inside an array argument', () => {
        const trail = open();
        trail.begin(record({ args: { items: [{ token: 'supersecret' }] } }));

        expect((trail.recent() as Row[])[0]?.args).not.toContain('supersecret');
    });

    it('still redacts a secret at the top level', () => {
        const trail = open();
        trail.begin(record({ args: { api_key: 'supersecret' } }));

        expect((trail.recent() as Row[])[0]?.args).not.toContain('supersecret');
    });

    it('leaves non-secret nested values intact', () => {
        const trail = open();
        trail.begin(record({ args: { options: { quality: 'HD-1080p' } } }));

        expect((trail.recent() as Row[])[0]?.args).toContain('HD-1080p');
    });
});
