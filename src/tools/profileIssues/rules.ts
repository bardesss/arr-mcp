export type Confidence = 'certain' | 'likely';

export type FindingKind =
    | 'unreachable_floor'
    | 'knife_edge_floor'
    | 'subset_format_scored'
    | 'language_preferred_not_required'
    | 'dialect_sibling_missing'
    | 'profilarr_drift';

export type Finding = { kind: FindingKind; confidence: Confidence; detail: string; remedy: string };

export type FormatItem = { name: string; score: number };
export type ProfileInput = { name: string; minFormatScore: number; formatItems: FormatItem[] };

/**
 * An upper bound, not an achievable score: two custom formats may be mutually
 * exclusive. Every rule below only fires when even the bound fails, so the
 * approximation can never produce a false positive.
 */
export function positiveTotal(profile: ProfileInput): number {
    return profile.formatItems.reduce((sum, f) => (f.score > 0 ? sum + f.score : sum), 0);
}

export function floorFindings(profile: ProfileInput): Finding[] {
    const total = positiveTotal(profile);
    if (profile.minFormatScore > total) {
        return [{
            kind: 'unreachable_floor',
            confidence: 'certain',
            detail: `\`${profile.name}\` requires a score of ${profile.minFormatScore}, but every custom format it scores adds up to at most ${total}. Nothing can satisfy it.`,
            remedy: `In Profilarr, lower this profile's minimum custom format score below ${total}, or score the formats that would supply the difference.`
        }];
    }
    if (total > 0 && profile.minFormatScore === total) {
        return [{
            kind: 'knife_edge_floor',
            confidence: 'certain',
            detail: `\`${profile.name}\` requires ${profile.minFormatScore}, which is exactly the total of every positive custom format. Each one must match, and a single negative match rejects the release.`,
            remedy: `In Profilarr, lower this profile's minimum custom format score so it has headroom above the formats you actually require.`
        }];
    }
    return [];
}

export type Specification = { implementation: string; negate: boolean; required: boolean; fields: Array<{ name: string; value: unknown }> };
export type CustomFormatInput = { name: string; specifications: Specification[] };

/**
 * The language values of a format that is a pure OR over languages, or
 * undefined for anything else. `required` and `negate` change what the *arr
 * matcher does with a condition, so a format carrying either is not comparable
 * by set inclusion and is left alone.
 */
export function pureLanguageSet(cf: CustomFormatInput): Set<number> | undefined {
    if (cf.specifications.length === 0) return undefined;
    const values = new Set<number>();
    for (const spec of cf.specifications) {
        if (spec.implementation !== 'LanguageSpecification') return undefined;
        if (spec.negate || spec.required) return undefined;
        const raw = spec.fields.find(f => f.name === 'value')?.value;
        if (typeof raw !== 'number') return undefined;
        values.add(raw);
    }
    return values;
}

const isStrictSubset = (a: Set<number>, b: Set<number>): boolean =>
    a.size < b.size && [...a].every(v => b.has(v));

export function subsetFindings(profile: ProfileInput, formats: readonly CustomFormatInput[]): Finding[] {
    const byName = new Map(formats.map(f => [f.name, f]));
    const scored = profile.formatItems.filter(f => f.score > 0);
    const unscored = profile.formatItems.filter(f => f.score === 0);
    const findings: Finding[] = [];
    for (const narrow of scored) {
        const narrowSet = pureLanguageSet(byName.get(narrow.name) ?? { name: narrow.name, specifications: [] });
        if (!narrowSet) continue;
        for (const wide of unscored) {
            const wideSet = pureLanguageSet(byName.get(wide.name) ?? { name: wide.name, specifications: [] });
            if (!wideSet || !isStrictSubset(narrowSet, wideSet)) continue;
            findings.push({
                kind: 'subset_format_scored',
                confidence: 'certain',
                detail: `\`${profile.name}\` scores \`${narrow.name}\`, which matches fewer languages than \`${wide.name}\`. \`${wide.name}\` is scored 0, so releases it would have matched score nothing.`,
                remedy: `In Profilarr, score \`${wide.name}\` in this profile instead of \`${narrow.name}\`.`
            });
        }
    }
    return findings;
}

export type LanguageNames = ReadonlyMap<number, string>;

/** Keyed on names, resolved per instance: the id spaces of Radarr and Sonarr
 *  are not guaranteed to align. Confirmed against a live /api/v3/language. */
export const DIALECT_SIBLINGS: ReadonlyArray<readonly [string, string]> = [
    ['Dutch', 'Flemish'],
    ['Portuguese', 'Portuguese (Brazil)'],
    ['Spanish', 'Spanish (Latino)']
];

const hasLanguageCondition = (cf: CustomFormatInput | undefined): boolean =>
    (cf?.specifications ?? []).some(s => s.implementation === 'LanguageSpecification');

export function languagePreferenceFindings(profile: ProfileInput, formats: readonly CustomFormatInput[]): Finding[] {
    if (profile.minFormatScore !== 0) return [];
    const byName = new Map(formats.map(f => [f.name, f]));
    const scored = profile.formatItems.filter(f => f.score > 0 && hasLanguageCondition(byName.get(f.name)));
    if (scored.length === 0) return [];
    const names = scored.map(f => `\`${f.name}\``).join(', ');
    return [{
        kind: 'language_preferred_not_required',
        confidence: 'likely',
        detail: `\`${profile.name}\` scores ${names} but has no minimum custom format score, so a release in any language is still acceptable. It prefers the language rather than requiring it.`,
        remedy: `In Profilarr, set this profile's minimum custom format score above zero if the language is meant to be a requirement.`
    }];
}

export function dialectFindings(profile: ProfileInput, formats: readonly CustomFormatInput[], languages: LanguageNames): Finding[] {
    if (profile.minFormatScore <= 0) return [];
    const byName = new Map(formats.map(f => [f.name, f]));
    const total = positiveTotal(profile);
    const findings: Finding[] = [];
    for (const item of profile.formatItems) {
        if (item.score <= 0) continue;
        // Load-bearing: without it the floor is out of reach, so it gates.
        if (total - item.score >= profile.minFormatScore) continue;
        const values = pureLanguageSet(byName.get(item.name) ?? { name: item.name, specifications: [] });
        if (!values) continue;
        const present = new Set([...values].map(v => languages.get(v)).filter((n): n is string => n !== undefined));
        for (const [a, b] of DIALECT_SIBLINGS) {
            for (const [have, missing] of [[a, b], [b, a]] as const) {
                if (!present.has(have) || present.has(missing)) continue;
                findings.push({
                    kind: 'dialect_sibling_missing',
                    confidence: 'likely',
                    detail: `\`${profile.name}\` requires \`${item.name}\` to reach its minimum score, and that format matches ${have} but not ${missing}. ${missing} releases are rejected outright.`,
                    remedy: `In Profilarr, add ${missing} to \`${item.name}\`, or score a format that covers both.`
                });
            }
        }
    }
    return findings;
}
