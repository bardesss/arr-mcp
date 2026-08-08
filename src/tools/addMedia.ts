import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import {
    hasMediaAdd,
    type MediaAddCapable,
    type QualityProfile,
    type RootFolder,
    type ServiceAdapter
} from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * The last of the writes, and the only one that has to *choose*
 * something on the user's behalf.
 *
 * Adding needs a quality profile and a root folder, and neither has a
 * defensible default this code could invent. So the rule is: if there is
 * exactly one, use it silently — there was no choice to make. If there are
 * several and the caller named none, **refuse and list them**. Picking the
 * first of four quality profiles would be a guess presented as a decision, and
 * the user would discover it as a 4K film filling a disk they meant to keep
 * for 1080p.
 *
 * Safe tier: an added item can be removed again with `delete_media`. It still
 * says in the preview that it will start downloading, because "add" reads
 * cheaper than it is.
 */

const findAdapter = (
    adapters: readonly ServiceAdapter[],
    service: ServiceId,
    instance?: string
): ServiceAdapter & MediaAddCapable => {
    const adapter = resolveInstance(adapters, service, instance);
    if (!hasMediaAdd(adapter)) {
        throw new ServiceError('NotFound', service, `${service} cannot add media`, {
            remedy: 'Only radarr (films, by TMDB id) and sonarr (series, by TVDB id) can.'
        });
    }
    return adapter;
};

/**
 * Resolves one of several options, or refuses in a way that can be acted on.
 *
 * Exact matches are tried first and, crucially, a **loose match that is
 * ambiguous is a refusal, not a coin toss**. Two live failures shaped this:
 *
 * - Asking for quality profile `8` selected `HD-1080p` (id 4), because the
 *   old single predicate `id === requested || name.includes(requested)` let
 *   the *name* branch fire on the digit: "hd-1080p" contains "8". A film was
 *   added and a 1080p release grabbed against an explicit request for 2160p.
 *   A numeric request now only ever matches an id.
 * - `2160p Balanced` is a prefix of `2160p Balanced NL`, so a substring match
 *   silently picked whichever came first.
 *
 * Both are the same failure the "several, none named" refusal below exists to
 * prevent — a guess presented as a decision — and both are worse for arriving
 * while looking like the tool had understood.
 */
function chooseOne<T>(
    options: readonly T[],
    requested: string | undefined,
    match: { exact: (option: T, requested: string) => boolean; loose: (option: T, requested: string) => boolean },
    describe: (option: T) => string,
    what: string,
    service: ServiceId
): T {
    if (options.length === 0) {
        throw new ServiceError('NotFound', service, `${service} has no ${what} configured`, {
            remedy: `Add one in ${service}'s own settings first — nothing can be added without it.`
        });
    }

    if (requested !== undefined) {
        const exact = options.filter(o => match.exact(o, requested));
        if (exact.length === 1) return exact[0]!;

        // Only consulted when nothing matched exactly, so an exact name can
        // never be beaten by another option that merely contains it.
        const loose = exact.length === 0 ? options.filter(o => match.loose(o, requested)) : exact;
        if (loose.length === 1) return loose[0]!;

        if (loose.length === 0) {
            throw new ServiceError('NotFound', service, `no ${what} on ${service} matches "${requested}"`, {
                remedy: `Available: ${options.map(describe).join('; ')}.`
            });
        }

        throw new ServiceError('NotFound', service, `"${requested}" matches more than one ${what} on ${service}`, {
            remedy: `Be exact — it matches: ${loose.map(describe).join('; ')}. Naming the id is unambiguous.`
        });
    }

    // Exactly one is not a choice, so making it silently is not a guess.
    if (options.length === 1) return options[0]!;

    throw new ServiceError('NotFound', service, `${service} has several ${what}s and none was named`, {
        remedy: `Name one — available: ${options.map(describe).join('; ')}. Not guessing, because the wrong one is not obvious until the download finishes.`
    });
}

/** A request made entirely of digits is an id and nothing else. Without this,
 *  "8" matches the *name* "HD-1080p". */
const isNumeric = (value: string) => /^\d+$/.test(value);

const GIB = 1024 ** 3;
const freeSpace = (folder: RootFolder): string =>
    folder.freeSpaceBytes === undefined ? 'free space unknown' : `${(folder.freeSpaceBytes / GIB).toFixed(0)} GB free`;

const PROFILE_MATCH = {
    exact: (p: QualityProfile, requested: string): boolean =>
        String(p.id) === requested || p.name.toLowerCase() === requested.toLowerCase(),
    // A numeric request is an id, full stop — never a substring of a name.
    loose: (p: QualityProfile, requested: string): boolean =>
        !isNumeric(requested) && p.name.toLowerCase().includes(requested.toLowerCase())
};

const FOLDER_MATCH = {
    exact: (f: RootFolder, requested: string): boolean => f.path.toLowerCase() === requested.toLowerCase(),
    loose: (f: RootFolder, requested: string): boolean => f.path.toLowerCase().includes(requested.toLowerCase())
};

export function registerAddMedia(server: McpServer, context: WriteContext, adapters: readonly ServiceAdapter[]): void {
    registerWriteTool(server, context, {
        name: 'add_media',
        description:
            'Adds a film to Radarr or a series to Sonarr and, by default, starts searching for it. Radarr takes a TMDB id, Sonarr takes a TVDB id — get the right one from lookup_media, which returns both under `ids`. If the service has more than one quality profile or root folder you must name which, because guessing wrong is only discovered once the download finishes. Previews by default — call again with the returned `confirm` token to actually add it.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('radarr for a film, sonarr for a series.'),
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            external_id: z
                .string()
                .min(1)
                .describe('TMDB id for radarr, TVDB id for sonarr, as an integer string. From lookup_media.'),
            quality_profile: z
                .string()
                .optional()
                .describe('Profile name or id. Optional only when the service has exactly one.'),
            root_folder: z
                .string()
                .optional()
                .describe('Root folder path, or any distinctive part of it. Optional only when the service has exactly one.'),
            monitored: z.boolean().default(true).describe('Monitor it for downloads. Defaults to true.'),
            search_now: z
                .boolean()
                .default(true)
                .describe('Start searching immediately. Defaults to true — set false to add without downloading yet.')
        }),
        // The resolved instance id, not the bare type: permissions are granted per
        // instance, so checking `radarr` against a config that only grants
        // `radarr/hd` would deny a permitted write — or worse, the reverse.
        service: ({ service, instance }) => findAdapter(adapters, service, instance).id,
        operation: 'add_media',
        tier: 'safe',

        async plan({ service, instance, external_id, quality_profile, root_folder, monitored, search_now }): Promise<WritePlan> {
            const adapter = findAdapter(adapters, service, instance);

            // All three reads together: they are independent, and a preview
            // that takes three sequential round trips on a LAN service is
            // needlessly slow.
            const [candidate, profiles, folders] = await Promise.all([
                adapter.lookupForAdd(external_id),
                adapter.listQualityProfiles(),
                adapter.listRootFolders()
            ]);

            const label = `${candidate.title}${candidate.year === undefined ? '' : ` (${candidate.year})`}`;

            // Already there is a no-op, not a failure — and adding again would
            // be a duplicate entry rather than a second copy of the film.
            if (candidate.existingId !== undefined) {
                return {
                    target: `${service}:${external_id}`,
                    summary: `${label} is already in ${service} (id ${candidate.existingId}).`,
                    effects: [],
                    noop: true
                };
            }

            const profile = chooseOne(
                profiles,
                quality_profile,
                PROFILE_MATCH,
                p => `${p.display} (id ${p.id})`,
                'quality profile',
                service
            );

            const folder = chooseOne(
                folders,
                root_folder,
                FOLDER_MATCH,
                f => `${f.display} (${freeSpace(f)})`,
                'root folder',
                service
            );

            const effects = [
                `Adds ${label} to ${service} under ${folder.display} (${freeSpace(folder)}), quality profile ${profile.display} (id ${profile.id}).`,
                monitored
                    ? 'Monitors it, so it will be grabbed when a matching release appears.'
                    : 'Adds it unmonitored, so nothing will be grabbed until you monitor it.'
            ];

            effects.push(
                search_now
                    ? 'Starts searching immediately — this may begin a download, using disk space and bandwidth.'
                    : 'Does not search yet. Use trigger_search when you want it to look.'
            );

            return {
                target: `${service}:${external_id}`,
                summary: `Add ${label} to ${service}.`,
                effects,
                // The resolved profile and folder, not the strings asked for:
                // the token must commit to what will actually happen, so a
                // preview showing "1080p into /movies" cannot be confirmed
                // into "4K into /media2".
                args: {
                    service,
                    externalId: external_id,
                    qualityProfileId: profile.id,
                    rootFolderPath: folder.path,
                    monitored,
                    searchNow: search_now
                }
            };
        },

        async apply(plan, { service, instance }) {
            const a = plan.args as {
                externalId: string;
                qualityProfileId: number;
                rootFolderPath: string;
                monitored: boolean;
                searchNow: boolean;
            };

            // Taken from the plan rather than re-resolved from the arguments:
            // re-running `chooseOne` here could land on a different profile if
            // one was added in between, and the token guaranteed the one that
            // was previewed.
            return findAdapter(adapters, service, instance).addMedia({
                externalId: a.externalId,
                qualityProfileId: a.qualityProfileId,
                rootFolderPath: a.rootFolderPath,
                monitored: a.monitored,
                searchNow: a.searchNow
            });
        }
    });
}
