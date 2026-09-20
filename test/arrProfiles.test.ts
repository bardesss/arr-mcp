import { describe, expect, it } from 'vitest';
import type { BaseServiceConfig } from '../src/config/schema.ts';
import { apiKeyHeader } from '../src/core/auth.ts';
import { ServiceHttp } from '../src/core/http.ts';
import { readArrProfileDiagnostics } from '../src/services/arrProfiles.ts';

const config: BaseServiceConfig = {
    url: 'http://192.168.1.20:7878',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** `/api/v3/qualityprofile`, `/api/v3/customformat` and `/api/v3/language`
 *  answer in that order, matched positionally to the three GETs
 *  `readArrProfileDiagnostics` fires with `Promise.all`. */
const http = (profiles: unknown[], formats: unknown[], languages: unknown[]) => {
    const responses: Record<string, unknown[]> = {
        '/api/v3/qualityprofile': profiles,
        '/api/v3/customformat': formats,
        '/api/v3/language': languages
    };
    const fetchImpl = (async (input: unknown) => {
        const url = new URL(String(input));
        const body = responses[url.pathname];
        return json(body ?? []);
    }) as unknown as typeof fetch;
    return new ServiceHttp('radarr', config, apiKeyHeader('X-Api-Key', 'secret'), fetchImpl);
};

describe('readArrProfileDiagnostics', () => {
    it('defaults a profile missing name and minFormatScore, and drops formatItems with no name', async () => {
        const result = await readArrProfileDiagnostics(
            http(
                [{ formatItems: [{ name: 'French', score: 3 }, { score: 5 }, { name: 'German' }] }],
                [],
                []
            )
        );

        expect(result.profiles).toEqual([
            {
                name: '',
                minFormatScore: 0,
                formatItems: [
                    { name: 'French', score: 3 },
                    { name: 'German', score: 0 }
                ]
            }
        ]);
    });

    it('defaults a custom format specification missing its flags, and drops fields with no name', async () => {
        const result = await readArrProfileDiagnostics(
            http(
                [],
                [
                    {
                        name: 'Dutch',
                        specifications: [{ fields: [{ name: 'value', value: 7 }, { value: 'ignored' }] }]
                    }
                ],
                []
            )
        );

        expect(result.formats).toEqual([
            {
                name: 'Dutch',
                specifications: [
                    {
                        implementation: '',
                        negate: false,
                        required: false,
                        fields: [{ name: 'value', value: 7 }]
                    }
                ]
            }
        ]);
    });

    it('keeps only languages with both a numeric id and a name', async () => {
        const result = await readArrProfileDiagnostics(
            http([], [], [{ id: 1, name: 'Dutch' }, { id: 2 }, { name: 'no id' }])
        );

        expect(result.languages).toEqual([{ id: 1, name: 'Dutch' }]);
    });
});
