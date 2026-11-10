import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { mcpServerFactory, type Ceiling } from './app.ts';
import { configPath } from './config/load.ts';
import type { WriteAudit } from './core/audit.ts';
import { logger } from './core/logger.ts';
import { Runtime } from './core/runtime.ts';
import type { Sessions } from './core/session.ts';
import type { WebhookEvents } from './core/webhookEvents.ts';
import { startRefresh } from './metadata/refresh.ts';
import type { Transport } from '@modelcontextprotocol/server';

/** Who a stdio connection is in the audit trail, though it can never write. */
export const STDIO_CALLER = 'stdio';

/**
 * Read-only, always, and not configurable.
 *
 * A stdio connection presents no credential: whoever can start the process is
 * the caller. Over HTTP a token's tier says what that caller may change, and
 * there is nothing here to hang a tier on — so the answer is the one that
 * needs no credential to be safe. Writes stay on `/mcp`, behind a token.
 */
export const stdioCeiling = (): Ceiling => ({
    tiers: new Set(),
    refusal: () => ({
        reason: 'a stdio connection is read-only',
        remedy: 'Writes go through the HTTP endpoint at /mcp, with an MCP token of the write or destructive tier from the config page.'
    }),
    caller: STDIO_CALLER
});

export type StdioDeps = {
    configDir: string;
    audit: WriteAudit;
    events: WebhookEvents;
    sessions: Sessions;
    /** A transport to serve instead of the process's own stdin and stdout. For tests. */
    transport?: Transport;
};

/**
 * MCP over stdin and stdout, for a client that launches arr-mcp as a child
 * process instead of reaching it over the network. The same tools, prompts and
 * resources as `/mcp`, from the same factory, capped to reads.
 *
 * No config UI and no HTTP listener: configure the services first, in the UI of
 * an HTTP instance or in config.yaml, then point this at the same directory.
 * A missing config.yaml is seeded as on any first start, which leaves a server
 * with no services that still lists every tool — enough for a client, or a
 * registry, to see what it offers.
 */
export async function serveOverStdio(deps: StdioDeps): Promise<{ close(): Promise<void> }> {
    const { configDir, audit, events, sessions, transport } = deps;
    const runtime = await Runtime.start(configDir, audit, { refresh: dataset => startRefresh(dataset), sessions });

    logger.info({ adapters: runtime.current.adapters.map(a => a.id) }, 'arr-mcp serving MCP over stdio, read-only');
    if (runtime.current.adapters.length === 0) {
        logger.warn({ config: configPath(configDir) }, 'no services configured — every tool will report that');
    }

    let handle: StdioServerHandle;
    try {
        handle = serveStdio(mcpServerFactory(runtime, events, stdioCeiling), {
            ...(transport === undefined ? {} : { transport }),
            onerror: err => logger.error({ err }, 'stdio connection error')
        });
    } catch (err) {
        await runtime.close();
        throw err;
    }
    return {
        close: async () => {
            try {
                await handle.close();
            } finally {
                await runtime.close();
            }
        }
    };
}
