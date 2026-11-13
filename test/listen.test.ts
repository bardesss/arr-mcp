import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BIND_ORDER, listen } from '../src/listen.ts';

const servers: Server[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map(s => new Promise(resolve => s.close(resolve))));
});

const fetch = () => new Response('ok');

describe('listen', () => {
    // A client that resolves the host to an IPv6 address was refused outright
    // by an IPv4-only listener.
    it('tries the IPv6 wildcard first, so one socket takes both families', () => {
        expect(BIND_ORDER[0]).toBe('::');
        expect(BIND_ORDER).toContain('0.0.0.0');
    });

    it('answers on IPv4 and IPv6 loopback from one listener', async () => {
        const { server, hostname } = await listen(fetch, 0);
        servers.push(server);
        const { port } = server.address() as AddressInfo;

        expect(await (await globalThis.fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok');
        // Only where the dual-stack bind succeeded; a runner without IPv6 fell back.
        if (hostname === '::') expect(await (await globalThis.fetch(`http://[::1]:${port}/`)).text()).toBe('ok');
    });

    // What a container with IPv6 switched off answers to `::`.
    it('falls back to the next address when one is not available here', async () => {
        // TEST-NET-1: never assigned to a local interface, so the bind fails with EADDRNOTAVAIL.
        const { server, hostname } = await listen(fetch, 0, ['192.0.2.1', '127.0.0.1']);
        servers.push(server);
        expect(hostname).toBe('127.0.0.1');
    });

    it('does not hide a port that is already taken', async () => {
        const first = await listen(fetch, 0, ['127.0.0.1']);
        servers.push(first.server);
        const { port } = first.server.address() as AddressInfo;
        await expect(listen(fetch, port, ['127.0.0.1', '127.0.0.1'])).rejects.toMatchObject({ code: 'EADDRINUSE' });
    });
});
