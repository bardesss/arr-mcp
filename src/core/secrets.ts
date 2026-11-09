import { createHash, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256:';

/** What a stored hash looks like on disk: the config schema validates against it. */
export const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const hashToken = (plain: string): string => `${PREFIX}${createHash('sha256').update(plain).digest('hex')}`;

export const fingerprint = (hash: string): string => hash.slice(PREFIX.length, PREFIX.length + 8);

/** Tolerates unequal lengths without leaking them by timing. */
export function constantTimeEquals(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) {
        timingSafeEqual(right, right);
        return false;
    }
    return timingSafeEqual(left, right);
}

/** Every stored hash is compared, so timing says nothing about which one matched. */
export function findByHash<T extends { hash: string }>(presented: string | undefined, stored: readonly T[]): T | undefined {
    if (presented === undefined || presented === '') return undefined;
    const digest = hashToken(presented);
    let found: T | undefined;
    for (const entry of stored) {
        if (constantTimeEquals(entry.hash, digest) && found === undefined) found = entry;
    }
    return found;
}
