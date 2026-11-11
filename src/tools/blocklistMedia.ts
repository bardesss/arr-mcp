import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import { unfence } from '../core/fence.ts';
import { titled } from '../core/labels.ts';
import { checkPermission, type PermissionSource, type WriteTier } from '../core/permissions.ts';
import { SeerrAdapter } from '../services/seerr.ts';
import { hasImportExclusions, type ImportExclusionCapable, type MediaAddCapable, type ServiceAdapter } from '../services/types.ts';
import { serviceTarget, targetInput } from './serviceTarget.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * Seerr's blocklist (#602): a title on it cannot be requested by anyone, so a
 * film deleted from Radarr is not sent straight back by the next request or
 * watchlist sync. `delete_media` adds to it in the same call as the delete;
 * this tool is the rest — blocklisting a title that was never in Radarr or
 * Sonarr, retrying one the delete could not finish, and lifting one.
 *
 * Adding is `safe`: it changes nothing Seerr has, only refuses what comes
 * next. Removing is `destructive`, which is Seerr's doing and not obvious from
 * the word: its route deletes the title's media record with the blocklist row,
 * and that record cascades to every request and issue for the title
 * (`server/routes/blocklist.ts`, `entity/Media.ts`). One tool with the tier
 * derived from `action`, as `manage_indexer` did for its delete, because the
 * two directions of one list are one thing to look for.
 */

const seerrOf = (adapters: readonly ServiceAdapter[]): SeerrAdapter | undefined =>
    adapters.find((a): a is SeerrAdapter => a instanceof SeerrAdapter);

export function requireSeerr(adapters: readonly ServiceAdapter[]): SeerrAdapter {
    const seerr = seerrOf(adapters);
    if (seerr === undefined) {
        throw new ServiceError('NotFound', 'seerr', 'seerr is not configured', {
            remedy: 'The blocklist lives in Seerr. Add a services.seerr block to config.yaml and restart.'
        });
    }
    return seerr;
}

/**
 * For a write that reaches Seerr from another service's tool. The harness
 * checks the permissions of the service a tool is routed to, and nothing else,
 * so `delete_media` on Radarr would otherwise blocklist in Seerr on Radarr's
 * grant alone.
 */
export function requireSeerrWrite(permissions: PermissionSource, seerr: SeerrAdapter, tier: WriteTier, operation: string): void {
    const verdict = checkPermission(permissions, seerr.id, tier);
    if (!verdict.allowed) {
        throw new ServiceError('PermissionDenied', seerr.id, `${verdict.reason} (${tier} write ${operation} on ${seerr.id})`, {
            remedy: verdict.remedy
        });
    }
}

/** Seerr's word for a kind. */
export const seerrMediaType = (kind: 'movie' | 'series'): 'movie' | 'tv' => (kind === 'series' ? 'tv' : 'movie');

/** Where each service's list keys a title, for previews and refusals. */
const ID_LABEL: Readonly<Record<string, string>> = { seerr: 'TMDB', radarr: 'TMDB', sonarr: 'TVDB', lidarr: 'MusicBrainz' };

/** Seerr's blocklist, or an *arr's import exclusions. */
type Listing = SeerrAdapter | (ServiceAdapter & ImportExclusionCapable & MediaAddCapable);

const TARGET = serviceTarget({
    services: ['seerr', 'radarr', 'sonarr', 'lidarr'],
    can: (a): a is Listing => a instanceof SeerrAdapter || hasImportExclusions(a),
    cannot: 'has no blocklist or import exclusions',
    hint: 'Whisparr is left out until a live capture shows which id its exclusions hold.'
});

const BlocklistMediaInput = z.object({
    ...targetInput(TARGET),
    service: targetInput(TARGET).service.default('seerr'),
    action: z.enum(['add', 'remove']).describe('add, or remove[[seerr:  (on Seerr destructive: it also deletes its record of the title)]].'),
    id: z
        .union([z.number().int().positive(), z.string().min(1)])
        .optional()
        .describe(
            "The title's {{or: seerr|radarr=TMDB id (seerr, radarr); sonarr=TVDB id (sonarr); lidarr=MusicBrainz artist id (lidarr)}}, from `ids` on a search_media or get_media_details record."
        ),
    kind: z.enum(['movie', 'series']).optional().describe('[[seerr: Seerr only, where it is required.]]'),
    // 1.81.0 shipped this, Seerr-only, before `id` covered the *arrs (DEPRECATIONS).
    tmdb_id: z.number().int().positive().optional().describe('[[seerr: Deprecated: use id. Seerr only.]]')
});

type Input = z.infer<typeof BlocklistMediaInput>;

/** `id`, or the deprecated `tmdb_id` on Seerr; never both, never neither. */
function idOf({ service, id, tmdb_id }: Input): number | string {
    if (tmdb_id !== undefined) {
        if (service !== 'seerr') {
            throw new ServiceError('NotFound', service, 'tmdb_id is for seerr', { remedy: 'Pass the id as `id`.' });
        }
        if (id !== undefined && String(id) !== String(tmdb_id)) {
            throw new ServiceError('NotFound', service, 'id and tmdb_id name different titles', { remedy: 'Pass `id` alone.' });
        }
        return tmdb_id;
    }
    if (id === undefined) throw new ServiceError('NotFound', service, 'no id given', { remedy: "Pass the title's id as `id`." });
    return id;
}

export function registerBlocklistMedia(server: McpServer, context: WriteContext, adapters: readonly ServiceAdapter[]): void {
    registerWriteTool(server, context, {
        name: 'blocklist_media',
        title: 'Blocklist a title',
        description:
            "Adds a title to, or removes it from, [[seerr: Seerr's blocklist (nobody can request it) or, with `service`,]] an *arr's import exclusions (only its own import lists skip it). [[seerr: delete_media's `seerr_blocklist` adds to Seerr while deleting. Removing from Seerr is destructive: it also deletes the title's requests and issues.]] Previews first; confirm to apply.",
        inputSchema: BlocklistMediaInput,
        target: { adapters, to: TARGET },
        operation: 'blocklist_media',
        tier: ({ service, action }) => (service === 'seerr' && action === 'remove' ? 'destructive' : 'safe'),

        async plan(args, adapter): Promise<WritePlan> {
            if (adapter instanceof SeerrAdapter) return planSeerr(adapter, args);
            return planExclusion(adapter, args);
        },

        async apply(plan, args, adapter) {
            if (adapter instanceof SeerrAdapter) {
                const tmdbId = plan.args?.['tmdbId'] as number;
                const mediaType = plan.args?.['mediaType'] as 'movie' | 'tv';
                if (args.action === 'remove') {
                    await adapter.removeFromBlocklist(tmdbId, mediaType);
                    return { removed: plan.target };
                }
                const title = plan.args?.['title'];
                const outcome = await adapter.addToBlocklist({ tmdbId, mediaType, ...(typeof title === 'string' ? { title } : {}) });
                return { blocklisted: plan.target, outcome };
            }
            if (args.action === 'remove') {
                await adapter.removeImportExclusion(plan.args?.['exclusionId'] as number);
                return { removed: plan.target };
            }
            const year = plan.args?.['year'];
            await adapter.addImportExclusion(plan.args?.['id'] as string, {
                title: plan.args?.['title'] as string,
                ...(typeof year === 'number' ? { year } : {})
            });
            return { excluded: plan.target };
        }
    });
}

async function planSeerr(seerr: SeerrAdapter, input: Input): Promise<WritePlan> {
    const { action, kind } = input;
    const id = idOf(input);
    if (kind === undefined) {
        throw new ServiceError('NotFound', seerr.id, 'Seerr keys its blocklist on a TMDB id and a kind', {
            remedy: 'Pass kind: "movie" or kind: "series" with the TMDB id.'
        });
    }
    const tmdbId = Number(id);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
        throw new ServiceError('NotFound', seerr.id, `"${id}" is not a TMDB id`, { remedy: 'Seerr takes a TMDB id, a positive integer: `ids.tmdb`.' });
    }
    const mediaType = seerrMediaType(kind);
    // Strict, so a wrong id or kind fails here as a 404 rather than
    // blocklisting a TMDB id nobody looked at.
    const media = await seerr.describeTitle(mediaType, tmdbId, { strict: true });
    const label = media === undefined ? `TMDB ${kind} ${tmdbId}` : titled(media.title, media.year);
    const listed = await seerr.isBlocklisted(tmdbId, mediaType);
    const target = `seerr:${mediaType}:${tmdbId}`;
    const args = { action, tmdbId, mediaType, ...(media === undefined ? {} : { title: unfence(media.title) }) };

    if (action === 'add') {
        if (listed) return { target, summary: `${label} is already blocklisted in Seerr.`, effects: [], noop: true };
        return {
            target,
            summary: `Blocklist ${label} in Seerr.`,
            effects: [
                'Seerr refuses every new request for it, from any user or watchlist sync, until it is removed from the blocklist.',
                'Leaves its existing requests, and anything Radarr or Sonarr already has, as they are.'
            ],
            args
        };
    }

    if (!listed) return { target, summary: `${label} is not blocklisted in Seerr.`, effects: [], noop: true };
    return {
        target,
        summary: `Remove ${label} from Seerr's blocklist.`,
        effects: [
            "Deletes Seerr's record of it, with every request and issue for it. Seerr does this whenever a title leaves the blocklist, and it cannot be undone.",
            'It can be requested again.'
        ],
        args
    };
}

/**
 * An *arr's import exclusion. Both directions are `safe`: the exclusion is
 * the whole record, and deleting it takes nothing else with it. The preview
 * names the title through `add_media`'s own lookup, which also refuses an id
 * that is malformed or that the *arr's metadata provider does not know.
 */
async function planExclusion(adapter: ServiceAdapter & ImportExclusionCapable & MediaAddCapable, input: Input): Promise<WritePlan> {
    const { action, kind } = input;
    const id = idOf(input);
    const implied = adapter.type === 'radarr' ? 'movie' : adapter.type === 'sonarr' ? 'series' : undefined;
    if (kind !== undefined && kind !== implied) {
        throw new ServiceError('NotFound', adapter.id, `${adapter.type} has no ${kind} exclusions`, {
            remedy: 'Leave kind out for an *arr: Radarr excludes films, Sonarr series and Lidarr artists.'
        });
    }
    const externalId = String(id);
    const candidate = await adapter.lookupForAdd(externalId);
    const label = titled(candidate.title, candidate.year);
    const existing = await adapter.findImportExclusion(externalId);
    const target = `${adapter.id}:${(ID_LABEL[adapter.type] ?? 'id').toLowerCase()}:${externalId}`;
    const lists = `${adapter.id}'s import lists`;

    if (action === 'add') {
        if (existing !== undefined) return { target, summary: `${label} is already excluded from ${lists}.`, effects: [], noop: true };
        return {
            target,
            summary: `Exclude ${label} from ${lists}.`,
            effects: [
                `${lists} will not add it again. A Seerr request or a manual add still can; blocklist it in Seerr to stop requests.`,
                ...(adapter.type === 'lidarr' ? ["Lidarr deletes the exclusion itself when one of the artist's albums is added."] : [])
            ],
            args: { action, id: externalId, title: unfence(candidate.title), ...(candidate.year === undefined ? {} : { year: candidate.year }) }
        };
    }

    if (existing === undefined) return { target, summary: `${label} is not excluded from ${lists}.`, effects: [], noop: true };
    return {
        target,
        summary: `Remove ${label}'s exclusion from ${lists}.`,
        effects: [`${lists} can add it again.`],
        args: { action, id: externalId, exclusionId: existing.id }
    };
}
