import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

// better-sqlite3 13 compiles nothing at install time — it bundles a prebuilt
// .node per platform, and the aarch64 one imports fmod@GLIBC_2.38 while amd64
// tops out at GLIBC_2.34. On bookworm (glibc 2.36) that killed the arm64 image
// at startup and left amd64 working, which is how it reached a Raspberry Pi.
// This compares what the shipped binaries demand against the base image the
// Dockerfile names, so the next prebuild to outgrow it fails here instead.

// The platforms release.yml publishes; the linuxmusl-* prebuilds that also ship
// in the tarball are irrelevant to a Debian base image.
const PLATFORMS = ['linux-x64', 'linux-arm64'];

// glibc is frozen for the life of a Debian suite, so a table is enough. An
// unknown suite fails rather than defaulting — assuming a modern glibc is the
// assumption that produced the bug.
const SUITE_GLIBC: Record<string, [number, number]> = {
    bookworm: [2, 36],
    trixie: [2, 41]
};

type Version = [number, number];

const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1];
const show = (v: Version): string => `${v[0]}.${v[1]}`;

// "GLIBC_2.2.5" and "GLIBC_2.34" both appear; two parts is enough to order them.
const parseSymbolVersion = (tag: string): Version => {
    const [major, minor] = tag.slice('GLIBC_'.length).split('.');
    return [Number(major), Number(minor ?? 0)];
};

const PREBUILD_DIR = join(ROOT, 'node_modules', 'better-sqlite3', 'prebuilds');

// Scanning raw bytes reads the ELF's version-needed strings without an ELF
// parser. Over-matching only makes the assertion stricter, never falsely green.
const requiredGlibc = (platform: string): Version => {
    const bytes = readFileSync(join(PREBUILD_DIR, `${platform}.node`)).toString('latin1');
    const tags = bytes.match(/GLIBC_\d+\.\d+(\.\d+)?/g) ?? [];
    const highest = tags.map(parseSymbolVersion).sort(compare).at(-1);
    if (!highest) throw new Error(`${platform}.node imports no glibc symbols at all`);
    return highest;
};

const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

const baseImages = (): string[] =>
    [...DOCKERFILE.matchAll(/^FROM\s+node:\S+/gm)].map((m) => m[0].replace(/^FROM\s+/, ''));

const glibcFor = (image: string): Version | undefined => {
    const suite = Object.keys(SUITE_GLIBC).find((s) => image.includes(s));
    return suite ? SUITE_GLIBC[suite] : undefined;
};

describe('the Docker base image against better-sqlite3 prebuilds', () => {
    it('still gets its native addon from bundled prebuilds', () => {
        // If better-sqlite3 goes back to compiling at install time, the base
        // image no longer decides this and the tests below measure nothing.
        const shipped = readdirSync(PREBUILD_DIR);
        for (const platform of PLATFORMS) {
            expect(shipped, `better-sqlite3 no longer ships a ${platform} prebuild`).toContain(`${platform}.node`);
        }
    });

    it('names at least one base image', () => {
        expect(baseImages().length).toBeGreaterThan(0);
    });

    it('pins every stage to a suite whose glibc is known', () => {
        for (const image of baseImages()) {
            expect(glibcFor(image), `${image} uses a suite missing from SUITE_GLIBC — add its glibc version`).toBeDefined();
        }
    });

    for (const platform of PLATFORMS) {
        it(`ships a glibc new enough for ${platform}`, () => {
            const required = requiredGlibc(platform);
            for (const image of baseImages()) {
                const provided = glibcFor(image);
                if (!provided) continue; // reported by the test above
                expect(
                    compare(provided, required),
                    `${image} provides glibc ${show(provided)} but ${platform}.node needs ${show(required)}`
                ).toBeGreaterThanOrEqual(0);
            }
        });
    }
});

describe('the Docker build', () => {
    it('installs no compiler, because nothing in the dependency tree compiles', () => {
        const bs3 = JSON.parse(readFileSync(join(ROOT, 'node_modules/better-sqlite3/package.json'), 'utf8')) as { gypfile?: boolean; scripts?: Record<string, string> };
        // gypfile:false is what stops npm running node-gyp on binding.gyp
        expect(bs3.gypfile).toBe(false);
        expect(bs3.scripts?.install).toBeUndefined();
        const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { hasInstallScript?: boolean; dev?: boolean; optional?: boolean; os?: string[] }> };
        const scripted = Object.entries(lock.packages)
            .filter(([, p]) => p.hasInstallScript && !(p.dev && p.optional && p.os?.every(o => o === 'darwin')))
            .map(([k]) => k);
        expect(scripted).toEqual([]);
        // npm ci from the lockfile still node-gyp-rebuilds binding.gyp packages; only --ignore-scripts keeps the compiler out
        expect(DOCKERFILE).toMatch(/^RUN npm ci --ignore-scripts$/m);
        expect(DOCKERFILE).not.toMatch(/\bg\+\+|\bmake\b|python3|build-essential/);
    });

    it('keeps the build context to what the Dockerfile copies', () => {
        const ignored = readFileSync(join(ROOT, '.dockerignore'), 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
        for (const p of ['specs', 'screenshots', 'scripts', 'proxmox', 'unraid', 'assets', 'docs', '*.md']) expect(ignored).toContain(p);
        // every context path a COPY without --from names must survive the ignore list
        const copied = [...DOCKERFILE.matchAll(/^COPY (?!--from)(.+) \S+$/gm)].flatMap(m => m[1]!.split(/\s+/));
        expect(copied).toEqual(['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'src', 'docker-entrypoint.sh']);
        for (const c of copied) expect(ignored.some(i => i === c || (i === '*.md' && c.endsWith('.md')))).toBe(false);
    });
});
