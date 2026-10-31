import { isIgnored, matchRule, unmatchedReason, type TorrentFacts, type UnmatchedReason } from '../core/cleanuparrRules.ts';
import { stripDangerous } from '../core/fence.ts';
import { logger } from '../core/logger.ts';
import { resolveRuleSets } from './cleanuparrQueue.ts';
import {
    hasCleanuparr,
    hasQueue,
    hasTorrentEndpoint,
    hasSeedCriteria,
    hasSeedLimits,
    type CleanuparrSeeding,
    type CleanuparrRuleSet,
    type ClientSeedLimits,
    type IndexerSeedCriteria,
    type ServiceAdapter
} from '../services/types.ts';

export type SeedingRules = {
    clients: ClientSeedLimits[];
    indexers: IndexerSeedCriteria[];
    cleanuparr?: Array<CleanuparrRuleSet & { service?: string }>;
    /** Per torrent client a Cleanuparr rule set maps to: how many of its torrents no rule covers. */
    coverage?: CleanuparrCoverage[];
    /** Where the rules contradict each other or leave a gap. */
    notes: string[];
};

export type CleanuparrCoverage = {
    service: string;
    torrents: number;
    /** Torrents no rule matches, so the Download Cleaner never removes them. Ignored ones are not counted. */
    uncovered: number;
    /** Torrents on Cleanuparr's ignore list. */
    ignored?: number;
};

/** Prowlarr names each synced copy `"<name> (Prowlarr)"`. */
const SYNCED = / \(Prowlarr\)$/;

const describe = (c: IndexerSeedCriteria): string =>
    [
        c.seedRatio === undefined ? 'no ratio' : `ratio ${c.seedRatio}`,
        c.seedTimeSeconds === undefined ? 'no seed time' : `${c.seedTimeSeconds / 60} min`
    ].join(', ');

/** `cleanuparrLimits`: an enforced Cleanuparr rule set limits seeding on at least one client. */
function notesFor(clients: ClientSeedLimits[], indexers: IndexerSeedCriteria[], prowlarrIds: Set<string>, cleanuparrLimits: boolean): string[] {
    const notes: string[] = [];
    const prowlarr = indexers.filter(i => prowlarrIds.has(i.service));
    const apps = indexers.filter(i => !prowlarrIds.has(i.service));

    for (const copy of apps) {
        if (!SYNCED.test(copy.indexer)) continue;
        const name = copy.indexer.replace(SYNCED, '');
        const source = prowlarr.find(p => p.indexer === name);
        if (source === undefined) continue;
        if (source.seedRatio === copy.seedRatio && source.seedTimeSeconds === copy.seedTimeSeconds) continue;
        notes.push(
            `${copy.service}'s copy of "${name}" has ${describe(copy)}, but ${source.service} has ${describe(source)}. ` +
                `The copy is what ${copy.service} hands the client on a grab.`
        );
    }

    const clientLimited = clients.some(c => c.ratioLimit !== undefined || c.seedingLimitSeconds !== undefined);
    const unlimited = apps.filter(i => i.seedRatio === undefined && i.seedTimeSeconds === undefined);
    if (clients.length > 0 && !clientLimited && cleanuparrLimits && unlimited.length > 0) {
        // Which category an indexer's grabs land in is the *arr's to say, so the per-torrent answer is get_queue's.
        notes.push(
            `${unlimited.map(i => `"${i.indexer}"`).join(', ')} set no seed ratio or time and no torrent client has a default limit, ` +
                "so Cleanuparr's rules are the only limit. A torrent in a category no rule covers seeds until someone stops it; " +
                'get_queue at detail "full" says which rule covers each torrent, or why none does.'
        );
    } else if (clients.length > 0 && !clientLimited) {
        for (const i of apps) {
            if (i.seedRatio !== undefined || i.seedTimeSeconds !== undefined) continue;
            notes.push(
                `"${i.indexer}" in ${i.service} sets no seed ratio or time, and no torrent client has a default limit, ` +
                    'so its grabs seed until someone stops them.'
            );
        }
    }

    return notes;
}

function cleanuparrNotes(
    seeding: CleanuparrSeeding,
    mapped: Map<string, CleanuparrRuleSet>,
    conflicts: Map<string, CleanuparrRuleSet[]>,
    clients: ClientSeedLimits[]
): string[] {
    const notes: string[] = [];
    for (const [service, list] of conflicts) {
        const names = list.map(s => `"${s.client}"`);
        const [all, none] = names.length > 2 ? ['all', 'none of their'] : ['both', "neither's"];
        notes.push(`Cleanuparr's clients ${names.slice(0, -1).join(', ')} and ${names.at(-1)} ${all} point at ${service}, so ${none} rules are applied to get_queue.`);
    }
    const conflicted = new Set([...conflicts.values()].flat());
    for (const set of seeding.sets) {
        if (conflicted.has(set)) continue;
        const service = [...mapped].find(([, s]) => s === set)?.[0];
        if (service === undefined) {
            notes.push(`Cleanuparr's client "${set.client}" matches no configured arr-mcp client, so its rules are not applied to get_queue.`);
            continue;
        }
        const own = clients.find(c => c.service === service)?.ratioLimit;
        for (const rule of set.rules) {
            if (rule.maxRatio === undefined || own === undefined || own === rule.maxRatio) continue;
            notes.push(
                `Cleanuparr rule "${rule.name}" on ${service} ${rule.action === 'delete' ? 'removes' : 'stops'} at ratio ${rule.maxRatio}, ` +
                    `but ${service} itself seeds to ${own}. Cleanuparr acts first when it runs.`
            );
        }
    }
    if (!seeding.enforced && seeding.sets.some(s => s.rules.length > 0)) {
        notes.push("Cleanuparr's Download Cleaner is not scheduled, so none of its seeding rules are applied.");
    }
    return notes;
}

const quoted = (names: readonly string[], max: number): string => {
    const shown = names.slice(0, max).map(n => `"${stripDangerous(n)}"`).join(', ');
    return names.length > max ? `${shown} and ${names.length - max} more` : shown;
};

/** What each reason means for the user, after the count. */
const REASON_TEXT: Record<Exclude<UnmatchedReason, 'category not in any rule'>, string> = {
    'no category': 'have no category; give them one a rule covers',
    'tracker not in any rule': "have no tracker the rules' tracker patterns match",
    'tracker unknown': 'report no working tracker, so a rule with tracker patterns may still cover them',
    'tags not in any rule': 'lack the tags the rules require',
    'privacy mismatch': 'fail the public/private setting of every rule that would otherwise take them',
    'privacy unknown': 'do not say whether they are private; Cleanuparr reads them as public, and only private rules would take them'
};

/**
 * Counts, never a torrent list: one note per client says how many torrents no
 * rule covers and why, and one says which rule categories no torrent is in.
 * Categories come from the torrents themselves, as Cleanuparr sees them, so a
 * category the client defines but no torrent uses counts as absent.
 */
function coverageOf(
    service: string,
    set: CleanuparrRuleSet,
    torrents: readonly TorrentFacts[],
    ignoredList: readonly string[]
): { row: CleanuparrCoverage; notes: string[] } {
    const notes: string[] = [];
    let ignored = 0;
    const reasons = new Map<UnmatchedReason, number>();
    const unnamed = new Map<string, number>();
    for (const t of torrents) {
        if (isIgnored(t, ignoredList)) {
            ignored += 1;
            continue;
        }
        if (matchRule(t, set.rules) !== undefined) continue;
        const reason = unmatchedReason(t, set.rules);
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
        if (reason === 'category not in any rule') unnamed.set(t.category, (unnamed.get(t.category) ?? 0) + 1);
    }
    const uncovered = [...reasons.values()].reduce((a, b) => a + b, 0);
    if (uncovered > 0) {
        const parts = [...reasons]
            .sort((a, b) => b[1] - a[1])
            .map(([reason, n]) => {
                if (reason !== 'category not in any rule') return `${n} ${REASON_TEXT[reason]}`;
                const cats = [...unnamed].sort((a, b) => b[1] - a[1]).map(([c, k]) => `${c} (${k})`);
                return `${n} are in categories no rule names, ${quoted(cats, 5)}; add those to a rule or recategorise the torrents`;
            });
        notes.push(`${uncovered} of ${torrents.length} torrents on ${service} match no Cleanuparr rule, so the Download Cleaner never removes them: ${parts.join('; ')}.`);
    }
    const seen = new Set(torrents.map(t => t.category.toLowerCase()));
    // Unlinked and Dead move torrents into these, so an empty one is normal.
    const targets = new Set((set.targetCategories ?? []).map(c => c.toLowerCase()));
    const named = [...new Map(set.rules.flatMap(r => r.categories).map(c => [c.toLowerCase(), c])).values()];
    const unused = named.filter(c => !seen.has(c.toLowerCase()) && !targets.has(c.toLowerCase()));
    if (unused.length > 0 && torrents.length > 0) {
        notes.push(
            `Cleanuparr's rules for ${service} name ${unused.length === 1 ? 'a category' : 'categories'} no torrent there is in: ${quoted(unused, 10)}. ` +
                'A typo, or a category renamed in the client, leaves a rule matching nothing.'
        );
    }
    return { row: { service, torrents: torrents.length, uncovered, ...(ignored === 0 ? {} : { ignored }) }, notes };
}

/** Clients and rule sets that leave torrents with nothing to clean them. */
function gapNotes(
    seeding: CleanuparrSeeding,
    mapped: Map<string, CleanuparrRuleSet>,
    conflicts: Map<string, CleanuparrRuleSet[]>,
    adapters: readonly ServiceAdapter[]
): string[] {
    const notes: string[] = [];
    for (const a of adapters) {
        if (!hasTorrentEndpoint(a) || mapped.has(a.id) || conflicts.has(a.id)) continue;
        notes.push(
            `${a.id} is not a download client in Cleanuparr: no enabled client there has its type and ${a.endpoint}, so Cleanuparr cleans none of its torrents. ` +
                'Deleting a client in Cleanuparr drops its seeding rules and its Unlinked, Dead and Orphaned settings with it, so they have to be set up again.'
        );
    }
    for (const set of seeding.sets) {
        if (set.rules.length > 0) continue;
        notes.push(
            set.modulesOff === true
                ? `Cleanuparr's client "${set.client}" has no seeding rules and Unlinked, Dead and Orphaned are all off, so the Download Cleaner does nothing with it.`
                : `Cleanuparr's client "${set.client}" has no seeding rules, so the Download Cleaner never removes its torrents.`
        );
    }
    return notes;
}

/** Settled per service: one unreachable client must not hide the others. */
export async function buildSeedingRules(
    adapters: readonly ServiceAdapter[],
    markDegraded: (id: string) => void
): Promise<SeedingRules> {
    const read = async <T>(id: string, fetch: () => Promise<T>): Promise<T | undefined> => {
        try {
            return await fetch();
        } catch (err) {
            logger.warn({ service: id, err }, 'seeding rules unavailable; omitting');
            markDegraded(id);
            return undefined;
        }
    };

    const cleanuparrSource = adapters.find(hasCleanuparr);
    const [clients, indexers, cleanuparr] = await Promise.all([
        Promise.all(adapters.filter(hasSeedLimits).map(a => read(a.id, () => a.getSeedLimits()))),
        Promise.all(adapters.filter(hasSeedCriteria).map(a => read(a.id, () => a.getSeedCriteria()))),
        cleanuparrSource === undefined ? undefined : read(cleanuparrSource.id, () => cleanuparrSource.getSeedingRules())
    ]);

    const prowlarrIds = new Set(adapters.filter(a => a.type === 'prowlarr').map(a => a.id));
    const clientRows = clients.filter((c): c is ClientSeedLimits => c !== undefined);
    const indexerRows = indexers
        .flatMap(i => i ?? [])
        .sort((a, b) => a.service.localeCompare(b.service) || a.indexer.localeCompare(b.indexer));
    clientRows.sort((a, b) => a.service.localeCompare(b.service));

    const { mapped, conflicts } =
        cleanuparr === undefined
            ? { mapped: new Map<string, CleanuparrRuleSet>(), conflicts: new Map<string, CleanuparrRuleSet[]>() }
            : resolveRuleSets(cleanuparr.sets, adapters);
    const cleanuparrLimits =
        cleanuparr?.enforced === true &&
        [...mapped.values()].some(set => set.rules.some(r => r.maxRatio !== undefined || r.maxSeedHours !== undefined));
    const notes = notesFor(clientRows, indexerRows, prowlarrIds, cleanuparrLimits);
    const sets = (cleanuparr?.sets ?? []).map(set => {
        const service = [...mapped].find(([, s]) => s === set)?.[0];
        // The coverage check's inputs stay internal.
        const { modulesOff: _off, targetCategories: _targets, ...shown } = set;
        return service === undefined ? shown : { ...shown, service };
    });
    const coverage: CleanuparrCoverage[] = [];
    if (cleanuparr !== undefined) {
        notes.push(...cleanuparrNotes(cleanuparr, mapped, conflicts, clientRows));
        notes.push(...gapNotes(cleanuparr, mapped, conflicts, adapters));
        // The whole torrent list of each mapped client: one call each, like get_queue.
        const reads = await Promise.all(
            [...mapped].map(async ([service, set]) => {
                const adapter = adapters.find(a => a.id === service);
                if (adapter === undefined || !hasQueue(adapter) || set.rules.length === 0) return undefined;
                const items = await read(service, () => adapter.getQueue());
                if (items === undefined) return undefined;
                return coverageOf(service, set, items.flatMap(i => (i.torrent === undefined ? [] : [i.torrent])), cleanuparr.ignored);
            })
        );
        for (const r of reads) {
            if (r === undefined) continue;
            coverage.push(r.row);
            notes.push(...r.notes);
        }
        coverage.sort((a, b) => a.service.localeCompare(b.service));
    }

    return {
        clients: clientRows,
        indexers: indexerRows,
        ...(sets.length > 0 ? { cleanuparr: sets } : {}),
        ...(coverage.length > 0 ? { coverage } : {}),
        notes
    };
}
