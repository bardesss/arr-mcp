import { describe, expect, it } from 'vitest';
import { logger } from '../src/core/logger.ts';

describe('toolchain', () => {
    it('exposes a logger with the service name bound', () => {
        expect(logger).toBeDefined();
        expect(typeof logger.info).toBe('function');
        expect(logger.bindings().service).toBe('arr-mcp');
    });
});
