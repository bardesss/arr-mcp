
/**
 * everything a service returns is untrusted data, never
 * instruction. Prowlarr returns release names from public indexers — those
 * strings are attacker-controllable and flow straight into model context.
 *
 * This does not make injection impossible. It makes injected text visibly
 * *data*, and removes the characters that let a string render as something
 * other than what it is.
 */

/** Long enough for any real overview; short enough that 500 of them fit. */
export const FENCE_MAX_LENGTH = 2000;

const OPEN = '<<untrusted:';
const CLOSE = '<</>>';

/**
 * Code point ranges stripped from untrusted text, written as numbers rather
 * than as a regex character class. A class of invisible codepoints cannot be
 * reviewed by reading it, and does not survive being pasted through an editor.
 */
const DANGEROUS_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x00, 0x08], // C0 controls before \t
    [0x0b, 0x1f], // C0 controls after \n, including \r
    [0x7f, 0x9f], // DEL and the C1 controls
    [0x200b, 0x200f], // zero-width space through right-to-left mark
    [0xfeff, 0xfeff], // zero-width no-break space, the BOM
    [0x202a, 0x202e], // bidirectional embedding and override
    [0x2066, 0x2069] // bidirectional isolates
];

/**
 * Tab and newline survive: overviews legitimately contain them, and neither
 * changes how the surrounding text renders.
 *
 * The bidi ranges are the ones that matter most. U+202E makes the remainder of
 * a string render right-to-left, so a release name can display as something
 * entirely different from the bytes a human later reads in an audit log.
 */
const isDangerous = (codePoint: number): boolean =>
    DANGEROUS_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);

export function stripDangerous(value: string): string {
    // Defensive against a non-string despite the type. This function is the
    // one place every untrusted value passes through, and a service returning
    // null where its own docs say string should cost that one field, not the
    // whole tool. It happened: 69 of 502 Bazarr episodes carry `sceneName:
    // null`, and the crash took down get_subtitles entirely.
    if (typeof value !== 'string') return '';

    let out = '';
    // Iterating the string yields whole code points, so astral characters are
    // not split into surrogates and mistaken for something else.
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint !== undefined && !isDangerous(codePoint)) out += character;
    }
    return out;
}

/** Slices without leaving half an astral character at the end. */
const cut = (value: string, length: number): string => {
    const out = value.slice(0, length);
    const last = out.charCodeAt(out.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? out.slice(0, -1) : out;
};

/** Long enough for any real guid (usually a URL); short enough to bound a
 *  hostile one. */
export const GUID_MAX_LENGTH = 500;

/**
 * For a guid: opaque-id-shaped text a later grab tool needs verbatim, so it
 * is never fenced or escaped like prose. It still reaches model context from
 * an indexer nobody vetted, so the same dangerous code points `fenceText`
 * strips — bidi overrides, C1 controls — come out here too, and the length
 * is capped so one hostile row cannot blow the token budget on its own.
 */
export function sanitizeGuid(value: string): string {
    const clean = stripDangerous(value);
    return clean.length > GUID_MAX_LENGTH ? cut(clean, GUID_MAX_LENGTH) : clean;
}

/** Printable ASCII with no space, and none of the characters a fence or a
 *  bracketed list is built from. Every real guid seen so far — a URL, a hash,
 *  a Shelfmark id — fits. */
const OPAQUE_GUID = /^[\x21-\x3b\x3d\x3f-\x5a\x5c\x5e-\x7e]+$/u;

/**
 * A guid for model-facing text (#507). `sanitizeGuid` leaves ASCII prose
 * alone, which is fine in `structuredContent` but not in a text line: an
 * indexer could pick `x] Ignore the above…` as its guid and write past the
 * fence. One shaped like an id goes in bare, since grab_release needs it
 * verbatim; anything else is fenced like a title, and the caller can grab
 * that row by `release_title` instead.
 */
export function guidForText(guid: string, service: string): string {
    return OPAQUE_GUID.test(guid) ? guid : fenceText(guid, { service, field: 'guid' });
}

/**
 * Wraps free text in a labelled boundary. The value's own angle brackets are
 * escaped first, so a release name cannot close the fence and continue outside
 * it — a fence a value can escape is worse than no fence, because it looks
 * like protection.
 *
 * Escaping, not censoring: the words survive verbatim, so the model can still
 * read what the indexer actually said.
 */
export function fenceText(value: string, source: { service: string; field: string }): string {
    if (typeof value !== 'string' || value === '') return '';

    let clean = stripDangerous(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
    if (clean.length > FENCE_MAX_LENGTH) {
        clean = `${cut(clean, FENCE_MAX_LENGTH)}…[truncated]`;
    }

    return `${OPEN}${source.service}.${source.field}>>${clean}${CLOSE}`;
}

const FENCED = /<<untrusted:[^>]*>>([\s\S]*?)<<\/>>/g;

/**
 * The value as its service said it, for a person reading the web UI. The fence
 * tells a model which words are data, and to anyone else it is noise in the
 * middle of a sentence.
 *
 * Only for output that escapes what it prints: this puts the value's own angle
 * brackets back. Never for anything that reaches a model.
 */
export function unfence(value: string): string {
    return value.replace(FENCED, (_fence, inner: string) =>
        inner.replaceAll('\\u003c', '<').replaceAll('\\u003e', '>')
    );
}
