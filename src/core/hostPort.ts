/** `host:port`, lowercased, default ports filled in. Matches one service's URL against another's record of it. */
export function hostPort(url: string): string | undefined {
    try {
        const u = new URL(url);
        const port = u.port !== '' ? u.port : u.protocol === 'https:' ? '443' : '80';
        return `${u.hostname.toLowerCase()}:${port}`;
    } catch {
        return undefined;
    }
}
