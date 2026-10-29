const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * A magnet's `btih` is 40 hex characters or, per BEP 9, 32 base32 ones. The
 * torrent clients key on hex, so a base32 hash looked up as given never
 * matches and a duplicate check silently passes. A 32-character value with a
 * character outside the base32 alphabet is left as given.
 */
export function btihToHex(btih: string): string {
    const lower = btih.toLowerCase();
    if (lower.length !== 32 || [...lower].some(c => !BASE32.includes(c))) return lower;
    const bits = [...lower].map(c => BASE32.indexOf(c).toString(2).padStart(5, '0')).join('');
    return Array.from({ length: 40 }, (_, i) => parseInt(bits.slice(i * 4, i * 4 + 4), 2).toString(16)).join('');
}

/** The info hash a magnet names, in hex, or undefined when it carries no `btih`. */
export function magnetHash(uri: string): string | undefined {
    const btih = /xt=urn:btih:([0-9a-zA-Z]+)/.exec(uri)?.[1];
    return btih === undefined ? undefined : btihToHex(btih);
}
