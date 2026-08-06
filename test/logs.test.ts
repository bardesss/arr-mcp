import { afterEach, describe, expect, it } from 'vitest';
import { LEVELS, LOG_RING_SIZE, LogStore } from '../src/core/logs.ts';

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

        expect(logs.count()).toBeLessThanOrEqual(LOG_RING_SIZE);
        // The newest survived, the oldest did not.
        expect(logs.recent(  { limit: 1 })[0]?.msg).toBe(`line ${LOG_RING_SIZE + 249}`);
        expect(logs.recent({ limit: LOG_RING_SIZE }).some(r => r.msg === 'line 0')).toBe(false);
    });
});
