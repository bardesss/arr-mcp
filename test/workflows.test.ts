import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..');
const dir = join(root, '.github/workflows');

interface Step {
    name?: string;
    uses?: string;
    run?: string;
    with?: Record<string, string>;
}
interface Job {
    permissions?: Record<string, string>;
    steps?: Step[];
}
interface Workflow {
    on: Record<string, unknown>;
    permissions?: Record<string, string>;
    jobs: Record<string, Job>;
}

const wf = (f: string): Workflow => parse(readFileSync(join(dir, f), 'utf8')) as Workflow;
const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));
const buildSteps = (f: string): Step[] =>
    Object.values(wf(f).jobs).flatMap((j) => (j.steps ?? []).filter((s) => s.uses?.startsWith('docker/build-push-action@')));

describe('the GitHub workflows', () => {
    it('runs CI on pull requests only; release.yml builds main', () => {
        expect(Object.keys(wf('ci.yml').on)).toEqual(['pull_request']);
    });

    it('interpolates no expression into a shell script', () => {
        for (const file of files) {
            for (const job of Object.values(wf(file).jobs)) {
                for (const step of job.steps ?? []) {
                    if (step.run === undefined) continue;
                    expect(step.run, `${file} ${step.name ?? step.run.slice(0, 40)}`).not.toContain('${{');
                }
            }
        }
    });

    it('caches every image build under its own scope', () => {
        const scopes: Record<string, string[]> = { 'ci.yml': ['amd64', 'arm64'], 'release.yml': ['release'], 'preview.yml': ['preview'] };
        for (const [file, expected] of Object.entries(scopes)) {
            const steps = buildSteps(file);
            expect(steps, file).toHaveLength(expected.length);
            steps.forEach((step, i) => {
                expect(step.with?.['cache-from'], file).toMatch(/type=gha,scope=\S+/);
                // #551: a token that cannot write the cache must not fail the build
                expect(step.with?.['cache-to'], file).toMatch(/^type=gha,mode=max,scope=\S+,ignore-error=true$/);
                expect(step.with?.['cache-to'], file).toContain(`scope=${expected[i]},`);
            });
        }
    });

    it('grants release permissions per job', () => {
        const release = wf('release.yml');
        expect(release.permissions).toEqual({});
        for (const [name, job] of Object.entries(release.jobs)) expect(job.permissions, name).toBeTypeOf('object');
        expect(release.jobs['image']!.permissions).toEqual({
            contents: 'read',
            packages: 'write',
            'id-token': 'write',
            attestations: 'write'
        });
        expect(release.jobs['release-please']!.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' });
    });
});
