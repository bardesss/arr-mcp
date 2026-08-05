import { serve } from '@hono/node-server';
import { buildApp } from './app.ts';
import { loadConfig } from './config/load.ts';
import { logger } from './core/logger.ts';
import { buildAdapters } from './services/registry.ts';

const CONFIG_DIR = process.env.ARR_MCP_CONFIG_DIR ?? '/config';
const PORT = Number(process.env.ARR_MCP_PORT ?? 6060);

const { config, created } = await loadConfig(CONFIG_DIR);

if (created) {
    // The token is the only way in and there is no UI until Phase 5, so it has
    // to be discoverable from `docker logs` on first start.
    logger.info({ token: config.auth.bearer_token }, 'first run — use this bearer token for /mcp');
}

const adapters = buildAdapters(config);

if (adapters.length === 0) {
    logger.warn(
        { config: `${CONFIG_DIR}/config.yaml` },
        'no services configured — stack_health will return an empty result until you add one'
    );
}

serve({ fetch: buildApp({ config, adapters }).fetch, port: PORT, hostname: '0.0.0.0' }, info => {
    logger.info({ port: info.port, adapters: adapters.map(a => a.id) }, 'arr-mcp listening');
});
