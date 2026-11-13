import type { Server } from 'node:http';
import { createAdaptorServer } from '@hono/node-server';

type Fetch = Parameters<typeof createAdaptorServer>[0]['fetch'];

/**
 * `::` first: on Linux and Windows it is dual stack, so one socket takes IPv6
 * clients and IPv4 ones (as `::ffff:` addresses, which `peerAddress` strips).
 * A host or container with IPv6 switched off refuses that bind, and then the
 * IPv4 wildcard is the right answer rather than a crash.
 */
export const BIND_ORDER = ['::', '0.0.0.0'] as const;

/** Codes meaning "this address family is not here", as opposed to a real fault. */
const UNAVAILABLE = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT']);

const bind = (fetch: Fetch, port: number, hostname: string): Promise<Server> =>
    new Promise((resolve, reject) => {
        const server = createAdaptorServer({ fetch }) as Server;
        const onError = (err: Error): void => {
            server.removeListener('listening', onListening);
            reject(err);
        };
        const onListening = (): void => {
            server.removeListener('error', onError);
            resolve(server);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, hostname);
    });

/** Listens on the first address in `order` this machine can bind. */
export async function listen(
    fetch: Fetch,
    port: number,
    order: readonly string[] = BIND_ORDER
): Promise<{ server: Server; hostname: string }> {
    let last: unknown;
    for (const hostname of order) {
        try {
            return { server: await bind(fetch, port, hostname), hostname };
        } catch (err) {
            if (!UNAVAILABLE.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
            last = err;
        }
    }
    throw last;
}
