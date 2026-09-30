import * as z from 'zod/v4';
import type { ServiceInstance } from '../config/instances.ts';
import type { InstanceFields } from '../config/mutate.ts';
import { ServiceIdSchema } from '../config/schema.ts';
import { withoutCredentials } from '../tools/stackHealth.ts';

/** What GET returns but PUT cannot change; accepted so GET-modify-PUT works. */
const readOnly = {
    id: z.unknown().optional(),
    apiKeySet: z.unknown().optional(),
    passwordSet: z.unknown().optional()
};

const fields = {
    url: z.string().optional(),
    apiKey: z.string().optional(),
    username: z.string().nullable().optional(),
    password: z.string().optional(),
    defaultUser: z.string().nullable().optional(),
    allowOtherUsers: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
    safeWrite: z.boolean().optional(),
    destructive: z.boolean().optional(),
    allowMetadataRepair: z.boolean().optional()
};

export const AppBody = z.strictObject({
    ...readOnly,
    type: z.unknown().optional(),
    name: z.unknown().optional(),
    ...fields
});
export type AppBodyValue = z.infer<typeof AppBody>;

export const NewAppBody = z.strictObject({
    ...readOnly,
    ...fields,
    url: z.string({ error: 'required' }).trim().min(1, 'required'),
    type: ServiceIdSchema,
    name: z.string().min(1).nullable().optional(),
    renameExistingTo: z.string().min(1).optional()
});

/** `POST /app/test`: an existing app by `id`, or a new one by `type`. */
export const TestAppBody = z.strictObject({
    ...fields,
    id: z.string().optional(),
    apiKeySet: z.unknown().optional(),
    passwordSet: z.unknown().optional(),
    type: ServiceIdSchema.optional(),
    name: z.string().min(1).nullable().optional(),
    renameExistingTo: z.string().min(1).optional()
});

/** Whether `sent` is `stored` as GET showed it: credentials stripped, maybe a trailing slash more or less. */
function sameUrl(sent: string, stored: string): boolean {
    let a: URL;
    let b: URL;
    try {
        a = new URL(sent.trim());
        b = new URL(withoutCredentials(stored));
    } catch {
        return false;
    }
    const path = (u: URL) => u.pathname.replace(/\/+$/, '');
    return a.username === '' && a.password === '' && a.origin === b.origin && path(a) === path(b) && a.search === b.search;
}

/**
 * The body as the edit functions take it. `null` clears; a URL equal to the
 * credential-stripped one GET showed keeps the stored URL and its credentials.
 */
export function fieldsFromBody(body: AppBodyValue, current: ServiceInstance | undefined): InstanceFields {
    const stored = current?.config as { url: string; permissions: { safe_write: boolean; destructive: boolean } } | undefined;
    const unchanged = stored !== undefined && body.url !== undefined && sameUrl(body.url, stored.url);
    const permissionTouched = body.safeWrite !== undefined || body.destructive !== undefined;

    return {
        ...(body.url === undefined || unchanged ? {} : { url: body.url.trim() }),
        ...(body.apiKey === undefined ? {} : { api_key: body.apiKey.trim() }),
        ...(body.username === undefined ? {} : { username: body.username === null ? '' : body.username.trim() }),
        ...(body.password === undefined ? {} : { password: body.password }),
        ...(body.defaultUser === undefined ? {} : { default_user: body.defaultUser === null ? '' : body.defaultUser.trim() }),
        ...(body.allowOtherUsers === undefined ? {} : { allow_other_users: body.allowOtherUsers }),
        ...(body.timeoutMs === undefined ? {} : { timeout_ms: body.timeoutMs }),
        ...(body.allowMetadataRepair === undefined ? {} : { allow_metadata_repair: body.allowMetadataRepair }),
        // applyFields writes both flags whenever either is present.
        ...(permissionTouched
            ? {
                  safe_write: body.safeWrite ?? stored?.permissions.safe_write ?? false,
                  destructive: body.destructive ?? stored?.permissions.destructive ?? false
              }
            : {})
    };
}
