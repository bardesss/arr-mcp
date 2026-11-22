/**
 * What `capture-fixtures.ts` does to every Emby capture, split out so it can
 * be unit tested: the script itself runs a top-level `loadConfig()` on import.
 *
 * The captures come from a test server holding public-domain films, so what
 * they say about the media is public. What they say about the server is not:
 * its install, user, session and task ids, when anything happened on it, the
 * names on it, and its network card. `EmbyScrubber` replaces those, the same
 * way across every fixture of one run, and drops the fields nothing reads
 * that only carry more of them.
 */

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Read by no Emby request arr-mcp makes. Images, cast, chapters, streams and
 * plot text describe the file or the film; an activity-log entry's `Overview`
 * names a signed-in client's address, and `WakeOnLanInfo` holds the server's
 * MAC address.
 */
const UNREAD = new Set([
    'BackdropImageTags',
    'Chapters',
    'ExternalUrls',
    'ImageBlurHashes',
    'ImageTags',
    'MediaStreams',
    'Overview',
    'People',
    'RemoteTrailers',
    'Studios',
    'Taglines',
    'WakeOnLanInfo'
]);
/** `SeriesPrimaryImageTag`, `ParentThumbImageTag` and the like: an id and a .NET tick count, joined. */
const IMAGE_KEY = /Image(?:Tag|Tags|AspectRatio)$/;

const HEX_ID = /[0-9a-f]{32}/g;
/** What `#text` writes in place of one, so a second pass leaves it alone. */
const FAKE_ID = /^0+\d{1,4}$/;
/** The folders a path has above the test server's library folders, which say where its share is. */
const SHARE = /^\/(?:[^/]+\/)+?(?=(?:movies|tv|music)(?:\/|$))/;
/** An ISO-format UTC time from this century, which on a test server set up for the capture is when the capture was made. */
const CAPTURE_TIME = /^20[2-9]\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
/** Where the first capture time lands; the rest keep their distance from it. */
const ANCHOR = Date.parse('2024-01-02T12:00:00Z');

const asWord = (text: string): RegExp => new RegExp(`(?<![\\w-])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g');

export class EmbyScrubber {
    readonly #ids = new Map<string, string>();
    readonly #names = new Map<string, string>();
    #first: number | undefined;

    /**
     * One fixture body, scrubbed. Call it on every fixture of a run, in
     * capture order, before the endpoint's own anonymiser: what that writes is
     * already invented, and stays as written.
     */
    scrub(node: unknown): unknown {
        if (typeof node === 'string') return this.#text(node);
        if (Array.isArray(node)) return node.map(n => this.scrub(n));
        if (!isRow(node)) return node;
        return Object.fromEntries(
            Object.entries(node)
                .filter(([k]) => !UNREAD.has(k) && !IMAGE_KEY.test(k))
                .map(([k, v]) => {
                    if (k === 'ServerName' && typeof v === 'string') this.rename(v, 'Server 1');
                    return [k, this.scrub(v)];
                })
        );
    }

    /**
     * A name an anonymiser replaces (a user's, the server's), replaced wherever
     * a later fixture writes it as a word: the activity log's sentences name
     * both ("<user> is playing Detour").
     */
    rename(real: string, placeholder: string): void {
        if (real !== '' && real !== placeholder) this.#names.set(real, placeholder);
    }

    /**
     * A 32-hex id becomes `0…01`, `0…02` in the order first seen, so a user id
     * in `/Users` and the same id on a session still match. A capture time
     * keeps its distance from the first one seen, which lands on 2024-01-02:
     * the order of a log and the gaps in it survive, the date and the time of
     * day do not. A path's folders above the library's own (`movies`, `tv`,
     * `music`) become `/media/`, as the *arr captures name theirs, and a
     * renamed name becomes its placeholder.
     */
    #text(value: string): string {
        if (CAPTURE_TIME.test(value)) {
            const at = Date.parse(value);
            this.#first ??= at;
            return new Date(ANCHOR + (at - this.#first)).toISOString();
        }
        let text = value.replace(SHARE, '/media/');
        // Longest first, so a name that begins a longer one cannot leave the rest of it behind.
        for (const [real, placeholder] of [...this.#names].sort(([a], [b]) => b.length - a.length)) text = text.replace(asWord(real), placeholder);
        return text.replace(HEX_ID, id => {
            if (FAKE_ID.test(id)) return id;
            let fake = this.#ids.get(id);
            if (fake === undefined) {
                fake = String(this.#ids.size + 1).padStart(32, '0');
                this.#ids.set(id, fake);
            }
            return fake;
        });
    }
}

/** What the users capture writes in place of a user's name. */
const USER_PLACEHOLDER = /^User \d+$/;

/** A playback sentence that opens with that placeholder, as "User 2 is playing Detour" does. */
const keepsSentence = (entry: unknown): boolean =>
    isRow(entry) && typeof entry.Type === 'string' && entry.Type.startsWith('playback.') && typeof entry.Name === 'string' && /^User \d+ /.test(entry.Name);

/**
 * The activity log, after the scrub. A playback entry keeps its sentence, as
 * Emby writes it, only when the sentence opens with a user placeholder; every
 * other sentence is replaced. Any of them can name a user, and the scrub
 * replaces only the names `/Users` gave it, so a user deleted since, or a run
 * whose users capture failed, would leave one.
 */
export const anonymiseActivityLog = (body: unknown): unknown => {
    if (!isRow(body) || !Array.isArray(body.Items)) return body;
    const items: unknown[] = body.Items;
    return { ...body, Items: items.map((e, i) => (keepsSentence(e) ? e : { ...(isRow(e) ? e : {}), Name: `Fixture message ${i + 1}` })) };
};

/**
 * The user an activity-log number names. The scrub has renamed it when
 * `/Users` listed it; a name it did not replace still gets a placeholder.
 * `Prefix` follows the name.
 */
export const anonymiseLogUser = (body: unknown): unknown => {
    if (!isRow(body)) return body;
    const unrenamed = typeof body.Name === 'string' && !USER_PLACEHOLDER.test(body.Name);
    return { ...body, ...(unrenamed ? { Name: 'User 2' } : {}), Prefix: 'U' };
};
