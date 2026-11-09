/**
 * The cost of building one McpServer, measured.
 *
 * Over HTTP the factory in `src/app.ts` runs once per request, so this is the
 * overhead every MCP call pays before its tool runs. Run it again if the tool
 * surface grows enough to make that number worth re-checking.
 *
 *   node --experimental-strip-types scripts/measure-mcp-factory.ts
 *
 * Registration of tools, prompts and resources is unconditional, so one
 * service is representative. Nothing is read from or written to disk.
 */
import { mcpServerFactory } from '../src/app.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { Runtime } from '../src/core/runtime.ts';
import { WebhookEvents } from '../src/core/webhookEvents.ts';
import { stdioCeiling } from '../src/stdio.ts';

const WARMUP = 100;
const RUNS = 1000;

const ms = (n: number): string => n.toFixed(2);

async function measure(label: string, hideUnusable: boolean): Promise<void> {
    const config = ConfigSchema.parse({
        auth: {},
        ...(hideUnusable ? { tools: { hide_unusable: true } } : {}),
        services: { radarr: { url: 'http://192.0.2.10:7878', api_key: 'k' } }
    });
    const runtime = Runtime.fromConfig(config, WriteAudit.ephemeral());
    const factory = mcpServerFactory(runtime, WebhookEvents.ephemeral(), stdioCeiling);

    for (let i = 0; i < WARMUP; i++) await factory({ era: 'modern' });

    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
        const start = performance.now();
        await factory({ era: 'modern' });
        times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const at = (p: number): number => times[Math.min(times.length - 1, Math.floor(times.length * p))] ?? 0;
    console.log(
        `${label.padEnd(24)} median ${ms(at(0.5))} ms  p95 ${ms(at(0.95))} ms  max ${ms(times[times.length - 1] ?? 0)} ms`
    );
}

console.log(`node ${process.version}, ${RUNS} calls after ${WARMUP} warm-up`);
await measure('default', false);
await measure('tools.hide_unusable', true);
