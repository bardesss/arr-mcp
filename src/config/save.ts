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

/**
 * The services on disk, by name, for the drift check below. Read from the
 * document rather than through the schema: a file that has since become
 * invalid still has to be detectable as *changed*.
 */
function serviceNames(doc: Document): string[] {
    const services = doc.getIn(['services']);
    if (!isMap(services)) return [];
    return services.items.map(item => String((item.key as { value?: unknown })?.value ?? '')).sort();
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
export async function saveConfig(configDir: string, next: Config, opts: { expected?: Config } = {}): Promise<void> {
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
    if (opts.expected !== undefined) {
        const onDisk = serviceNames(doc).join(',');
        const believed = Object.keys(opts.expected.services).sort().join(',');
        if (onDisk !== believed) {
            throw new Error(
                'config.yaml changed on disk since this page was loaded, so saving would overwrite that change. ' +
                    'Reload the page and make the edit again.'
            );
        }
    }

    doc.setIn(['auth', 'bearer_token'], value.auth.bearer_token);
    doc.setIn(['auth', 'username'], value.auth.username);
    // Deleted rather than set when absent: `setIn` with `undefined` writes a
    // null-valued key, and a config carrying `password_hash: null` reads back
    // as claimed-with-an-empty-hash — an instance nobody can sign in to, and
    // one the setup page will not rescue because it no longer looks unclaimed.
    if (value.auth.password_hash === undefined) doc.deleteIn(['auth', 'password_hash']);
    else doc.setIn(['auth', 'password_hash'], value.auth.password_hash);
    doc.setIn(['auth', 'allowed_hosts'], value.auth.allowed_hosts);

    // Key by key, not `setIn(['services'], …)`.
    //
    // The wholesale form replaced the node with plain JS values, and every
    // comment inside it went with them — which is property 1 above, broken in
    // exactly the block people annotate most. `mergeInto` still removes what is
    // gone (a service switched off, a field cleared), so the orphans the strict
    // schema would reject never survive; it just leaves the nodes that remain,
    // and their comments, in place.
    mergeInto(doc, ['services'], value.services);

    // Deleted when absent rather than written as null, for the same reason as
    // `password_hash` above: the schema is strict, and `metadata: null` would
    // fail to parse on the next start — turning a save into an instance that
    // will not boot. Until 0.8 this key was preserved only because nothing
    // here touched it, which held right up until the config page could switch
    // the dataset on.
    if (value.metadata === undefined) doc.deleteIn(['metadata']);
    else mergeInto(doc, ['metadata'], value.metadata);

    // A unique temp name per save. A fixed `config.yaml.tmp` meant two
    // overlapping saves wrote into the same file and both renamed it into
    // place, so one could rename a half-written copy of the other — defeating
    // the atomicity property 3 promises.
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    // 0o600 on the temp file too — it holds the same secrets for the moment it
    // exists, and a default-umask temp file is a readable one.
    await writeFile(tmp, doc.toString(), { mode: 0o600 });
    await rename(tmp, path);
}
