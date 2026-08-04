import { describe, expect, it } from 'vitest';
import { logger } from '../src/core/logger.ts';

describe('toolchain', () => {
    it('exposes a logger with the app name bound', () => {
        expect(logger).toBeDefined();
        expect(typeof logger.info).toBe('function');
        expect(logger.bindings().app).toBe('arr-mcp');
    });

    it('leaves `service` free for per-service log filtering', () => {
        // Binding the app name to `service` would collide with the media
        // service a log line is about and emit a duplicate JSON key.
        expect(logger.bindings().service).toBeUndefined();
    });
});
