import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hashToken } from './mcpTokens.ts';

export const generateManagementKey = (): string => `amk_${randomBytes(32).toString('hex')}`;

export function matchesManagementKey(presented: string | undefined, stored: { hash: string } | undefined): boolean {
    if (stored === undefined || presented === undefined || presented === '') return false;
    const digest = Buffer.from(hashToken(presented));
    const want = Buffer.from(stored.hash);
    return digest.length === want.length && timingSafeEqual(digest, want);
}
