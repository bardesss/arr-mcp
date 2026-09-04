import { instanceId } from './instances.ts';
import {
    ConfigSchema,
    MULTI_INSTANCE,
    type AnyServiceConfig,
    type Config,
    type Instanced,
    type ServiceId
} from './schema.ts';

/**
 * Adding, editing and removing one instance, as config algebra.
 *
 * Kept out of the page so it can be tested without a browser or a session, and
 * because these are the operations that must not go wrong: every one of them
 * ends by parsing the result through `ConfigSchema`, so an edit that would
 * produce an invalid config fails in the handler with a message rather than
 * reaching disk.
 */

type Entry = Instanced<AnyServiceConfig>;

/** What a card's form can set. Blank credentials mean *unchanged*, which is why
 *  they are optional here rather than defaulted to empty. */
export type InstanceFields = {
    url?: string;
    api_key?: string;
    username?: string;
    password?: string;
    default_user?: string;
    allow_other_users?: boolean;
    timeout_ms?: number;
    safe_write?: boolean;
    destructive?: boolean;
};

export class ConfigEditError extends Error {}

const entriesOf = (services: Record<string, unknown>, type: ServiceId): Entry[] => {
    const value = services[type];
    if (value === undefined) return [];
    return Array.isArray(value) ? [...(value as Entry[])] : [value as Entry];
};

/**
 * One unnamed entry is written as a bare block; anything else is a list.
 *
 * A single *named* entry stays a list on purpose. Collapsing it back to
 * `services.radarr` would rename `radarr/hd` to `radarr` — a second silent
 * rename, undoing the one the user was explicitly asked to approve when the
 * name was introduced.
 */
function writeBack(services: Record<string, unknown>, type: ServiceId, entries: Entry[]): void {
    if (entries.length === 0) {
        delete services[type];
        return;
    }
    const only = entries[0];
    if (entries.length === 1 && only !== undefined && only.name === undefined) {
        services[type] = only;
        return;
    }
    services[type] = entries;
}

/** Deep enough: every value below `services` is a plain object or array of them. */
const cloneServices = (config: Config): Record<string, unknown> =>
    JSON.parse(JSON.stringify(config.services)) as Record<string, unknown>;

/**
 * Re-parses the whole config with `services` swapped in.
 *
 * Spread rather than assembled key by key. Listing the keys it meant to keep is
 * how this silently switched the IMDb dataset off: `metadata` was not in the
 * list, `saveConfig` deletes an absent `metadata` block, and so editing a
 * timeout on any card wiped a setting that card has nothing to do with. The
 * same rule the `build*Config` builders follow in `src/web/routes.ts` — carry
 * forward every field you do not own — and the spread keeps it true for keys
 * added later.
 */
const validate = (config: Config, services: Record<string, unknown>): Config => {
    const result = ConfigSchema.safeParse({ ...config, services });
    if (!result.success) {
        throw new ConfigEditError(result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    return result.data;
};

const MULTI_USER: ReadonlySet<ServiceId> = new Set<ServiceId>(['jellyfin', 'plex', 'seerr']);
const NO_API_KEY: ReadonlySet<ServiceId> = new Set<ServiceId>(['transmission', 'qbittorrent']);

/**
 * Applies form fields to an entry, leaving a blank credential as it was.
 *
 * Gated by service type rather than by which fields the form happened to send.
 * Every card posts the same field names — an unchecked checkbox is simply
 * absent, so the form cannot distinguish "off" from "this service has no such
 * field", and the service schemas are **strict**: one stray
 * `allow_other_users` on a Radarr makes the whole config invalid.
 */
function applyFields(type: ServiceId, base: Entry, fields: InstanceFields): Entry {
    const next = { ...base } as Record<string, unknown>;

    if (fields.url !== undefined && fields.url !== '') next.url = fields.url;
    if (fields.timeout_ms !== undefined) next.timeout_ms = fields.timeout_ms;

    // Blank means unchanged, which is what keeps a saved page or a screenshot
    // from being able to carry a secret back in.
    if (NO_API_KEY.has(type)) {
        if (fields.password !== undefined && fields.password !== '') next.password = fields.password;
        // Not a credential, so blank means "cleared" rather than "unchanged".
        if (fields.username !== undefined) {
            if (fields.username === '') delete next.username;
            else next.username = fields.username;
        }
    } else if (fields.api_key !== undefined && fields.api_key !== '') {
        next.api_key = fields.api_key;
    }

    if (MULTI_USER.has(type)) {
        if (fields.default_user !== undefined) {
            if (fields.default_user === '') delete next.default_user;
            else next.default_user = fields.default_user;
        }
        if (fields.allow_other_users !== undefined) next.allow_other_users = fields.allow_other_users;
    }

    if (fields.safe_write !== undefined || fields.destructive !== undefined) {
        next.permissions = {
            safe_write: fields.safe_write ?? false,
            destructive: fields.destructive ?? false
        };
    }

    return next as Entry;
}

export function addInstance(
    config: Config,
    opts: { type: ServiceId; name?: string | undefined; renameExistingTo?: string | undefined; fields: InstanceFields }
): Config {
    const services = cloneServices(config);
    const entries = entriesOf(services, opts.type);
    const multi = MULTI_INSTANCE.includes(opts.type);

    if (entries.length > 0 && !multi) {
        throw new ConfigEditError(
            `${opts.type} is already configured, and only ${MULTI_INSTANCE.join(', ')} can have more than one instance.`
        );
    }

    if (entries.length > 0 && opts.name === undefined) {
        throw new ConfigEditError(`Name the new ${opts.type} instance — several cannot share one name.`);
    }

    // The rename this can force, made explicit. The existing instance's id is
    // its permission key and its audit column, so it is never renamed without
    // the caller having said what to rename it to.
    const existing = entries[0];
    if (entries.length === 1 && existing !== undefined && existing.name === undefined) {
        if (opts.renameExistingTo === undefined || opts.renameExistingTo === '') {
            throw new ConfigEditError(
                `Adding a second ${opts.type} means naming the one you already have — it is currently "${opts.type}".`
            );
        }
        entries[0] = { ...existing, name: opts.renameExistingTo };
    }

    if (opts.name !== undefined && entries.some(e => e.name?.toLowerCase() === opts.name?.toLowerCase())) {
        throw new ConfigEditError(`${opts.type} already has an instance named "${opts.name}".`);
    }

    const created = applyFields(
        opts.type,
        { permissions: { safe_write: false, destructive: false } } as unknown as Entry,
        opts.fields
    );
    entries.push(opts.name === undefined ? created : { ...created, name: opts.name });

    writeBack(services, opts.type, entries);
    return validate(config, services);
}

export function updateInstance(config: Config, id: string, fields: InstanceFields): Config {
    const services = cloneServices(config);
    const { type, entries, index } = locate(services, id);

    entries[index] = applyFields(type, entries[index] as Entry, fields);
    writeBack(services, type, entries);
    return validate(config, services);
}

export function removeInstance(config: Config, id: string): Config {
    const services = cloneServices(config);
    const { type, entries, index } = locate(services, id);

    entries.splice(index, 1);
    writeBack(services, type, entries);
    return validate(config, services);
}

function locate(
    services: Record<string, unknown>,
    id: string
): { type: ServiceId; entries: Entry[]; index: number } {
    const slash = id.indexOf('/');
    const type = (slash === -1 ? id : id.slice(0, slash)) as ServiceId;
    const name = slash === -1 ? undefined : id.slice(slash + 1);

    const entries = entriesOf(services, type);
    const index = entries.findIndex(e => instanceId(type, e.name) === instanceId(type, name));

    if (index === -1) throw new ConfigEditError(`${id} is not configured.`);
    return { type, entries, index };
}
