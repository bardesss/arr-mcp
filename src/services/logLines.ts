import { fenceText } from '../core/fence.ts';
import type { LogEntry } from './types.ts';

/**
 * Raw lines read before folding. A client failing every two seconds writes a
 * pair of lines each time and fills this in under a minute, which can push out
 * the line that explains the failure. `read` and `total` say how far it got.
 */
export const LOG_LINES = 50;

/**
 * A numeric date and time, in the orders and separators locales write them in.
 * Only the fold key is masked: a recurring warning that quotes a time would
 * otherwise never repeat. A four-digit year keeps IP addresses and versions out,
 * because a difference in those is often what the log is there to show. A format
 * this misses only folds less.
 */
const LOG_DATE_TIME = /(?<![\d.])(?:\d{4}[/.-]\d{1,2}[/.-]\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4})[ T]\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:\s?[AP]M)?(?:Z|[+-]\d{2}(?::?\d{2})?)?(?!\d)/gi;

/**
 * A credential quoted in a URL or a header. The *arrs cleanse their own logs,
 * but Seerr and Bazarr make no such promise and a failed request is exactly what
 * a log line quotes, while `stack_health` promises no API key comes back. `(removed)`
 * is what the *arrs write in the same place, so every service reads alike.
 */
const LOG_CREDENTIAL = /\b((?:[a-z_-]*api[_-]?key|(?:access[_-]?)?token|passkey|password|passwd)["']?\s*[=:]\s*["']?)[^\s"'&,;}]+/gi;

/** An `Authorization` header's value. The scheme stays: it says what kind of login failed. */
const LOG_AUTHORIZATION = /\b(authorization["']?\s*[=:]\s*["']?(?:(?:bearer|basic|token)\s+)?)[^\s"'&,;}]+/gi;

/** A bearer token with no header name. Sixteen characters keeps "Bearer token rejected" as written. */
const LOG_BEARER = /\b(bearer\s+)[a-z0-9._~+/-]{16,}=*/gi;

/** Credentials in a URL's authority, whether `user:password@` or a lone token. A port or a later `@` is not one. */
const LOG_URL_CREDENTIAL = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

const removeCredentials = (message: string): string =>
    message
        .replace(LOG_URL_CREDENTIAL, '$1(removed)@')
        .replace(LOG_AUTHORIZATION, '$1(removed)')
        .replace(LOG_BEARER, '$1(removed)')
        .replace(LOG_CREDENTIAL, '$1(removed)');

/** One line of a service's log, with its own field names already mapped. */
export type LogLine = {
    time: string;
    level: string;
    logger: string;
    message: string;
    exceptionType?: string | null | undefined;
};

/** Takes lines newest first, and folds those differing only in a date-time into one row with a count. */
export function foldLogLines(lines: readonly LogLine[], id: string): LogEntry[] {
    const folded = new Map<string, LogEntry>();
    for (const line of lines) {
        const message = removeCredentials(line.message);
        const key = `${line.level}\u0000${line.logger}\u0000${message.replace(LOG_DATE_TIME, '\u0000')}`;
        const seen = folded.get(key);
        if (seen !== undefined) {
            // Rows arrive newest first, so a later row only moves firstSeen back.
            seen.count++;
            seen.firstSeen = line.time;
            continue;
        }
        folded.set(key, {
            service: id,
            level: line.level,
            logger: line.logger,
            // Log lines quote hosts, paths, release names and indexer errors.
            message: fenceText(message, { service: id, field: 'message' }),
            ...(line.exceptionType ? { exceptionType: fenceText(line.exceptionType, { service: id, field: 'exceptionType' }) } : {}),
            count: 1,
            firstSeen: line.time,
            lastSeen: line.time
        });
    }
    return [...folded.values()];
}
