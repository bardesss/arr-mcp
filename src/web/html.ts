/**
 * The one place untrusted text becomes HTML.
 *
 * Design spec §11 treats everything a service returns as data, never
 * instruction — and the config UI is where that data stops being JSON in a
 * model's context and becomes markup in a browser. A release name from a
 * public indexer reaches the log stream; a film title reaches the audit view.
 * Both are attacker-controllable, and neither may become a `<script>`.
 *
 * `fenceText` is not enough here. It escapes angle brackets for values that
 * pass through the adapters, but log lines carry raw fields that never did,
 * and an error message can contain anything. So every interpolation into the
 * page goes through `esc`, and templates are built by `html` rather than by
 * string concatenation, so forgetting is something you have to do on purpose.
 */

const ENTITIES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};

export function esc(value: unknown): string {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, character => ENTITIES[character] ?? character);
}

/**
 * Markup that is already safe, and says so by construction.
 *
 * Wrapping is the only way to opt a string out of escaping, so an unescaped
 * interpolation is visible at the call site as `raw(...)` rather than being
 * the silent default.
 */
export class SafeHtml {
    // Written out rather than as a constructor parameter property: Node runs
    // this project's TypeScript in strip-only mode, which rejects those.
    readonly value: string;

    constructor(value: string) {
        this.value = value;
    }

    toString(): string {
        return this.value;
    }
}

export const raw = (value: string): SafeHtml => new SafeHtml(value);

/**
 * Tagged template that escapes every interpolation except `SafeHtml`.
 *
 * Arrays are joined without separators, so a list of rendered rows can be
 * dropped straight in — the common case, and one that otherwise invites
 * `.join('')` on already-stringified markup, which loses the safety marker.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
    let out = strings[0] ?? '';
    for (let i = 0; i < values.length; i += 1) {
        out += render(values[i]) + (strings[i + 1] ?? '');
    }
    return new SafeHtml(out);
}

function render(value: unknown): string {
    if (value instanceof SafeHtml) return value.value;
    if (Array.isArray(value)) return value.map(render).join('');
    return esc(value);
}

/** Bytes as something a person reads, for disk-space displays. */
export function humanBytes(bytes: number | undefined): string {
    if (bytes === undefined || !Number.isFinite(bytes)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    // One decimal below 100 in any scaled unit: "24.1 GB" is the difference
    // between two films and three, and "512 KB" gains nothing from ".0".
    return `${unit > 0 && value < 100 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** An ISO timestamp as something scannable in a log table. */
export function shortTime(iso: string): string {
    return iso.replace('T', ' ').replace(/\.\d+Z?$/, '').replace('Z', '');
}
