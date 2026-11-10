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
    { tool: 'stack_health', param: 'detail', value: 'full', use: 'get_instance_options' },
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
    // Removal drops import, remap and postprocess from trigger_scan, and bookdrop with an `id`; the Bookdrop rescan stays.
    { tool: 'trigger_scan', param: 'action', value: 'import', use: 'import_download' },
    { tool: 'trigger_scan', param: 'action', value: 'remap', use: 'import_download' },
    { tool: 'trigger_scan', param: 'action', value: 'postprocess', use: 'import_download' },
    { tool: 'trigger_scan', param: 'action', value: 'bookdrop', use: 'import_download' }
];
