import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config/load.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { unfence } from '../src/core/fence.ts';
import { LogStore } from '../src/core/logs.ts';
import { PlayHistory } from '../src/core/playHistory.ts';
import { Runtime } from '../src/core/runtime.ts';
import { hashPassword } from '../src/core/session.ts';
import { WebhookEvents } from '../src/core/webhookEvents.ts';
import { JELLYFIN_PLAY_TEMPLATE, parseJellyfinPlay } from '../src/services/jellyfinWebhook.ts';
import { CONFIG_TABS } from '../src/web/configPage.ts';

const USER = '0123456789abcdef0123456789abcdef';
const DASHED_USER = '01234567-89AB-CDEF-0123-456789ABCDEF';

// Values as the plugin's Handlebars template renders them: every one a string.
const filmStop = (extra: Record<string, unknown> = {}) => ({
    NotificationType: 'PlaybackStop',
    ItemId: 'aaaabbbbccccddddeeeeffff00001111',
    ItemType: 'Movie',
    Name: 'Dune',
    Year: '2021',
    Provider_tmdb: '438631',
    Provider_imdb: 'tt1160419',
    UserId: DASHED_USER,
    NotificationUsername: 'Sam',
    PlayedToCompletion: 'True',
    ...extra
});

const episodeStop = (extra: Record<string, unknown> = {}) => ({
    ...filmStop(),
    ItemId: 'bbbb0000cccc1111dddd2222eeee3333',
    ItemType: 'Episode',
    Name: 'Pilot',
    SeriesName: 'A Show',
    SeasonNumber: '1',
    EpisodeNumber: '2',
    Year: '2019',
    Provider_tvdb: '9999',
    ...extra
});

describe('parseJellyfinPlay', () => {
    it('reads a finished film with its year and ids, and the ids in the API form', () => {
        const play = parseJellyfinPlay('jellyfin', filmStop());
        expect(play?.userId).toBe(USER);
        expect(play?.record).toMatchObject({ kind: 'movie', year: 2021, ids: { tmdb: 438631, imdb: 'tt1160419' }, entry: { itemId: 'aaaabbbbccccddddeeeeffff00001111', user: 'Sam' } });
        expect(unfence(play?.record.entry.title ?? '')).toBe('Dune');
    });

    it("reads an episode with its numbering and the series' year, but not the episode's ids", () => {
        const play = parseJellyfinPlay('jellyfin', episodeStop());
        expect(play?.record).toMatchObject({ kind: 'episode', year: 2019, entry: { season: 1, episode: 2 } });
        expect(play?.record.ids).toBeUndefined();
        expect(unfence(play?.record.entry.seriesTitle ?? '')).toBe('A Show');
    });

    it('reads a finished song as a track, with its artist, when the destination sends music', () => {
        const play = parseJellyfinPlay('jellyfin', filmStop({ ItemType: 'Audio', Name: 'A Song', Artist: 'A Band', Year: '1999', Provider_tmdb: undefined, Provider_imdb: undefined }));
        expect(play?.record).toMatchObject({ kind: 'track', year: 1999 });
        expect(play?.record.ids).toBeUndefined();
        expect(unfence(play?.record.entry.seriesTitle ?? '')).toBe('A Band');
    });

    it('drops a stop partway through, any other notification, and anything but a film, episode or song', () => {
        expect(parseJellyfinPlay('jellyfin', filmStop({ PlayedToCompletion: 'False' }))).toBeUndefined();
        expect(parseJellyfinPlay('jellyfin', filmStop({ PlayedToCompletion: undefined }))).toBeUndefined();
        expect(parseJellyfinPlay('jellyfin', filmStop({ NotificationType: 'PlaybackStart' }))).toBeUndefined();
        expect(parseJellyfinPlay('jellyfin', filmStop({ ItemType: 'MusicVideo' }))).toBeUndefined();
        expect(parseJellyfinPlay('jellyfin', null)).toBeUndefined();
    });

    it('gives a template that renders to the same keys the parser reads', () => {
        const template = Object.keys(JSON.parse(JELLYFIN_PLAY_TEMPLATE) as object).sort();
        expect(template).toEqual(Object.keys({ ...filmStop(), ...episodeStop(), Artist: '' }).sort());
    });
});

describe('the Jellyfin play webhook route', () => {
    const SECRET = 's'.repeat(40);
    let dir: string;
    let audit: WriteAudit;
    let logs: LogStore;
    let events: WebhookEvents;
    let plays: PlayHistory;
    let app: ReturnType<typeof buildApp>;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'arr-mcp-jellyfin-webhook-'));
        audit = WriteAudit.ephemeral();
        logs = LogStore.ephemeral();
        events = WebhookEvents.ephemeral();
        plays = PlayHistory.ephemeral();
        await writeFile(
            join(dir, 'config.yaml'),
            `auth:\n  username: admin\n  password_hash: ${await hashPassword('test-password-1234')}\n  allowed_hosts: []\n` +
                `services:\n  jellyfin:\n    url: http://jellyfin.test:8096\n    api_key: ${'a'.repeat(32)}\n    default_user: Sam\n` +
                `webhooks:\n  enabled: true\n  secret: ${SECRET}\n  retention_days: 30\n`,
            'utf8'
        );
        const { config } = await loadConfig(dir);
        app = buildApp({ runtime: Runtime.fromConfig(config, audit, { configDir: dir }), audit, logs, events, plays });
    });

    afterEach(async () => {
        audit.close();
        logs.close();
        events.close();
        plays.close();
        await rm(dir, { recursive: true, force: true });
    });

    const post = (path: string, body: unknown, password = SECRET) =>
        app.request(`http://localhost:6060${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`arr-mcp:${password}`).toString('base64')}` },
            body: JSON.stringify(body)
        });

    it('records a finished play for the user it names, and nothing in the *arr event log', async () => {
        expect((await post('/webhooks/jellyfin', filmStop())).status).toBe(200);
        expect(plays.read('jellyfin', USER).map(r => r.entry.itemId)).toEqual(['aaaabbbbccccddddeeeeffff00001111']);
        expect(events.read({}).total).toBe(0);
    });

    // Captured from the plugin's "Send All Properties" on Jellyfin 12.4.0, then
    // scrubbed of titles, ids, device and user. It posts a form, not JSON.
    const captured = async (completed: boolean) =>
        (await readFile(join(import.meta.dirname, 'fixtures', 'webhooks', 'jellyfin', 'PlaybackStop.form'), 'utf8'))
            .trim()
            .replace('PlayedToCompletion=False', `PlayedToCompletion=${completed ? 'True' : 'False'}`);
    const postForm = (body: string) =>
        app.request('http://localhost:6060/webhooks/jellyfin', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`arr-mcp:${SECRET}`).toString('base64')}` },
            body
        });

    it('reads the form the plugin posts with Send All Properties, keeping only a finished play', async () => {
        expect((await postForm(await captured(false))).status).toBe(200);
        expect(plays.read('jellyfin', USER)).toEqual([]);

        expect((await postForm(await captured(true))).status).toBe(200);
        const [row] = plays.read('jellyfin', USER);
        expect(row).toMatchObject({ kind: 'episode', year: 2022, entry: { itemId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', season: 4, episode: 4, user: 'Sam' } });
        expect(unfence(row?.entry.seriesTitle ?? '')).toBe('Series Title');
    });

    it('answers 200 and stores nothing for a notification it does not keep', async () => {
        expect((await post('/webhooks/jellyfin', filmStop({ NotificationType: 'ItemAdded' }))).status).toBe(200);
        expect(plays.read('jellyfin', USER)).toEqual([]);
    });

    it('gives the plugin steps and the whole Authorization header on the config page', async () => {
        let cookie = '';
        const call = async (path: string, init: RequestInit = {}) => {
            const res = await app.request(`http://localhost:6060${path}`, { ...init, headers: { ...(init.headers ?? {}), ...(cookie === '' ? {} : { cookie }) } });
            const set = res.headers.get('set-cookie');
            if (set !== null) cookie = set.split(';')[0] ?? '';
            return res;
        };
        await call('/ui/login', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: 'admin', password: 'test-password-1234' }).toString()
        });
        const page = (await Promise.all(CONFIG_TABS.map(async t => (await call(`/ui/config?tab=${t.key}`)).text()))).join('\n');

        expect(page).toContain('Jellyfin plays');
        expect(page).toContain('/webhooks/jellyfin');
        expect(page).toContain('Send All Properties');
        expect(page).toContain(`value="Basic ${Buffer.from(`arr-mcp:${SECRET}`).toString('base64')}"`);
        const copy = /<button[^>]*data-copy="webhooks\.jellyfin-header"[^>]*>/.exec(page)?.[0] ?? '';
        expect(copy).toContain('type="button"');
    });

    it('wants the secret, a NotificationType, and a configured instance', async () => {
        expect((await post('/webhooks/jellyfin', filmStop(), 'w'.repeat(40))).status).toBe(401);
        expect((await post('/webhooks/jellyfin', { Name: 'Dune' })).status).toBe(400);
        expect((await post('/webhooks/jellyfin/other', filmStop())).status).toBe(404);
    });
});
