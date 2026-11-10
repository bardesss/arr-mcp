import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const GENERATED = `src${sep}services${sep}generated`;

// `file NAME` pairs that stay exported on purpose. Empty until a name has a reason.
const ALLOWED = new Set<string>();

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|mjs)$/.test(e.name))
    .map((e) => relative(ROOT, join(e.parentPath, e.name)))
    .filter((f) => !f.startsWith(GENERATED));
}

describe('exports', () => {
  it('exports nothing that only its own module uses', () => {
    const files = ['src', 'test', 'scripts'].flatMap(sources);
    const idents = new Map<string, Set<string>>();
    for (const f of files) {
      idents.set(f, new Set(readFileSync(join(ROOT, f), 'utf8').match(/[A-Za-z_$][\w$]*/g) ?? []));
    }
    const declared =
      /^export (?:const|function|async function|class|type|interface|let|abstract class) ([A-Za-z_$][\w$]*)/gm;
    const unused: string[] = [];
    for (const f of files.filter((p) => p.startsWith(`src${sep}`))) {
      for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(declared)) {
        const name = m[1]!;
        const pair = `${f.split(sep).join('/')} ${name}`;
        if (ALLOWED.has(pair)) continue;
        const usedElsewhere = files.some((o) => o !== f && idents.get(o)!.has(name));
        if (!usedElsewhere) unused.push(pair);
      }
    }
    expect(unused).toEqual([]);
  });
});
