import type { Config } from '../../src/config/schema.ts';
import { generateMcpToken, hashToken } from '../../src/core/mcpTokens.ts';

// In memory only: a script must never add a credential to the user's config.yaml.
export function withScriptToken(config: Config): { config: Config; token: string } {
    const token = generateMcpToken();
    const entry = { name: 'maintainer-script', tier: 'destructive' as const, hash: hashToken(token) };
    return { config: { ...config, auth: { ...config.auth, tokens: [...config.auth.tokens, entry] } }, token };
}
