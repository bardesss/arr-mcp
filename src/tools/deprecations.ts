/**
 * Tools and parameters that still work but have a replacement.
 *
 * Each one stays registered for a full minor with "Deprecated: use X" in its
 * description, and the removal PR works from this list. `param` and `value`
 * narrow an entry to one parameter or one value of it; without them the whole
 * tool is deprecated.
 */
export type Deprecation = { tool: string; param?: string; value?: string; use: string };

export const DEPRECATIONS: readonly Deprecation[] = [
    { tool: 'lookup_media', use: 'search_media' },
    // Removal drops the `options` field that `detail: "full"` returns; `full` itself stays.
    { tool: 'stack_health', param: 'detail', value: 'full', use: 'get_instance_options' }
];
