import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

/**
 * A UTF-8 byte order mark. Node strips it when `require`-ing JSON, and npm and
 * tsc tolerate it — but `JSON.parse` does not, and release-please parses
 * package.json that way. So a BOM here fails the *release*, days after it
 * passes lint, tests and the Docker build.
 *
 * That is exactly what happened: PowerShell's `Set-Content -Encoding UTF8`
 * writes a BOM on Windows, one edit to package.json broke releases, and every
 * other gate stayed green. This test is the gate that would have caught it.
 */
const BOM = '﻿';

/** Root-level JSON is what the toolchain reads: npm, tsc, release-please. */
async function rootJsonFiles(): Promise<string[]> {
    const entries = await readdir(ROOT, { withFileTypes: true });
    return entries
        .filter(e => e.isFile() && e.name.endsWith('.json'))
        .map(e => e.name)
        .sort();
}

/**
 * `tsconfig*.json` is JSONC — it carries `//` comments on purpose, and tsc
 * parses it that way. Only these are read by strict `JSON.parse` consumers,
 * so only these have to survive it.
 */
const isStrictJson = (name: string) => !name.startsWith('tsconfig');

/**
 * Sequences that appear when UTF-8 is read as Latin-1 and written back — the
 * signature of a tool that guessed the encoding. `—` becomes `â€"`, `é`
 * becomes `Ã©`. Twice during Phase 2 a PowerShell `Set-Content -Encoding utf8`
 * did exactly this to a source file, and nothing caught it: the code still
 * compiled, the tests still passed, and only the comments were wrong.
 */
const MOJIBAKE = /Ã.|â€|Â[^\s]/;

/**
 * This file is skipped by the mojibake scan below: it has to contain the
 * corrupted sequences in order to test for them. Everything else is fair game.
 */
const SELF = 'encoding.test.ts';

async function sourceFiles(dir: string, out: string[] = []): Promise<string[]> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === 'generated' || entry.name === 'node_modules' || entry.name === SELF) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await sourceFiles(path, out);
        else if (/\.(ts|mjs)$/.test(entry.name)) out.push(path);
    }
    return out;
}

/**
 * Every source file, read once and concurrently, shared by both scans below.
 *
 * It used to be a serial `await readFile` inside a loop, run twice — once per
 * scan. That is ~180 sequential round trips, which was comfortable at Phase 3
 * and started intermittently blowing vitest's 5s default timeout once Phase 4
 * added enough files, but *only* under the full suite, where every other test
 * file is competing for the same disk. A gate that fails on a busy machine
 * rather than on a real BOM is a gate people learn to re-run rather than read.
 */
let cached: Promise<{ file: string; text: string }[]> | undefined;

const allSources = async (): Promise<{ file: string; text: string }[]> => {
    cached ??= (async () => {
        const files = (await Promise.all(['src', 'test', 'scripts'].map(d => sourceFiles(join(ROOT, d))))).flat();
        return Promise.all(files.map(async file => ({ file, text: await readFile(file, 'utf8') })));
    })();
    return cached;
};

describe('source file encoding', () => {
    it('has no byte order mark in any source file', async () => {
        const offenders = (await allSources()).filter(s => s.text.startsWith(BOM)).map(s => s.file);
        expect(offenders).toEqual([]);
    });

    it('has no mojibake from a tool that guessed the encoding', async () => {
        const offenders = (await allSources()).filter(s => MOJIBAKE.test(s.text)).map(s => s.file);
        expect(offenders).toEqual([]);
    });

    // The scans above are only meaningful if they actually saw the tree.
    it('scanned a plausible number of source files', async () => {
        expect((await allSources()).length).toBeGreaterThan(50);
    });

    it('detects the corruption it is looking for', () => {
        // The exact damage seen: an em-dash round-tripped through Latin-1.
        expect(MOJIBAKE.test('never by pattern â€” for the same reason')).toBe(true);
        expect(MOJIBAKE.test('never by pattern — for the same reason')).toBe(false);
    });
});

describe('repository JSON encoding', () => {
    it('finds the config files it is supposed to be guarding', async () => {
        const files = await rootJsonFiles();
        expect(files).toContain('package.json');
        expect(files).toContain('release-please-config.json');
        expect(files).toContain('.release-please-manifest.json');
    });

    it('has no byte order mark in any root JSON file', async () => {
        const offenders: string[] = [];
        for (const name of await rootJsonFiles()) {
            const raw = await readFile(join(ROOT, name), 'utf8');
            if (raw.startsWith(BOM)) offenders.push(name);
        }
        expect(offenders).toEqual([]);
    });

    it('parses strict-JSON config files the way release-please does', async () => {
        const files = (await rootJsonFiles()).filter(isStrictJson);
        expect(files.length).toBeGreaterThan(0);

        for (const name of files) {
            const raw = await readFile(join(ROOT, name), 'utf8');
            expect(() => JSON.parse(raw) as unknown, `${name} is not valid JSON`).not.toThrow();
        }
    });
});
