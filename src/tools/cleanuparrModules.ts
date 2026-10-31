import { fenceText } from '../core/fence.ts';
import type { CleanuparrRuleSet } from '../services/types.ts';

/**
 * Notes on the Download Cleaner's per-client modules, read against Cleanuparr
 * v2.10.9: `UnlinkedDownloadsService`, `DeadTorrentService` and
 * `OrphanedFilesCleanupService`, with `DownloadService.BuildClaimedPaths`.
 */

const LISTED = 5;

/** Separators and trailing slashes as Cleanuparr's `NormalizePath`, and lowercased: it compares paths ignoring case. */
export function normalisePath(path: string): string {
    const slashed = path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    return (slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed).toLowerCase();
}

/** Path segments in their own case, whichever separator the path uses. */
const segments = (path: string): string[] => path.trim().split(/[\\/]+/).filter(s => s !== '');

const under = (path: string, dir: string): boolean => path !== dir && path.startsWith(dir === '/' ? '/' : `${dir}/`);

/** .NET's `FileSystemName.MatchesSimpleExpression`, ignoring case: `*` is any run, `?` one character. */
export function matchesSimple(pattern: string, name: string): boolean {
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${source}$`, 'is').test(name);
}

const listed = (list: string[]): string => {
    const shown = list.slice(0, LISTED).join(', ');
    return list.length > LISTED ? `${shown} and ${list.length - LISTED} more` : shown;
};

/** Where a module moves torrents to, when no seeding rule of the same client picks them up from there. */
export function moduleNotes(set: CleanuparrRuleSet): string[] {
    const notes: string[] = [];
    const covered = (category: string) => set.rules.some(r => r.categories.some(c => c.toLowerCase() === category.toLowerCase()));
    const moves = [
        ['Unlinked', 'with no hardlinks', set.unlinked] as const,
        ['Dead Torrents', 'reporting no seeders', set.deadTorrents] as const
    ];
    for (const [name, what, module] of moves) {
        // With a tag the torrent keeps its category, and whichever rule covered it still does.
        if (module?.enabled !== true || module.useTag === true || module.target === '' || covered(module.target)) continue;
        notes.push(
            `Cleanuparr's ${name} module on "${set.client}" moves torrents ${what} into category "${module.target}", ` +
                "which none of that client's seeding rules covers, so they seed there until someone removes them."
        );
    }
    const orphaned = set.orphanedFiles;
    if (orphaned?.enabled === true && orphaned.purgeAfterHours === undefined) {
        notes.push(
            `Cleanuparr's Orphaned Files module on "${set.client}" moves orphans into ${orphaned.orphanedDirectory} and never purges it, ` +
                'so that directory only grows until someone empties it. Setting a purge age deletes what has sat there longer.'
        );
    }
    return notes;
}

export type SaveDirs = {
    /** The client whose torrents these are. */
    service: string;
    /** Distinct save directories, as the client reports them. */
    dirs: string[];
};

/**
 * Compares a client's save directories with the orphan scan of the Cleanuparr
 * set mapped to it. `claimed` holds every save directory, normalised, of every
 * client with an orphan scan: Cleanuparr claims paths across all of them.
 *
 * Cleanuparr lists only the entries directly inside each scan directory, and
 * keeps one if a torrent's save path or its top-level content is that entry,
 * or its name matches an exclude pattern. So a save directory that is not a
 * scan directory is never searched for orphans, and a directory between a scan
 * directory and a save directory is itself an unclaimed entry: moved whole,
 * torrents and all, unless excluded.
 */
export function coverageNotes(set: CleanuparrRuleSet, saves: SaveDirs, claimed: ReadonlySet<string>): string[] {
    const scan = set.orphanScan;
    const module = set.orphanedFiles;
    if (module?.enabled !== true || scan === undefined || scan.scanDirectories.length === 0 || saves.dirs.length === 0) return [];
    const path = (p: string) => fenceText(p, { service: saves.service, field: 'path' });
    // Cleanuparr's own paths, fenced in the adapter, at the same index as the raw ones.
    const scans = scan.scanDirectories.map((s, i) => ({ raw: s, norm: normalisePath(s), shown: module.scanDirectories[i] ?? '' }));
    const dirs = [...new Map(saves.dirs.map(d => [normalisePath(d), d])).entries()].map(([norm, raw]) => ({ norm, raw }));
    const orphanedDir = normalisePath(scan.orphanedDirectory);

    const related = dirs.some(d => scans.some(s => d.norm === s.norm || under(d.norm, s.norm) || under(s.norm, d.norm)));
    if (!related) {
        // Cleanuparr may map the client's paths onto its own mount, and that mapping lives with the client's password.
        return [
            `None of the ${dirs.length} save directories ${saves.service} reports (${listed(dirs.map(d => path(d.raw)))}) lies inside an orphan scan directory of ` +
                `Cleanuparr's "${set.client}", so arr-mcp cannot tell what the scan covers. Cleanuparr may see these files under another mount, ` +
                "mapped in its download client settings, which arr-mcp does not read because they hold the client's password."
        ];
    }

    const notes: string[] = [];
    const hazards = new Map<string, { scan: string; entry: string; holds: string[] }>();
    for (const s of scans) {
        for (const d of dirs) {
            if (!under(d.norm, s.norm)) continue;
            // The entry Cleanuparr sees inside the scan directory, on the way down to the save directory.
            const name = segments(d.raw)[segments(s.raw).length] ?? '';
            const entry = s.norm === '/' ? `/${name.toLowerCase()}` : `${s.norm}/${name.toLowerCase()}`;
            if (name === '' || claimed.has(entry) || entry === orphanedDir) continue;
            if (module.excludePatterns.some(p => matchesSimple(p, name))) continue;
            const key = `${s.norm}|${entry}`;
            const hit = hazards.get(key) ?? { scan: s.shown, entry: name, holds: [] };
            hit.holds.push(d.raw);
            hazards.set(key, hit);
        }
    }
    // One note per entry, capped: a scan of `/` could otherwise name every top-level folder.
    const found = [...hazards.values()];
    for (const h of found.slice(0, LISTED)) {
        notes.push(
            `Cleanuparr's "${set.client}" scans ${h.scan} for orphans, and the entry ${path(h.entry)} inside it holds torrents (saved in ${listed(h.holds.map(path))}) ` +
                `but is neither a save directory nor excluded, so Cleanuparr would count it as one orphan and move it whole, torrents and all, into ${module.orphanedDirectory}. ` +
                'Exclude its name, or scan the save directories themselves: cross-seed link directories have to be listed one per tracker.'
        );
    }
    if (found.length > LISTED) {
        notes.push(`${found.length - LISTED} more entries in Cleanuparr's "${set.client}" scan directories would be moved the same way.`);
    }

    const unscanned = dirs.filter(d => !scans.some(s => s.norm === d.norm));
    if (unscanned.length > 0) {
        notes.push(
            `${saves.service} saves torrents in ${listed(unscanned.map(d => path(d.raw)))}, which Cleanuparr's "${set.client}" does not scan for orphans. ` +
                'It checks only the entries directly inside each scan directory, so orphans left there are never found.'
        );
    }
    return notes;
}
