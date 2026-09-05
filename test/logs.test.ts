import { afterEach, describe, expect, it } from 'vitest';
import { LEVELS, LOG_RING_SIZE, LogStore, logFields } from '../src/core/logs.ts';

let store: LogStore | undefined;
const open = (): LogStore => (store = LogStore.ephemeral());

afterEach(() => {
    store?.close();
    store = undefined;
});

const line = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ level: LEVELS.info, time: 1_786_000_000_000, app: 'arr-mcp', msg: 'hello', ...over });

describe('the log ring buffer', () => {
    it('stores a pino line', () => {
        const logs = open();
        logs.write(line({ msg: 'listening' }));

        const [row] = logs.recent();
        expect(row?.msg).toBe('listening');
        expect(row?.level).toBe(LEVELS.info);
        expect(row?.levelName).toBe('info');
    });

    it('promotes the service a line is about into its own column', () => {
        const logs = open();
        logs.write(line({ service: 'radarr', msg: 'unreachable' }));
        expect(logs.recent()[0]?.service).toBe('radarr');
    });

    // `app` is the process; `service` is the media service a line is about.
    it('does not mistake the app name for a service', () => {
        const logs = open();
        logs.write(line());
        expect(logs.recent()[0]?.service).toBeNull();
    });

    it('keeps everything else as fields rather than dropping it', () => {
        const logs = open();
        logs.write(line({ service: 'radarr', port: 7878, err: { kind: 'Unreachable' } }));

        const fields = JSON.parse(logs.recent()[0]?.fields ?? '{}') as Record<string, unknown>;
        expect(fields.port).toBe(7878);
        expect(fields.err).toEqual({ kind: 'Unreachable' });
    });

    it('returns newest first', () => {
        const logs = open();
        logs.write(line({ msg: 'first' }));
        logs.write(line({ msg: 'second' }));
        expect(logs.recent()[0]?.msg).toBe('second');
    });

    // Logging must never be able to break the thing it is logging about.
    it('swallows a malformed line rather than throwing', () => {
        const logs = open();
        expect(() => logs.write('not json')).not.toThrow();
        expect(() => logs.write('')).not.toThrow();
        expect(logs.count()).toBe(0);
    });

    it('survives a line with no message or level', () => {
        const logs = open();
        logs.write(JSON.stringify({ time: 1 }));
        expect(logs.recent()[0]?.msg).toBe('');
    });
});

describe('filtering', () => {
    const seeded = (): LogStore => {
        const logs = open();
        logs.write(line({ level: LEVELS.info, msg: 'ok', service: 'radarr' }));
        logs.write(line({ level: LEVELS.warn, msg: 'slow', service: 'sonarr' }));
        logs.write(line({ level: LEVELS.error, msg: 'broken', service: 'radarr' }));
        return logs;
    };

    it('filters by minimum level, inclusively', () => {
        const rows = seeded().recent({ minLevel: LEVELS.warn });
        expect(rows.map(r => r.msg).sort()).toEqual(['broken', 'slow']);
    });

    it('filters by service', () => {
        const rows = seeded().recent({ service: 'radarr' });
        expect(rows.map(r => r.msg).sort()).toEqual(['broken', 'ok']);
    });

    it('combines both filters', () => {
        const rows = seeded().recent({ service: 'radarr', minLevel: LEVELS.error });
        expect(rows.map(r => r.msg)).toEqual(['broken']);
    });

    it('lists only services that actually logged, so the filter offers no dead options', () => {
        expect(seeded().services()).toEqual(['radarr', 'sonarr']);
    });

    it('returns only rows newer than one already seen, for polling', () => {
        const logs = seeded();
        const newest = logs.recent()[0]!.id;
        logs.write(line({ msg: 'later' }));

        expect(logs.recent({ afterId: newest }).map(r => r.msg)).toEqual(['later']);
    });

    it('clamps a silly limit rather than trusting it', () => {
        const logs = seeded();
        expect(logs.recent({ limit: 0 })).toHaveLength(1);
        expect(logs.recent({ limit: 10_000_000 }).length).toBeLessThanOrEqual(LOG_RING_SIZE);
    });
});

describe('ring behaviour', () => {
    // The whole point of a ring buffer: a chatty service must not fill a home
    // server's disk.
    it('discards the oldest rows once it is full', () => {
        const logs = open();
        for (let i = 0; i < LOG_RING_SIZE + 250; i += 1) logs.write(line({ msg: `line ${i}` }));
        logs.prune();

        // Exactly the size, not "at most": `<=` is what let the ring keep
        // LOG_RING_SIZE - 1 rows unnoticed.
        expect(logs.count()).toBe(LOG_RING_SIZE);
        // The newest survived, the oldest did not.
        expect(logs.recent(  { limit: 1 })[0]?.msg).toBe(`line ${LOG_RING_SIZE + 249}`);
        expect(logs.recent({ limit: LOG_RING_SIZE }).some(r => r.msg === 'line 0')).toBe(false);
    });
});

describe('the fields a row carries', () => {
    it('flattens one level, so a serialized error reads as fields rather than a blob', () => {
        const logs = open();
        logs.write(
            line({
                level: LEVELS.warn,
                service: 'radarr',
                msg: 'source failed; degrading rather than failing',
                err: { type: 'ServiceError', kind: 'Timeout', detail: 'no response within the configured timeout' }
            })
        );

        const [row] = logs.recent();
        expect(logFields(row!.fields)).toEqual([
            ['err.type', 'ServiceError'],
            ['err.kind', 'Timeout'],
            ['err.detail', 'no response within the configured timeout']
        ]);
    });

    it('drops the stack, which is the one field a table cannot show', () => {
        const logs = open();
        logs.write(line({ err: { kind: 'Timeout', stack: 'ServiceError: ...\n    at somewhere' }, stack: 'top' }));

        const keys = logFields(logs.recent()[0]!.fields).map(([key]) => key);
        expect(keys).toEqual(['err.kind']);
    });

    it('keeps scalars as they are, and renders a non-string as JSON', () => {
        const logs = open();
        logs.write(line({ ip: '192.168.178.82', port: 6060, queryOffered: false }));

        expect(logFields(logs.recent()[0]!.fields)).toEqual([
            ['ip', '192.168.178.82'],
            ['port', '6060'],
            ['queryOffered', 'false']
        ]);
    });

    it('has nothing to show for a line that carried no extra fields', () => {
        const logs = open();
        logs.write(line());

        expect(logFields(logs.recent()[0]!.fields)).toEqual([]);
    });

    it('shows an unparseable blob verbatim rather than dropping it', () => {
        expect(logFields('not json')).toEqual([['fields', 'not json']]);
    });
});
