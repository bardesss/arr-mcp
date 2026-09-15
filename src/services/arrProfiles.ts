import type { ServiceHttp } from '../core/http.ts';
import type { ProfileDiagnosticsData } from './types.ts';

type RawFormatItem = { name?: string | null; score?: number };
type RawProfile = { name?: string | null; minFormatScore?: number; formatItems?: RawFormatItem[] | null };
type RawField = { name?: string | null; value?: unknown };
type RawSpecification = {
    implementation?: string | null;
    negate?: boolean;
    required?: boolean;
    fields?: RawField[] | null;
};
type RawCustomFormat = { name?: string | null; specifications?: RawSpecification[] | null };
type RawLanguage = { id?: number; name?: string | null };

/**
 * The three reads `get_profile_issues` needs from one Radarr, Sonarr or
 * Whisparr — shared because Radarr and Sonarr answer these identically.
 * GET only: arr-mcp never writes a profile or a custom format.
 */
export async function readArrProfileDiagnostics(http: ServiceHttp): Promise<ProfileDiagnosticsData> {
    const [profiles, formats, languages] = await Promise.all([
        http.get<RawProfile[]>('/api/v3/qualityprofile'),
        http.get<RawCustomFormat[]>('/api/v3/customformat'),
        http.get<RawLanguage[]>('/api/v3/language')
    ]);

    return {
        profiles: profiles.map(p => ({
            name: p.name ?? '',
            minFormatScore: p.minFormatScore ?? 0,
            formatItems: (p.formatItems ?? [])
                .filter((f): f is RawFormatItem & { name: string } => typeof f.name === 'string')
                .map(f => ({ name: f.name, score: f.score ?? 0 }))
        })),
        formats: formats.map(cf => ({
            name: cf.name ?? '',
            specifications: (cf.specifications ?? []).map(s => ({
                implementation: s.implementation ?? '',
                negate: s.negate ?? false,
                required: s.required ?? false,
                fields: (s.fields ?? [])
                    .filter((f): f is RawField & { name: string } => typeof f.name === 'string')
                    .map(f => ({ name: f.name, value: f.value }))
            }))
        })),
        languages: languages
            .filter((l): l is RawLanguage & { id: number; name: string } => typeof l.id === 'number' && typeof l.name === 'string')
            .map(l => ({ id: l.id, name: l.name }))
    };
}
