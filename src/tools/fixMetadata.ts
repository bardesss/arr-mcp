import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
    findMismatches,
    findMovieMismatches,
    managedSeriesOf,
    pinnedToProvider,
    type EpisodeRecord,
    type ManagedFolder,
    type Mismatch,
    type MovieRecord
} from '../core/episodeMismatch.ts';
import { ServiceError } from '../core/errors.ts';
import type { PermissionSource } from '../core/permissions.ts';
import { fenceText } from '../core/fence.ts';
import { logger } from '../core/logger.ts';
import { unfenced } from '../core/titleMatch.ts';
import type { IdentityResolver } from '../core/identity.ts';
import { ArtistTitleRefusal, BookTitleRefusal, filmOrSeriesMatch, isFilmOrSeries, type FilmOrSeries, type MergedItem } from '../core/resolver.ts';
import {
    hasMediaDetails,
    hasMetadataInspect,
    hasMetadataRepair,
    hasTagRepair,
    type BookFields,
    type BookMetadataCapable,
    type BookSearch,
    type MediaDetailCapable,
    type MetadataInspectCapable,
    type MetadataRepairCapable,
    type RetagFile,
    type ServiceAdapter,
    type TagRepairCapable
} from '../services/types.ts';
import { bestCandidate, describeBookChange, diffBookFields, FIX_FIELDS, normaliseIsbn } from './bookMetadata.ts';
import { buildResolvedMediaDetails } from './getMediaDetails.ts';
import type { LibraryLoader } from './library.ts';
import { bothIds, byMediaServers, itemIdOn, pickMediaServer, serviceInput, withBoth, type MediaServers } from './mediaServers.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';
import { titled } from '../core/labels.ts';

/**
 * "The episode titles on these files are wrong"; the repair `trigger_scan`
 * was never for. A scan asks whether a file is on disk; this asks whether the
 * metadata bolted to that file describes it, and replaces it when it does not.
 *
 * `destructive` tier: the repair overwrites whatever the media server held,
 * including anything corrected by hand. That is why the preview leads with
 * evidence rather than a count.
 */

type MediaServer = ServiceAdapter & MetadataInspectCapable & MetadataRepairCapable;

const NO_MEDIA_SERVER =
    'Metadata repair lives in the media server. Add a services.jellyfin or services.plex block to config.yaml and restart.';

const PLEX_REPAIR_OFF = {
    reason: 'Plex repair is off',
    remedy: 'Set services.plex.allow_metadata_repair: true in config.yaml, or tick it on the Plex card, to allow it.'
};

/** The server `service` names, else the one an `id` prefix names, else the primary. */
const chooseServer = (servers: MediaServers, service: string | undefined, id: string | undefined): { adapter: MediaServer; identity: IdentityResolver } => {
    const named = prefixed(servers, id);
    if (service !== undefined && named !== undefined && service !== named) {
        throw new Error(`\`id\` is a ${named} id; drop \`service\` or pass \`service: ${named}\`.`);
    }
    const chosen = pickMediaServer(servers, service ?? named);
    if (chosen === undefined || !hasMetadataInspect(chosen.adapter) || !hasMetadataRepair(chosen.adapter) || chosen.identity === undefined) {
        throw new ServiceError('NotFound', chosen?.adapter.id ?? 'jellyfin', 'no media server is configured', { remedy: NO_MEDIA_SERVER });
    }
    return { adapter: chosen.adapter, identity: chosen.identity };
};

const prefixed = (servers: MediaServers, id: string | undefined): string | undefined =>
    id === undefined
        ? undefined
        : [servers.primary, servers.secondary].find(c => c !== undefined && id.startsWith(`${c.adapter.id}:`))?.adapter.id;

// Read from config.yaml, like the permission gate, never from the adapter.
export const plexRepairAllowed = (permissions: PermissionSource): boolean => {
    const config = permissions.get('plex');
    return config !== undefined && 'allow_metadata_repair' in config && config.allow_metadata_repair;
};

// The setting off is a ceiling on the Plex instance, like a token's: no tier passes.
const withPlexGate = (source: PermissionSource, adapters: readonly ServiceAdapter[]): PermissionSource => {
    const plex = new Set(adapters.filter(a => a.type === 'plex').map(a => a.id));
    if (plex.size === 0 || plexRepairAllowed(source)) return source;
    return {
        get: instance => source.get(instance),
        permits: (tier, instance) => !plex.has(instance) && (source.permits?.(tier, instance) ?? true),
        refusal: (tier, instance) => (plex.has(instance) ? PLEX_REPAIR_OFF : source.refusal?.(tier, instance))
    };
};

type Lidarr = ServiceAdapter & TagRepairCapable & MediaDetailCapable;

const isLidarr = (a: ServiceAdapter): a is Lidarr => hasTagRepair(a) && hasMediaDetails(a);

/**
 * `lidarr:42` names a Lidarr artist, whose music is repaired by rewriting the
 * tags in its files. The prefix is matched in any case, as `resolveInstance`
 * matches instance names. An id written that way that no configured Lidarr
 * matches, or that has nothing after the colon, is refused by the `service`
 * routing (`unknownLidarr`); any other id is a media-server item. Read from
 * the arguments alone, so the permission check sees which service is written
 * to before anything is resolved.
 */
const lidarrTarget = (music: readonly ServiceAdapter[], id: string | undefined): { adapter: Lidarr; artistId: string } | undefined => {
    if (id === undefined) return undefined;
    const adapter = music.find((a): a is Lidarr => isLidarr(a) && id.slice(0, a.id.length + 1).toLowerCase() === `${a.id}:`.toLowerCase());
    const artistId = adapter === undefined ? '' : id.slice(adapter.id.length + 1);
    return adapter === undefined || artistId === '' ? undefined : { adapter, artistId };
};

/** The artist ids each configured Lidarr takes, as a caller writes them; undefined when none is configured. */
const artistIdForms = (music: readonly ServiceAdapter[]): string | undefined => {
    const forms = music.filter(isLidarr).map(a => `\`${a.id}:<artistId>\``);
    return forms.length === 0 ? undefined : forms.join(' or ');
};

/**
 * An id written as a Lidarr artist's that no configured Lidarr matches, such
 * as `lidarr:42` where the only Lidarr is `lidarr/flac`, or that names no
 * artist (`lidarr`, `lidarr/flac:`). No media-server id is written that way,
 * and read as one it would be checked against the media server's permissions
 * and then looked up there.
 */
const unknownLidarr = (music: readonly ServiceAdapter[], id: string): ServiceError => {
    const forms = artistIdForms(music);
    if (forms === undefined) {
        return new ServiceError('NotFound', 'lidarr', 'no Lidarr is configured', {
            remedy: 'Add a services.lidarr block to config.yaml and restart.'
        });
    }
    const colon = id.indexOf(':');
    const named = colon === -1 ? id : id.slice(0, colon);
    return new ServiceError('NotFound', 'lidarr', music.some(a => isLidarr(a) && a.id.toLowerCase() === named.toLowerCase()) ? `"${id}" names no artist` : `no Lidarr is configured as "${named}"`, {
        remedy: `Give the artist as ${forms}, from its \`acquisition.service\` and \`acquisition.id\`.`
    });
};

/**
 * An artist asked for by name. The fix is in Lidarr, by id: a title only says
 * which service it belongs to after resolving it, and the permission check
 * has already run on the arguments by then.
 */
const artistByName = (item: MergedItem, music: readonly ServiceAdapter[]): Error => {
    const { service, id } = item.acquisition ?? {};
    const lidarr = music.find(a => a.id === service && isLidarr(a));
    const lidarrId = lidarr !== undefined && id !== undefined ? `${lidarr.id}:${id}` : undefined;
    return new Error(
        lidarrId === undefined
            ? `"${item.title}" is an artist no Lidarr manages. fix_metadata repairs music by rewriting the tags in its files from Lidarr, and a media server's own music metadata is not something it changes.`
            : `"${item.title}" is an artist. Its music is repaired by rewriting the tags in its files from Lidarr: call fix_metadata with id "${lidarrId}".`
    );
};

// Unfenced before the split and fenced again after, rather than split as it
// arrives: the closing marker `<</>>` contains a slash, so splitting
// the fenced string on path separators returns the tail of the marker instead
// of the filename. Re-fencing keeps the guarantee that server-supplied text is
// labelled wherever it is printed.
const fileName = (path: string, service: string, field = 'path'): string => {
    const raw = unfenced(path);
    return fenceText(raw.split(/[/\\]/).at(-1) ?? raw, { service, field });
};

/** An absent tag reads as empty. Printed bare, "Genres Rock → " looks cut off. */
const tagValue = (v: string): string => (unfenced(v) === '' ? '(empty)' : v);

const describeRetag = (f: RetagFile, service: string): string =>
    `${fileName(f.path, service)} (#${f.trackFileId}): ${f.changes.map(c => `${c.field} ${tagValue(c.oldValue)} → ${tagValue(c.newValue)}`).join('; ')}`;

async function planRetag(adapter: Lidarr, artistId: string, files: readonly number[] | undefined): Promise<WritePlan> {
    // The artist is read too: Lidarr previews an unknown artist as an empty
    // list, which would otherwise read as "nothing to fix".
    const [artist, preview, settings] = await Promise.all([
        adapter.getMediaDetails(artistId, { includeEpisodes: false, episodeLimit: 0 }),
        adapter.previewRetag(artistId),
        adapter.readTagSettings()
    ]);
    const target = `${adapter.id}:${artistId}`;

    const missing = (files ?? []).filter(id => !preview.some(f => f.trackFileId === id));
    if (missing.length > 0) {
        const which = missing.length === 1 ? `track file ${missing[0]} has` : `track files ${missing.join(', ')} have`;
        throw new ServiceError('NotFound', adapter.id, `${which} no tag differences under ${artist.title}`, {
            remedy:
                (missing.length === 1
                    ? "Either its tags already match Lidarr's, it is not one of this artist's files, or Lidarr leaves it"
                    : "Either their tags already match Lidarr's, they are not this artist's files, or Lidarr leaves them") +
                ' out of its retag preview, as it does any file linked to several tracks or to none, or that it cannot read. Preview without `files` to see which ones differ.'
        });
    }
    const selected = files === undefined ? preview : preview.filter(f => files.includes(f.trackFileId));
    if (selected.length === 0) {
        return {
            target,
            summary: `${adapter.id}'s retag preview lists no file under ${artist.title} whose tags differ from its metadata. It leaves out a file linked to several tracks or to none, or that it cannot read.`,
            effects: [],
            noop: true
        };
    }

    const n = selected.length;
    const these = n === 1 ? 'this file' : 'these files';
    const changes = selected.reduce((sum, f) => sum + f.changes.length, 0);
    return {
        target,
        summary: `Rewrite the embedded tags in ${n} of ${artist.title}'s files from ${adapter.id}'s metadata (${changes} field${changes === 1 ? '' : 's'}).`,
        effects: [
            ...(settings.scrubAudioTags === false
                ? []
                : [
                      settings.scrubAudioTags === true
                          ? `Lidarr's Scrub Existing Tags setting is on: every tag Lidarr does not write itself (ReplayGain, comments, other players' ratings) is deleted from ${these} first, and the list below does not show those.`
                          : `Lidarr did not say whether its Scrub Existing Tags setting is on. If it is, every tag Lidarr does not write itself (ReplayGain, comments, other players' ratings) is deleted from ${these} first, and the list below does not show those.`
                  ]),
            `Rewrites the tags inside ${n} audio file${n === 1 ? '' : 's'} on disk. Irreversible: Lidarr's history records the change, but nothing writes the old values back.`,
            `Runs regardless of Lidarr's Tag Audio Files with Metadata setting (now \`${settings.writeAudioTags}\`).`,
            `A media server shows the new tags after its next scan of ${these}; trigger_scan on it to pick them up now.`,
            ...selected.slice(0, EXAMPLE_LIMIT).map(f => describeRetag(f, adapter.id)),
            ...(n > EXAMPLE_LIMIT ? [`…and ${n - EXAMPLE_LIMIT} more.`] : [])
        ],
        // The files, not "whatever differs at apply time", and the setting that
        // decides whether other tags are wiped. Not the values: Lidarr writes
        // its metadata as it stands at apply time, as a Jellyfin or Plex repair
        // takes the provider's. `albums` is where the check after the retag
        // looks, or the whole artist when a row came without one.
        args: {
            kind: 'retag',
            artistId,
            files: selected.map(f => f.trackFileId).sort((a, b) => a - b),
            scrub: settings.scrubAudioTags ?? null,
            albums: selected.every(f => f.albumId !== undefined) ? [...new Set(selected.map(f => f.albumId ?? 0))].sort((a, b) => a - b) : null
        }
    };
}

/**
 * The command settling is not the files being fixed: a file Lidarr cannot
 * write is logged and skipped, and the command still completes. A fresh
 * preview of the bound files is what says whether they now match, and only
 * that far: Lidarr's preview also leaves out a file it cannot read.
 */
async function applyRetag(adapter: Lidarr, bound: { artistId: string; files: number[]; scrub: boolean | null; albums: number[] | null }) {
    const n = bound.files.length;
    const run = await adapter.retagFiles(bound.artistId, bound.files);
    // Scrub deletes a file's tags before writing them, and a write that then
    // fails leaves the file with none (`AudioTagService.WriteTags`).
    const scrubbed =
        bound.scrub === false ? '' : ` ${bound.scrub === true ? 'Scrub Existing Tags is on' : 'If Scrub Existing Tags is on'}: Lidarr deletes a file's tags before writing them, so a file it could not write may now have none.`;
    if (!run.settled) {
        // Queued and possibly still running, so a preview now would list files
        // the command has yet to reach, and sending it again would retag twice.
        return {
            filesBefore: n,
            status: 'unknown',
            ...(run.commandId === undefined ? {} : { commandId: run.commandId }),
            verified: false,
            note: `NOT VERIFIED: Lidarr queued RetagFiles${run.commandId === undefined ? '' : ` (command ${run.commandId})`}, and arr-mcp stopped waiting for it: ${run.reason}. It may still run. get_stack_health's \`commands\` shows when it ends; then preview fix_metadata again to see which files still differ. Do not confirm it again.${scrubbed}`
        };
    }
    const row = run;
    const said = row.message === undefined ? '' : ` (${row.message})`;
    let remaining: number;
    try {
        // The bound files' albums alone: every file Lidarr previews is read from
        // disk, so the whole artist again would read files nothing touched. One
        // album at a time, as set_watched writes its items, not a burst of reads.
        const after: RetagFile[] = [];
        for (const album of bound.albums ?? [undefined]) after.push(...(await adapter.previewRetag(bound.artistId, album)));
        remaining = after.filter(f => bound.files.includes(f.trackFileId)).length;
    } catch (err) {
        // The write has happened and the token is spent: say so, not just the read's error.
        return {
            filesBefore: n,
            status: row.status,
            verified: false,
            note: `NOT VERIFIED: Lidarr's RetagFiles command ended ${row.status}${said}, but the retag preview that checks the files could not be read (${err instanceof Error ? err.message : String(err)}). Preview fix_metadata again to see which files still differ before retagging them again.${scrubbed}`
        };
    }
    const verified = row.status === 'completed' && remaining === 0;
    const stillDiffer = `${remaining} of ${n} file${n === 1 ? '' : 's'} still ${remaining === 1 ? 'differs' : 'differ'}`;
    const noneListed = `a fresh retag preview no longer lists ${n === 1 ? 'the file' : `any of the ${n} files`} as differing from Lidarr's metadata`;
    return {
        filesBefore: n,
        filesStillDiffering: remaining,
        status: row.status,
        verified,
        note: verified
            ? `Retagged: ${noneListed}. trigger_scan on the media server to show the new tags there.`
            : row.status !== 'completed'
              ? remaining === 0
                  ? `NOT VERIFIED: Lidarr's RetagFiles command ended ${row.status}${said}, though ${noneListed}. Lidarr's log says what failed.${scrubbed}`
                  : `NOT FIXED: Lidarr's RetagFiles command ended ${row.status}${said}. ${stillDiffer}.${scrubbed}`
              : `NOT FIXED: the command completed but ${stillDiffer} from Lidarr's metadata. Lidarr skips a file it cannot write (permissions, a format it cannot tag); its log names which.${scrubbed}`
    };
}

const serverName = (adapter: ServiceAdapter): string => (adapter.type === 'plex' ? 'Plex' : 'Jellyfin');

/** Where the lock lives in each server's own UI. */
export const unlockHow = (adapter: ServiceAdapter): string =>
    adapter.type === 'plex'
        ? 'Edit, then the lock icon beside the field'
        : 'Edit metadata, then clear "Lock this item to prevent future metadata changes", or tick the field under Enabled Fields';

/** Sonarr's series folders, from the library index. Empty when no Sonarr is
 *  configured or the index cannot be read. */
export async function managedFolders(loader: LibraryLoader): Promise<ManagedFolder[]> {
    try {
        const { index } = await loader.load();
        return index.all().flatMap(i => {
            const path = i.acquisition?.path;
            if (i.kind !== 'series' || i.acquisition === undefined || path === undefined) return [];
            const key = i.ids.tvdb === undefined ? `${i.acquisition.service}:${i.acquisition.id ?? i.title}` : `tvdb:${i.ids.tvdb}`;
            return [{ key, title: i.title, path }];
        });
    } catch (err) {
        logger.warn({ err }, 'could not read Sonarr series folders');
        return [];
    }
}

/** What to do about one media-server item that holds several Sonarr series. */
export const mergedHow = (adapter: ServiceAdapter, titles: readonly string[]): string =>
    `This one ${serverName(adapter)} item holds the files of ${titles.length} Sonarr series (${titles.join(', ')}), so separate shows were merged into it. ` +
    'fix_metadata would re-identify it against the id it already holds and change nothing. ' +
    (adapter.type === 'plex' ? 'Use Split on the item in Plex so each show gets its own item.' : 'Separate them in Jellyfin so each folder is its own series.');

/** How many examples ride along in the preview. Enough to recognise the
 *  pattern, few enough to read before confirming. */
const EXAMPLE_LIMIT = 5;

const describe = (m: Mismatch, service: string): string => {
    const file = fileName(m.path, service, 'Path');
    const server =
        m.serverSeason !== undefined && m.serverEpisode !== undefined
            ? `S${m.serverSeason}E${m.serverEpisode} ${m.serverTitle}`
            : m.serverYear === undefined
              ? m.serverTitle
              : `${m.serverTitle} (${m.serverYear})`;
    return `${file} → ${server} (${m.reasons.join(' + ')})`;
};

type Resolved = {
    itemId: string;
    title: string;
    kind: 'movie' | 'series';
    tvdbId?: number;
    tmdbId?: number;
    /** No Radarr or Sonarr manages this, so any provider id on it is the media
     *  server's own, possibly the wrong one that caused the mismatch. */
    unmanaged: boolean;
};

/**
 * Which provider id the repair will actually pin, decided once.
 *
 * TMDB for a film because Radarr is built on it, TVDB for a series because
 * Sonarr is, with the other as a fallback. The summary, the "not pinned"
 * warning and the confirmation token all read this, so none of the three can
 * describe a different id from the one `apply` sends.
 */
const pinnedProvider = (
    item: Resolved
): { label: string; id?: { tvdbId?: number; tmdbId?: number } } => {
    const order = item.kind === 'movie' ? ([['TMDB', 'tmdbId'], ['TVDB', 'tvdbId']] as const) : ([['TVDB', 'tvdbId'], ['TMDB', 'tmdbId']] as const);

    for (const [label, key] of order) {
        const value = item[key];
        if (value !== undefined) return { label: `${label} ${value}`, id: { [key]: value } };
    }
    return { label: 'no pinned provider id' };
};

/**
 * Title to media-server item, through the same library index `get_media_details`
 * uses, so a title that resolves there resolves the same way here.
 *
 * Films and series both, but on different evidence. A series is judged on
 * episode numbering and episode filenames; a film has neither, so it is judged
 * on its **year** and its title. The year is the film's confident signal for
 * the same reason numbering is the series' one: a film file names its year
 * almost universally, and a year that disagrees means the server matched a
 * different film rather than the same one worded differently.
 */
async function resolve(loader: LibraryLoader, query: string, adapter: ServiceAdapter, isSecondary: boolean): Promise<Resolved> {
    let best: FilmOrSeries;
    try {
        best = await buildResolvedMediaDetails(loader, query);
    } catch (err) {
        // This tool does repair a book, but by id, so point there rather than at get_media_details.
        if (err instanceof BookTitleRefusal) {
            throw new Error(
                `"${query}" matches only a Grimmory book in your library. fix_metadata repairs a book by its id: pass id: "grimmory:${err.bookId ?? '<book id>'}"${err.bookId === undefined ? ', with the acquisition.id of its get_library row' : ''}.`,
                { cause: err }
            );
        }
        throw err;
    }

    const itemId = itemIdOn(best, adapter.id);
    if (itemId === undefined) {
        const { degraded } = await loader.load();
        const down = degraded.includes(adapter.id);
        const unread = down || (best.media_servers !== undefined && best.media_servers[adapter.id] === undefined);
        if (unread) {
            // Unread without being degraded only happens to a secondary skipped
            // for a missing or unmatched default_user.
            const skipped = isSecondary && !down;
            throw new ServiceError('Unreachable', adapter.id, `${serverName(adapter)}'s library could not be read, so "${best.title}" cannot be looked up there`, {
                remedy: skipped
                    ? `Check that services.${adapter.id}.default_user is set and names a real user.`
                    : `Check get_stack_health for ${adapter.id}.`
            });
        }
        throw new ServiceError('NotFound', adapter.id, `"${best.title}" is not in ${serverName(adapter)}`, {
            remedy:
                'fix_metadata repairs what the media server holds. This title is managed by an *arr but the media server has no item for it. Run trigger_scan first, then try again.'
        });
    }

    return fromMerged(best, itemId);
}

const fromMerged = (item: FilmOrSeries, itemId: string): Resolved => ({
    itemId,
    title: item.title,
    kind: item.kind,
    unmanaged: item.acquisition === undefined,
    ...(item.ids.tvdb === undefined ? {} : { tvdbId: item.ids.tvdb }),
    ...(item.ids.tmdb === undefined ? {} : { tmdbId: item.ids.tmdb })
});

/**
 * The id get_metadata_issues printed, as `plex:119962` or bare. A title can
 * resolve to a different item than the one flagged (The Fall the series came
 * back as Fall the film), and the id cannot.
 */
async function resolveById(loader: LibraryLoader, raw: string, adapter: ServiceAdapter): Promise<Resolved> {
    const prefix = `${adapter.id}:`;
    const itemId = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;

    // Through the index first, so a managed title keeps its Radarr or Sonarr ids.
    const { index } = await loader.load();
    const known = index
        .all()
        .find((i): i is FilmOrSeries => isFilmOrSeries(i) && itemIdOn(i, adapter.id) === itemId);
    if (known !== undefined) return fromMerged(known, itemId);

    const notFound = new ServiceError('NotFound', adapter.id, `${serverName(adapter)} has no film or series with id ${itemId}`, {
        remedy: 'Take the id from get_metadata_issues, which prints it as service:itemId.'
    });
    if (!hasMediaDetails(adapter)) throw notFound;
    const details = await adapter.getMediaDetails(itemId, { includeEpisodes: false, episodeLimit: 0 });
    if (details.kind !== 'movie' && details.kind !== 'series') throw notFound;

    return {
        itemId,
        title: details.title,
        kind: details.kind,
        unmanaged: true,
        ...(details.ids.tvdb === undefined ? {} : { tvdbId: details.ids.tvdb }),
        ...(details.ids.tmdb === undefined ? {} : { tmdbId: details.ids.tmdb })
    };
}

/** How long apply waits on a refresh the server queued. It has no done signal
 *  on Plex, so the wait is for a result that holds across two reads. */
export type RepairTiming = { pollMs: number; waitMs: number; sleep: (ms: number) => Promise<void> };

const DEFAULT_TIMING: RepairTiming = { pollMs: 5_000, waitMs: 30_000, sleep: ms => new Promise(r => setTimeout(r, ms)) };

type Reading = { mismatches: Mismatch[]; compared: number };

const hasPath = (p: { path?: string }): boolean => p.path !== undefined && p.path.trim() !== '';

/** Rows and their mismatches, with locks read by id for the mismatching rows
 *  on a server whose list reads leave locks out. A failed lock read costs the
 *  lock, not the answer. */
export async function withLocks<T extends EpisodeRecord | MovieRecord>(
    adapter: ServiceAdapter & MetadataInspectCapable,
    rows: readonly T[],
    find: (rows: readonly T[]) => Mismatch[]
): Promise<{ rows: readonly T[]; mismatches: Mismatch[] }> {
    const mismatches = find(rows);
    if (adapter.readLockedFields === undefined || mismatches.length === 0) return { rows, mismatches };

    let locks: Map<string, string[]>;
    try {
        locks = await adapter.readLockedFields(mismatches.map(m => m.id));
    } catch (err) {
        logger.warn({ service: adapter.id, err }, 'could not read locked fields; answering without them');
        return { rows, mismatches };
    }
    const merged = rows.map(r => {
        const locked = locks.get(r.id);
        return locked === undefined || locked.length === 0 ? r : { ...r, lockedFields: locked };
    });
    return { rows: merged, mismatches: find(merged) };
}

type BookLibrary = ServiceAdapter & BookMetadataCapable;

/** A provider name is one plain word; anything else is not printed as one. */
const providerName = (v: string | undefined): string => (v !== undefined && /^[A-Za-z]{1,20}$/.test(v) ? v : 'a provider');

/**
 * A book's repair: look it up with Grimmory's own providers and replace the
 * fields where the best match differs. Runs again on confirm, so a provider
 * that answers differently by then changes the bound `changes` and the token
 * is refused with a fresh preview rather than writing what nobody saw.
 */
async function planBookFix(
    books: BookLibrary | undefined,
    id: string,
    o: { service: string | undefined; user: string | undefined; isbn: string | undefined }
): Promise<WritePlan> {
    const bookId = /^grimmory:(\d+)$/.exec(id)?.[1];
    if (bookId === undefined) {
        throw new ServiceError('NotFound', 'grimmory', `"${id}" is not a Grimmory book id`, {
            remedy: 'Give a book as grimmory:<book id>, the id get_metadata_issues prints for it.'
        });
    }
    if (books === undefined) {
        throw new ServiceError('NotFound', 'grimmory', 'no Grimmory is configured', {
            remedy: 'Add a services.grimmory block to config.yaml and restart.'
        });
    }
    if (o.service !== undefined) throw new Error('`service` picks a media server; drop it for a Grimmory book.');
    if (o.user !== undefined) throw new Error('`user` picks whose media-server view to read; a Grimmory book has none, so drop it.');
    const typed = o.isbn === undefined ? undefined : normaliseIsbn(o.isbn);
    if (o.isbn !== undefined && typed === undefined) {
        throw new Error('`isbn` is not an ISBN: it needs 10 or 13 digits, and an ISBN-10 may end in X.');
    }

    const book = await books.readBookMetadata(bookId);
    const target = `grimmory:${bookId}`;
    if (book.allLocked) {
        return {
            target,
            summary: `Every metadata field of ${book.label} is locked in Grimmory, so a repair changes nothing. Unlock the fields on the book in Grimmory first.`,
            effects: [],
            noop: true
        };
    }

    const own = book.fields.isbn13 ?? book.fields.isbn10;
    const isbn = typed ?? (own === undefined ? undefined : normaliseIsbn(own));
    const author = book.fields.authors?.[0];
    const search: BookSearch =
        isbn !== undefined
            ? { isbn }
            : { ...(book.fields.title === undefined ? {} : { title: book.fields.title }), ...(author === undefined ? {} : { author }) };
    if (search.isbn === undefined && search.title === undefined) {
        return {
            target,
            summary: `Nothing to apply: ${book.label} has no ISBN or title to search Grimmory's providers by. Pass \`isbn\` to search by one.`,
            effects: [],
            noop: true
        };
    }

    const candidates = await books.findBookCandidates(bookId, search);
    const best = bestCandidate(candidates, book.fields, search);
    if (best === undefined) {
        return {
            target,
            summary: `Nothing to apply: none of the ${candidates.length} answers from Grimmory's providers is ${book.label}. A match is an ISBN match, or the title and first author together.`,
            effects: [isbn === undefined ? 'Pass `isbn` to search by an ISBN you know.' : 'Pass `isbn` to search by a different ISBN.'],
            noop: true
        };
    }

    const provider = providerName(best.provider);
    const { changes, keptLocked } = diffBookFields(book.fields, best.fields, book.locked, FIX_FIELDS);
    const changed = Object.keys(changes) as (keyof BookFields)[];
    const lockedLine =
        keptLocked.length === 0 ? [] : [`Left alone because ${keptLocked.length === 1 ? 'it is' : 'they are'} locked in Grimmory: ${keptLocked.join(', ')}.`];
    if (changed.length === 0) {
        return {
            target,
            summary:
                keptLocked.length === 0
                    ? `${book.label} already matches ${provider}'s match; nothing to apply.`
                    : `Nothing to apply to ${book.label}: every field where ${provider}'s match differs is locked in Grimmory.`,
            effects: lockedLine,
            noop: true
        };
    }

    return {
        target,
        summary: `Replace ${changed.length} field${changed.length === 1 ? '' : 's'} of ${book.label} with ${provider}'s match.`,
        effects: [
            ...changed.map(f => describeBookChange(f, book.fields[f], changes[f])),
            ...lockedLine,
            'The cover and description are left alone.',
            'Grimmory may also write the new metadata into the book file, and move it to match its naming pattern, when its metadata settings say so.'
        ],
        // The changes themselves are bound, not a count: a provider that
        // answers differently on confirm must not write values nobody saw.
        args: { server: books.id, itemId: bookId, kind: 'book', changes }
    };
}

/** Errors a server gives while it rebuilds an item: Plex answers 503 mid-refresh. */
const STILL_SETTLING = new Set(['UpstreamError', 'Timeout', 'Unreachable', 'NotFound']);

const fixMetadataInput = byMediaServers(ids => z.object({
    ...serviceInput(ids),
    query: z
        .string()
        .min(1)
        .optional()
        .describe('A film or series title. Resolved through the library index, the same way get_media_details resolves one.'),
    id: z
        .string()
        .min(1)
        .optional()
        .describe(
            'The media server item id, as get_metadata_issues prints it (`plex:119962`) or bare[[grimmory: , or a Grimmory book as `grimmory:<book id>`]][[lidarr: , or a Lidarr artist as `lidarr:<artistId>`]]. Wins over `query`.'
        ),
    files: z
        .array(z.number().int().positive())
        .min(1)
        .optional()
        .describe('[[lidarr: Music only: the Lidarr track file ids to retag, as the preview prints them (`#123`). Omit for every file that differs.]]'),
    user: z
        .string()
        .optional()
        .describe(
            "Whose view of the library to read the episodes through. Defaults to the media server's default_user[[jellyfin: ; on Jellyfin, naming anyone else needs services.jellyfin.allow_other_users]]."
        ),
    isbn: z
        .string()
        .min(10)
        .max(17)
        .optional()
        .describe("[[grimmory: Books only: search Grimmory's providers by this ISBN instead of the book's own.]]")
}));

export function registerFixMetadata(
    server: McpServer,
    context: WriteContext,
    servers: MediaServers,
    loader: LibraryLoader,
    timing: RepairTiming = DEFAULT_TIMING,
    books?: BookLibrary,
    /** Every configured adapter. Only the Lidarr ones are read, for music. */
    music: readonly ServiceAdapter[] = []
): void {
    const adapters = [servers.primary?.adapter, servers.secondary?.adapter].filter(a => a !== undefined);
    registerWriteTool(server, { ...context, permissions: withPlexGate(context.permissions, adapters) }, {
        name: 'fix_metadata',
        title: 'Repair wrong metadata',
        description:
            '[[jellyfin|plex: Repairs films and series whose media-server metadata does not describe the file on disk (a file `Episode 101` shown as S1E1 with another title). Not trigger_scan, which never replaces a wrong title. Give a title as `query`, or the `id` get_metadata_issues printed. The preview lists `numbering` findings (confident) and `title` findings (advisory); a film is judged on year and title. **Destructive**: re-identifies the item against TVDB or TMDB and replaces all its metadata, hand edits included.]] [[jellyfin: Jellyfin has no undo.]] [[jellyfin|plex: Locked fields are never overwritten.]] [[sonarr: When the preview says a refresh cannot move the episodes, use trigger_scan `action: "rename"` on the Sonarr series, then a media-server rescan.]] [[jellyfin: On Jellyfin the repair holds the request open a long time: do not retry.]] [[grimmory: A Grimmory book is `grimmory:<book id>`, matched by ISBN or title and author.]] [[lidarr: For music, `id: "lidarr:<artistId>"` retags its files.]] Previews first; confirm to apply. Field reference: arr://docs/fix_metadata.' +
            withBoth(
                bothIds(servers),
                'With two media servers configured, `service` picks one; it defaults to the primary, and an `id` prefixed `plex:` or `jellyfin:` picks that server.'
            ),
        inputSchema: fixMetadataInput(bothIds(servers)),
        // A `lidarr:` id first: that write goes to Lidarr. One that no configured
        // Lidarr matches is refused here, before the permission check reads a
        // media server for it, as the tools that take `instance` refuse one that
        // is not configured. `service` is enum-checked against the configured
        // ids, so `pickMediaServer` cannot throw.
        service: ({ service, id }) => {
            const retag = lidarrTarget(music, id);
            if (retag !== undefined) return retag.adapter.id;
            if (id !== undefined && /^lidarr(?:[:/]|$)/i.test(id)) throw unknownLidarr(music, id);
            return id?.startsWith('grimmory:') === true ? (books?.id ?? 'grimmory') : (pickMediaServer(servers, service ?? prefixed(servers, id))?.adapter.id ?? 'jellyfin');
        },
        operation: 'fix_metadata',
        tier: 'destructive',

        async plan({ service, query, id, user, isbn, files }): Promise<WritePlan> {
            if (id === undefined && query === undefined) throw new Error('Name a film or series as `query`, or give its `id`.');
            const retag = lidarrTarget(music, id);
            if (retag !== undefined) {
                if (service !== undefined) throw new Error('`service` picks a media server; a `lidarr:` id is retagged in Lidarr. Drop `service`.');
                if (user !== undefined) throw new Error('`user` picks whose media-server view to read; a music retag reads Lidarr alone. Drop it.');
                if (isbn !== undefined) throw new Error('`isbn` is for a book: give the book as `id: "grimmory:<book id>"`.');
                return planRetag(retag.adapter, retag.artistId, files);
            }
            if (files !== undefined) {
                const forms = artistIdForms(music);
                throw new Error(forms === undefined ? '`files` is for music only, and no Lidarr is configured.' : `\`files\` is for music only, with \`id\` as ${forms}.`);
            }
            // Before any media-server request: a book never reaches that path.
            if (id === 'grimmory' || id?.startsWith('grimmory:') === true) return planBookFix(books, id, { service, user, isbn });
            if (isbn !== undefined) throw new Error('`isbn` is for a book: give the book as `id: "grimmory:<book id>"`.');
            if (id === undefined && query !== undefined) {
                // The resolver's own choice, before a media server is needed: an
                // artist is repaired in Lidarr. A book is left to `resolve` below.
                try {
                    filmOrSeriesMatch((await loader.load()).index.search(query), query);
                } catch (err) {
                    if (err instanceof ArtistTitleRefusal) throw artistByName(err.artist, music);
                    if (!(err instanceof BookTitleRefusal)) throw err;
                }
            }
            const { adapter, identity } = chooseServer(servers, service, id);
            const viewer = await identity.resolve(user);
            const series = id !== undefined ? await resolveById(loader, id, adapter) : await resolve(loader, query ?? '', adapter, adapter.id === servers.secondary?.adapter.id);

            let parts: readonly (EpisodeRecord | MovieRecord)[];
            let mismatches: Mismatch[];

            if (series.kind === 'movie') {
                const films = await adapter.readMovieMetadata(viewer, series.itemId);
                parts = films;
                mismatches = findMovieMismatches(films);
            } else {
                ({ rows: parts, mismatches } = await withLocks(adapter, await adapter.readEpisodeMetadata(viewer, series.itemId), findMismatches));
            }
            const target = `${adapter.id}:${series.itemId}`;
            const unit = series.kind === 'movie' ? 'file' : 'episodes';

            const comparable = parts.filter(hasPath).length;
            if (comparable === 0) {
                // Distinct from "nothing is wrong", and the difference matters:
                // a server that returned no paths was never actually asked the
                // question, and reporting that as a clean bill of health would
                // be a lie in the reassuring direction.
                throw new ServiceError('UpstreamError', adapter.id, `${serverName(adapter)} returned no file paths for "${series.title}"`, {
                    remedy:
                        'Nothing could be compared, so nothing is claimed. This read needs a token that can see file paths (on Jellyfin, an administrator) and an item whose files are on disk.'
                });
            }

            if (mismatches.length === 0) {
                return {
                    target,
                    summary: `Nothing in ${series.title} disagrees with its files (${comparable} ${unit} checked).`,
                    effects: [],
                    noop: true
                };
            }

            if (series.kind === 'series') {
                const owners = managedSeriesOf(parts, await managedFolders(loader));
                if (owners.length > 1) {
                    return {
                        target,
                        summary: `${series.title} has ${mismatches.length} of ${comparable} episodes disagreeing with their files, but it is separate shows merged into one item, which a repair cannot fix.`,
                        effects: [mergedHow(adapter, owners.map(o => o.title)), ...mismatches.slice(0, EXAMPLE_LIMIT).map(m => describe(m, adapter.id))],
                        noop: true
                    };
                }
            }

            /**
             * The finding that decides whether this write is worth doing at
             * all, and it is stated first because it is the one that can waste
             * someone's time.
             *
             * A refresh re-fetches an episode from the provider id stored *on
             * that episode*. An episode pinned to the wrong id is therefore
             * re-written with the same wrong metadata, and the repair reports
             * success having changed nothing. Verified on Dragon Ball Kai: all
             * 68 mismatching episodes carried their own AniDB/TVDB ids, the
             * repair applied cleanly, and every title came back identical.
             */
            // Films are exempt. An episode pinned to a provider id keeps its
            // scan-time numbering across a refresh, which is what makes the
            // repair pointless there. A film has no such index: its year and
            // title come from the match, and re-identifying re-derives both;
            // so every matched film would otherwise be told, wrongly, that this
            // repair achieves nothing and to rename a Sonarr series.
            const byId = new Map(parts.map(e => [e.id, e]));
            const pinned =
                series.kind === 'movie'
                    ? 0
                    : mismatches.filter(m => {
                          const record = byId.get(m.id);
                          return record !== undefined && pinnedToProvider(record);
                      }).length;

            const numbering = mismatches.filter(m => m.reasons.includes('numbering')).length;
            const titleOnly = mismatches.length - numbering;
            const locked = mismatches.filter(m => m.locked === true).length;
            const shifted = mismatches.filter(m => m.advisory === 'shifted').length;
            const languages = mismatches.filter(m => m.advisory === 'language').length;
            const film = series.kind === 'movie' ? mismatches[0] : undefined;
            // One decision, used by the summary, the warning and the token
            // binding, so the three cannot disagree about which id is pinned.
            const provider = pinnedProvider(series);
            // The Plex Movie agent takes a film's year from Plex's own metadata,
            // so re-matching to the id Plex already holds leaves it alone (#312).
            const plexFilm = film !== undefined && adapter.type === 'plex';
            const serverTmdb = film === undefined ? undefined : (byId.get(film.id) as MovieRecord | undefined)?.providerIds?.Tmdb;
            const sameMatch =
                plexFilm && film.reasons.length === 1 && film.reasons[0] === 'year' && provider.id?.tmdbId !== undefined && serverTmdb === String(provider.id.tmdbId);

            return {
                target,
                summary:
                    locked === mismatches.length
                        ? `${series.title} disagrees with its ${film === undefined ? 'files' : 'file'}, but every disagreeing field is locked in ${serverName(adapter)}, so a repair cannot change it. Unlock the field on the item in ${serverName(adapter)} first.`
                        : pinned === mismatches.length
                          ? `${series.title} has ${mismatches.length} of ${comparable} episodes disagreeing with their files, but every one of them was matched to a specific provider episode. A refresh will not move those, and this repair is expected to change nothing.`
                          : plexFilm
                            ? `Re-match ${series.title} in Plex${provider.id === undefined ? '' : ` using ${provider.label}`} and refresh it from Plex's own metadata: its file names a different ${film.reasons.includes('year') ? 'year' : 'title'}.`
                            : film !== undefined
                            ? `Re-identify ${series.title} against ${provider.label} and replace all of its metadata: its file names a different ${film.reasons.includes('year') ? 'year' : 'title'}.`
                            : `Re-identify ${series.title} against ${provider.label} and replace all of its metadata: ${mismatches.length} of ${comparable} ${unit} disagree with their files.`,
                effects: [
                    ...(sameMatch
                        ? [
                              `Plex is already matched to ${provider.label}, so this re-matches the same film, and the Plex Movie agent keeps Plex's own year. A repair is not expected to change the year. Check the year in Radarr and the file name first.`
                          ]
                        : []),
                    ...(shifted === 0
                        ? []
                        : [
                              `${shifted} of the ${mismatches.length} mismatching episodes carry the title ${serverName(adapter)} gives another episode in the same season. That is a different episode order rather than a wrong match, and on a real Plex library a rematch did not move a single one.`
                          ]),
                    ...(languages === 0
                        ? []
                        : [
                              `${languages} of the ${mismatches.length} mismatching episodes have the filename and the ${serverName(adapter)} title in different languages. Both can be right, and a rematch does not change the language.`
                          ]),
                    ...(locked === 0
                        ? []
                        : [
                              `${locked === mismatches.length ? 'Every' : `${locked} of the ${mismatches.length}`} disagreeing ${film === undefined ? 'episodes have their' : 'film has its'} field locked in ${serverName(adapter)}. ${adapter.type === 'plex' ? 'Fix Match and a refresh never overwrite' : 'A refresh never overwrites'} a locked field, so unlock it on the item first (${unlockHow(adapter)}).`
                          ]),
                    ...(pinned === 0
                        ? []
                        : [
                              pinned === mismatches.length
                                  ? `EXPECTED TO ACHIEVE NOTHING. All ${pinned} mismatching episodes were matched to a specific provider episode, and a refresh does not re-derive an episode's season, number or title from its file. Those are stored on the item from the original scan. Measured on a real library in this exact state: a full refresh changed nothing, and so did clearing an episode's provider ids and refreshing it again. The repair that does work is upstream: trigger_scan with action "rename" on the Sonarr series to give the files proper SxxExx names, then trigger_scan on the media server to rescan them.`
                                  : `${pinned} of the ${mismatches.length} mismatching episodes were matched to a specific provider episode, and a refresh will not move those. An episode's numbers and title are stored on the item from the original scan, not re-derived from the file. For those, trigger_scan with action "rename" on the Sonarr series and then a media server rescan is the repair that works.`
                          ]),
                    adapter.type === 'plex'
                        ? 'Re-matches the item in Plex (Fix Match) and refreshes all of its metadata in the background. Hand edits are overwritten unless the field is locked; Fix Match or Unmatch on the item in Plex is the way back.'
                        : `Replaces every metadata field on the ${series.kind === 'movie' ? 'film' : 'series and its episodes'}. Hand edits are overwritten unless the field or the item is locked, and the previous values are not recoverable.`,
                    ...(provider.id === undefined
                        ? [
                              'No provider id is known for this title, so the identity is not pinned before the refresh. The server may re-match it the same wrong way. Fix it in Radarr or Sonarr first.'
                          ]
                        : []),
                    // m3: an id that came only from the media server is not
                    // independent evidence; it may be the wrong id that caused
                    // this. Say so rather than presenting it as a fix.
                    ...(provider.id !== undefined && series.unmanaged
                        ? [
                              `${provider.label} is the media server's own id for this title, and no Radarr or Sonarr manages it. So re-identifying may pin exactly the id that is already wrong.`
                          ]
                        : []),
                    ...(film !== undefined
                        ? [
                              film.reasons.includes('year')
                                  ? "The year in the filename disagrees with the server's, the stronger signal: it usually means a different film was matched."
                                  : 'Only the title text disagrees, the weaker signal, and legitimate for an alternate or regional title.'
                          ]
                        : [
                              `${numbering} episode${numbering === 1 ? '' : 's'} where the path's own season/episode number disagrees with the server.`,
                              ...(adapter.type === 'plex' && numbering > 0
                                  ? [
                                        'Plex takes season and episode numbers from the file names, so a numbering mismatch usually needs the files renamed (trigger_scan with action "rename" on Sonarr, then trigger_scan on Plex) rather than a rematch.'
                                    ]
                                  : []),
                              `${titleOnly} where only the title text disagrees. This is the weaker signal, and legitimate for a romanised or alternate-language filename.`
                          ]),
                    ...mismatches.slice(0, EXAMPLE_LIMIT).map(m => describe(m, adapter.id)),
                    ...(mismatches.length > EXAMPLE_LIMIT ? [`…and ${mismatches.length - EXAMPLE_LIMIT} more.`] : [])
                ],
                // The count is bound into the token deliberately: if the library
                // changed between preview and confirm, the evidence the person
                // agreed to no longer describes what would happen, and a fresh
                // preview is the right outcome.
                // No token for a write this predicts will do nothing. Issuing
                // one asks a person to confirm a destructive, irreversible
                // operation whose own preview says it achieves nothing, which
                // is how confirming becomes reflexive.
                ...((pinned > 0 && pinned === mismatches.length && numbering > 0) || locked === mismatches.length ? { noop: true } : {}),
                args: {
                    // Bound so a confirm cannot repair on a different server than it previewed.
                    server: adapter.id,
                    itemId: series.itemId,
                    mismatches: mismatches.length,
                    // Bound into the token as well as the count: a confirmation
                    // for a preview that unpinned nothing must not authorise one
                    // that unpins sixty-eight episodes.
                    pinned,
                    locked,
                    kind: series.kind,
                    // The id `apply` will actually pin, not just the series one:
                    // a film pins TMDB, and binding only TVDB left a change to
                    // the film's merged TMDB id invisible to the token.
                    ...(provider.id === undefined ? {} : { providerId: provider.id })
                }
            };
        },

        // The verdict, not just "Applied": a client that drops
        // structuredContent (#234) could not tell a repair from a failure.
        applied(outcome, plan) {
            const changed = (outcome as { changed?: string[] } | undefined)?.changed;
            if (changed !== undefined) return `Applied. ${plan.summary} Changed: ${changed.join(', ')}.`;
            const note = (outcome as { note?: string } | undefined)?.note;
            return note === undefined ? undefined : `Applied. ${plan.summary}

${note}`;
        },

        async apply(plan, { user }) {
            // From the plan the token was verified against, not a second
            // resolve. Re-resolving would let a concurrent write that
            // invalidated the library index land this repair on a different
            // item than the one the confirmation names.
            const bound = plan.args as
                | { kind: 'retag'; artistId: string; files: number[]; scrub: boolean | null; albums: number[] | null }
                | {
                      server: string;
                      itemId: string;
                      kind: 'movie' | 'series' | 'book';
                      providerId?: { tvdbId?: number; tmdbId?: number };
                      changes?: BookFields;
                  };
            if (bound.kind === 'retag') {
                // The Lidarr the token's target names, not a fresh resolve.
                const target = lidarrTarget(music, plan.target);
                if (target === undefined) throw new ServiceError('NotFound', 'lidarr', `${plan.target} is no longer a configured Lidarr artist`);
                return applyRetag(target.adapter, bound);
            }
            if (bound.kind === 'book') {
                if (books === undefined) throw new ServiceError('NotFound', 'grimmory', 'no Grimmory is configured');
                const changes = bound.changes ?? {};
                await books.writeBookMetadata(bound.itemId, changes);
                return { changed: Object.keys(changes) };
            }
            const { adapter, identity } = chooseServer(servers, bound.server, undefined);
            const viewer = await identity.resolve(user);
            const series = { itemId: bound.itemId, kind: bound.kind, title: plan.summary };

            const read = async (locks = false): Promise<Reading> => {
                if (series.kind === 'movie') {
                    const films = await adapter.readMovieMetadata(viewer, series.itemId);
                    return { mismatches: findMovieMismatches(films), compared: films.filter(hasPath).length };
                }
                const episodes = await adapter.readEpisodeMetadata(viewer, series.itemId);
                const { mismatches } = locks ? await withLocks(adapter, episodes, findMismatches) : { mismatches: findMismatches(episodes) };
                return { mismatches, compared: episodes.filter(hasPath).length };
            };

            const before = await read(true);

            // Exactly the id the preview named and the token bound.
            const { settled, matchedTo } = await adapter.repairMetadata(series.itemId, bound.providerId ?? {});
            const matched =
                matchedTo === undefined ? '' : ` Matched to ${titled(matchedTo.name, matchedTo.year)}.`;

            /**
             * A queued refresh is read until an improvement holds across two
             * reads, or the wait runs out. One read straight after was wrong in
             * three of four live Plex applies: twice it caught a show mid-rebuild
             * with nothing to compare and called that repaired, once it read a
             * film before the refresh landed and called that a failure.
             */
            // The write has landed by now, so a failed read is "not settled
            // yet", never an error: Broken Darkness was repaired and reported
            // as a 503.
            let readError: string | undefined;
            const readAfter = async (): Promise<Reading | undefined> => {
                try {
                    return await read();
                } catch (err) {
                    if (!(err instanceof ServiceError) || !STILL_SETTLING.has(err.kind)) throw err;
                    readError = err.detail;
                    return undefined;
                }
            };

            const improved = (r: Reading | undefined): boolean =>
                r !== undefined && r.compared >= before.compared && r.mismatches.length < before.mismatches.length;
            let after = await readAfter();
            let held = settled && improved(after);
            let waitedMs = 0;
            while (!settled && waitedMs < timing.waitMs) {
                await timing.sleep(timing.pollMs);
                waitedMs += timing.pollMs;
                const next = await readAfter();
                held = improved(after) && improved(next) && next?.mismatches.length === after?.mismatches.length;
                if (next !== undefined) after = next;
                if (held) break;
            }

            const b = before.mismatches.length;
            const unit = series.kind === 'movie' ? 'file' : 'episodes';
            const waited = `${Math.round(waitedMs / 1000)} seconds`;

            if (after === undefined) {
                return {
                    mismatchesBefore: b,
                    comparedBefore: before.compared,
                    verified: false,
                    note: `NOT VERIFIED: the repair was accepted, but ${serverName(adapter)} answered every read after it with an error (${readError ?? 'unknown'}) for ${waited}, so the result could not be checked.${matched} That usually means it is still refreshing the item. Run get_metadata_issues again in a few minutes.`
                };
            }
            const a = after.mismatches.length;
            const lockedBefore = before.mismatches.filter(m => m.locked === true).length;
            const lockNote =
                lockedBefore === 0
                    ? ''
                    : ` ${lockedBefore} of them ${lockedBefore === 1 ? 'is' : 'are'} on a field locked in ${serverName(adapter)}, which no repair overwrites; unlock it on the item first.`;

            /**
             * The write succeeding and the problem being fixed are two different
             * facts, and this tool used to report only the first. A live run
             * returned `applied: true` having changed nothing at all, which is
             * the reassuring lie every other part of this file is written to
             * avoid, so the outcome is stated in its own words here.
             *
             * Whether an unchanged count is a failure depends on which call ran.
             * On Jellyfin the identify path finishes the refresh before it
             * answers, so its result is final and an unchanged count means it
             * genuinely did nothing. A queued refresh (Jellyfin's plain one, and
             * Plex's always) has no done signal, so it gets the wait above and an
             * honest "not verified" when that runs out.
             */
            return {
                mismatchesBefore: b,
                mismatchesAfter: a,
                comparedBefore: before.compared,
                comparedAfter: after.compared,
                verified: held,
                note: held
                    ? `Repaired: ${b - a} of ${b} mismatches are gone.${matched}` +
                      (settled ? '' : ` That held across two reads ${Math.round(timing.pollMs / 1000)} seconds apart.`)
                    : after.compared < before.compared
                      ? `NOT VERIFIED: ${serverName(adapter)} was still rebuilding the item after ${waited}. The last read compared ${after.compared} of the ${before.compared} ${unit} compared before the repair, so its count says nothing yet.${matched} Run get_metadata_issues again in a few minutes.`
                      : settled && a >= b
                        ? `NOT FIXED: the re-identify completed and ${a} mismatches remain, the same as before. This is a final answer rather than an early one, because the server finished the work before replying. An episode's season and number are stored on the item from the original scan and no refresh re-derives them, so the repair that works is trigger_scan with action "rename" on the managing Radarr or Sonarr, then trigger_scan on the media server.`
                        : `NOT VERIFIED: ${a} of ${b} mismatches remain after waiting ${waited}${a < b ? ', and that count did not hold across a second read' : ''}.${matched}${lockNote} ` +
                          (bound.providerId === undefined
                              ? 'No provider id could be pinned, so this was a plain refresh, which the server queues. '
                              : 'The server queues the refresh and finishes it in the background. ') +
                          'Run get_metadata_issues again in a few minutes. If they are still there, this repair does not fix them.'
            };
        }
    });
}
