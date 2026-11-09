import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ServiceIdSchema, type ServiceId } from '../src/config/schema.js';

const DISPLAY: Record<ServiceId, string> = {
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  whisparr: 'Whisparr',
  lidarr: 'Lidarr',
  prowlarr: 'Prowlarr',
  bazarr: 'Bazarr',
  jellyfin: 'Jellyfin',
  seerr: 'Seerr',
  sabnzbd: 'SABnzbd',
  nzbget: 'NZBGet',
  transmission: 'Transmission',
  qbittorrent: 'qBittorrent',
  plex: 'Plex',
  profilarr: 'Profilarr',
  cleanuparr: 'Cleanuparr',
  reclaimerr: 'Reclaimerr',
  dispatcharr: 'Dispatcharr',
  shelfmark: 'Shelfmark',
  grimmory: 'Grimmory',
};
const NAMES = Object.values(DISPLAY);

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const pkg = JSON.parse(read('package.json')) as { description: string; overrides: Record<string, string> };
const unraidOverview = /<Overview>([\s\S]*?)<\/Overview>/.exec(read('unraid/arr-mcp.xml'))?.[1] ?? '';
const proxmox = JSON.parse(read('proxmox/json/arr-mcp.json')) as { description: string };
const readmeLine9 = read('README.md').split('\n')[8] ?? '';

interface Body {
  type: string;
  id?: string;
  attributes?: { options?: unknown[]; label?: string };
}
interface Option {
  label: string;
}
const template = (file: string): Body[] =>
  (parse(read(`.github/ISSUE_TEMPLATE/${file}`)) as { body: Body[] }).body;

describe('service lists', () => {
  it('names a display name for every service id', () => {
    expect(Object.keys(DISPLAY).sort()).toEqual([...ServiceIdSchema.options].sort());
  });

  it.each([
    ['package.json description', pkg.description],
    ['unraid Overview', unraidOverview],
    ['proxmox json description', proxmox.description],
    ['README line 9', readmeLine9],
  ])('%s names every service', (_where, text) => {
    for (const name of NAMES) expect(text).toMatch(new RegExp(`\\b${name}\\b`));
  });

  it.each(['bug_report.yml', 'feature_request.yml'])('%s offers a checkbox per service', (file) => {
    const item = template(file).find((b) => b.type === 'checkboxes' && b.id === 'services');
    const labels = ((item?.attributes?.options ?? []) as Option[]).map((o) => o.label);
    expect([...labels].sort()).toEqual([...NAMES].sort());
  });

  it('the bug template describes the current access model', () => {
    const t = read('.github/ISSUE_TEMPLATE/bug_report.yml');
    expect(t).not.toMatch(/bearer/i);
    expect(t).not.toMatch(/talks to \w+ services/);
    const body = template('bug_report.yml');
    const deployment = body.find((b) => b.id === 'deployment');
    const options = (deployment?.attributes?.options ?? []) as string[];
    expect(options.some((o) => /Unraid/.test(o))).toBe(true);
    expect(options.some((o) => /Proxmox/.test(o))).toBe(true);
    const redaction = body.find((b) => b.id === 'redaction');
    const label = ((redaction?.attributes?.options ?? []) as Option[])[0]?.label ?? '';
    expect(label).toMatch(/MCP token/);
  });

  it('says why every npm override exists and when it goes', () => {
    const doc = read('CONTRIBUTING.md');
    const start = doc.indexOf('## Dependencies');
    expect(start).toBeGreaterThan(-1);
    const rest = doc.slice(start + 3);
    const next = rest.indexOf('\n## ');
    const section = next === -1 ? rest : rest.slice(0, next);
    for (const key of Object.keys(pkg.overrides)) {
      expect(section).toContain(key);
    }
    expect(section).toContain('Remove');
  });
});
