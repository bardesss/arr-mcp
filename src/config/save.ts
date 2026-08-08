import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import * as z from 'zod/v4';
import { ConfigSchema, type Config } from './schema.ts';

const FILENAME = 'config.yaml';

/**
 * Writes config.yaml from the config UI.
 *
 * Three properties, each learned the hard way somewhere in this project:
 *
 * 1. **Comments survive.** A plain `stringify` round trip silently deletes
 *    every comment and reflows the file. People hand-edit this file — the
 *    README told them to for five releases — so their annotations are theirs,
 *    not ours to discard. `parseDocument` keeps them.
 * 2. **It validates before it writes.** The same schema the loader uses, so a
 *    form post cannot produce a file that will not start the process.
 * 3. **It replaces atomically.** Written to a temp file and renamed, so a
 *    crash mid-write cannot leave a truncated config holding every API key —
 *    which would lock the user out of the UI that could fix it.
 */
export async function saveConfig(configDir: string, next: Config): Promise<void> {
    // Validated first: the caller assembles `next` from form fields, and a
    // typo there must fail before anything touches the file.
    const parsed = ConfigSchema.safeParse(next);
    if (!parsed.success) {
        throw new Error(`that configuration is not valid:\n${z.prettifyError(parsed.error)}`);
    }
    const value = parsed.data;

    const path = join(configDir, FILENAME);
    const doc = parseDocument(await readFile(path, 'utf8'));

    doc.setIn(['auth', 'bearer_token'], value.auth.bearer_token);
    doc.setIn(['auth', 'username'], value.auth.username);
    // Deleted rather than set when absent: `setIn` with `undefined` writes a
    // null-valued key, and a config carrying `password_hash: null` reads back
    // as claimed-with-an-empty-hash — an instance nobody can sign in to, and
    // one the setup page will not rescue because it no longer looks unclaimed.
    if (value.auth.password_hash === undefined) doc.deleteIn(['auth', 'password_hash']);
    else doc.setIn(['auth', 'password_hash'], value.auth.password_hash);
    doc.setIn(['auth', 'allowed_hosts'], value.auth.allowed_hosts);

    // Services are replaced wholesale rather than merged key by key: a service
    // the user switched off has to disappear, and a field they cleared has to
    // clear. Merging would leave orphans behind that the strict schema would
    // then reject on the next start.
    doc.setIn(['services'], value.services);

    // Deleted when absent rather than written as null, for the same reason as
    // `password_hash` above: the schema is strict, and `metadata: null` would
    // fail to parse on the next start — turning a save into an instance that
    // will not boot. Until 0.8 this key was preserved only because nothing
    // here touched it, which held right up until the config page could switch
    // the dataset on.
    if (value.metadata === undefined) doc.deleteIn(['metadata']);
    else doc.setIn(['metadata'], value.metadata);

    const tmp = `${path}.tmp`;
    // 0o600 on the temp file too — it holds the same secrets for the moment it
    // exists, and a default-umask temp file is a readable one.
    await writeFile(tmp, doc.toString(), { mode: 0o600 });
    await rename(tmp, path);
}
