import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { grimmorySession, noAuth } from '../core/auth.ts';
import { ServiceError, type ServiceErrorKind } from '../core/errors.ts';
import type { IndexInput } from '../core/resolver.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import { parseEventStream } from '../core/eventStream.ts';
import { compareVersions, parseVersion } from './versions.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type HealthCheck,
    type BookLibrary,
    type BookCandidate,
    type BookField,
    type BookFields,
    type BookMetadataCapable,
    type BookMetadataIssue,
    type BookMetadataIssueCapable,
    type BookMetadataState,
    type BookSearch,
    type BookDeleteCapable,
    type BookDeletion,
    type BookReadState,
    type BookReadStatusCapable,
    type QueueCapable,
    type QueueItem,
    type QueueRemoveCapable,
    type RemoveQueueOptions,
    type BookLibraryScanCapable,
    type HealthCheckCapable,
    type HistoryCapable,
    type HistoryEntry,
    type HistoryQuery,
    type Window,
    type LibraryCapable,
    type MediaDetailCapable,
    type MediaDetails,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type ServiceAdapter
} from './types.ts';

/** The Grimmory this adapter was written against and captured on. */
export const TESTED_VERSION = '3.5.0';

const HEALTH_PATH = '/api/v1/healthcheck';
const LIBRARIES_PATH = '/api/v1/libraries';

/** Pending Bookdrop files older than this are worth a warning. */
const BOOKDROP_STALE_MS = 24 * 3_600_000;

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : {});
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((r): r is Raw => typeof r === 'object' && r !== null) : []);

/** Says which read failed and why in a word; never the URL or a response body. */
function unreadable(name: string, reason: unknown): string {
    const status = reason instanceof ServiceError ? /^HTTP (\d+)/.exec(reason.detail)?.[1] : undefined;
    if (status === '403') return `This Grimmory account may not read ${name}, so it is left out.`;
    const why = status !== undefined ? `HTTP ${status}` : reason instanceof ServiceError ? reason.kind : 'error';
    return `Grimmory's ${name} could not be read (${why}), so it is left out.`;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** An ISBN or ASIN is short and plain; anything else in that field is not an identifier. */
const identifier = (v: unknown): string | undefined => {
    const s = str(v);
    return s !== undefined && /^[0-9A-Za-z-]{1,20}$/.test(s) ? s : undefined;
};
const SEARCH_SIZE = 20;
/** Books per library page: Grimmory's own app list allows this many in one read. */
const LIBRARY_PAGE_SIZE = 200;
/**
 * The most pages one library read follows: 20,000 books. Past it the read
 * fails by name rather than looping, since it runs on every library load and a
 * server that ignores `page` would otherwise answer `hasNext: true` forever.
 */
export const MAX_LIBRARY_PAGES = 100;
/** A book scoring under this is listed by get_metadata_issues. */
export const BOOK_MATCH_THRESHOLD = 45;
/** Failures that belong to one book in the metadata sweep; anything else (a login, an open circuit) ends it. */
const PER_BOOK_FAILURES: ReadonlySet<ServiceErrorKind> = new Set(['NotFound', 'Timeout', 'UpstreamError']);

/**
 * The catalogue ids on a book's metadata; any one of them means it was
 * identified. Every `*Id` the spec's BookMetadata declares, bar `bookId`
 * (Grimmory's own row id), plus `asin`.
 */
const BOOK_CATALOGUE_IDS = [
    'asin',
    'goodreadsId',
    'googleId',
    'hardcoverId',
    'hardcoverBookId',
    'openlibraryId',
    'comicvineId',
    'doubanId',
    'lubimyczytacId',
    'ranobedbId',
    'audibleId',
    'applebooksId'
] as const;
/**
 * Grimmory has one login for the whole server and no viewer identity, so a
 * book row carries this fixed label. The configured username is half of the
 * login and never reaches output.
 */
const BOOK_ACCOUNT_LABEL = 'grimmory account';
/** Bookdrop files per page of the queue read. */
const BOOKDROP_PAGE_SIZE = 100;
/** The most pages one Bookdrop read follows: 1,000 files, then it fails by name rather than loop. */
export const MAX_BOOKDROP_PAGES = 10;
/** Grimmory's discard takes a selection; this names exactly one file and never "all". */
const discardBody = (id: number) => ({ selectAll: false, selectedIds: [id], excludedIds: [] as number[] });
/** A file type is a short word such as EPUB or CBZ; anything else is not one. */
const fileType = (v: unknown): string | undefined => {
    const s = str(v);
    return s !== undefined && /^[A-Za-z0-9_]{1,20}$/.test(s) ? s : undefined;
};
/**
 * An ISO 8601 timestamp and nothing else. `Date.parse` alone accepts free text
 * that ends in a year, which would reach a row unfenced and scramble the
 * string sort `sort: 'added'` relies on.
 */
const isoDate = (v: unknown): string | undefined => {
    const s = str(v);
    return s !== undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s))
        ? s
        : undefined;
};

const AUDIT_PATH = '/api/v1/audit-logs';
/** Audit rows per page; the most Grimmory's audit log is asked for at once. */
const AUDIT_PAGE_SIZE = 100;
/** The most pages one audit action is followed: 1,000 rows, newest first. */
export const MAX_AUDIT_PAGES = 10;
/** The audit actions get_history reads, and the event each becomes. Logins, users, settings and tasks are not history. */
export const GRIMMORY_HISTORY_ACTIONS = { BOOK_UPLOADED: 'added', BOOK_DELETED: 'deleted', METADATA_UPDATED: 'metadata', LIBRARY_SCANNED: 'scanned' } as const;
type GrimmoryAuditAction = keyof typeof GRIMMORY_HISTORY_ACTIONS;
const isBookEntity = (v: unknown): boolean => typeof v === 'string' && v.toUpperCase() === 'BOOK';
/** A Java LocalDateTime has no offset; the ones Grimmory sends are read as UTC. */
const NO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** An audit `createdAt` as ISO with an offset: a bare one gets `Z`; anything else is not a time. */
const auditTime = (v: unknown): string | undefined => {
    const s = str(v);
    if (s === undefined) return undefined;
    const iso = NO_OFFSET.test(s) ? `${s}Z` : WITH_OFFSET.test(s) ? s : undefined;
    return iso !== undefined && Number.isFinite(Date.parse(iso)) ? iso : undefined;
};
/** `since` as an instant: a date or an offset-free time is UTC. */
const auditInstant = (since: string): number => Date.parse(NO_OFFSET.test(since) ? `${since}Z` : since);

/**
 * How long a metadata lookup may take. Grimmory asks every enabled provider in
 * turn and streams the answers, and the call ends only when the last one has.
 */
export const PROSPECTIVE_TIMEOUT_MS = 60_000;
const BOOK_TEXT_FIELDS = [
    'title',
    'subtitle',
    'publisher',
    'publishedDate',
    'seriesName',
    'isbn13',
    'isbn10',
    'asin',
    'language',
    'goodreadsId',
    'googleId',
    'hardcoverId',
    'openlibraryId'
] as const satisfies readonly BookField[];
const BOOK_NUMBER_FIELDS = ['seriesNumber', 'pageCount'] as const satisfies readonly BookField[];
const BOOK_LIST_FIELDS = ['authors', 'categories'] as const satisfies readonly BookField[];
/** Every book field, in the order locks are listed. */
const BOOK_FIELD_ORDER: readonly BookField[] = [
    'title',
    'subtitle',
    'authors',
    'publisher',
    'publishedDate',
    'seriesName',
    'seriesNumber',
    'isbn13',
    'isbn10',
    'asin',
    'language',
    'pageCount',
    'categories',
    'goodreadsId',
    'googleId',
    'hardcoverId',
    'openlibraryId'
];

/** A book's metadata, or one provider's candidate, as `BookFields`. Empty strings and lists are absent. */
function bookFields(meta: Raw): BookFields {
    const out: Record<string, unknown> = {};
    for (const key of BOOK_TEXT_FIELDS) {
        const v = str(meta[key]);
        if (v !== undefined) out[key] = v;
    }
    for (const key of BOOK_NUMBER_FIELDS) {
        const v = num(meta[key]);
        if (v !== undefined) out[key] = v;
    }
    for (const key of BOOK_LIST_FIELDS) {
        const v = (Array.isArray(meta[key]) ? (meta[key] as unknown[]) : []).filter((a): a is string => typeof a === 'string' && a !== '');
        if (v.length > 0) out[key] = v;
    }
    return out;
}

type RawHealth = { data?: { version?: unknown } };

/**
 * Grimmory's REST API, written against tag v3.5.0. It signs in with a username
 * and password and answers with a JWT; the healthcheck is the one route that
 * takes no token.
 */
export class GrimmoryAdapter implements ServiceAdapter, HealthCheckCapable, SearchCapable, MediaDetailCapable, LibraryCapable, BookLibraryScanCapable, BookDeleteCapable, BookReadStatusCapable, QueueCapable, QueueRemoveCapable, HistoryCapable, BookMetadataIssueCapable, BookMetadataCapable {
    readonly type: ServiceId = 'grimmory';
    readonly id = 'grimmory';
    readonly queueKind = 'book';
    readonly supportsBlocklist = false;
    readonly discardsFile = true;
    readonly #http: ServiceHttp;
    /** The same timeout and breaker, without the login: the healthcheck needs no token. */
    readonly #public: ServiceHttp;

    readonly #now: () => number;

    constructor(config: ConfigByService['grimmory'], fetchImpl: typeof fetch = fetch, opts: { now?: () => number } = {}) {
        this.#now = opts.now ?? Date.now;
        this.#http = new ServiceHttp(
            this.id,
            config,
            grimmorySession({ id: this.id, url: config.url, username: config.username, password: config.password, timeoutMs: config.timeout_ms, fetchImpl }),
            fetchImpl
        );
        this.#public = new ServiceHttp(this.id, config, noAuth, fetchImpl);
    }

    async getVersion(): Promise<string> {
        const body = await this.#public.get<RawHealth>(HEALTH_PATH);
        const version = body.data?.version;
        if (typeof version !== 'string' || version === '') throw new ServiceError('UpstreamError', this.id, 'healthcheck returned no version');
        return version.replace(/^v/i, '');
    }

    /** The healthcheck needs no login, so it alone would pass a wrong password. */
    async testConnection(): Promise<ConnectionDiagnosis> {
        let version: string | undefined;
        const diagnosis = await diagnoseConnection(this.id, this.type, async () => {
            version = await this.getVersion();
            await this.#http.get<unknown>(LIBRARIES_PATH);
            return version;
        });
        // A refused login still tells which Grimmory answered.
        return !diagnosis.ok && version !== undefined ? { ...diagnosis, version } : diagnosis;
    }

    /**
     * Libraries whose folder cannot be reached, Bookdrop files left waiting
     * over a day, and a newer release. Each read stands alone: a 403 on the
     * Bookdrop (it needs a permission) drops that finding and nothing else.
     */
    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const check = (source: string, type: string, message: string): HealthCheck => ({ service: this.id, source, type, message });
        const [libraries, health, version, bookdrop] = await Promise.allSettled([
            this.#http.get<unknown>(LIBRARIES_PATH),
            this.#http.get<unknown>(`${LIBRARIES_PATH}/health`),
            this.#http.get<unknown>('/api/v1/version'),
            this.#bookdropFinding()
        ]);
        const out: HealthCheck[] = [];
        const left = (name: string, r: PromiseSettledResult<unknown>): void => {
            if (r.status === 'rejected') out.push(check(name, 'notice', unreadable(name, r.reason)));
        };
        left('libraries', libraries);
        left('library health', health);
        left('version', version);
        left('bookdrop', bookdrop);

        if (libraries.status === 'fulfilled' && health.status === 'fulfilled') {
            const reach = obj(health.value);
            for (const lib of list(libraries.value)) {
                if (reach[String(lib.id)] !== false) continue;
                const name = typeof lib.name === 'string' && lib.name !== '' ? lib.name : `#${String(lib.id)}`;
                out.push(check('library', 'error', `Library ${fenceText(name, { service: this.id, field: 'library_name' })} cannot be reached: its folder is missing or unreadable.`));
            }
        }
        if (bookdrop.status === 'fulfilled' && bookdrop.value !== undefined) out.push(bookdrop.value);
        if (version.status === 'fulfilled') {
            const { current, latest } = obj(version.value);
            const have = typeof current === 'string' ? parseVersion(current) : undefined;
            const newest = typeof latest === 'string' ? parseVersion(latest) : undefined;
            if (typeof current === 'string' && typeof latest === 'string' && have !== undefined && newest !== undefined && compareVersions(newest, have) > 0) {
                out.push(check('update', 'notice', `Grimmory ${newest.join('.')} is out; this is ${have.join('.')}.`));
            }
        }
        return out;
    }

    #fence(value: string, field: string): string {
        return fenceText(value, { service: this.id, field });
    }

    /** `<title> by <authors>`, fenced; the one place a book's display title is built. */
    #bookTitle(title: string | undefined, authors: string[]): string {
        const name = title ?? 'untitled';
        return this.#fence(authors.length === 0 ? name : `${name} by ${authors.join(', ')}`, 'title');
    }

    /** Books you own, so `library` only. */
    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        if (source !== 'library') return [];
        const params = new URLSearchParams({ q: query, page: '0', size: String(SEARCH_SIZE) });
        const page = obj(await this.#http.get<unknown>(`/api/v1/app/books/search?${params.toString()}`));
        return list(page.content).flatMap(book => {
            const id = num(book.id);
            if (id === undefined) return [];
            const authors = (Array.isArray(book.authors) ? book.authors : []).filter((a): a is string => typeof a === 'string' && a !== '');
            const year = /^(\d{4})/.exec(str(book.publishedDate) ?? '')?.[1];
            return [
                {
                    service: this.id,
                    source,
                    kind: 'book' as const,
                    id: String(id),
                    title: this.#bookTitle(str(book.title), authors),
                    ...(year === undefined ? {} : { year: Number(year) }),
                    ids: {}
                }
            ];
        });
    }

    /**
     * Every book, one row each, for `get_library`. Paged until Grimmory says
     * there is no next page, the page count it reported is reached, or a page
     * comes back empty. Past `MAX_LIBRARY_PAGES` it throws rather than loop.
     *
     * `monitored: false` because Grimmory has no monitoring; `get_library` does
     * not print it for a book. A book has no external id, so `ids` is empty and
     * it never merges with another row.
     */
    async listLibrary(): Promise<IndexInput[]> {
        // Read once, before the pages: a book names its library by id only. A
        // failure here fails the read rather than leaving every book unlabelled,
        // which a `library` filter would then answer as "none".
        const libraryNames = new Map<number, string>();
        for (const lib of list(await this.#http.get<unknown>(LIBRARIES_PATH))) {
            const id = num(lib.id);
            const name = str(lib.name);
            if (id !== undefined && name !== undefined) libraryNames.set(id, name);
        }
        const out: IndexInput[] = [];
        for await (const rows of this.#bookPages()) {
            for (const book of rows) {
                const id = num(book.id);
                if (id === undefined) continue;
                const authors = (Array.isArray(book.authors) ? book.authors : []).filter((a): a is string => typeof a === 'string' && a !== '');
                const quality = fileType(book.primaryFileType);
                const sizeKb = num(book.fileSizeKb);
                const addedAt = isoDate(book.addedOn);
                const libraryId = num(book.libraryId);
                const libraryName = libraryId === undefined ? undefined : libraryNames.get(libraryId);
                out.push({
                    kind: 'book',
                    title: this.#bookTitle(str(book.title), authors),
                    ...(libraryName === undefined ? {} : { library: this.#fence(libraryName, 'library_name') }),
                    ids: {},
                    // Absent `readStatus` is UNSET; only READ counts as watched.
                    playback: { user: BOOK_ACCOUNT_LABEL, watched: book.readStatus === 'READ' },
                    acquisition: {
                        service: this.id,
                        id: String(id),
                        monitored: false,
                        hasFile: book.primaryFileId !== undefined && book.primaryFileId !== null,
                        ...(quality === undefined ? {} : { quality }),
                        ...(sizeKb === undefined ? {} : { sizeBytes: sizeKb * 1024 }),
                        ...(addedAt === undefined ? {} : { addedAt })
                    }
                });
            }
        }
        return out;
    }

    /**
     * Every page of the app book list, one array of rows per page. Stops when
     * Grimmory says there is no next page, the page count it reported is
     * reached, or a page comes back empty. Past `MAX_LIBRARY_PAGES` it throws.
     */
    async *#bookPages(): AsyncGenerator<Raw[]> {
        for (let page = 0; ; page += 1) {
            if (page >= MAX_LIBRARY_PAGES) {
                throw new ServiceError(
                    'UpstreamError',
                    this.id,
                    `the book list did not end within ${MAX_LIBRARY_PAGES} pages of ${LIBRARY_PAGE_SIZE} (${MAX_LIBRARY_PAGES * LIBRARY_PAGE_SIZE} books)`
                );
            }
            const params = new URLSearchParams({ page: String(page), size: String(LIBRARY_PAGE_SIZE) });
            const body = obj(await this.#http.get<unknown>(`/api/v1/app/books?${params.toString()}`));
            const rows = list(body.content);
            yield rows;
            const totalPages = num(body.totalPages);
            if (body.hasNext !== true || rows.length === 0 || (totalPages !== undefined && page + 1 >= totalPages)) return;
        }
    }

    /**
     * Books worth a look: a match score under `threshold`. A book with a fine
     * score but no ISBN is complete enough to read and is not listed; its
     * metadata matched, it just lacks an id. For a listed book with no ISBN on
     * its list row, the book itself is read once to check the catalogue ids,
     * so the row can say `fix_metadata` will search by title and author. A
     * book with no score is not listed.
     */
    async listBookMetadataIssues(threshold: number): Promise<{ issues: BookMetadataIssue[]; scanned: number }> {
        const issues: BookMetadataIssue[] = [];
        let scanned = 0;
        for await (const rows of this.#bookPages()) {
            for (const book of rows) {
                const id = num(book.id);
                if (id === undefined) continue;
                scanned += 1;
                const score = num(book.metadataMatchScore);
                if (score === undefined || score >= threshold) continue;
                let hasIdentifier = str(book.isbn13) !== undefined || str(book.isbn10) !== undefined;
                let idsUnknown = false;
                if (!hasIdentifier) {
                    try {
                        const meta = obj(obj(await this.#http.get<unknown>(`/api/v1/books/${encodeURIComponent(String(id))}`)).metadata);
                        hasIdentifier = BOOK_CATALOGUE_IDS.some(key => str(meta[key]) !== undefined);
                    } catch (err) {
                        // A login or connection failure ends the sweep. One book that cannot be read
                        // (deleted since the list, a timeout) is still listed for its score.
                        if (!(err instanceof ServiceError) || !PER_BOOK_FAILURES.has(err.kind)) throw err;
                        idsUnknown = true;
                    }
                }
                const reason = `low match score (${score})` + (hasIdentifier || idsUnknown ? '' : ' and no ISBN or catalogue id');
                const authors = (Array.isArray(book.authors) ? book.authors : []).filter((a): a is string => typeof a === 'string' && a !== '');
                issues.push({
                    id: String(id),
                    title: this.#bookTitle(str(book.title), authors),
                    matchScore: score,
                    hasIdentifier,
                    reason,
                    // On the list row itself; absent means not fully locked.
                    allLocked: book.allMetadataLocked === true
                });
            }
        }
        return { issues, scanned };
    }

    async getMediaDetails(id: string): Promise<MediaDetails> {
        const book = obj(await this.#http.get<unknown>(`/api/v1/books/${encodeURIComponent(id)}`));
        const meta = obj(book.metadata);
        const authors = (Array.isArray(meta.authors) ? meta.authors : []).filter((a): a is string => typeof a === 'string' && a !== '');
        const primary = book.primaryFile === undefined ? undefined : obj(book.primaryFile);
        const files = [...(primary === undefined ? [] : [primary]), ...list(book.alternativeFormats)];
        const formats = files.map(f => {
            const sizeKb = num(f.fileSizeKb);
            const format = fileType(f.bookType) ?? fileType(str(f.extension)?.toUpperCase()) ?? 'UNKNOWN';
            return {
                format,
                fileName: this.#fence(str(f.fileName) ?? 'unnamed', 'file_name'),
                ...(sizeKb === undefined ? {} : { sizeBytes: sizeKb * 1024 })
            };
        });
        const year = /^(\d{4})/.exec(str(meta.publishedDate) ?? '')?.[1];
        const primaryPath = str(primary?.filePath) ?? str(primary?.fileName);
        const primarySize = num(primary?.fileSizeKb);
        const series = str(meta.seriesName);
        const seriesNumber = num(meta.seriesNumber);
        const isbn13 = identifier(meta.isbn13);
        const asin = identifier(meta.asin);
        const score = num(book.metadataMatchScore);
        const addedOn = isoDate(book.addedOn);
        return {
            service: this.id,
            kind: 'book',
            id: String(book.id ?? id),
            title: this.#fence(str(meta.title) ?? 'untitled', 'title'),
            ...(year === undefined ? {} : { year: Number(year) }),
            hasFile: primary !== undefined,
            ...(primarySize === undefined ? {} : { sizeBytes: primarySize * 1024 }),
            ...(primaryPath === undefined ? {} : { path: this.#fence(primaryPath.split(/[\\/]/).pop() ?? primaryPath, 'path') }),
            ids: {},
            book: {
                authors: authors.map(a => this.#fence(a, 'author')),
                ...(series === undefined ? {} : { series: this.#fence(series, 'series') }),
                ...(seriesNumber === undefined ? {} : { seriesNumber }),
                library: this.#fence(str(book.libraryName) ?? `#${String(book.libraryId ?? '')}`, 'library_name'),
                formats,
                ...(isbn13 === undefined ? {} : { isbn13 }),
                ...(asin === undefined ? {} : { asin }),
                ...(score === undefined ? {} : { matchScore: score }),
                ...(addedOn === undefined ? {} : { addedOn })
            }
        };
    }

    /**
     * Grimmory's bulk delete takes `ids` and always deletes the files. It
     * answers with the ids it deleted and the ones whose files it could not.
     */
    async deleteBook(id: string): Promise<BookDeletion> {
        const body = await this.#write('delete books', 'canDeleteBook', `book ${id}`, () =>
            this.#http.deleteForBody<unknown>(`/api/v1/books?ids=${encodeURIComponent(id)}`)
        );
        const holds = (key: string) => {
            const ids = obj(body)[key];
            return Array.isArray(ids) && ids.some(v => Number(v) === Number(id));
        };
        return { deleted: holds('deleted'), filesLeft: holds('failedFileDeletions') };
    }

    /** The read status of one book, for the account this adapter signs in as. */
    async readBookReadStatus(id: string): Promise<BookReadState> {
        const book = obj(
            await this.#write('read books', 'library access', `book ${id}`, () => this.#http.get<unknown>(`/api/v1/books/${encodeURIComponent(id)}`))
        );
        const authors = (Array.isArray(obj(book.metadata).authors) ? (obj(book.metadata).authors as unknown[]) : []).filter(
            (a): a is string => typeof a === 'string' && a !== ''
        );
        return { id, title: this.#bookTitle(str(obj(book.metadata).title), authors), readStatus: str(book.readStatus) ?? 'UNSET' };
    }

    /** READ sets the finish date to now; UNREAD clears it. */
    async setBookReadStatus(id: string, status: 'READ' | 'UNREAD'): Promise<void> {
        await this.#write('change read status', 'access to that book', `book ${id}`, () =>
            this.#http.post<unknown>('/api/v1/books/status', { bookIds: [Number(id)], status }, true)
        );
    }

    /** A book's metadata, which fields are locked, and whether all of them are. */
    async readBookMetadata(id: string): Promise<BookMetadataState> {
        const book = obj(
            await this.#write('read book metadata', 'canEditMetadata', `book ${id}`, () => this.#http.get<unknown>(`/api/v1/books/${encodeURIComponent(id)}`))
        );
        const meta = obj(book.metadata);
        const fields = bookFields(meta);
        return {
            id,
            label: this.#bookTitle(fields.title, fields.authors ?? []),
            fields,
            locked: BOOK_FIELD_ORDER.filter(key => meta[`${key}Locked`] === true),
            allLocked: meta.allMetadataLocked === true
        };
    }

    /**
     * Asks every enabled metadata provider about one book. Read-only on
     * Grimmory's side, though it answers as an event stream, read whole.
     */
    async findBookCandidates(id: string, search: BookSearch): Promise<BookCandidate[]> {
        const providers = list(
            await this.#write('look up book metadata', 'canEditMetadata', `book ${id}`, () => this.#http.get<unknown>('/api/v1/metadata/providers'))
        )
            .filter(p => p.enabled === true)
            .flatMap(p => str(p.name) ?? []);
        if (providers.length === 0) {
            throw new ServiceError('NotFound', this.id, 'Grimmory has no metadata provider enabled', { remedy: "Turn one on in Grimmory's metadata settings." });
        }
        const body = {
            bookId: Number(id),
            providers,
            ...(search.isbn === undefined ? {} : { isbn: search.isbn }),
            ...(search.title === undefined ? {} : { title: search.title }),
            ...(search.author === undefined ? {} : { author: search.author })
        };
        const text = await this.#write('look up book metadata', 'canEditMetadata', `book ${id}`, () =>
            this.#http.postText(`/api/v1/books/${encodeURIComponent(id)}/metadata/prospective`, body, { timeoutMs: PROSPECTIVE_TIMEOUT_MS })
        );
        return parseEventStream(text).flatMap(value => {
            const raw = obj(value);
            if (Object.keys(raw).length === 0) return [];
            const provider = str(raw.provider);
            return [{ ...(provider === undefined ? {} : { provider }), fields: bookFields(raw) }];
        });
    }

    /**
     * Sets the given fields and clears the `clear` ones. The server skips a
     * locked field, and with REPLACE_WHEN_PROVIDED leaves every absent one as it is.
     */
    async writeBookMetadata(id: string, fields: BookFields, clear: BookField[] = []): Promise<void> {
        const body = { metadata: { bookId: Number(id), ...fields }, clearFlags: Object.fromEntries(clear.map(f => [f, true])) };
        await this.#write('edit book metadata', 'canEditMetadata', `book ${id}`, () =>
            this.#http.put<unknown>(`/api/v1/books/${encodeURIComponent(id)}/metadata?replaceMode=REPLACE_WHEN_PROVIDED&mergeCategories=false`, body, true)
        );
    }

    async setBookFieldLocks(id: string, fields: BookField[], lock: boolean): Promise<void> {
        const fieldActions = Object.fromEntries(fields.map(f => [`${f}Locked`, lock ? 'LOCK' : 'UNLOCK']));
        await this.#write('lock book metadata', 'canEditMetadata', `book ${id}`, () =>
            this.#http.put<unknown>('/api/v1/books/metadata/toggle-field-locks', { bookIds: [Number(id)], fieldActions }, true)
        );
    }

    /**
     * Runs one write and turns the two refusals a Grimmory account can meet
     * into an answer that names what to change. Every Grimmory write goes
     * through here, so a 403 always names the permission that was missing and a
     * 404 the thing that was not found.
     *
     * @param what what the account tried to do, as in "may not rescan a library"
     * @param permission the Grimmory user permission that allows it
     * @param missing what a 404 means is absent, as in "library 3"
     */
    async #write<T>(what: string, permission: string, missing: string, call: () => Promise<T>, remedy?: string): Promise<T> {
        try {
            return await call();
        } catch (error) {
            if (error instanceof ServiceError && error.detail.startsWith('HTTP 403')) {
                throw new ServiceError('AuthFailed', this.id, `this Grimmory account may not ${what}`, {
                    remedy: `Give it ${permission} in Grimmory's user settings, or use an admin account.`,
                    cause: error
                });
            }
            if (error instanceof ServiceError && error.kind === 'NotFound') {
                throw new ServiceError('NotFound', this.id, `Grimmory has no ${missing}`, {
                    remedy:
                        remedy ??
                        'A book id is `acquisition.id` on get_library; a library is listed by stack_health and get_library.',
                    cause: error
                });
            }
            throw error;
        }
    }

    /**
     * Deleted books, metadata changes and library scans, read from the audit
     * log (admin only). Logins, users, settings and tasks are never asked for.
     * Each action is paged on its own, so the newest rows of a quiet action are
     * not crowded out by a busy one. `since` is sent as an offset-free UTC
     * `from`; Grimmory reads a LocalDateTime in its own zone, which a Docker
     * image keeps at UTC unless TZ says otherwise. `id` scopes to one book and
     * answers an array, though a deleted-book row names no id (its entity is
     * null), so a delete never matches.
     */
    async readHistory(opts: HistoryQuery): Promise<HistoryEntry[] | Window<HistoryEntry>> {
        const scoped = opts.id !== undefined;
        const actions = (Object.keys(GRIMMORY_HISTORY_ACTIONS) as GrimmoryAuditAction[]).filter(
            action => (opts.eventType === undefined || GRIMMORY_HISTORY_ACTIONS[action] === opts.eventType) && !(scoped && action === 'LIBRARY_SCANNED')
        );
        if (actions.length === 0) return [];
        const sinceMs = opts.since === undefined ? undefined : auditInstant(opts.since);
        const from = sinceMs === undefined || !Number.isFinite(sinceMs) ? undefined : new Date(sinceMs).toISOString().slice(0, 19);
        const size = Math.min(opts.want ?? AUDIT_PAGE_SIZE, AUDIT_PAGE_SIZE);

        const reads = await Promise.all(actions.map(action => this.#auditRows(action, { from, size, want: opts.want, id: opts.id, sinceMs })));
        const entries = reads.flatMap(r => r.entries).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
        if (scoped) return entries;
        return { items: opts.want === undefined ? entries : entries.slice(0, opts.want), total: reads.reduce((sum, r) => sum + r.total, 0) };
    }

    /** One action's rows, newest first, paged until `want` are kept, the pages run out or `MAX_AUDIT_PAGES` is reached. */
    async #auditRows(
        action: GrimmoryAuditAction,
        o: { from: string | undefined; size: number; want: number | undefined; id: string | undefined; sinceMs: number | undefined }
    ): Promise<{ entries: HistoryEntry[]; total: number }> {
        const entries: HistoryEntry[] = [];
        let total = 0;
        for (let page = 0; page < MAX_AUDIT_PAGES; page += 1) {
            const params = new URLSearchParams({ action, page: String(page), size: String(o.size) });
            if (o.from !== undefined) params.set('from', o.from);
            let body: Raw;
            try {
                body = obj(await this.#http.get<unknown>(`${AUDIT_PATH}?${params.toString()}`));
            } catch (error) {
                if (error instanceof ServiceError && error.detail.startsWith('HTTP 403')) {
                    throw new ServiceError('AuthFailed', this.id, 'this Grimmory account may not read the audit log', {
                        remedy: 'The audit log needs a Grimmory admin account.',
                        cause: error
                    });
                }
                throw error;
            }
            const rows = list(body.content);
            const info = obj(body.page);
            if (page === 0) total = num(info.totalElements) ?? rows.length;
            for (const raw of rows) {
                const entry = this.#auditEntry(action, raw);
                if (entry === undefined) continue;
                if (o.sinceMs !== undefined && Date.parse(entry.at) < o.sinceMs) continue;
                if (o.id !== undefined && !(isBookEntity(raw.entityType) && String(raw.entityId) === o.id)) continue;
                entries.push(entry);
            }
            const totalPages = num(info.totalPages);
            if (rows.length === 0 || totalPages === undefined || page + 1 >= totalPages || (o.want !== undefined && entries.length >= o.want)) break;
        }
        return { entries, total };
    }

    #auditEntry(action: GrimmoryAuditAction, raw: Raw): HistoryEntry | undefined {
        const id = num(raw.id);
        const at = auditTime(raw.createdAt);
        if (id === undefined || at === undefined) return undefined;
        const entityId = num(raw.entityId);
        const description = str(raw.description);
        const onBook = action !== 'LIBRARY_SCANNED' && isBookEntity(raw.entityType) && entityId !== undefined;
        const plain = action === 'LIBRARY_SCANNED' ? `library ${entityId ?? ''}`.trim() : onBook ? `book ${entityId}` : 'book';
        return {
            service: this.id,
            id: String(id),
            at,
            event: GRIMMORY_HISTORY_ACTIONS[action],
            rawEvent: action,
            // Grimmory's own description. On 3.5.0 a delete logs a count ("Deleted 1 book(s)"), not the
            // title, and the row has no book id, so it names no book.
            title: description === undefined ? plain : this.#fence(description, 'description'),
            ...(onBook ? { mediaId: String(entityId) } : {})
        };
    }

    async listBookLibraries(): Promise<BookLibrary[]> {
        return list(await this.#http.get<unknown>(LIBRARIES_PATH)).flatMap(lib => {
            const id = num(lib.id);
            if (id === undefined) return [];
            const name = str(lib.name) ?? `#${String(id)}`;
            return [{ id: String(id), name, label: this.#fence(name, 'library_name'), watch: lib.watch === true }];
        });
    }

    async refreshBookLibrary(id: string): Promise<void> {
        await this.#write('rescan a library', 'canManageLibrary', `library ${id}`, () =>
            this.#http.put<unknown>(`${LIBRARIES_PATH}/${encodeURIComponent(id)}/refresh`, undefined, true)
        );
    }

    async rescanBookdrop(): Promise<void> {
        await this.#write('rescan the Bookdrop', 'canAccessBookdrop', 'Bookdrop', () =>
            this.#http.post<unknown>('/api/v1/bookdrop/rescan', undefined, true)
        );
    }

    /** One page of the files waiting in the Bookdrop. */
    async #bookdropPage(page: number, size: number): Promise<Raw> {
        return obj(await this.#http.get<unknown>(`/api/v1/bookdrop/files?status=pending&page=${page}&size=${size}`));
    }

    /**
     * The Bookdrop's pending files, one row each. Paged until Grimmory's
     * `page.totalPages` is reached or a page comes back empty; past
     * `MAX_BOOKDROP_PAGES` it throws. A 403 fails by name rather than read as
     * an empty Bookdrop.
     */
    async getQueue(): Promise<QueueItem[]> {
        const out: QueueItem[] = [];
        for (let page = 0; ; page += 1) {
            if (page >= MAX_BOOKDROP_PAGES) {
                throw new ServiceError(
                    'UpstreamError',
                    this.id,
                    `the Bookdrop did not end within ${MAX_BOOKDROP_PAGES} pages of ${BOOKDROP_PAGE_SIZE} (${MAX_BOOKDROP_PAGES * BOOKDROP_PAGE_SIZE} files)`
                );
            }
            const body = await this.#write('read the Bookdrop', 'canAccessBookdrop', 'Bookdrop', () => this.#bookdropPage(page, BOOKDROP_PAGE_SIZE));
            const rows = list(body.content);
            for (const file of rows) {
                const id = num(file.id);
                if (id === undefined) continue;
                const addedAt = isoDate(file.createdAt);
                out.push({
                    service: this.id,
                    id: String(id),
                    title: this.#fence(str(file.fileName) ?? 'unnamed', 'file_name'),
                    status: 'pending review',
                    ...(addedAt === undefined ? {} : { addedAt })
                });
            }
            const totalPages = num(obj(body.page).totalPages);
            if (rows.length === 0 || totalPages === undefined || page + 1 >= totalPages) return out;
        }
    }

    /** Deletes the file from disk and takes it off the Bookdrop; Grimmory has no keep-the-file discard. */
    async removeQueueItem(id: string, _opts: RemoveQueueOptions): Promise<void> {
        await this.#write(
            'discard Bookdrop files',
            'canAccessBookdrop',
            `Bookdrop file ${id}`,
            () => this.#http.post<unknown>('/api/v1/bookdrop/files/discard', discardBody(Number(id)), true),
            'The file may already have been imported or discarded in Grimmory. get_queue lists what is waiting.'
        );
    }

    async #bookdropFinding(): Promise<HealthCheck | undefined> {
        const pending = Number(obj(await this.#http.get<unknown>('/api/v1/bookdrop/notification')).pendingCount);
        if (!(pending > 0)) return undefined;
        const page = await this.#bookdropPage(0, 50);
        const times = list(page.content)
            .map(f => Date.parse(String(f.createdAt)))
            .filter(t => Number.isFinite(t));
        if (times.length === 0) return undefined;
        const oldest = Math.min(...times);
        if (this.#now() - oldest <= BOOKDROP_STALE_MS) return undefined;
        const day = new Date(oldest).toISOString().slice(0, 10);
        return {
            service: this.id,
            source: 'bookdrop',
            type: 'warning',
            message: `${pending} ${pending === 1 ? 'book has' : 'books have'} been waiting in the Bookdrop since ${day}.`
        };
    }
}
