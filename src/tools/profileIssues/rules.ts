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
