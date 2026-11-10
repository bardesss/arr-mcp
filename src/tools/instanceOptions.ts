import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServiceId } from '../config/schema.ts';
import { serviceOf } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { READ_ONLY, listText, toolInput } from '../core/shape.ts';
import { hasMediaAdd, type ServiceAdapter } from '../services/types.ts';
import { INSTANCE_PARAM_DESCRIPTION } from './resolveInstance.ts';

/**
 * The values `add_media` and `update_media` refuse to guess at. Paths and tag
 * labels are the **fenced** display forms: these are for reading, and the raw
 * path is only ever posted back inside the write tools, which resolve it
 * themselves.
 */
export type InstanceOptions = {
    instance: string;
    qualityProfiles: { id: number; name: string }[];
    /**
     * `unmappedFolders` names folders under this root that the instance
     * associates with no item. Reported here because the root folder read
     * already returns it and dropping it hid the only API-visible trace of a
     * mapping the service has lost. It is a fact, not a fault: a hand-dropped
     * folder and a delete that kept its files look identical from here.
     */
    rootFolders: { path: string; freeSpaceBytes?: number; unmappedFolders?: string[] }[];
    tags: string[];
};

type AdapterFilter = { service?: ServiceId | undefined; instance?: string | undefined };

/**
 * The adapters one `service`/`instance` pair names. An `instance` is an id as
 * `permissions` lists it (`radarr`, `radarr/4k`); one that matches nothing is
 * refused with the ids that exist, so the next call is not a second guess.
 */
export function selectAdapters<T extends ServiceAdapter>(adapters: readonly T[], filter: AdapterFilter): T[] {
    const { service, instance } = filter;
    if (instance !== undefined && instance !== '') {
        const wanted = instance.toLowerCase();
        if (!adapters.some(a => a.id.toLowerCase() === wanted)) {
            throw new ServiceError('NotFound', 'arr-mcp', `no instance "${instance}"`, {
                remedy: `Configured: ${adapters.map(a => a.id).join(', ') || 'none'}.`
            });
        }
        return adapters.filter(a => a.id.toLowerCase() === wanted && (service === undefined || a.type === service));
    }
    return service === undefined ? [...adapters] : adapters.filter(a => a.type === service);
}

/**
 * Settled per instance, never awaited bare: an instance whose profile list is
 * down is marked degraded and left out, and the others still answer.
 */
export async function buildInstanceOptions(
    adapters: readonly ServiceAdapter[],
    filter: AdapterFilter,
    markDegraded: (id: string) => void
): Promise<InstanceOptions[]> {
    const rows = await Promise.all(
        selectAdapters(adapters.filter(hasMediaAdd), filter).map(async adapter => {
            try {
                const [profiles, folders, tags] = await Promise.all([
                    adapter.listQualityProfiles(),
                    adapter.listRootFolders(),
                    adapter.listTags()
                ]);
                return [
                    {
                        instance: adapter.id,
                        qualityProfiles: profiles.map(p => ({ id: p.id, name: p.display })),
                        rootFolders: folders.map(f => ({
                            path: f.display,
                            ...(f.freeSpaceBytes === undefined ? {} : { freeSpaceBytes: f.freeSpaceBytes }),
                            ...(f.unmappedFolders === undefined ? {} : { unmappedFolders: f.unmappedFolders })
                        })),
                        tags: tags.map(t => t.display)
                    }
                ];
            } catch (err) {
                logger.warn({ service: adapter.id, err }, 'add options unavailable; omitting');
                markDegraded(adapter.id);
                return [];
            }
        })
    );
    return rows.flat().sort((a, b) => a.instance.localeCompare(b.instance));
}

const GetInstanceOptionsInput = toolInput({
    service: serviceOf(['radarr', 'sonarr', 'whisparr', 'lidarr']).optional(),
    instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION)
});

const GetInstanceOptionsOutput = z.looseObject({
    items: z.array(z.unknown()),
    degraded: z.array(z.string())
});

const lineOf = (o: InstanceOptions): string =>
    `${o.instance} — profiles: ${o.qualityProfiles.map(p => `${p.name} (${p.id})`).join(', ') || 'none'}; root folders: ${o.rootFolders.map(f => f.path).join(', ') || 'none'}; tags: ${o.tags.join(', ') || 'none'}`;

export function registerGetInstanceOptions(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'get_instance_options',
        {
            title: 'Instance options',
            annotations: READ_ONLY,
            description:
                'Quality profiles, root folders and tags of each Radarr, Sonarr, Whisparr and Lidarr instance: the values add_media and update_media need, so read them here, never guess. For health use stack_health. Returns one row per instance (`qualityProfiles` with ids, `rootFolders` with free space and `unmappedFolders`, `tags`); an instance whose read fails is in `degraded`. `instance` is an id from stack_health `permissions`; an unknown one is refused with the valid ids.',
            inputSchema: GetInstanceOptionsInput,
            outputSchema: GetInstanceOptionsOutput
        },
        async ({ service, instance }) => {
            const degraded: string[] = [];
            const items = await buildInstanceOptions(adapters, { service, instance }, id => {
                if (!degraded.includes(id)) degraded.push(id);
            });
            const summary = `${items.length} instance(s)${degraded.length === 0 ? '' : `; unavailable: ${degraded.join(', ')}`}.`;
            return {
                content: [{ type: 'text', text: listText(summary, items.map(lineOf), line => line) }],
                structuredContent: { items, degraded }
            };
        }
    );
}
