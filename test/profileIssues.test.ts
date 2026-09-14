import { describe, expect, it } from 'vitest';
import { floorFindings, positiveTotal, type ProfileInput } from '../src/tools/profileIssues/rules.ts';

const profile = (over: Partial<ProfileInput>): ProfileInput => ({ name: 'p', minFormatScore: 0, formatItems: [], ...over });

describe('floor rules', () => {
    it('sums only positive scores', () => {
        expect(positiveTotal(profile({ formatItems: [{ name: 'a', score: 500 }, { name: 'b', score: -10000 }] }))).toBe(500);
    });

    it('flags a floor no release can reach', () => {
        const found = floorFindings(profile({ minFormatScore: 1000, formatItems: [{ name: 'a', score: 500 }] }));
        expect(found.map(f => f.kind)).toEqual(['unreachable_floor']);
        expect(found[0]?.confidence).toBe('certain');
    });

    it('flags a floor exactly equal to the achievable total', () => {
        const found = floorFindings(profile({ minFormatScore: 500000, formatItems: [{ name: 'Dutch', score: 500000 }] }));
        expect(found.map(f => f.kind)).toEqual(['knife_edge_floor']);
    });

    it('is quiet when the floor leaves headroom', () => {
        expect(floorFindings(profile({ minFormatScore: 100, formatItems: [{ name: 'a', score: 500 }] }))).toEqual([]);
    });

    it('is quiet on a profile with no floor and no positive scores', () => {
        expect(floorFindings(profile({ minFormatScore: 0, formatItems: [{ name: 'a', score: -10000 }] }))).toEqual([]);
    });

    it('does not fire on mutually exclusive formats that share an upper bound', () => {
        // Two source formats that can never both match. positiveTotal is an upper
        // bound, so a floor below it must not be reported as knife-edge.
        const found = floorFindings(profile({ minFormatScore: 100, formatItems: [{ name: 'Bluray', score: 100 }, { name: 'WEB', score: 100 }] }));
        expect(found).toEqual([]);
    });
});
