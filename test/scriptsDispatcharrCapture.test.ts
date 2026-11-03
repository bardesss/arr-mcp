import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anonymiseDispatcharr, findDispatcharrSecrets } from '../scripts/lib/dispatcharrCapture.ts';
import { refreshReason } from '../src/services/dispatcharr.ts';

const SECRET_URL = 'http://iptv.real-provider.tv/get.php?username=bob&password=s3cret';

/** An admin's view of /api/m3u/accounts/ at v0.33.0: the password comes back. */
const adminAccounts = [
    {
        id: 7,
        name: 'My Real Provider',
        server_url: SECRET_URL,
        file_path: '/data/m3u/real.m3u',
        username: 'bob',
        password: 's3cret',
        custom_properties: { xc: { password: 's3cret' } },
        status: 'error',
        last_message: `Server returned HTTP 884 (authentication/authorization failure) from URL: ${SECRET_URL}. Server message: bob s3cret`,
        profiles: [
            {
                id: 3,
                name: 'Bob main line',
                search_pattern: 'bob',
                replace_pattern: 's3cret',
                custom_properties: { password: 's3cret' },
                exp_date: '2027-01-01T00:00:00Z',
                account: { id: 7, name: 'My Real Provider', account_type: 'XC' }
            }
        ],
        // Seen live on 0.33.0: the provider and profile names are repeated here.
        all_expirations: [{ profile_id: 3, profile_name: 'Bob main line', exp_date: '2027-01-01T00:00:00Z' }],
        channel_groups: [{ channel_group: 1, custom_properties: { xc_id: '42' } }],
        filters: [{ regex_pattern: 'bob.*' }]
    }
];
const adminSources = [
    { id: 2, name: 'Real EPG', url: SECRET_URL, username: 'bob', status: 'error', last_message: `Error refreshing EPG data: 404 Client Error: Not Found for url: ${SECRET_URL}` }
];

describe('anonymiseDispatcharr', () => {
    it('removes every credential from M3U accounts and their profiles', () => {
        const out = JSON.stringify(anonymiseDispatcharr(adminAccounts));
        for (const leak of ['bob', 's3cret', 'real-provider', 'My Real Provider', '/data/m3u']) expect(out).not.toContain(leak);
    });

    it('drops channel groups and filters, which the adapter never reads', () => {
        const [row] = anonymiseDispatcharr(adminAccounts) as Record<string, unknown>[];
        expect(row).not.toHaveProperty('channel_groups');
        expect(row).not.toHaveProperty('filters');
    });

    it('renames the provider and profile names wherever they repeat', () => {
        const [row] = anonymiseDispatcharr(adminAccounts) as { profiles: { account: { name: string } }[]; all_expirations: { profile_name: string }[] }[];
        expect(row?.profiles[0]?.account.name).toBe('Example Provider 1');
        expect(row?.all_expirations[0]?.profile_name).toBe('Example Profile 1');
    });

    it('removes every credential from EPG sources', () => {
        const out = JSON.stringify(anonymiseDispatcharr(adminSources));
        for (const leak of ['bob', 's3cret', 'real-provider', 'Real EPG']) expect(out).not.toContain(leak);
    });

    it('keeps the fields the adapter reads', () => {
        const [row] = anonymiseDispatcharr(adminAccounts) as Record<string, unknown>[];
        expect(row).toMatchObject({ id: 7, status: 'error', name: 'Example Provider 1' });
        expect((row?.profiles as Record<string, unknown>[])[0]).toMatchObject({ id: 3, name: 'Example Profile 1', exp_date: '2027-01-01T00:00:00Z' });
    });

    it('keeps last_message in the same shape, so the classifier reads it the same way', () => {
        const [account] = anonymiseDispatcharr(adminAccounts) as { last_message: string }[];
        const [epg] = anonymiseDispatcharr(adminSources) as { last_message: string }[];
        expect(account?.last_message).toContain('provider.example');
        expect(refreshReason(account?.last_message)).toBe(refreshReason(adminAccounts[0]?.last_message));
        expect(refreshReason(epg?.last_message)).toBe(refreshReason(adminSources[0]?.last_message));
    });

    it("keeps Dispatcharr's fixed messages classifiable, without the names some of them carry", () => {
        const messages = [
            'No M3U source available (missing URL and file)',
            'EPG file appears incomplete (missing closing </tv>). Keeping previous data when available; will retry on next refresh.',
            "EPG source 'Bob TV' rate limited (429) - try again later",
            'Authentication failed for profile Bob main line (3)',
            "EPG source 'Bob TV' encountered HTTP error 502",
            "Timeout error: EPG source 'Bob TV' took too long to respond"
        ];
        for (const message of messages) {
            const [row] = anonymiseDispatcharr([{ id: 1, name: 'x', url: '', status: 'error', last_message: message }]) as { last_message: string }[];
            expect(refreshReason(row?.last_message)).toBe(refreshReason(message));
            expect(row?.last_message).not.toContain('Bob');
        }
    });

    it('leaves a non-list body alone', () => {
        expect(anonymiseDispatcharr({ version: '0.33.0' })).toEqual({ version: '0.33.0' });
    });
});

describe('findDispatcharrSecrets', () => {
    it('names what is left in an unredacted body', () => {
        expect(findDispatcharrSecrets(adminAccounts)).not.toEqual([]);
    });

    it('finds nothing once redacted', () => {
        expect(findDispatcharrSecrets(anonymiseDispatcharr(adminAccounts))).toEqual([]);
        expect(findDispatcharrSecrets(anonymiseDispatcharr(adminSources))).toEqual([]);
    });
});

const FIXTURES = join(import.meta.dirname, 'fixtures', 'dispatcharr');
const fixtureFiles = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter(f => f.endsWith('.json')) : [];

describe.skipIf(fixtureFiles.length === 0)('committed Dispatcharr fixtures', () => {
    const dir = FIXTURES;
    for (const file of fixtureFiles) {
        it(`${file} holds no credentials`, () => {
            expect(findDispatcharrSecrets(JSON.parse(readFileSync(join(dir, file), 'utf8')))).toEqual([]);
        });
    }
});
