import { describe, expect, it } from 'vitest';
import { hostPort } from '../src/core/hostPort.ts';

describe('hostPort', () => {
    it('normalises host case, path and default ports', () => {
        expect(hostPort('http://Transmission.Example:9091/transmission/rpc')).toBe('transmission.example:9091');
        expect(hostPort('http://qbit.example/')).toBe('qbit.example:80');
        expect(hostPort('https://qbit.example')).toBe('qbit.example:443');
    });

    it('returns undefined for something that is not a URL', () => {
        expect(hostPort('not a url')).toBeUndefined();
    });
});
