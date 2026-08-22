import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMap, parseDocument, type Document } from 'yaml';
import * as z from 'zod/v4';
import { ConfigSchema, type Config } from './schema.ts';

const FILENAME = 'config.yaml';

/**
 * Write `value` into `doc` at `path`, one key at a time.
 *
 * `setIn` on a map replaces the whole node, and a replaced node takes every
 * comment inside it. Walking down to the leaves instead means the only nodes
 * rewritten are the ones whose values actually changed, so annotations on
 * everything else survive — including the ones nested inside a service block.
 *
 * Keys absent from `value` are deleted, so this removes as well as updates: a
 * service switched off still disappears. Lists are replaced outright; a comment
 * inside a list of instances is not preserved, and pretending otherwise would
 * need positional matching that a reordered list would get wrong.
 */
function mergeInto(doc: Document, path: string[], value: unknown): void {
    // `undefined` is absence, not null. `setIn` would write a null-valued key,
    // and the schema refuses those on the next load — a save that produced an
    // instance which will not start.
    if (value === undefined) {
        doc.deleteIn(path);
        return;
    }

    const existing = doc.getIn(path);
    const isPlainObject = typeof value === 'object' && value !== null && !Array.isArray(value);

    if (!isMap(existing) || !isPlainObject) {
        doc.setIn(path, value);
        return;
    }

    const wanted = value as Record<string, unknown>;
    for (const item of [...existing.items]) {
        const key = String((item.key as { value?: unknown })?.value ?? '');
        if (!(key in wanted)) doc.deleteIn([...path, key]);
    }
    for (const [key, child] of Object.entries(wanted)) mergeInto(doc, [...path, key], child);
}

/** Key order is not data, so a stable ordering is what makes two configs
 *  comparable. */
function stableJson(value: unknown): string {
    return JSON.stringify(value, (_key, node: unknown) =>
        node !== null && typeof node === 'object' && !Array.isArray(node)
            ? Object.fromEntries(Object.entries(node as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
            : node
    );
}

/**
 * Whether the file still says what the page believed.
 *
 * Compared through the schema, not by service name: the name check saw a
 * service added or removed and nothing else, so a hand-edited `api_key` — or
 * anything under `auth` — passed it and was then overwritten. A file that no
 * longer parses has certainly changed.
 */
function driftedFrom(doc: Document, expected: Config): boolean {
    const onDisk = ConfigSchema.safeParse(doc.toJS());
    if (!onDisk.success) return true;
    return stableJson(onDisk.data) !== stableJson(expected);
}

/**
 * Writes config.yaml from the config UI.
 *
 * Four properties, each learned the hard way somewhere in this project:
 *
 * 1. **Comments survive.** A plain `stringify` round trip silently deletes
 *    every comment and reflows the file. People hand-edit this file — the
 *    README told them to for five releases — so their annotations are theirs,
 *    not ours to discard. `parseDocument` keeps them, and `mergeInto` keeps
 *    the ones *inside* the services block, which a wholesale `setIn` ate.
 * 2. **It validates before it writes.** The same schema the loader uses, so a
 *    form post cannot produce a file that will not start the process.
 * 3. **It replaces atomically.** Written to a uniquely-named temp file and
 *    renamed, so a crash mid-write cannot leave a truncated config holding
 *    every API key — which would lock the user out of the UI that could fix
 *    it — and two concurrent saves cannot rename each other's half-written
 *    copy into place.
 * 4. **It refuses to overwrite a change it never saw.** Pass `expected` and a
 *    file edited since that snapshot was taken is a refusal, not a silent
 *    deletion of whatever was added.
 */
/**
 * Serialises saves within the process.
 *
 * Property 4 reads the file, compares, then writes, and every step awaits — so
 * two overlapping saves both read the *old* file, both find no drift, and the
 * second silently overwrote the first. Atomic replacement (property 3) does not
 * help: both writes are individually atomic and the last one still wins.
 */
let writes: Promise<unknown> = Promise.resolve();

export function saveConfig(configDir: string, next: Config, opts: { expected?: Config } = {}): Promise<void> {
    const run = writes.then(
        () => writeConfig(configDir, next, opts),
        () => writeConfig(configDir, next, opts)
    );
    // Swallowed on the queue only — `run` still rejects for the caller.
    writes = run.catch(() => undefined);
    return run;
}

async function writeConfig(configDir: string, next: Config, opts: { expected?: Config }): Promise<void> {
    // Validated first: the caller assembles `next` from form fields, and a
    // typo there must fail before anything touches the file.
    const parsed = ConfigSchema.safeParse(next);
    if (!parsed.success) {
        throw new Error(`that configuration is not valid:\n${z.prettifyError(parsed.error)}`);
    }
    const value = parsed.data;

    const path = join(configDir, FILENAME);
    const doc = parseDocument(await readFile(path, 'utf8'));

    // The caller assembles `next` from the snapshot its page was rendered
    // from. A service hand-added to the file since then is absent from that
    // snapshot, so writing it back deleted the service — under a "Saved.
    // Applied immediately" message. Refusing is the only honest answer: this
    // cannot tell "the user removed it" from "the user never saw it".
    if (opts.expected !== undefined && driftedFrom(doc, opts.expected)) {
        throw new Error(
            'config.yaml changed on disk since this page was loaded, so saving would overwrite that change. ' +
                'Reload the page and make the edit again.'
        );
    }

    // Driven by the schema, not by a list kept here. A list is a thing to
    // forget, and `ui` was forgotten for a release: the Appearance card built
    // the right config, the schema accepted it, and the save reported success
    // over a file that had never been given a theme.
    //
    // Key by key rather than `setIn(['services'], …)`, which is property 1
    // above: the wholesale form replaced each node with plain JS values and
    // took every comment inside it with them. `mergeInto` still removes what is
    // gone — a service switched off, a field cleared — and leaves the nodes
    // that remain, and their comments, in place.
    //
    // Top-level keys the schema has never heard of are untouched, since nothing
    // iterates them. They do nothing either way; the loader strips them.
    const blocks = value as Record<string, unknown>;
    for (const key of Object.keys(ConfigSchema.shape)) mergeInto(doc, [key], blocks[key]);

    await writeConfigAtomic(path, doc.toString());
}

/**
 * Replaces `path` atomically, 0o600. Property 3 above, reusable — the loader's
 * bearer-token backfill needs the same guarantee.
 *
 * A unique temp name per write: a fixed `config.yaml.tmp` meant two overlapping
 * writes shared one file and both renamed it into place, so one could rename a
 * half-written copy of the other. 0o600 on the temp file too — it holds the
 * same secrets for the moment it exists, and a default-umask temp file is a
 * readable one.
 */
export async function writeConfigAtomic(path: string, text: string): Promise<void> {
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, path);
}
