import { describe, expect, it } from 'vitest';
import { floorFindings, positiveTotal, pureLanguageSet, subsetFindings, type CustomFormatInput, type ProfileInput } from '../src/tools/profileIssues/rules.ts';
import { dialectFindings, languagePreferenceFindings } from '../src/tools/profileIssues/rules.ts';

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

const lang = (name: string, values: number[]): CustomFormatInput => ({
    name,
    specifications: values.map(v => ({ implementation: 'LanguageSpecification', negate: false, required: false, fields: [{ name: 'value', value: v }] }))
});

describe('subset formats', () => {
    it('reads a pure language format as a value set', () => {
        expect([...(pureLanguageSet(lang('x', [7, 19])) ?? [])]).toEqual([7, 19]);
    });

    it('refuses to read a format with a release title condition', () => {
        expect(pureLanguageSet({ name: 'x', specifications: [{ implementation: 'ReleaseTitleSpecification', negate: false, required: false, fields: [{ name: 'value', value: 'NL' }] }] })).toBeUndefined();
    });

    it('refuses to read a negated language format', () => {
        expect(pureLanguageSet({ name: 'x', specifications: [{ implementation: 'LanguageSpecification', negate: true, required: false, fields: [{ name: 'value', value: 7 }] }] })).toBeUndefined();
    });

    it('refuses to read a required language format', () => {
        expect(pureLanguageSet({ name: 'x', specifications: [{ implementation: 'LanguageSpecification', negate: false, required: true, fields: [{ name: 'value', value: 7 }] }] })).toBeUndefined();
    });

    it('refuses to read a language format whose value is not a number', () => {
        expect(pureLanguageSet({ name: 'x', specifications: [{ implementation: 'LanguageSpecification', negate: false, required: false, fields: [{ name: 'value', value: 'dutch' }] }] })).toBeUndefined();
    });

    it('refuses to read a format with no conditions at all', () => {
        expect(pureLanguageSet({ name: 'x', specifications: [] })).toBeUndefined();
    });

    it('flags scoring the narrower of two language formats', () => {
        const formats = [lang('Dutch', [7]), lang('Language: Dutch', [7, 19])];
        const found = subsetFindings(profile({ name: '2160p Balanced NL', minFormatScore: 500000, formatItems: [{ name: 'Dutch', score: 500000 }, { name: 'Language: Dutch', score: 0 }] }), formats);
        expect(found.map(f => f.kind)).toEqual(['subset_format_scored']);
        expect(found[0]?.detail).toContain('Language: Dutch');
    });

    it('is quiet when the wider format is the one scored', () => {
        const formats = [lang('Dutch', [7]), lang('Language: Dutch', [7, 19])];
        expect(subsetFindings(profile({ formatItems: [{ name: 'Dutch', score: 0 }, { name: 'Language: Dutch', score: 500 }] }), formats)).toEqual([]);
    });

    it('is quiet when the two sets are equal', () => {
        const formats = [lang('A', [7]), lang('B', [7])];
        expect(subsetFindings(profile({ formatItems: [{ name: 'A', score: 500 }, { name: 'B', score: 0 }] }), formats)).toEqual([]);
    });
});

const NAMES = new Map([[7, 'Dutch'], [19, 'Flemish'], [1, 'English']]);

describe('likely rules', () => {
    it('flags a language scored but not required', () => {
        const found = languagePreferenceFindings(
            profile({ name: 'HD-2160p (NL)', minFormatScore: 0, formatItems: [{ name: 'Language: Dutch', score: 1000 }] }),
            [lang('Language: Dutch', [7, 19])]
        );
        expect(found.map(f => f.kind)).toEqual(['language_preferred_not_required']);
        expect(found[0]?.confidence).toBe('likely');
    });

    it('is quiet on a TRaSH-style preference profile with no language format', () => {
        expect(languagePreferenceFindings(
            profile({ name: 'WEB-2160p', minFormatScore: 0, formatItems: [{ name: 'Bluray Tier 01', score: 1000 }] }),
            [{ name: 'Bluray Tier 01', specifications: [{ implementation: 'ReleaseTitleSpecification', negate: false, required: false, fields: [{ name: 'value', value: 'x' }] }] }]
        )).toEqual([]);
    });

    it('is quiet when a language format is scored negatively', () => {
        // HD-1080p blocks Dutch at -10000. That is deliberate, not a fault.
        expect(languagePreferenceFindings(
            profile({ name: 'HD-1080p', minFormatScore: 0, formatItems: [{ name: 'Language: Dutch', score: -10000 }] }),
            [lang('Language: Dutch', [7, 19])]
        )).toEqual([]);
    });

    it('flags a load-bearing language gate missing its sibling', () => {
        const found = dialectFindings(
            profile({ name: '2160p Balanced NL', minFormatScore: 500000, formatItems: [{ name: 'Dutch', score: 500000 }] }),
            [lang('Dutch', [7])],
            NAMES
        );
        expect(found.map(f => f.kind)).toEqual(['dialect_sibling_missing']);
        expect(found[0]?.detail).toContain('Flemish');
    });

    it('is quiet when the sibling is present', () => {
        expect(dialectFindings(
            profile({ name: 'p', minFormatScore: 500000, formatItems: [{ name: 'Language: Dutch', score: 500000 }] }),
            [lang('Language: Dutch', [7, 19])],
            NAMES
        )).toEqual([]);
    });

    it('is quiet when the language format is not load-bearing', () => {
        // Floor is reachable without it, so it is a preference not a gate.
        expect(dialectFindings(
            profile({ name: 'p', minFormatScore: 100, formatItems: [{ name: 'Dutch', score: 100 }, { name: 'Other', score: 1000 }] }),
            [lang('Dutch', [7])],
            NAMES
        )).toEqual([]);
    });
});
