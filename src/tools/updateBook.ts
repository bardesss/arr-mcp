import { INSTANCE_PARAM_DESCRIPTION } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import {
    hasBookMetadata,
    type BookField,
    type BookFields,
    type BookMetadataCapable,
    type ServiceAdapter
} from '../services/types.ts';
import { describeBookChange, diffBookFields } from './bookMetadata.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';
import { resolveTarget, serviceTarget } from './serviceTarget.ts';

const TARGET = serviceTarget({
    services: ['grimmory'],
    can: (a): a is ServiceAdapter & BookMetadataCapable => hasBookMetadata(a),
    cannot: 'cannot edit book metadata'
});

/** The book fields `update_book` can lock or unlock, by the name a caller uses. */
const LOCKABLE = ['title', 'authors', 'series', 'series_number', 'tags'] as const;
type Lockable = (typeof LOCKABLE)[number];
const BOOK_FIELD_OF: Record<Lockable, BookField> = {
    title: 'title',
    authors: 'authors',
    series: 'seriesName',
    series_number: 'seriesNumber',
    tags: 'categories'
};
const NAME_OF: Partial<Record<BookField, Lockable>> = Object.fromEntries(
    Object.entries(BOOK_FIELD_OF).map(([name, field]) => [field, name])
);
const nameOf = (field: BookField): string => NAME_OF[field] ?? field;


type BookArgs = {
    title?: string | undefined;
    authors?: string[] | undefined;
    series?: string | undefined;
    series_number?: number | undefined;
    tags?: string[] | undefined;
    lock_fields?: Lockable[] | undefined;
    unlock_fields?: Lockable[] | undefined;
};

/**
 * A hand edit to one book. Only the fields named are sent, and a field is
 * blanked only by an explicit `series: ""` or `tags: []`, never by leaving it
 * out. A locked field is refused here rather than skipped by the server, so
 * the preview never promises a change that will not land.
 */
export async function planBook(book: ServiceAdapter & BookMetadataCapable, rawId: string, args: BookArgs): Promise<WritePlan> {
    // `58` or `grimmory:58`; anything else is refused before a request is made.
    const id = rawId.replace(/^grimmory:/, '');
    if (!/^\d+$/.test(id)) {
        throw new ServiceError('NotFound', book.type, `"${rawId}" is not a Grimmory book id`, {
            remedy: 'Pass the book id as digits, as in 58 or grimmory:58: `acquisition.id` on a get_library record.'
        });
    }
    const { title, authors, series, series_number, tags } = args;
    const lock = [...new Set(args.lock_fields ?? [])].map(n => BOOK_FIELD_OF[n]);
    const unlock = [...new Set(args.unlock_fields ?? [])].map(n => BOOK_FIELD_OF[n]);

    if (
        title === undefined &&
        authors === undefined &&
        series === undefined &&
        series_number === undefined &&
        tags === undefined &&
        lock.length === 0 &&
        unlock.length === 0
    ) {
        throw new Error('Nothing to change. Name at least one of title, authors, series, series_number, tags, lock_fields or unlock_fields.');
    }
    const both = lock.filter(f => unlock.includes(f));
    if (both.length > 0) {
        throw new Error(`Cannot lock and unlock the same field in one call: ${both.map(nameOf).join(', ')} is in both lock_fields and unlock_fields.`);
    }
    if (tags?.some(t => t.trim() === '')) {
        throw new Error('A tag cannot be blank. Pass [] to clear the categories.');
    }
    if (title !== undefined && title.trim() === '') throw new Error('The title cannot be blank.');
    if (authors?.some(a => a.trim() === '')) throw new Error('An author cannot be blank.');
    if (series !== undefined && series !== '' && series.trim() === '') {
        throw new Error('The series cannot be blank. Pass "" to clear it.');
    }

    const state = await book.readBookMetadata(id);
    const wanted: BookFields = {
        ...(title === undefined ? {} : { title }),
        ...(authors === undefined ? {} : { authors }),
        ...(series === undefined || series === '' ? {} : { seriesName: series }),
        ...(series_number === undefined ? {} : { seriesNumber: series_number }),
        ...(tags === undefined || tags.length === 0 ? {} : { categories: tags })
    };
    // Explicit blanking, and only where there is something to blank.
    const clear: BookField[] = [
        ...(series === '' && state.fields.seriesName !== undefined ? (['seriesName'] as const) : []),
        ...(tags?.length === 0 && (state.fields.categories?.length ?? 0) > 0 ? (['categories'] as const) : [])
    ];

    const stillLocked = state.locked.filter(f => !unlock.includes(f));
    const { changes, keptLocked } = diffBookFields(state.fields, wanted, stillLocked, Object.keys(wanted) as BookField[]);
    const blocked = [...keptLocked, ...clear.filter(f => stillLocked.includes(f))];
    if (blocked.length > 0) {
        const it = blocked.length === 1 ? 'it' : 'them';
        throw new ServiceError('NotFound', book.type, `${blocked.map(nameOf).join(', ')} ${blocked.length === 1 ? 'is' : 'are'} locked in Grimmory`, {
            remedy: `Add ${it} to unlock_fields in this same call to edit ${it}, or leave ${it} out.`
        });
    }
    const changed = [...(Object.keys(changes) as BookField[]), ...clear];
    if (changed.length > 0 && state.allLocked) {
        throw new ServiceError('NotFound', book.type, `${state.label} has every metadata field locked in Grimmory`, {
            remedy: 'Unlock the book in Grimmory first; unlock_fields only releases single fields.'
        });
    }

    // A lock already in the wanted state is not a change.
    const lockNow = lock.filter(f => !state.locked.includes(f));
    const unlockNow = unlock.filter(f => state.locked.includes(f));

    const target = `${book.id}:${id}`;
    if (changed.length === 0 && lockNow.length === 0 && unlockNow.length === 0) {
        return { target, summary: `${state.label} already has those values and locks in Grimmory.`, effects: [], noop: true };
    }

    const effects = [
        ...(Object.keys(changes) as BookField[]).map(f => describeBookChange(f, state.fields[f], changes[f])),
        ...clear.map(f => describeBookChange(f, state.fields[f], undefined)),
        ...(unlockNow.length === 0 ? [] : [`Unlocks ${unlockNow.map(nameOf).join(', ')} first, so the edit can land.`]),
        ...(lockNow.length === 0
            ? []
            : [`Locks ${lockNow.map(nameOf).join(', ')} afterwards, so a later metadata refresh leaves ${lockNow.length === 1 ? 'it' : 'them'} alone.`]),
        ...(changed.length === 0
            ? []
            : ['Grimmory may also write the new metadata into the book file, and move it to match its naming pattern, when its metadata settings say so.'])
    ];
    const parts = [...(changed.length === 0 ? [] : [changed.map(nameOf).join(', ')]), ...(lockNow.length + unlockNow.length === 0 ? [] : ['field locks'])];

    return {
        target,
        summary: `Change the ${parts.join(' and ')} of ${state.label} in Grimmory.`,
        effects,
        // The changes themselves are bound, not the strings that were asked for.
        args: { service: 'grimmory', id, fields: changes, clear, lock: lockNow, unlock: unlockNow }
    };
}

/**
 * Writes the planned edit. Reads the book id from the plan the token was
 * verified against: the `id` as given may still carry its `grimmory:` prefix.
 * Unlocks first so the write can land, locks last so the new values are kept.
 */
async function applyBook(book: ServiceAdapter & BookMetadataCapable, plan: WritePlan): Promise<{ changed: string[] }> {
    const bound = plan.args as { id: string; fields: BookFields; clear: BookField[]; lock: BookField[]; unlock: BookField[] };
    if (bound.unlock.length > 0) await book.setBookFieldLocks(bound.id, bound.unlock, false);
    if (Object.keys(bound.fields).length > 0 || bound.clear.length > 0) await book.writeBookMetadata(bound.id, bound.fields, bound.clear);
    if (bound.lock.length > 0) await book.setBookFieldLocks(bound.id, bound.lock, true);
    return { changed: [...Object.keys(bound.fields), ...bound.clear] };
}

const UpdateBookInput = z.object({
    instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
    id: z.string().min(1).describe("The book's id: `acquisition.id` on a get_library record, as 58 or grimmory:58."),
    title: z.string().min(1).optional().describe('The new title.'),
    authors: z.array(z.string().min(1)).min(1).optional().describe('The authors; replaces the list.'),
    series: z.string().optional().describe('The series name. "" clears it.'),
    series_number: z.number().positive().optional().describe("The book's number in its series."),
    tags: z.array(z.string()).optional().describe('Its categories: free text that need not exist yet, replacing the set. [] clears them.'),
    lock_fields: z
        .array(z.enum(LOCKABLE))
        .min(1)
        .optional()
        .describe('Fields to lock after writing, so a metadata refresh leaves them alone.'),
    unlock_fields: z
        .array(z.enum(LOCKABLE))
        .min(1)
        .optional()
        .describe('Fields to unlock before writing. A locked field is refused unless this call unlocks it.')
});

export function registerUpdateBook(server: McpServer, context: WriteContext, adapters: readonly ServiceAdapter[]): void {
    registerWriteTool(server, context, {
        name: 'update_book',
        title: 'Edit a Grimmory book',
        description:
            "Edits one Grimmory book by hand: title, authors, series, series number, categories (`tags`) and field locks. A locked field is refused unless the same call unlocks it, and Grimmory may rewrite the book file and rename it. Film, series or artist: update_media. From a provider: fix_metadata. Previews first; confirm to apply. Field reference: arr://docs/update_book.",
        inputSchema: UpdateBookInput,
        service: ({ instance }) => resolveTarget(adapters, TARGET, 'grimmory', instance).id,
        operation: 'update_book',
        tier: 'safe',

        async plan({ instance, id, title, authors, series, series_number, tags, lock_fields, unlock_fields }): Promise<WritePlan> {
            const book = resolveTarget(adapters, TARGET, 'grimmory', instance);
            return planBook(book, id, { title, authors, series, series_number, tags, lock_fields, unlock_fields });
        },

        async apply(plan, { instance }) {
            return applyBook(resolveTarget(adapters, TARGET, 'grimmory', instance), plan);
        }
    });
}
