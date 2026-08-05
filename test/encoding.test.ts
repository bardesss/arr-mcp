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
