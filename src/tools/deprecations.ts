/**
 * Tools and parameters that still work but have a replacement.
 *
 * Each one stays registered for a full minor with "Deprecated: use X" in its
 * description, and the removal PR works from this list. `param` and `value`
 * narrow an entry to one parameter or one value of it; without them the whole
 * tool is deprecated. `rename` marks a tool whose replacement is the same tool
 * under a new name: the old name takes the same arguments and answers the same.
 */
export type Deprecation = { tool: string; param?: string; value?: string; use: string; rename?: true };

/** The description of a tool kept only under its old name. */
export const ALIAS_DESCRIPTION = (use: string): string => `Deprecated: use ${use}, which takes the same arguments.`;

export const DEPRECATIONS: readonly Deprecation[] = [
    { tool: 'lookup_media', use: 'search_media' },
    // Removal drops clean_queue and its WRITE_TOOLS/TOOL_SERVICES/TOOL_NAMES entries; planOrphaned and applyOrphaned stay in cleanQueue.ts or move into removeQueueItem.ts.
    { tool: 'clean_queue', use: 'remove_queue_item' },
    // Removal drops the old names from TOOL_NAMES and register.ts, and the `arr://docs/` aliases in TOOL_DOC_ALIASES.
    { tool: 'stack_health', use: 'get_stack_health', rename: true },
    { tool: 'diagnose', use: 'diagnose_media', rename: true },
    // Removal drops the `options` field that `detail: "full"` returns; `full` itself stays.
    { tool: 'get_stack_health', param: 'detail', value: 'full', use: 'get_instance_options' },
    // Removal drops grimmory from update_media: its `services`, hint, the book branch, and `tags` on a book.
    { tool: 'update_media', param: 'service', value: 'grimmory', use: 'update_book' },
    { tool: 'update_media', param: 'title', use: 'update_book' },
    { tool: 'update_media', param: 'authors', use: 'update_book' },
    { tool: 'update_media', param: 'series', use: 'update_book' },
    { tool: 'update_media', param: 'series_number', use: 'update_book' },
    { tool: 'update_media', param: 'lock_fields', use: 'update_book' },
    { tool: 'update_media', param: 'unlock_fields', use: 'update_book' },
    { tool: 'set_monitoring', param: 'level', value: 'artist', use: 'update_media' },
    { tool: 'set_monitoring', param: 'artists', use: 'update_media' },
    { tool: 'set_monitoring', param: 'monitor_new_items', use: 'update_media' },
    // Removal drops trigger_scan's import, remap and postprocess values, the `download_id`, `reassignments`
    // and `mapping` parameters, and the file import under bookdrop: the `action === 'bookdrop' && id !== undefined`
    // branch in `plan` and the `fileId` branch in `apply`. The `bookdrop` value itself stays, since it is the rescan.
    // It also drops nzbget from trigger_scan's `service` list and from TOOL_SERVICES.trigger_scan, which today keep
    // trigger_scan listed on an NZBGet-only stack for the alias alone.
    { tool: 'trigger_scan', param: 'action', value: 'import', use: 'import_download' },
    { tool: 'trigger_scan', param: 'action', value: 'remap', use: 'import_download' },
    { tool: 'trigger_scan', param: 'action', value: 'postprocess', use: 'import_download' },
    { tool: 'trigger_scan', param: 'action', value: 'bookdrop', use: 'import_download' },
    { tool: 'trigger_scan', param: 'download_id', use: 'import_download' },
    { tool: 'trigger_scan', param: 'reassignments', use: 'import_download' },
    { tool: 'trigger_scan', param: 'mapping', use: 'import_download' },
    // Removal drops `delete` from manage_indexer, which is then safe tier and no longer destructiveHint.
    { tool: 'manage_indexer', param: 'action', value: 'delete', use: 'delete_indexer' },
    // Removal drops `tmdb_id` and `idOf` from blocklist_media, and makes `id` required again.
    { tool: 'blocklist_media', param: 'tmdb_id', use: 'id' }
];
