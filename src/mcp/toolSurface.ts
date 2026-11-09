import type { McpServer } from '@modelcontextprotocol/server';
import { SERVICES_KEY, type ServiceId } from '../config/schema.ts';

/**
 * Shapes what `tools/list` sends, at registration time (#518).
 *
 * Every byte of every tool's name, description and schemas sits in the
 * client's context on every session, so this trims what tells a model
 * nothing and what does not apply to this stack:
 *
 * - `$schema`, the same dialect URL on every schema;
 * - the ±2^53 bounds zod writes on a bare `.int()`, which read like real limits;
 * - on output schemas, field descriptions: `arr://docs/<tool>` and the results
 *   carry those, and Claude Code does not show output schemas to the model;
 * - on a `service` field built with `serviceOf`, every service the tool does
 *   not take and, when anything is configured, every service that is not;
 * - in a description, text wrapped in `[[lidarr|whisparr: …]]` when none of
 *   the services it names is configured;
 * - with `tools.hide_unusable`, the tools in `TOOL_SERVICES` none of whose
 *   services is configured.
 *
 * Only what a client reads changes. Validation still accepts every service id,
 * so a wrong one gets the tool's own refusal with its remedy, and the zod
 * objects the tools hold are untouched.
 *
 * With nothing configured (a fresh install, most tests) every service counts
 * as present: there is no stack to tailor to yet.
 */

export type SurfaceOptions = {
    /** The service types this config has at least one instance of. */
    configured: ReadonlySet<ServiceId>;
    /** `tools.hide_unusable`. */
    hideUnusable: boolean;
};

/**
 * Tools that do nothing without one of these services. Hidden only with
 * `tools.hide_unusable`. A tool that is not listed always shows: the merged
 * reads, the lookups and `diagnose` answer something on any stack.
 */
export const TOOL_SERVICES: Readonly<Record<string, readonly ServiceId[]>> = {
    get_subtitles: ['bazarr'],
    trigger_subtitle_search: ['bazarr'],
    get_indexers: ['prowlarr'],
    manage_indexer: ['prowlarr'],
    sync_database: ['profilarr'],
    get_requests: ['seerr'],
    respond_to_request: ['seerr'],
    delete_request: ['seerr'],
    request_media: ['seerr'],
    pause_downloads: ['sabnzbd', 'nzbget', 'transmission', 'qbittorrent'],
    retry_download: ['sabnzbd', 'nzbget', 'shelfmark'],
    get_playback: ['jellyfin', 'plex'],
    set_watched: ['jellyfin', 'grimmory'],
    get_metadata_issues: ['jellyfin', 'plex', 'grimmory'],
    fix_metadata: ['jellyfin', 'plex', 'grimmory', 'lidarr'],
    get_profile_issues: ['radarr', 'sonarr', 'whisparr'],
    get_wanted: ['radarr', 'sonarr', 'lidarr'],
    get_calendar: ['radarr', 'sonarr', 'whisparr', 'lidarr'],
    get_blocklist: ['radarr', 'sonarr', 'whisparr', 'lidarr'],
    remove_blocklist_item: ['radarr', 'sonarr', 'whisparr', 'lidarr'],
    clean_queue: ['radarr', 'sonarr', 'whisparr', 'lidarr'],
    trigger_search: ['radarr', 'sonarr', 'whisparr', 'lidarr'],
    add_media: ['radarr', 'sonarr', 'whisparr', 'lidarr'],
    set_monitoring: ['sonarr', 'whisparr', 'lidarr'],
    delete_episode_files: ['sonarr', 'whisparr'],
    update_media: ['radarr', 'sonarr', 'lidarr', 'grimmory'],
    delete_media: ['radarr', 'sonarr', 'whisparr', 'lidarr', 'grimmory'],
    get_releases: ['radarr', 'sonarr', 'whisparr', 'lidarr', 'shelfmark'],
    grab_release: ['radarr', 'sonarr', 'whisparr', 'lidarr', 'shelfmark', 'transmission', 'qbittorrent']
};

const SAFE_INT = Number.MAX_SAFE_INTEGER;

/** `[[lidarr|whisparr: text]]`: the text applies only with one of those services. */
const SCOPED = /\[\[([a-z|]+): ((?:[^\]]|\](?!\]))*)\]\]/g;

const present = (services: readonly string[], opts: SurfaceOptions): boolean =>
    opts.configured.size === 0 || services.some(s => opts.configured.has(s as ServiceId));

/** Whether a tool is listed to the client: false only when `hide_unusable` removed it. */
export function toolUsable(name: string, opts: SurfaceOptions): boolean {
    const needs = TOOL_SERVICES[name];
    return !(opts.hideUnusable && opts.configured.size > 0 && needs !== undefined && !present(needs, opts));
}

/** Resolves the `[[…]]` scopes in one piece of text. */
export function scopeText(text: string, opts: SurfaceOptions): string {
    return text
        .replace(SCOPED, (_, list: string, body: string) => (present(list.split('|'), opts) ? body : ''))
        .replace(/ {2,}/g, ' ')
        .replace(/ +([.,;:])/g, '$1')
        .trim();
}

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keywords whose value is one schema. */
const ONE = ['items', 'additionalProperties', 'not', 'contains', 'propertyNames', 'unevaluatedProperties', 'if', 'then', 'else'];
/** Keywords whose value is a list of schemas. */
const LIST = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];
/** Keywords whose value maps names to schemas. */
const MAP = ['properties', 'patternProperties', '$defs', 'definitions'];

export function leanJsonSchema(schema: unknown, io: 'input' | 'output', opts: SurfaceOptions, root = true): unknown {
    if (!isNode(schema)) return schema;
    const out: Node = { ...schema };

    if (root) delete out['$schema'];
    if (io === 'output' && !root) delete out['description'];
    if (typeof out['description'] === 'string') {
        const text = scopeText(out['description'], opts);
        if (text === '') delete out['description'];
        else out['description'] = text;
    }
    if (out['maximum'] === SAFE_INT) delete out['maximum'];
    if (out['minimum'] === -SAFE_INT) delete out['minimum'];

    const services = out[SERVICES_KEY];
    if (Array.isArray(services)) {
        if (Array.isArray(out['enum'])) {
            const taken = (out['enum'] as unknown[]).filter(v => services.includes(v));
            const here = taken.filter(v => opts.configured.has(v as ServiceId));
            // A tool none of whose services is configured still names them:
            // an empty enum would make every call unwritable.
            out['enum'] = opts.configured.size === 0 || here.length === 0 ? taken : here;
        }
        delete out[SERVICES_KEY];
    }

    for (const key of ONE) if (isNode(out[key])) out[key] = leanJsonSchema(out[key], io, opts, false);
    for (const key of LIST) {
        if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).map(s => leanJsonSchema(s, io, opts, false));
    }
    for (const key of MAP) {
        const map = out[key];
        if (isNode(map)) out[key] = Object.fromEntries(Object.entries(map).map(([k, s]) => [k, leanJsonSchema(s, io, opts, false)]));
    }
    return out;
}

type JsonSchemaHook = Record<'input' | 'output', (o: unknown) => unknown>;
type Standard = { jsonSchema?: JsonSchemaHook } & Record<string, unknown>;

/**
 * A view of `schema` whose JSON form is trimmed. Built per registration on top
 * of the shared schema object rather than by changing it: the server is built
 * per request from the current config, and many tools share one schema.
 * Everything but the JSON hook is inherited, so parsing and validation are the
 * schema's own.
 */
export function leanSchema<T>(schema: T, opts: SurfaceOptions): T {
    if (!isNode(schema)) return schema;
    const std = schema['~standard'] as Standard | undefined;
    const hook = std?.jsonSchema;
    if (std === undefined || hook === undefined) return schema;
    const view = Object.create(schema) as Node;
    Object.defineProperty(view, '~standard', {
        enumerable: false,
        value: {
            ...std,
            jsonSchema: {
                input: (o: unknown) => leanJsonSchema(hook.input(o), 'input', opts),
                output: (o: unknown) => leanJsonSchema(hook.output(o), 'output', opts)
            }
        }
    });
    return view as T;
}

/** Applies all of the above to every tool this server registers from here on. */
export function shapeToolSurface(server: McpServer, opts: SurfaceOptions): McpServer {
    const register = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: unknown) => unknown;
    (server as unknown as { registerTool: typeof register }).registerTool = (name, config, cb) => {
        if (!toolUsable(name, opts)) return undefined;
        const description = config['description'];
        return register(
            name,
            {
                ...config,
                ...(typeof description === 'string' ? { description: scopeText(description, opts) } : {}),
                ...(config['inputSchema'] === undefined ? {} : { inputSchema: leanSchema(config['inputSchema'], opts) }),
                ...(config['outputSchema'] === undefined ? {} : { outputSchema: leanSchema(config['outputSchema'], opts) })
            },
            cb
        );
    };
    return server;
}
