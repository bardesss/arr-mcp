import { randomBytes } from 'node:crypto';
import { BEARER_CALLER_PREFIX } from './audit.ts';
import type { WriteTier } from './permissions.ts';
import { findByHash, fingerprint } from './secrets.ts';

export type TokenTier = 'read' | 'write' | 'destructive';
export type ExpiryChoice = '30' | '90' | 'never';
export type StoredToken = {
    name: string;
    tier: TokenTier;
    hash: string;
    expires?: string | undefined;
    /** The day it was made, `YYYY-MM-DD`. Absent on tokens created before this
     *  was recorded, and on any hand-written into config.yaml, so the table
     *  shows a dash rather than inventing one. */
    created?: string | undefined;
};

const DAY_MS = 86_400_000;
const SOON_DAYS = 7;

export const generateMcpToken = (): string => `amcp_${randomBytes(32).toString('hex')}`;

export const bearerCaller = (token: StoredToken): string => `${BEARER_CALLER_PREFIX}${token.name}#${fingerprint(token.hash)}`;

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

/**
 * How long a token has left, in words.
 *
 * Lives here rather than in the page that first needed it: the dashboard said
 * "4 days left" while the Access page, the page you would act on it from,
 * showed the bare date. One function, both pages.
 */
export function daysLeft(expires: string | undefined, now: Date): string {
    if (expires === undefined) return 'no expiry';
    const days = Math.ceil((Date.parse(`${expires}T23:59:59Z`) - now.getTime()) / DAY_MS);
    if (days < 0) return 'expired';
    return days === 1 ? '1 day left' : `${days} days left`;
}

export function expiresIn(choice: ExpiryChoice, now: Date): string | undefined {
    if (choice === 'never') return undefined;
    return new Date(now.getTime() + Number(choice) * DAY_MS).toISOString().slice(0, 10);
}

export function matchToken(
    presented: string,
    tokens: readonly StoredToken[],
    now: Date
): { kind: 'match'; token: StoredToken } | { kind: 'expired'; token: StoredToken } | { kind: 'none' } {
    const found = findByHash(presented, tokens);
    if (found === undefined) return { kind: 'none' };
    return isExpired(found.expires, now) ? { kind: 'expired', token: found } : { kind: 'match', token: found };
}
