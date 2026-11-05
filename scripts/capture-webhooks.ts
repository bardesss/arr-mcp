/**
 * Saves real *arr webhook payloads into test/fixtures/webhooks/, for the receiver
 * to be written against. Run by the maintainer, never in CI.
 *
 *   npm run capture:webhooks                # port 9099, reads ./config/config.yaml
 *   npm run capture:webhooks -- 9100        # another port
 *   ARR_MCP_CAPTURE_CONFIG=/path npm run capture:webhooks
 *
 * It answers on every network interface, because an *arr in Docker or on another
 * machine has to reach it, so each run makes its own password. The config is read
 * only for what to scrub: its credentials and hosts are never printed or sent.
 *
 * Titles stay in the files. Read every file before committing it.
 */
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.ts';
import { hostsOf, secretsOf } from './lib/redact.ts';
import { CAPTURE_SERVICES, startCaptureServer } from './lib/webhookCapture.ts';

const portArg = process.argv[2] ?? '9099';
const port = Number(portArg);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Not a port: ${portArg}`);
    process.exit(1);
}

// `persist: false`: capturing must never write to the file holding credentials.
const { config } = await loadConfig(process.env.ARR_MCP_CAPTURE_CONFIG ?? './config', { persist: false });
const hosts = hostsOf(config);
if (hosts.length === 0) {
    console.error('No services configured, so nothing tells this script what to scrub. Set ARR_MCP_CAPTURE_CONFIG.');
    process.exit(1);
}

const username = 'capture';
const password = randomBytes(18).toString('base64url');
const outDir = join(import.meta.dirname, '..', 'test', 'fixtures', 'webhooks');

await startCaptureServer({
    port,
    host: '0.0.0.0',
    outDir,
    username,
    password,
    secrets: secretsOf(config),
    hosts,
    log: line => console.log(line)
});

const addresses = Object.values(networkInterfaces())
    .flat()
    .filter(address => address !== undefined && address.family === 'IPv4' && !address.internal)
    .map(address => address?.address);

console.log(`Listening on port ${port}. Saving to ${outDir}`);
console.log('');
console.log('In each *arr: Settings > Connect > + > Webhook, method POST, with this username and password.');
console.log(`  Username: ${username}`);
console.log(`  Password: ${password}`);
console.log('  URL, ending in the service name, using an address that *arr can reach:');
for (const address of addresses) {
    for (const service of CAPTURE_SERVICES) console.log(`    http://${address}:${port}/${service}`);
}
console.log('');
console.log('Press Test, then cause a real grab, import and delete. Ctrl+C when done, then remove the connections.');
