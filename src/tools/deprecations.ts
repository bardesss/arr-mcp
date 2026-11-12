/**
 * Tools and parameters that still work but have a replacement.
 *
 * Each one stays registered for a full minor with "Deprecated: use X" in its
 * description, and the removal PR works from this list. `param` and `value`
 * narrow an entry to one parameter or one value of it; without them the whole
 * tool is deprecated. `rename` marks a tool whose replacement is the same tool
 * under a new name: the old name takes the same arguments and answers the same.
 *
 * Empty since 2.0.0, which removed everything 1.x deprecated.
 */
export type Deprecation = { tool: string; param?: string; value?: string; use: string; rename?: true };

/** The description of a tool kept only under its old name. */
export const ALIAS_DESCRIPTION = (use: string): string => `Deprecated: use ${use}, which takes the same arguments.`;

export const DEPRECATIONS: readonly Deprecation[] = [];
