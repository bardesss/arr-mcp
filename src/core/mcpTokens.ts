import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { WriteTier } from './permissions.ts';

export type TokenTier = 'read' | 'write' | 'destructive';
export type ExpiryChoice = '30' | '90' | 'never';
export type StoredToken = { name: string; tier: TokenTier; hash: string; expires?: string };

const DAY_MS = 86_400_000;
const SOON_DAYS = 7;

export const generateMcpToken = (): string => `amcp_${randomBytes(32).toString('hex')}`;

export const hashToken = (plain: string): string => `sha256:${createHash('sha256').update(plain).digest('hex')}`;

export const fingerprint = (hash: string): string => hash.slice('sha256:'.length, 'sha256:'.length + 8);

export const bearerCaller = (token: StoredToken): string => `bearer:${token.name}#${fingerprint(token.hash)}`;

export function tiersOf(tier: TokenTier): ReadonlySet<WriteTier> {
    if (tier === 'destructive') return new Set<WriteTier>(['safe', 'destructive']);
    if (tier === 'write') return new Set<WriteTier>(['safe']);
    return new Set<WriteTier>();
}

const startOf = (date: string): number => Date.parse(`${date}T00:00:00Z`);

export const isExpired = (expires: string | undefined, now: Date): boolean =>
    expires !== undefined && now.getTime() >= startOf(expires);

export const expiringSoon = (expires: string | undefined, now: Date): boolean =>
    expires !== undefined && !isExpired(expires, now) && startOf(expires) - now.getTime() < SOON_DAYS * DAY_MS;

export function expiresIn(choice: ExpiryChoice, now: Date): string | undefined {
    if (choice === 'never') return undefined;
    return new Date(now.getTime() + Number(choice) * DAY_MS).toISOString().slice(0, 10);
}

// Every stored hash is compared, so timing says nothing about which one matched.
export function matchToken(
    presented: string,
    tokens: readonly StoredToken[],
    now: Date
): { kind: 'match'; token: StoredToken } | { kind: 'expired'; token: StoredToken } | { kind: 'none' } {
    if (presented === '') return { kind: 'none' };
    const digest = Buffer.from(hashToken(presented));
    let found: StoredToken | undefined;
    for (const token of tokens) {
        const stored = Buffer.from(token.hash);
        const same = stored.length === digest.length && timingSafeEqual(stored, digest);
        if (same && found === undefined) found = token;
    }
    if (found === undefined) return { kind: 'none' };
    return isExpired(found.expires, now) ? { kind: 'expired', token: found } : { kind: 'match', token: found };
}
