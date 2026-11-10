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
    const declared =
      /^export (?:const|function|async function|class|type|interface|let|abstract class) ([A-Za-z_$][\w$]*)/gm;
    const idents = new Map<string, Set<string>>();
    const declarations: Array<{ file: string; name: string }> = [];
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      idents.set(f, new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []));
      if (!f.startsWith(`src${sep}`)) continue;
      for (const m of text.matchAll(declared)) declarations.push({ file: f, name: m[1]! });
    }
    const unused: string[] = [];
    for (const { file, name } of declarations) {
      const pair = `${file.split(sep).join('/')} ${name}`;
      if (ALLOWED.has(pair)) continue;
      if (!files.some((o) => o !== file && idents.get(o)!.has(name))) unused.push(pair);
    }
    expect(unused, 'exported but used by no other file: drop the export, or add "file NAME" to ALLOWED').toEqual([]);
  }, 60_000);
});
