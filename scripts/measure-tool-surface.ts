/**
 * What `tools/list` costs a client, per stack.
 *
 * Every connected client pays this up front, on every session, before it has
 * asked for anything. Run it before and after a change to a tool schema or
 * description to see what the change did to that bill.
 *
 *   node scripts/measure-tool-surface.ts
 *
 * In-process through Hono, no network, nothing written to disk. Bytes are the
 * JSON length of the tool definitions; tokens are bytes / 4, a rough figure.
 */
import { listTools, svc } from './lib/listTools.ts';

const small = {
    radarr: svc(7878),
    sonarr: svc(8989),
    sabnzbd: svc(8080),
    jellyfin: svc(8096, { default_user: 'u' })
};

const STACKS: Record<string, Record<string, unknown>> = {
    empty: {},
    small,
    arr: {
        ...small,
        lidarr: svc(8686),
        prowlarr: svc(9696),
        bazarr: svc(6767),
        seerr: svc(5055, { default_user: 'u' })
    }
};

const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

for (const [stack, services] of Object.entries(STACKS)) {
    const tools = await listTools(services);
    const total = size(tools);
    console.log(`${stack}: ${tools.length} tools, ${total} bytes, ~${Math.round(total / 4)} tokens`);
    const rows = tools
        .map((t) => ({ name: t.name, total: size(t), input: size(t.inputSchema ?? {}) }))
        .sort((a, b) => b.total - a.total);
    for (const r of rows) console.log(`  ${r.name} ${r.total} (input ${r.input})`);
}
