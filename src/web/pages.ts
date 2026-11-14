import type { Theme } from '../config/schema.ts';
import { BEARER_CALLER, BEARER_CALLER_PREFIX, NO_CLIENT_ID, OAUTH_CALLER_PREFIX, type AuditRow } from '../core/audit.ts';
import { unfence } from '../core/fence.ts';
import { logFields, type LogRow } from '../core/logs.ts';
import { expiringSoon, isExpired, type StoredToken } from '../core/mcpTokens.ts';
import type { DatasetStatus } from '../metadata/imdbDataset.ts';
import type { ConnectionDiagnosis, HealthCheck, HistoryEntry, ScanState, Window } from '../services/types.ts';
import { humanBytes, type DiskGroup } from '../core/disks.ts';
import { esc, html, raw, shortTime, type SafeHtml } from './html.ts';
import { LOGO, NAV_ICONS, serviceIcon } from './icons.ts';

/**
 * Every page, server rendered. No client framework and no build step: the
 * only JavaScript is `assets.ts`, and every page here works without it except
 * the log auto-refresh.
 */

/** The configuration tabs are entries of their own here, so the page has one
 *  menu rather than a menu and a second row of tabs under it. */
type Nav = 'dashboard' | 'services' | 'access' | 'logs' | 'audit' | 'settings';

/** Where this came from, and where a missing tool or a bug goes. On every
 *  page, including the sign-in one: the person who cannot get in is exactly
 *  the person who needs the issue tracker. */
const REPO = 'https://github.com/bardesss/arr-mcp';

const NAV: { key: Nav; href: string; label: string }[] = [
    { key: 'dashboard', href: '/ui', label: 'Dashboard' },
    { key: 'services', href: '/ui/config?tab=services', label: 'Services' },
    { key: 'access', href: '/ui/config?tab=access', label: 'Access' },
    { key: 'logs', href: '/ui/logs', label: 'Logs' },
    { key: 'audit', href: '/ui/audit', label: 'Writes' },
    { key: 'settings', href: '/ui/config?tab=settings', label: 'Settings' }
];

/** rel="noreferrer" because this page is served over plain http on a LAN and
 *  the links leave for github.com: without it the Referer header hands them
 *  the hostname and port your instance is reachable on. */
const repoLinks = (): SafeHtml => html`<a href="${REPO}" target="_blank" rel="noreferrer">Source on GitHub</a>
    <a href="${REPO}/issues/new/choose" target="_blank" rel="noreferrer">Report a bug or request a tool</a>`;

export function layout(opts: {
    title: string;
    nav?: Nav;
    /** Required wherever `nav` is, because the nav carries the sign-out form. */
    csrf?: string;
    version: string;
    body: SafeHtml;
    message?: { kind: 'ok' | 'err'; text: string } | undefined;
    /** Absent, or `system`, leaves the attribute off so the CSS falls through
     *  to `prefers-color-scheme`. Stamped server-side rather than set by a
     *  script, so there is no flash of the theme the OS would have picked. */
    theme?: Theme | undefined;
    /** Reload the page this often. With scripting on, app.js does it and holds
     *  off while something is open or typed in; the meta refresh inside
     *  <noscript> is the fallback, so a background run reports progress with
     *  scripting off too. */
    refreshSeconds?: number | undefined;
}): string {
    const refresh =
        opts.refreshSeconds === undefined ? '' : `
<noscript><meta http-equiv="refresh" content="${Math.max(1, Math.floor(opts.refreshSeconds))}"></noscript>`;
    const theme =
        opts.theme === undefined || opts.theme === 'system' ? raw('') : raw(` data-theme="${opts.theme}"`);

    const message =
        opts.message === undefined
            ? raw('')
            : html`<div class="msg ${opts.message.kind}">${opts.message.text}</div>`;

    const brand = html`<a class="brand" href="/ui">${raw(LOGO)}<span>arr-mcp</span><small>${opts.version}</small></a>`;

    /**
     * The sidebar, or on a phone a bar with a menu button. The button is a
     * checkbox and its label, so the menu opens without scripting; a
     * <details> would also hide the sidebar on a wide screen, where it has to
     * stay open. The checkbox carries the name, the label only draws it.
     */
    const shell = (main: string): string =>
        opts.nav === undefined
            ? `<header class="bare">${brand.value}</header>
<main class="bare">${main}</main>
<footer>${repoLinks().value}</footer>`
            : html`<div class="app">
                  <aside class="side">
                      <div class="side-top">
                          ${brand}
                          <input type="checkbox" id="menu-toggle" class="menu-toggle" aria-label="Menu" aria-controls="side-nav">
                          <label for="menu-toggle" class="burger">${raw(NAV_ICONS.menu)}${raw(NAV_ICONS.close)}</label>
                      </div>
                      <nav class="side-nav" id="side-nav" aria-label="Main">
                          ${NAV.map(item =>
                              item.key === opts.nav
                                  ? html`<a href="${item.href}" class="on" aria-current="page">${raw(NAV_ICONS[item.key])}${item.label}</a>`
                                  : html`<a href="${item.href}" class="">${raw(NAV_ICONS[item.key])}${item.label}</a>`
                          )}
                      </nav>
                      <div class="side-foot">
                          ${repoLinks()}
                          <form method="post" action="/ui/logout">
                              <input type="hidden" name="csrf" value="${opts.csrf ?? ''}">
                              <button class="link" type="submit">Sign out</button>
                          </form>
                      </div>
                  </aside>
                  <div class="content">
                      <div class="top"><h1>${opts.title}</h1></div>
                      <main>${raw(main)}</main>
                  </div>
              </div>`.value;

    return `<!doctype html>
<html lang="en"${theme.value}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${refresh}
<title>${esc(opts.title)} · arr-mcp</title>
<!-- Version-stamped because the assets are served with an hour of cache: without
     it, an upgrade leaves a browser holding the previous app.js against the new
     page for up to an hour, which is how a button that opens a dialog becomes a
     button that does nothing. -->
<link rel="stylesheet" href="/ui/app.css?v=${encodeURIComponent(opts.version)}">
<link rel="icon" type="image/svg+xml" href="/ui/icon.svg?v=${encodeURIComponent(opts.version)}">
<!-- The add form lives in a dialog element that app.js opens. With no script there is
     nothing to open it, so it is styled back into the flow as the plain panel it
     used to be: every field visible, the server still validating, and the two
     controls that would need scripting taken away. -->
<noscript><style>
dialog { display: block; position: static; max-width: none; width: auto; margin: 0 0 1rem; }
[data-open], dialog .close { display: none; }
</style></noscript>
</head>
<body>
${shell(message.value + opts.body.value)}
<script src="/ui/app.js?v=${encodeURIComponent(opts.version)}" defer></script>
</body>
</html>`;
}

/**
 * Shown until someone claims the instance: a fresh install has no password, so
 * there is nothing a login form could accept. No `nav`, since there is nowhere
 * to go and no session to sign out of.
 *
 * The warning is not decoration: until this form is submitted, the instance
 * belongs to whoever reaches it first.
 */
export function setupPage(opts: { version: string; error?: string | undefined; theme?: Theme | undefined }): string {
    const body = html`<div class="login">
        <div class="panel">
            <h2>Set up arr-mcp</h2>
            <p class="note">
                Nobody has claimed this instance yet. Choose a username and password. Until you
                do, anyone who reaches this page can claim it instead.
            </p>
            <form method="post" action="/ui/setup">
                <div class="field">
                    <label for="username">Username</label>
                    <input id="username" name="username" value="admin" autocomplete="username" autofocus required>
                </div>
                <div class="field">
                    <label for="password">Password</label>
                    <input id="password" name="password" type="password" autocomplete="new-password"
                           minlength="12" required>
                </div>
                <div class="field">
                    <label for="confirm">Confirm password</label>
                    <input id="confirm" name="confirm" type="password" autocomplete="new-password"
                           minlength="12" required>
                </div>
                <button type="submit">Claim this instance</button>
            </form>
        </div>
    </div>`;

    return layout({
        title: 'Set up',
        version: opts.version,
        body,
        theme: opts.theme,
        ...(opts.error === undefined ? {} : { message: { kind: 'err' as const, text: opts.error } })
    });
}

export function loginPage(opts: { version: string; error?: string | undefined; theme?: Theme | undefined }): string {
    const body = html`<div class="login">
        <div class="panel">
            <h2>Sign in</h2>
            <p class="note">
                Lost the password? Delete the <span class="mono">password_hash</span> line from
                <span class="mono">config.yaml</span> and restart: you will be offered the setup
                page again, the same as a fresh install.
            </p>
            <form method="post" action="/ui/login">
                <div class="field">
                    <label for="username">Username</label>
                    <input id="username" name="username" autocomplete="username" autofocus required>
                </div>
                <div class="field">
                    <label for="password">Password</label>
                    <input id="password" name="password" type="password" autocomplete="current-password" required>
                </div>
                <button type="submit">Sign in</button>
            </form>
        </div>
    </div>`;

    return layout({
        title: 'Sign in',
        version: opts.version,
        body,
        theme: opts.theme,
        ...(opts.error === undefined ? {} : { message: { kind: 'err' as const, text: opts.error } })
    });
}

/**
 * The IMDb dataset's state, when one is configured.
 *
 * A background download with no visible state is one nobody can tell has
 * failed, and the state that matters most is the middle one: enabled, but the
 * first ingest has not finished. Saying nothing there is indistinguishable
 * from a broken download, and the user would reasonably conclude the feature
 * does not work.
 */
const imdbPanel = (status: DatasetStatus): SafeHtml => html`<section class="box">
    <div class="box-h"><h2>IMDb dataset</h2></div>
    <div class="box-b">
        ${status.ingestedAt === undefined
            ? html`<p class="note">
                  Enabled, still downloading. Tools answer as before until the first ingest finishes, and
                  <strong>IMDb ratings for series are not available yet</strong>: this is their only source.
              </p>`
            : html`<p class="note">
                  Ratings fallback and the only source of an IMDb rating for a series. Refreshed weekly.
              </p>
              <dl class="kv">
                  <dt>Last ingested</dt><dd class="mono">${shortTime(status.ingestedAt)}</dd>
                  <dt>Titles</dt><dd>${status.titles.toLocaleString('en')}</dd>
                  <dt>Rated</dt><dd>${status.ratings.toLocaleString('en')}</dd>
              </dl>`}
    </div>
</section>`;

/** Write permission per instance, as the Services page sets it. */
export type Tier = 'read' | 'safe' | 'destructive';

const TIER_LABEL: Record<Tier, string> = { read: 'read-only', safe: 'safe write', destructive: 'destructive' };

/** Short enough for a status column; the detail and remedy say the rest. */
const KIND_LABEL: Record<NonNullable<ConnectionDiagnosis['error']>['kind'], string> = {
    Unreachable: 'Down',
    AuthFailed: 'Auth failed',
    NotFound: 'Not found',
    RateLimited: 'Rate limited',
    Timeout: 'Timeout',
    VersionUnsupported: 'Unsupported',
    PermissionDenied: 'Denied',
    UpstreamError: 'Error'
};

/**
 * Groups for the services table, by what a service does in the stack, in the
 * order a request travels through it. An id the list does not know lands in
 * Other rather than disappearing.
 */
const GROUPS: { label: string; types: readonly string[] }[] = [
    { label: 'Library', types: ['sonarr', 'radarr', 'lidarr', 'whisparr', 'bazarr', 'shelfmark', 'grimmory'] },
    { label: 'Downloads', types: ['sabnzbd', 'nzbget', 'transmission', 'qbittorrent'] },
    { label: 'Indexers and profiles', types: ['prowlarr', 'profilarr'] },
    { label: 'Media and requests', types: ['jellyfin', 'plex', 'seerr'] },
    { label: 'Other', types: [] }
];

const groupOf = (id: string): string => {
    const type = id.split('/')[0] ?? '';
    return GROUPS.find(g => g.types.includes(type))?.label ?? 'Other';
};

/** `radarr/4k` with the instance name dimmed, so a column of them scans by service. */
const serviceName = (id: string): SafeHtml => {
    const [type, name] = id.split('/');
    return name === undefined ? html`${id}` : html`${type ?? ''}<span class="dim">/${name}</span>`;
};

const DAY = 86_400_000;

function daysLeft(expires: string | undefined, now: Date): string {
    if (expires === undefined) return 'no expiry';
    const days = Math.ceil((Date.parse(`${expires}T23:59:59Z`) - now.getTime()) / DAY);
    if (days < 0) return 'expired';
    return days === 1 ? '1 day left' : `${days} days left`;
}

/**
 * Every service tested live, with what is wrong at the top.
 *
 * A connection test that returns true/false tells you nothing about what to
 * fix: `testConnection` returns kind, detail and remedy, and a failing service
 * shows all three under Needs attention. The table below it is one line per
 * instance, because on a healthy stack it should cost one glance, not a screen
 * of identical cards.
 */
export function dashboardPage(opts: {
    csrf: string;
    version: string;
    diagnoses: ConnectionDiagnosis[];
    configured: string[];
    /** Absent for an instance the page has no permissions for, which then shows none. */
    tiers?: Readonly<Record<string, Tier>> | undefined;
    tokens: readonly StoredToken[];
    /** Names of tokens config.yaml still holds in plaintext. */
    plaintextOnDisk: readonly string[];
    now: Date;
    /** Absent when the request carried no usable `Host`; see `origin.ts`. */
    mcpUrl?: string | undefined;
    writeCounts: { applied: number; denied: number; total: number };
    /** The latest few, newest first. */
    recentWrites?: readonly AuditRow[] | undefined;
    /** Absent when the IMDb dataset is not configured, in which case the
     *  panel is not rendered at all rather than rendered as "off". */
    imdb?: DatasetStatus | undefined;
    /** Already one row per filesystem: `buildStackHealth` groups them. */
    disks: DiskGroup[];
    failures: HealthCheck[];
    scans: ScanState[];
    theme?: Theme | undefined;
}): string {
    const down = opts.diagnoses.filter(d => !d.ok);
    const up = opts.diagnoses.length - down.length;
    const expiring = opts.tokens.filter(t => isExpired(t.expires, opts.now) || expiringSoon(t.expires, opts.now));

    const stat = (href: string, label: string, value: SafeHtml, sub: string, warn: boolean): SafeHtml =>
        html`<a class="stat" href="${href}">
            <span class="stat-k">${label}</span>
            <span class="stat-v">${value}</span>
            <span class="stat-s${warn ? ' warn' : ''}">${sub}</span>
        </a>`;

    const strip = html`<div class="strip">
        ${stat(
            '/ui/config?tab=services',
            'Services',
            html`${up} <small>/ ${opts.diagnoses.length} up</small>`,
            down.length === 0 ? 'all reachable' : `${down.length} need attention`,
            down.length > 0
        )}
        ${stat(
            '#attention',
            'Health checks',
            html`${opts.failures.length}`,
            opts.failures.length === 0 ? 'nothing reported' : `from ${[...new Set(opts.failures.map(f => f.service))].join(', ')}`,
            opts.failures.length > 0
        )}
        ${stat(
            '/ui/config?tab=access#tokens',
            'MCP tokens',
            html`${opts.tokens.length}`,
            expiring.length === 0 ? 'none expiring' : `${expiring.length} expired or expiring`,
            expiring.length > 0 || opts.tokens.length === 0
        )}
        ${stat(
            '/ui/audit',
            'Writes',
            html`${opts.writeCounts.total}`,
            `${opts.writeCounts.applied} applied, ${opts.writeCounts.denied} refused`,
            false
        )}
    </div>`;

    const alerts = [
        ...down.map(
            d => html`<div class="alert">
                <span class="sev bad">${d.error === undefined ? 'Down' : KIND_LABEL[d.error.kind]}</span>
                <div class="alert-what">${serviceName(d.service)}${d.error === undefined
                    ? raw('')
                    : html` <span class="mono dim">${unfence(d.error.detail)}</span>`}</div>
                ${d.error?.remedy === undefined ? raw('') : html`<div class="alert-fix">${unfence(d.error.remedy)}</div>`}
                <a class="button ghost alert-act" href="/ui/config?tab=services">Edit</a>
            </div>`
        ),
        ...opts.failures.map(
            f => html`<div class="alert">
                <span class="sev ${f.type === 'error' ? 'bad' : 'warn'}">${f.type === 'error' ? 'Error' : 'Warn'}</span>
                <div class="alert-what">${serviceName(f.service)} <span class="mono dim">${unfence(f.source)}</span></div>
                <div class="alert-fix">${unfence(f.message)}</div>
            </div>`
        )
    ];

    const attention = html`<section class="box" id="attention">
        <div class="box-h"><h2>Needs attention</h2><a href="/ui/logs?stream=problems">Problems log</a></div>
        ${alerts.length === 0 ? html`<p class="box-b note">Nothing needs attention.</p>` : html`${alerts}`}
    </section>`;

    const byGroup = GROUPS.map(g => ({
        label: g.label,
        rows: opts.diagnoses.filter(d => groupOf(d.service) === g.label)
    })).filter(g => g.rows.length > 0);

    const services =
        opts.diagnoses.length === 0
            ? html`<p class="box-b note">
                  No services configured yet. <a href="/ui/config?tab=services">Add one</a>.
              </p>`
            : html`<table class="svc-table">
                  <thead><tr><th scope="col">Service</th><th scope="col" class="opt">Version</th><th scope="col" class="opt">Latency</th><th scope="col">Writes</th><th scope="col">Status</th></tr></thead>
                  ${byGroup.map(
                      g => html`<tbody>
                          <tr class="group"><th scope="colgroup" colspan="5">${g.label}</th></tr>
                          ${g.rows.map(d => {
                              const tier = opts.tiers?.[d.service];
                              return html`<tr class="${d.ok ? '' : 'fail'}">
                                  <th scope="row"><span class="svc-name">${serviceIcon(d.service)}${serviceName(d.service)}</span></th>
                                  <td class="opt mono dim">${d.version ?? ''}</td>
                                  <td class="opt mono dim">${d.latency_ms} ms</td>
                                  <td>${tier === undefined ? raw('') : html`<span class="tier ${tier}">${TIER_LABEL[tier]}</span>`}</td>
                                  <td><span class="st ${d.ok ? 'ok' : 'bad'}"><i></i>${d.ok
                                      ? 'Up'
                                      : d.error === undefined
                                        ? 'Down'
                                        : KIND_LABEL[d.error.kind]}</span></td>
                              </tr>`;
                          })}
                      </tbody>`
                  )}
              </table>`;

    const connect = html`<section class="box">
        <div class="box-h"><h2>Connect a client</h2><a href="/ui/config?tab=access#tokens">Manage</a></div>
        <div class="box-b">
            ${opts.mcpUrl === undefined
                ? html`<p class="note">Use <span class="mono">/mcp</span> on the address you reached this page on.</p>`
                : html`<label for="mcp-url">MCP endpoint</label>
                      <div class="token">
                          <input id="mcp-url" type="text" value="${opts.mcpUrl}" readonly>
                          <button class="ghost" type="button" data-copy="mcp-url">Copy</button>
                      </div>`}
            ${opts.tokens.length === 0
                ? html`<p><strong>No MCP tokens yet. Create one to connect a client.</strong></p>`
                : html`<ul class="tokens">
                      ${opts.tokens.map(
                          t => html`<li>
                              <span>${t.name}</span>
                              <span class="${isExpired(t.expires, opts.now) || expiringSoon(t.expires, opts.now) ? 'warn' : 'dim'}">${daysLeft(t.expires, opts.now)}</span>
                          </li>`
                      )}
                  </ul>`}
            ${expiring.map(
                t => html`<p class="note"><strong>${isExpired(t.expires, opts.now)
                    ? `token '${t.name}' expired on ${t.expires}`
                    : `token '${t.name}' expires on ${t.expires}`}.</strong> Create a new one and revoke this one.</p>`
            )}
            ${opts.plaintextOnDisk.length === 0
                ? raw('')
                : html`<p class="note"><strong>Still plaintext in config.yaml:</strong> ${opts.plaintextOnDisk.join(', ')}. arr-mcp could not rewrite the file. The tokens work, but replace them with hashes or revoke them.</p>`}
            <a class="button" href="/ui/config?tab=access#tokens">New token</a>
        </div>
    </section>`;

    const disks = html`<section class="box">
        <div class="box-h"><h2>Disk space</h2></div>
        <div class="box-b">
            ${opts.disks.length === 0
                ? html`<p class="note">No service reported disk space.</p>`
                : opts.disks.map(d => {
                      const share = d.totalSpace === undefined || d.totalSpace === 0 ? undefined : 1 - d.freeSpace / d.totalSpace;
                      return html`<div class="disk">
                          <div class="disk-l"><span>${humanBytes(d.freeSpace)} free</span>${d.totalSpace === undefined
                              ? raw('')
                              : html`<span class="dim">of ${humanBytes(d.totalSpace)}</span>`}</div>
                          ${share === undefined
                              ? raw('')
                              : html`<div class="bar"><b class="${share > 0.85 ? 'warn' : ''}" style="width:${Math.round(share * 100)}%"></b></div>`}
                          <span class="dim small">${d.services.join(', ')}</span>
                      </div>`;
                  })}
        </div>
    </section>`;

    const writes = html`<section class="box">
        <div class="box-h"><h2>Recent writes</h2><a href="/ui/audit">All writes</a></div>
        <div class="box-b">
            ${(opts.recentWrites ?? []).length === 0
                ? html`<p class="note">Nothing has tried to write yet.</p>`
                : html`<ul class="feed">
                      ${(opts.recentWrites ?? []).map(
                          r => html`<li>
                              <span class="badge ${r.outcome}">${r.outcome}</span>
                              <span>${r.tool}</span>
                              <time class="mono dim">${shortTime(r.at)}</time>
                              <span class="feed-sub dim">${r.service} · ${r.target}</span>
                          </li>`
                      )}
                  </ul>`}
        </div>
    </section>`;

    const scans = html`<section class="box">
        <div class="box-h"><h2>Library scans</h2></div>
        <div class="box-b">
            ${opts.scans.length === 0
                ? html`<p class="note">No service reported a library scan.</p>`
                : html`<ul class="feed">
                      ${opts.scans.map(
                          s => html`<li>
                              <span class="badge">${s.running === true ? 'running' : 'done'}</span>
                              <span>${s.service}</span>
                              <time class="mono dim">${s.lastCompleted === undefined ? 'unknown' : shortTime(s.lastCompleted)}</time>
                          </li>`
                      )}
                  </ul>`}
        </div>
    </section>`;

    const body = html`${strip}
        <div class="dash">
            <div class="dash-main">
                ${attention}
                <section class="box">
                    <div class="box-h"><h2>Services</h2><a href="/ui/config?tab=services">Manage</a></div>
                    ${services}
                </section>
            </div>
            <div class="dash-side">
                ${connect}
                ${disks}
                ${writes}
                ${scans}
                ${opts.imdb === undefined ? raw('') : imdbPanel(opts.imdb)}
            </div>
        </div>`;

    return layout({ title: 'Dashboard', nav: 'dashboard', csrf: opts.csrf, version: opts.version, body, theme: opts.theme });
}

/**
 * The three streams.
 *
 * `logger.ts` has promised "the config UI's three log streams",
 * and the design spec that named them is not in this repository, so these are
 * the three the code can actually support, chosen from what the logger already
 * binds: everything, only what is wrong, and one service at a time. They are
 * named tabs rather than a level dropdown because "show me what is broken" is
 * a question, and picking `40` from a list of numbers is an implementation
 * detail leaking into the page.
 */
export const LOG_STREAMS = [
    { key: 'all', label: 'All activity', minLevel: 10, hint: 'Everything the server has logged.' },
    {
        key: 'problems',
        label: 'Problems',
        minLevel: 40,
        hint: 'Warnings and errors only: what to read first when something is wrong.'
    },
    {
        key: 'service',
        label: 'By service',
        minLevel: 10,
        hint: 'Everything logged about one service, whichever level it was logged at.'
    }
] as const;

export type LogStreamKey = (typeof LOG_STREAMS)[number]['key'];

/**
 * The tabs inside a page, for every page that has them. Each one is a link to a
 * server-rendered page, so they work without scripting and read as the same
 * control wherever they appear.
 */
const tabBar = (tabs: readonly { href: string; label: string; on: boolean }[]): SafeHtml =>
    html`<nav class="tabs">
        ${tabs.map(
            t => html`<a href="${t.href}" class="${t.on ? 'on' : ''}"${t.on ? raw(' aria-current="page"') : raw('')}>${t.label}</a>`
        )}
    </nav>`;

/** The event log's tab is not in `LOG_STREAMS`, because those are filters over log lines. */
const logTabs = (stream: LogStreamKey | 'events', selectedService: string): SafeHtml =>
    tabBar([
        ...LOG_STREAMS.map(s => ({
            href: `/ui/logs?stream=${s.key}${s.key === 'service' && selectedService !== '' ? `&service=${encodeURIComponent(selectedService)}` : ''}`,
            label: s.label,
            on: s.key === stream
        })),
        { href: '/ui/logs?stream=events', label: 'Library events', on: stream === 'events' }
    ]);

/**
 * Stored events rather than log lines, so its own columns and none of the log
 * tabs' ring-buffer note or auto-refresh. Rendered on the server: `html` escapes
 * these titles, and they arrive rarely enough that a reload shows what's new.
 */
export function eventLogPage(opts: {
    csrf: string;
    version: string;
    enabled: boolean;
    retentionDays: number | undefined;
    /** Undefined when the store could not be read. */
    read: Window<HistoryEntry> | undefined;
    theme?: Theme | undefined;
}): string {
    const rows = opts.read?.items ?? [];
    const plain = (value: string | undefined): string => (value === undefined ? '' : unfence(value));

    const status =
        opts.read === undefined
            ? html`<div class="msg err">The event log could not be read. The Problems tab has the error.</div>`
            : !opts.enabled
              ? html`<p class="note">
                    The library event log is off, so nothing new is being recorded. Turn it on under
                    <a href="/ui/config?tab=settings#webhooks">Library event log</a> on the Settings page.
                </p>`
              : rows.length === 0
                ? html`<p class="note">
                      Nothing has arrived yet. Each Radarr, Sonarr and Lidarr instance needs a webhook connection, and
                      <a href="/ui/config?tab=settings#webhooks">the Settings page</a> has the details.
                  </p>`
                : raw('');

    const table =
        rows.length === 0
            ? raw('')
            : html`<div class="scroll">
                  <table class="stacked">
                      <thead>
                          <tr><th>Time</th><th>Event</th><th>Service</th><th class="prose">Title</th><th>Details</th></tr>
                      </thead>
                      <tbody>
                          ${rows.map(
                              r => html`<tr>
                                  <td class="mono">${shortTime(r.at)}</td>
                                  <td>${r.event === 'unknown' ? (r.rawEvent ?? r.event) : r.event}</td>
                                  <td>${r.service}</td>
                                  <td class="prose">${plain(r.title)}</td>
                                  <td>${[r.quality, r.indexer, r.reason].map(plain).filter(v => v !== '').join(', ')}</td>
                              </tr>`
                          )}
                      </tbody>
                  </table>
              </div>`;

    const body = html`${logTabs('events', '')}
        <p class="note">
            What Radarr, Sonarr and Lidarr reported${opts.retentionDays === undefined ? raw('') : html`, kept for ${opts.retentionDays} days`}.
            A title's history goes from the service when the title is deleted, and this stays.
            ${(opts.read?.total ?? 0) > rows.length ? html`Showing the latest ${rows.length} of ${opts.read?.total ?? 0}.` : raw('')}
        </p>
        ${status}
        ${table}`;

    return layout({ title: 'Logs', nav: 'logs', csrf: opts.csrf, version: opts.version, body, theme: opts.theme });
}

export function logsPage(opts: {
    csrf: string;
    version: string;
    services: string[];
    selectedService: string;
    stream: LogStreamKey;
    streamUrl: string;
    rows: LogRow[];
    theme?: Theme | undefined;
}): string {
    const active = LOG_STREAMS.find(s => s.key === opts.stream) ?? LOG_STREAMS[0];

    const tabs = logTabs(opts.stream, opts.selectedService);

    const picker =
        opts.stream !== 'service'
            ? raw('')
            : html`<form class="inline" method="get" action="/ui/logs">
                  <input type="hidden" name="stream" value="service">
                  <div>
                      <label for="service">Service</label>
                      <select id="service" name="service">
                          ${opts.services.length === 0
                              ? html`<option value="">nothing logged yet</option>`
                              : opts.services.map(
                                    s =>
                                        html`<option
                                            value="${s}"
                                            ${s === opts.selectedService ? raw('selected') : raw('')}
                                        >
                                            ${s}
                                        </option>`
                                )}
                      </select>
                  </div>
                  <button type="submit">Show</button>
              </form>`;

    const body = html`<p class="note">
            The last few thousand lines, kept in a ring buffer beside your config. Full history stays in
            <span class="mono">docker logs</span>.
        </p>

        ${tabs}
        <p class="note">${active.hint}</p>
        ${picker}

        <label class="row" style="margin:0 0 .75rem">
            <input type="checkbox" id="follow" checked> Auto-refresh
        </label>

        <div class="scroll" id="log-stream" data-url="${opts.streamUrl}">${logTable(opts.rows)}</div>`;

    return layout({ title: 'Logs', nav: 'logs', csrf: opts.csrf, version: opts.version, body, theme: opts.theme });
}

/** The no-JavaScript rendering. The live one is rebuilt client-side from JSON
 *  with textContent; see assets.ts for why that one is not HTML. */
/**
 * A log row as the page shows it. The first render and the polled refresh both
 * go through this, so a row cannot change its wording or its time format when
 * the first refresh replaces the table.
 */
export function logRowView(r: LogRow): LogRow & { time: string; detail: [string, string][] } {
    return {
        ...r,
        time: shortTime(r.at),
        msg: unfence(r.msg),
        detail: logFields(r.fields).map(([key, value]): [string, string] => [key, unfence(value)])
    };
}

export function logTable(rows: LogRow[]): SafeHtml {
    if (rows.length === 0) return html`<p class="note">Nothing logged yet for this filter.</p>`;

    return html`<table class="stacked">
        <thead>
            <tr><th>Time</th><th>Level</th><th>Service</th><th>Message</th></tr>
        </thead>
        <tbody>
            ${rows.map(logRowView).map(r => {
                // Under the message rather than in a fifth column: these are
                // the fields that answer "which client, which endpoint, what
                // did the service say", useless if the column holding them is
                // squeezed to nothing, and there is no fixed set of them.
                const detail = r.detail;
                return html`<tr class="lvl-${r.level}">
                    <td class="mono">${r.time}</td>
                    <td>${r.levelName}</td>
                    <td>${r.service ?? ''}</td>
                    <td>
                        ${r.msg}
                        ${detail.length === 0
                            ? raw('')
                            : html`<dl class="fields">
                                  ${detail.map(
                                      ([key, value]) =>
                                          html`<dt class="mono">${key}</dt>
                                              <dd class="mono">${value}</dd>`
                                  )}
                              </dl>`}
                    </td>
                </tr>`;
            })}
        </tbody>
    </table>`;
}

/**
 * One recorded argument, kept short enough to read.
 *
 * A bulk write names every id it touched: `set_monitoring` on all artists of a
 * 1,578-artist Lidarr carries about 11 KB of ids, and this page renders 300
 * rows at once. Printing them made one row push the page into megabytes, which
 * is the same failure mode the field-per-argument split was introduced to fix.
 * The row keeps the full list; only this rendering is bounded.
 */
const ARG_TEXT_LIMIT = 160;

function argValue(value: unknown): string {
    if (typeof value === 'string') return value;
    const text = JSON.stringify(value) ?? String(value);
    if (text.length <= ARG_TEXT_LIMIT) return text;
    if (Array.isArray(value)) return `[${value.length} items] ${JSON.stringify(value.slice(0, 3)).slice(0, ARG_TEXT_LIMIT)}…`;
    return `${text.slice(0, ARG_TEXT_LIMIT)}…`;
}

/**
 * The recorded arguments, as fields rather than as the blob they are stored as.
 *
 * `args` is JSON in one database column, and printing it into a cell put a
 * whole object on one line beside six other columns, the single thing that
 * made this page unreadable at any width.
 *
 * A row that does not parse is shown verbatim rather than dropped. This is a
 * log: something unexpected in it is a reason to display it, not to hide it.
 */
function argFields(args: string): SafeHtml {
    let parsed: unknown;
    try {
        parsed = JSON.parse(args);
    } catch {
        return html`<dt>Arguments</dt><dd class="mono">${args}</dd>`;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return html`<dt>Arguments</dt><dd class="mono">${args}</dd>`;
    }

    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) return html`<dt>Arguments</dt><dd class="dim">none</dd>`;

    return html`${entries.map(
        ([key, value]) => html`<dt class="mono">${key}</dt>
                <dd class="mono">${argValue(value)}</dd>`
    )}`;
}

/**
 * Which credential made the write, in words rather than as a raw value.
 *
 * `bearer:<name>#<fingerprint>` is a named MCP token, shown as `name · fingerprint`.
 * Bare `bearer` is the static token from before named tokens, null is a row written before this column
 * existed, and a bare `oauth:` is a token that named no client (`NO_CLIENT_ID`);
 * none of them is a client's name and none is printed as one. An
 * `oauth:` value is a client id someone chose, so that alone is set in `mono`,
 * with the prefix dropped since the label already says whose it is.
 */
function callerField(caller: string | null): SafeHtml {
    if (caller === null) return html`<dd class="dim">not recorded (written before callers were logged)</dd>`;
    if (caller === BEARER_CALLER) return html`<dd class="dim">the static bearer token (before named tokens)</dd>`;
    if (caller.startsWith(BEARER_CALLER_PREFIX)) {
        const [name, fp] = caller.slice(BEARER_CALLER_PREFIX.length).split('#');
        return html`<dd class="mono">${name ?? ''} · ${fp ?? ''}</dd>`;
    }
    const id = caller.startsWith(OAUTH_CALLER_PREFIX) ? caller.slice(OAUTH_CALLER_PREFIX.length) : caller;
    if (id === NO_CLIENT_ID) return html`<dd class="dim">an OAuth token that named no client</dd>`;
    return html`<dd class="mono">${id}</dd>`;
}

/**
 * One entry per attempt, rather than one row of seven columns.
 *
 * The order is the order the questions get asked: what happened, to what, with
 * which arguments, and, only when there is one, what the service said back.
 */
function auditEntry(r: AuditRow): SafeHtml {
    return html`<article class="entry">
        <div class="entry-top">
            <span class="badge ${r.outcome}">${r.outcome}</span>
            <span class="tool">${r.tool}</span>
            <span class="mono dim">${r.service}</span>
            <time class="mono">${shortTime(r.at)}</time>
        </div>
        <dl>
            <dt>Target</dt>
            <dd class="mono">${r.target}</dd>
            <dt>Caller</dt>
            ${callerField(r.caller)}
            ${argFields(r.args)}
        </dl>
        ${r.detail === null || r.detail === '' ? raw('') : html`<div class="remedy">${unfence(r.detail)}</div>`}
    </article>`;
}

export function auditPage(opts: { csrf: string; version: string; rows: AuditRow[]; theme?: Theme | undefined }): string {
    const body = html`<p class="note">
            Every write attempt, including previews and refusals. An entry still reading
            <span class="mono">attempted</span> means arr-mcp stopped mid-write.
        </p>

        ${opts.rows.length === 0
            ? html`<p class="note">Nothing has tried to write yet.</p>`
            : html`<div class="trail">${opts.rows.map(auditEntry)}</div>`}`;

    return layout({ title: 'Writes', nav: 'audit', csrf: opts.csrf, version: opts.version, body, theme: opts.theme });
}

