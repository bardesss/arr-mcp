import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The project's copy carries no em dashes, and no en dashes used as dashes:
 * see "Writing" in CONTRIBUTING.md. This covers everything a person or a
 * client reads (tool output, descriptions, the config UI, the docs) and the
 * source comments with it. CHANGELOG.md is release-please's and is left out.
 */
const root = join(import.meta.dirname, '..');

function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
    });
}

const files = [
    ...walk(join(root, 'src')),
    ...readdirSync(join(root, 'docs'))
        .filter(name => name.endsWith('.md'))
        .map(name => join(root, 'docs', name)),
    ...['README.md', 'CONTRIBUTING.md', 'RELEASING.md', 'SECURITY.md'].map(name => join(root, name)),
    ...walk(join(root, '.github', 'ISSUE_TEMPLATE')),
    join(root, 'unraid', 'arr-mcp.xml')
];

describe('writing style', () => {
    it('uses no em dashes or en dashes in source, docs or templates', () => {
        const hits = files.flatMap(file =>
            readFileSync(file, 'utf8')
                .split('\n')
                .flatMap((line, i) => (/[–—]/.test(line) ? [`${relative(root, file)}:${i + 1}`] : []))
        );
        expect(hits).toEqual([]);
    });
});
