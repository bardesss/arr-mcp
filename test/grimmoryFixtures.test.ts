import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(process.cwd(), 'test', 'fixtures', 'grimmory');
const PATH_KEYS = new Set(['filePath', 'path', 'fileSubPath']);
/** Row ids of Grimmory itself, not catalogue ids. */
const STRUCTURAL_IDS = new Set(['id', 'bookId', 'libraryId', 'primaryFileId', 'libraryPathId', 'fileId']);
const FORBIDDEN_KEYS = new Set(['email', 'accessToken', 'refreshToken']);

/** Every `[key, value]` pair at every depth, with the object that held it. */
function* walk(value: unknown, holder?: Record<string, unknown>, key?: string): Generator<{ key: string | undefined; value: unknown; holder?: Record<string, unknown> }> {
    yield { key, value, ...(holder === undefined ? {} : { holder }) };
    if (Array.isArray(value)) {
        for (const item of value) yield* walk(item);
    } else if (typeof value === 'object' && value !== null) {
        for (const [k, v] of Object.entries(value)) yield* walk(v, value as Record<string, unknown>, k);
    }
}

describe('committed Grimmory fixtures hold no personal data', () => {
    const files = readdirSync(DIR).filter(f => f.endsWith('.json'));

    it('has the nine captured fixtures', () => {
        expect(files.sort()).toEqual(
            [
                'app-books-page.json',
                'app-books-search.json',
                'book.json',
                'bookdrop-files-pending.json',
                'bookdrop-notification.json',
                'healthcheck.json',
                'libraries-health.json',
                'libraries.json',
                'version.json'
            ].sort()
        );
    });

    for (const file of files) {
        it(`${file} is anonymised`, () => {
            const body: unknown = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
            for (const { key, value, holder } of walk(body)) {
                if (key === undefined) continue;
                expect(FORBIDDEN_KEYS.has(key), `${key} must not appear`).toBe(false);
                if (PATH_KEYS.has(key) && typeof value === 'string') {
                    expect(value.replace(/^\//, ''), `${key}: ${value}`).not.toContain('/');
                }
                if (key === 'title' && typeof value === 'string') expect(value).toMatch(/^Example Book \d+$/);
                if (key === 'name' && typeof value === 'string' && holder !== undefined && 'paths' in holder) expect(value).toMatch(/^Example Library \d+$/);
                if (key === 'authors' && Array.isArray(value)) for (const a of value) expect(a).toMatch(/^Example Author \d+$/);
                if ((key === 'fileName' || key === 'primaryFileName') && typeof value === 'string') expect(value).toMatch(/^Example Book \d+(\.\w+)?$/);
                if (key === 'libraryName') expect(value).toMatch(/^Example Library \d+$/);
                if (key === 'seriesName') expect(value).toMatch(/^Example Series \d+$/);
                if ((key === 'categories' || key === 'tags' || key === 'moods') && Array.isArray(value)) {
                    for (const t of value) expect(t).toMatch(/^Example (Category|Tag|Mood) \d+$/);
                }
                // External catalogue ids resolve to a real book, so only synthetic ones may stay.
                if (typeof value === 'string' && /Id$/.test(key) && !STRUCTURAL_IDS.has(key)) expect(value, key).toMatch(/^example-[a-z0-9]+-\d+$/);
                if (key === 'asin' && typeof value === 'string') expect(value).toMatch(/^example-asin-\d+$/);
                if (key === 'isbn13' && typeof value === 'string') expect(value).toMatch(/^978000000\d{4}$/);
                if (key === 'isbn10' && typeof value === 'string') expect(value).toMatch(/^000000\d{4}$/);
                if (/Rating$/.test(key) && typeof value === 'number') expect(value, key).toBe(4);
                if (/ReviewCount$/.test(key) && typeof value === 'number') expect(value, key).toBe(100);
                if (key === 'pageCount' && typeof value === 'number') expect(value).toBe(300);
                if (key === 'publishedDate' && typeof value === 'string') expect(value).toBe('2000-01-01');
                if (key === 'seriesNumber' && typeof value === 'number') expect(value).toBe(1);
                if (/SizeKb$/.test(key) && typeof value === 'number') expect(value, key).toBe(2048);
            }
        });
    }
});
