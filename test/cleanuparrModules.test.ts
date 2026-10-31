import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CleanuparrAdapter } from '../src/services/cleanuparr.ts';
import type { CleanuparrRuleSet, QueueItem, ServiceAdapter } from '../src/services/types.ts';
import { coverageNotes, matchesSimple, moduleNotes, normalisePath } from '../src/tools/cleanuparrModules.ts';
import { buildSeedingRules } from '../src/tools/seedingRules.ts';
import { expectWithinBudget } from './helpers/budget.ts';

const config = { url: 'http://cleanuparr:11011', api_key: 'k', timeout_ms: 5000, permissions: { safe_write: false, destructive: false } };
const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'cleanuparr', `${name}.json`), 'utf8'));
const real = (name: string): unknown => fixture(`2.10.12/${name}`);
function stub(routes: Record<string, unknown>, seen: string[] = []): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        seen.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        if (!(url.pathname in routes)) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify(routes[url.pathname]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
}

const QBIT_ID = '839d2aed-2a78-444f-813b-774598a79756';

/** The captured client list names its host `<host>`; a real one is a URL, which is what maps the set. */
const clients = { Clients: [{ ...(real('status-download-client') as { Clients: object[] }).Clients[0], host: 'http://qbit.example:8080' }] };

type Cleaner = { clients: Array<{ orphanedFilesConfig: Record<string, unknown>; unlinkedConfig: Record<string, unknown>; deadTorrentConfig: Record<string, unknown> }> };
const cleaner = (edit: (c: Cleaner['clients'][number]) => void = () => {}): Cleaner => {
    const body = structuredClone(real('configuration-download_cleaner')) as Cleaner;
    const first = body.clients[0];
    if (first !== undefined) edit(first);
    return body;
};

const routes = (over: Record<string, unknown> = {}) => ({
    '/api/status': real('status'),
    '/api/jobs': real('jobs'),
    '/api/status/download-client': clients,
    [`/api/seeding-rules/${QBIT_ID}`]: real('seeding-rules'),
    '/api/configuration/download_cleaner': real('configuration-download_cleaner'),
    '/api/configuration/general': { dryRun: false, ignoredDownloads: [] },
    ...over
});

const setOf = async (over: Record<string, unknown> = {}): Promise<CleanuparrRuleSet> => {
    const set = (await new CleanuparrAdapter(config, stub(routes(over))).getSeedingRules()).sets[0];
    if (set === undefined) throw new Error('no set');
    return set;
};

const torrent = (savePath: string): QueueItem => ({
    service: 'qbittorrent',
    id: savePath,
    title: 't',
    status: 'seeding',
    torrent: { hash: 'h', category: '', tags: [], trackerDomains: [], savePath, stopped: false, seeding: true }
});

const qbit = (paths: string[]) =>
    ({ id: 'qbittorrent', type: 'qbittorrent', endpoint: 'qbit.example:8080', getQueue: async () => paths.map(torrent) }) as unknown as ServiceAdapter;

const cover = (set: CleanuparrRuleSet, dirs: string[]) => coverageNotes(set, { service: 'qbittorrent', dirs }, new Set(dirs.map(normalisePath)));

describe('Cleanuparr cleaner modules, against the captured 2.10.12 configuration', () => {
    it('reads each module with its settings', async () => {
        const set = await setOf();
        expect(set.unlinked).toEqual({ enabled: true, categories: ['radarr', 'tv-sonarr'], target: 'cleanuparr-unlinked' });
        expect(set.deadTorrents).toEqual({ enabled: true, categories: ['radarr', 'tv-sonarr', 'cross-seed-link'], target: 'cleanuparr-dead', maxStrikes: 3 });
        expect(set.orphanedFiles).toMatchObject({ enabled: true, minFileAgeHours: 24, purgeAfterHours: 24 });
        if (set.orphanedFiles?.enabled !== true) throw new Error('orphaned files off');
        expect(set.orphanedFiles.scanDirectories).toHaveLength(9);
        expect(set.orphanedFiles.scanDirectories[0]).toBe('<<untrusted:cleanuparr.path>>/downloads<</untrusted>>');
        expect(set.orphanedFiles.orphanedDirectory).toContain('/downloads/orphaned');
        expect(set.orphanedFiles.excludePatterns).toContain('cleanuparr-*');
        expect(set.orphanScan?.scanDirectories[4]).toBe('/downloads/cross-seed/<tracker 1>');
    });

    it('has nothing to say about it: every target has a rule and the orphans are purged', async () => {
        expect(moduleNotes(await setOf())).toEqual([]);
    });

    it('stays quiet when the save directories are the ones it scans', async () => {
        const set = await setOf();
        expect(cover(set, ['/downloads/complete/radarr', '/downloads/complete/sonarr/', '/downloads/cross-seed/<tracker 1>'])).toEqual([]);
    });

    it('carries no modules from an older Cleanuparr that reports none per client', async () => {
        const set = await setOf({ '/api/configuration/download_cleaner': fixture('configuration-download_cleaner') });
        expect(set.unlinked).toBeUndefined();
        expect(set.orphanedFiles).toBeUndefined();
        expect(set.orphanScan).toBeUndefined();
    });

    it('reports a disabled module as only that', async () => {
        const set = await setOf({
            '/api/configuration/download_cleaner': cleaner(c => {
                c.orphanedFilesConfig.enabled = false;
                c.unlinkedConfig.enabled = false;
            })
        });
        expect(set.orphanedFiles).toEqual({ enabled: false });
        expect(set.unlinked).toEqual({ enabled: false });
        expect(set.orphanScan).toBeUndefined();
    });

    it('never asks for the download client configuration, which holds passwords', async () => {
        const seen: string[] = [];
        await new CleanuparrAdapter(config, stub(routes(), seen)).getSeedingRules();
        expect(seen.some(s => s.includes('/api/configuration/download_client'))).toBe(false);
        expect(seen.every(s => s.startsWith('GET '))).toBe(true);
    });
});

describe('cleaner module notes', () => {
    it('says when the orphaned directory is never purged', async () => {
        const set = await setOf({ '/api/configuration/download_cleaner': cleaner(c => (c.orphanedFilesConfig.purgeAfterHours = null)) });
        expect(set.orphanedFiles).not.toHaveProperty('purgeAfterHours');
        const [note] = moduleNotes(set);
        expect(note).toContain('never purges it');
        expect(note).toContain('/downloads/orphaned');
    });

    it('says when a target category no seeding rule covers', async () => {
        const set = await setOf({ '/api/configuration/download_cleaner': cleaner(c => (c.deadTorrentConfig.targetCategory = 'graveyard')) });
        expect(moduleNotes(set)).toEqual([
            `Cleanuparr's Dead Torrents module on "${set.client}" moves torrents reporting no seeders into category "graveyard", ` +
                "which none of that client's seeding rules covers, so they seed there until someone removes them."
        ]);
    });

    it('leaves a module that tags alone, since the torrent keeps the category its rule covers', async () => {
        const set = await setOf({
            '/api/configuration/download_cleaner': cleaner(c => {
                c.unlinkedConfig.targetCategory = 'nowhere';
                c.unlinkedConfig.useTag = true;
            })
        });
        expect(set.unlinked).toMatchObject({ useTag: true });
        expect(moduleNotes(set)).toEqual([]);
    });
});

describe('orphan scan coverage', () => {
    it('names a save directory the scan does not cover', async () => {
        const notes = cover(await setOf(), ['/downloads/complete/radarr', '/downloads/incomplete/radarr']);
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain('/downloads/incomplete/radarr');
        expect(notes[0]).toContain('never found');
    });

    it('warns that an unexcluded folder between a scan and a save directory would be moved whole', async () => {
        const notes = cover(await setOf(), ['/downloads/music/flac']);
        expect(notes[0]).toContain('the entry <<untrusted:qbittorrent.path>>music<</untrusted>> inside it holds torrents');
        expect(notes[0]).toContain('move it whole');
        expect(notes[0]).toContain('one per tracker');
        expect(notes[1]).toContain('does not scan');
    });

    it('flags a cross-seed parent that is scanned but not excluded', async () => {
        const set = await setOf({
            '/api/configuration/download_cleaner': cleaner(c => {
                c.orphanedFilesConfig.scanDirectories = ['/downloads/cross-seed'];
                c.orphanedFilesConfig.excludePatterns = [];
            })
        });
        // A torrent saved straight into the tracker folder claims it; one a level deeper does not.
        expect(cover(set, ['/downloads/cross-seed/TrackerA']).filter(n => n.includes('move it whole'))).toEqual([]);
        expect(cover(set, ['/downloads/cross-seed/TrackerA/movies']).some(n => n.includes('TrackerA<</untrusted>> inside it'))).toBe(true);
    });

    it('caps what it names, so a scan of the root stays inside the budget', async () => {
        const set = await setOf({
            '/api/configuration/download_cleaner': cleaner(c => {
                c.orphanedFilesConfig.scanDirectories = ['/'];
                c.orphanedFilesConfig.excludePatterns = [];
            })
        });
        const dirs = Array.from({ length: 500 }, (_, i) => `/volume${i}/torrents/category`);
        const notes = cover(set, dirs);
        expect(notes.filter(n => n.includes('move it whole'))).toHaveLength(5);
        expect(notes).toContain(`495 more entries in Cleanuparr's "${set.client}" scan directories would be moved the same way.`);
        expect(notes.at(-1)).toContain('and 495 more');
        expectWithinBudget(notes, 2000);
    });

    it('counts a directory another client saves into as claimed', async () => {
        const set = await setOf();
        const notes = coverageNotes(set, { service: 'qbittorrent', dirs: ['/downloads/music/flac'] }, new Set(['/downloads/music']));
        expect(notes.some(n => n.includes('move it whole'))).toBe(false);
    });

    it('compares paths the way Cleanuparr does: either slash, no trailing one, any case', async () => {
        expect(cover(await setOf(), ['\\downloads\\Complete\\Radarr\\', '//downloads//complete//sonarr'])).toEqual([]);
    });

    it('says it cannot tell, rather than flag every directory, when no save path is under any scan directory', async () => {
        const notes = cover(await setOf(), ['/data/torrents/radarr', '/data/torrents/sonarr']);
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain('cannot tell what the scan covers');
        expect(notes[0]).toContain('another mount');
    });

    it('says nothing without save directories or with the scan off', async () => {
        expect(cover(await setOf(), [])).toEqual([]);
        const off = await setOf({ '/api/configuration/download_cleaner': cleaner(c => (c.orphanedFilesConfig.enabled = false)) });
        expect(cover(off, ['/elsewhere'])).toEqual([]);
    });
});

describe('simple expressions', () => {
    it('matches like FileSystemName.MatchesSimpleExpression, ignoring case', () => {
        expect(matchesSimple('cleanuparr-*', 'Cleanuparr-Dead')).toBe(true);
        expect(matchesSimple('*.nfo', 'film.nfo')).toBe(true);
        expect(matchesSimple('?ovies', 'movies')).toBe(true);
        expect(matchesSimple('complete', 'completed')).toBe(false);
        expect(matchesSimple('a.b', 'axb')).toBe(false);
    });
});

describe('stack_health cleaner modules', () => {
    const cleanuparr = (over: Record<string, unknown> = {}) => new CleanuparrAdapter(config, stub(routes(over))) as ServiceAdapter;

    it('lists the modules on the mapped set, without the unfenced paths, and checks the save directories', async () => {
        const rules = await buildSeedingRules([cleanuparr(), qbit(['/downloads/complete/radarr', '/downloads/books/epub'])], () => {});
        const [set] = rules.cleanuparr ?? [];
        expect(set?.service).toBe('qbittorrent');
        expect(set?.orphanedFiles).toMatchObject({ enabled: true, purgeAfterHours: 24 });
        expect(set).not.toHaveProperty('orphanScan');
        expect(JSON.stringify(rules)).not.toContain('"/downloads/cross-seed');
        // "books" is excluded, so only the missing scan is worth saying.
        expect(rules.notes.filter(n => n.includes('orphans'))).toEqual([expect.stringContaining('books/epub')]);
    });

    it('reads no queue when no orphan scan is on', async () => {
        let read = false;
        const client = { ...qbit([]), getQueue: async () => ((read = true), []) } as unknown as ServiceAdapter;
        const off = cleaner(c => (c.orphanedFilesConfig.enabled = false));
        await buildSeedingRules([cleanuparr({ '/api/configuration/download_cleaner': off }), client], () => {});
        expect(read).toBe(false);
    });

    it('marks a client whose queue cannot be read as degraded, and keeps the module notes', async () => {
        const degraded: string[] = [];
        const broken = { ...qbit([]), getQueue: async () => Promise.reject(new Error('down')) } as unknown as ServiceAdapter;
        const purgeless = cleaner(c => (c.orphanedFilesConfig.purgeAfterHours = null));
        const rules = await buildSeedingRules([cleanuparr({ '/api/configuration/download_cleaner': purgeless }), broken], id => degraded.push(id));
        expect(degraded).toEqual(['qbittorrent']);
        expect(rules.notes.some(n => n.includes('never purges it'))).toBe(true);
    });

    it('names the modules that do not run when the Download Cleaner is not scheduled', async () => {
        const jobs = (real('jobs') as Array<{ jobType?: string; status?: string }>).map(j => (j.jobType === 'DownloadCleaner' ? { ...j, status: 'Paused' } : j));
        const rules = await buildSeedingRules([cleanuparr({ '/api/jobs': jobs }), qbit([])], () => {});
        expect(rules.notes).toContain(
            "Cleanuparr's Download Cleaner is not scheduled, so none of its seeding rules and the Unlinked, Dead Torrents and Orphaned Files modules run."
        );
    });
});
