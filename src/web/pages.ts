import type { Theme } from '../config/schema.ts';
import type { LogRow } from '../core/logs.ts';
import type { DatasetStatus } from '../metadata/imdbDataset.ts';
import type { ConnectionDiagnosis, DiskSpace, HealthCheck, ScanState } from '../services/types.ts';
import { esc, html, humanBytes, raw, shortTime, type SafeHtml } from './html.ts';
import { LOGO, serviceIcon } from './icons.ts';

/**
 * Every page, server rendered. No client framework and no build step — the
 * only JavaScript is `assets.ts`, and every page here works without it except
 * the log auto-refresh.
 */

export type Nav = 'dashboard' | 'config' | 'logs' | 'audit';

/** Where this came from, and where a missing tool or a bug goes. On every
 *  page, including the sign-in one — the person who cannot get in is exactly
 *  the person who needs the issue tracker. */
const REPO = 'https://github.com/bardesss/arr-mcp';

const NAV: { key: Nav; href: string; label: string }[] = [
    { key: 'dashboard', href: '/ui', label: 'Dashboard' },
    { key: 'config', href: '/ui/config', label: 'Configuration' },
    { key: 'logs', href: '/ui/logs', label: 'Logs' },
    { key: 'audit', href: '/ui/audit', label: 'Write audit' }
];

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
}): string {
    const theme =
        opts.theme === undefined || opts.theme === 'system' ? raw('') : raw(` data-theme="${opts.theme}"`);

    const message =
        opts.message === undefined
            ? raw('')
            : html`<div class="msg ${opts.message.kind}">${opts.message.text}</div>`;

    const nav =
        opts.nav === undefined
            ? raw('')
            : html`<nav>
                  ${NAV.map(
                      item => html`<a href="${item.href}" class="${item.key === opts.nav ? 'on' : ''}">${item.label}</a>`
                  )}
              </nav>
              <form method="post" action="/ui/logout">
                  <input type="hidden" name="csrf" value="${opts.csrf ?? ''}">
                  <button class="ghost" type="submit">Sign out</button>
              </form>`;

    return `<!doctype html>
<html lang="en"${theme}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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
<header><h1>${LOGO}arr-mcp <span>${esc(opts.version)}</span></h1>${nav}</header>
<main>${message}${opts.body}</main>
<!-- rel="noreferrer" because this page is served over plain http on a LAN and
     the link leaves for github.com: without it the Referer header hands them
     the hostname and port your instance is reachable on. -->
<footer>
  <span>arr-mcp ${esc(opts.version)}</span>
  <a href="${REPO}" target="_blank" rel="noreferrer">Source on GitHub</a>
  <a href="${REPO}/issues/new/choose" target="_blank" rel="noreferrer">Report a bug or request a tool</a>
</footer>
<script src="/ui/app.js?v=${encodeURIComponent(opts.version)}" defer></script>
</body>
</html>`;
}

/**
 * Shown until someone claims the instance: a fresh install has no password, so
 * there is nothing a login form could accept. No `nav`, since there is nowhere
 * to go and no session to sign out of.
 *
 * The warning is not decoration — until this form is submitted, the instance
 * belongs to whoever reaches it first.
 */
export function setupPage(opts: { version: string; error?: string | undefined; theme?: Theme | undefined }): string {
    const body = html`<div class="login">
        <div class="panel">
            <h2>Set up arr-mcp</h2>
            <p class="note">
                Nobody has claimed this instance yet. Choose a username and password — until you
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
                <span class="mono">config.yaml</span> and restart — you will be offered the setup
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

/** One filesystem, and every instance that can see it. */
export type DiskGroup = { freeSpace: number; totalSpace?: number | undefined; services: string[] };

/**
 * How far apart two reports of one filesystem may be and still be one disk.
 *
 * Measured: SABnzbd's two-decimal gigabytes put the same 4.6 TB filesystem
 * 4.8 MB — 0.0001% — from the byte count Radarr gives. This is a thousand times
 * that, and three orders of magnitude below the gap between any two real
 * disks.
 *
 * Relative rather than absolute because the quantisation error scales with the
 * number being reported, and an absolute figure that suited a 10 TB array would
 * be larger than a 240 GB SSD's entire free space.
 */
const SAME_DISK_TOLERANCE = 0.001;

/**
 * Two sizes close enough to be the same filesystem seen twice.
 *
 * Compared against the larger of the pair so the relation is symmetric — with
 * the smaller as the denominator, whether A matched B would depend on which the
 * loop happened to reach first.
 */
function sameSize(a: number, b: number): boolean {
    if (a === b) return true;
    const larger = Math.max(Math.abs(a), Math.abs(b));
    return larger === 0 || Math.abs(a - b) / larger <= SAME_DISK_TOLERANCE;
}

/**
 * Collapse the mounts every service reports down to the disks behind them.
 *
 * Services in a stack are containers over the same host filesystems, so the
 * same two or three disks arrive repeated — ten rows to say "you have two
 * disks", which is a table nobody reads.
 *
 * Free bytes are the fingerprint, compared with a **tolerance rather than for
 * equality**: not every service reports byte precision. SABnzbd returns
 * gigabytes to two decimals, so one 4.6 TB filesystem arrives 4.8 MB away from
 * the exact count Radarr gives for it, and exact equality could never match
 * them — the symptom being the disk listed twice with identical rounded
 * numbers.
 *
 * A mount only joins a group whose total it does not contradict, which guards
 * against a false merge and folds in the torrent clients, which report free
 * space with no total to contradict.
 *
 * Paths are dropped: which mount is `/storage` is a container-mapping
 * question, and this table answers whether anything is running out of room.
 */
export function groupDisks(disks: readonly DiskSpace[]): DiskGroup[] {
    const groups: DiskGroup[] = [];

    for (const disk of disks) {
        const group = groups.find(
            g =>
                sameSize(g.freeSpace, disk.freeSpace) &&
                (g.totalSpace === undefined ||
                    disk.totalSpace === undefined ||
                    sameSize(g.totalSpace, disk.totalSpace))
        );

        if (group === undefined) {
            groups.push({
                freeSpace: disk.freeSpace,
                ...(disk.totalSpace === undefined ? {} : { totalSpace: disk.totalSpace }),
                services: [disk.service]
            });
            continue;
        }

        group.totalSpace ??= disk.totalSpace;
        if (!group.services.includes(disk.service)) group.services.push(disk.service);
    }

    // Emptiest first: the disk about to cause a failed import is the one worth
    // reading, and it is never the one with room to spare.
    return groups.sort((a, b) => a.freeSpace - b.freeSpace);
}

/**
 * The IMDb dataset's state, when one is configured.
 *
 * A background download with no visible state is one nobody can tell has
 * failed — and the state that matters most is the middle one: enabled, but the
 * first ingest has not finished. Saying nothing there is indistinguishable
 * from a broken download, and the user would reasonably conclude the feature
 * does not work.
 */
const imdbPanel = (status: DatasetStatus): SafeHtml => html`<h2>IMDb dataset</h2>
    <div class="panel">
        ${status.ingestedAt === undefined
            ? html`<p class="note">
                  Enabled, still downloading. Every tool answers exactly as it did before until the first
                  ingest finishes — nothing is broken while this says so, but <strong>IMDb ratings for
                  series are not available yet</strong>, because this is the only thing that supplies them.
                  It runs again weekly.
              </p>`
            : html`<p class="note">
                      A fallback for ratings when Seerr is not configured or not answering — and the only
                      source of an <strong>IMDb rating for a series</strong>, which no service in this stack
                      reports. Refreshed weekly — about 223 MB down, roughly 81 MB on disk. Nothing here is
                      sent anywhere.
                  </p>
                  <table>
                      <thead><tr><th>Last ingested</th><th>Titles</th><th>Rated</th></tr></thead>
                      <tbody>
                          <tr>
                              <td class="mono">${shortTime(status.ingestedAt)}</td>
                              <td>${status.titles.toLocaleString('en')}</td>
                              <td>${status.ratings.toLocaleString('en')}</td>
                          </tr>
                      </tbody>
                  </table>`}
    </div>`;

const statusDot = (d: ConnectionDiagnosis): SafeHtml =>
    html`<span class="dot ${d.ok ? 'ok' : 'bad'}" title="${d.ok ? 'reachable' : 'unreachable'}"></span>`;

/**
 * A card per service, showing the *diagnosis* rather than a tick or a cross.
 *
 * A connection test that returns true/false tells you nothing about what to
 * fix. `testConnection` already returns kind, detail and remedy — this is the
 * first surface that shows all three to a human.
 */
export function dashboardPage(opts: {
    csrf: string;
    version: string;
    diagnoses: ConnectionDiagnosis[];
    configured: string[];
    bearerToken: string;
    /** Whether `?token=` is accepted, which decides whether the copy button is offered. */
    urlToken: boolean;
    /** Absent when the request carried no usable `Host` — see `origin.ts`. */
    mcpUrl?: string | undefined;
    writeCounts: { applied: number; denied: number; total: number };
    /** Absent when the IMDb dataset is not configured — in which case the
     *  panel is not rendered at all rather than rendered as "off". */
    imdb?: DatasetStatus | undefined;
    disks: DiskSpace[];
    failures: HealthCheck[];
    scans: ScanState[];
    theme?: Theme | undefined;
}): string {
    const cards =
        opts.diagnoses.length === 0
            ? html`<p class="note">
                  No services configured yet. Add one on the
                  <a href="/ui/config">Configuration</a> page.
              </p>`
            : html`<div class="grid">
                  ${opts.diagnoses.map(
                      d => html`<div class="card">
                          <h3>${serviceIcon(d.service)} ${d.service} ${statusDot(d)}</h3>
                          <dl>
                              <dt>Status</dt>
                              <dd>${d.ok ? 'Reachable' : (d.error?.kind ?? 'Unreachable')}</dd>
                              <dt>Latency</dt>
                              <dd>${d.latency_ms} ms</dd>
                              ${d.version === undefined ? raw('') : html`<dt>Version</dt><dd>${d.version}</dd>`}
                          </dl>
                          ${d.ok || d.error === undefined
                              ? raw('')
                              : html`<div class="remedy">
                                    <strong>${d.error.detail}</strong>
                                    ${d.error.remedy === undefined ? raw('') : html`<br>${d.error.remedy}`}
                                </div>`}
                      </div>`
                  )}
              </div>`;

    /**
     * The four things `stack_health` answers, on the page rather than only
     * through a tool. Reachability alone is a dashboard that calls a service
     * healthy while its disk is full and its library has not been scanned for
     * a day — which is exactly the gap `diagnose` exists to explain after the
     * fact.
     */
    const problems =
        opts.failures.length === 0
            ? html`<p class="note">Nothing is reporting a problem.</p>`
            : html`<table>
                  <thead><tr><th>Service</th><th>Source</th><th>Type</th><th>Message</th></tr></thead>
                  <tbody>
                      ${opts.failures.map(
                          f => html`<tr>
                              <td>${f.service}</td>
                              <td>${f.source}</td>
                              <td>${f.type}</td>
                              <td>${f.message}</td>
                          </tr>`
                      )}
                  </tbody>
              </table>`;

    const grouped = groupDisks(opts.disks);
    const disks =
        grouped.length === 0
            ? html`<p class="note">No service reported disk space.</p>`
            : html`<table>
                  <thead><tr><th>Free</th><th>Total</th><th>Seen by</th></tr></thead>
                  <tbody>
                      ${grouped.map(
                          d => html`<tr>
                              <td>${humanBytes(d.freeSpace)}</td>
                              <td>${d.totalSpace === undefined ? '—' : humanBytes(d.totalSpace)}</td>
                              <td>${d.services.join(', ')}</td>
                          </tr>`
                      )}
                  </tbody>
              </table>`;

    const scans =
        opts.scans.length === 0
            ? html`<p class="note">No service reported a library scan.</p>`
            : html`<table>
                  <thead><tr><th>Service</th><th>Last completed</th><th>Running now</th></tr></thead>
                  <tbody>
                      ${opts.scans.map(
                          s => html`<tr>
                              <td>${s.service}</td>
                              <td class="mono">${s.lastCompleted === undefined ? 'unknown' : shortTime(s.lastCompleted)}</td>
                              <td>${s.running === true ? 'yes' : 'no'}</td>
                          </tr>`
                      )}
                  </tbody>
              </table>`;

    const body = html`<h2>Services</h2>
        <p class="note">
            Tested live, just now. A failure shows what to fix rather than only that it failed.
        </p>
        ${cards}

        <h2>Problems</h2>
        <div class="panel">${problems}</div>

        ${opts.imdb === undefined ? raw('') : imdbPanel(opts.imdb)}

        <h2>Disk space</h2>
        <div class="panel">
            <p class="note">
                One row per filesystem, not per mount — services in one stack share the same disks, and
                listing every path they see them through says the same thing several times over.
            </p>
            ${disks}
        </div>

        <h2>Library scans</h2>
        <div class="panel">
            <p class="note">
                A library that has not been scanned recently is the usual reason something downloaded is
                still not playable.
            </p>
            ${scans}
        </div>

        <h2>MCP endpoint</h2>
        <div class="panel">
            <p class="note">
                Point your MCP client at this URL and give it the bearer token. This page is the
                only place the token is shown — it is never written to a log.
            </p>
            ${opts.mcpUrl === undefined
                ? html`<p class="note">
                      Use <span class="mono">/mcp</span> on this host — the address you reached this
                      page on.
                  </p>`
                : html`<div class="token">
                      <input id="mcp-url" type="text" value="${opts.mcpUrl}" readonly>
                      <button class="ghost" type="button" data-copy="mcp-url">Copy</button>
                  </div>`}
            <div class="token">
                <input id="bearer" type="password" value="${opts.bearerToken}" readonly>
                <button class="ghost" type="button" data-reveal="bearer">Show</button>
                <button class="ghost" type="button" data-copy="bearer">Copy</button>
            </div>
            ${opts.mcpUrl === undefined
                ? raw('')
                : html`<div class="row" style="margin-top:.75rem">
                          <button class="ghost" type="button" data-copy-config="mcp-config">
                              Copy client config
                          </button>
                          <span class="note" style="margin:0">Ready to paste — includes the token.</span>
                      </div>
                      <!-- Filled in by the browser at click time, never by the server: rendering
                           the token here would undo the masked field above it, and a screenshot
                           of this page would carry it. -->
                      <textarea id="mcp-config" class="mono" rows="9" readonly hidden></textarea>`}
            ${opts.mcpUrl === undefined || !opts.urlToken
                ? raw('')
                : html`<div class="row" style="margin-top:.75rem">
                          <button class="ghost" type="button" data-copy-url-token="mcp-url">
                              Copy URL with token
                          </button>
                          <span class="note" style="margin:0">For clients that take a URL and nothing else.</span>
                      </div>
                      <input id="mcp-url-token" type="text" readonly hidden>`}
        </div>

        <h2>Writes</h2>
        <div class="panel">
            <p class="note">
                Every write attempt is recorded, including the ones that were refused.
                <a href="/ui/audit">See the full trail</a>.
            </p>
            <div class="row">
                <span><strong>${opts.writeCounts.applied}</strong> applied</span>
                <span><strong>${opts.writeCounts.denied}</strong> refused</span>
                <span><strong>${opts.writeCounts.total}</strong> recorded in total</span>
            </div>
        </div>`;

    return layout({ title: 'Dashboard', nav: 'dashboard', csrf: opts.csrf, version: opts.version, body, theme: opts.theme });
}

/**
 * The three streams.
 *
 * `logger.ts` has promised "the config UI's three log streams",
 * and the design spec that named them is not in this repository — so these are
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
        hint: 'Warnings and errors only — what to read first when something is wrong.'
    },
    {
        key: 'service',
        label: 'By service',
        minLevel: 10,
        hint: 'Everything logged about one service, whichever level it was logged at.'
    }
] as const;

export type LogStreamKey = (typeof LOG_STREAMS)[number]['key'];

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

    const tabs = html`<nav style="margin-bottom:.75rem">
        ${LOG_STREAMS.map(
            s =>
                html`<a
                    href="/ui/logs?stream=${s.key}${s.key === 'service' && opts.selectedService !== ''
                        ? raw(`&service=${encodeURIComponent(opts.selectedService)}`)
                        : raw('')}"
                    class="${s.key === opts.stream ? 'on' : ''}"
                    >${s.label}</a
                >`
        )}
    </nav>`;

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

    const body = html`<h2>Logs</h2>
        <p class="note">
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
 *  with textContent — see assets.ts for why that one is not HTML. */
export function logTable(rows: LogRow[]): SafeHtml {
    if (rows.length === 0) return html`<p class="note">Nothing logged yet for this filter.</p>`;

    return html`<table>
        <thead>
            <tr><th>Time</th><th>Level</th><th>Service</th><th>Message</th></tr>
        </thead>
        <tbody>
            ${rows.map(
                r => html`<tr class="lvl-${r.level}">
                    <td class="mono">${shortTime(r.at)}</td>
                    <td>${r.levelName}</td>
                    <td>${r.service ?? '—'}</td>
                    <td>${r.msg}</td>
                </tr>`
            )}
        </tbody>
    </table>`;
}

export type AuditRow = {
    at: string;
    tool: string;
    service: string;
    operation: string;
    tier: string;
    target: string;
    args: string;
    outcome: string;
    detail: string | null;
};

/**
 * The recorded arguments, as fields rather than as the blob they are stored as.
 *
 * `args` is JSON in one database column, and printing it into a cell put a
 * whole object on one line beside six other columns — the single thing that
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
        ([key, value]) =>
            html`<dt class="mono">${key}</dt>
                <dd class="mono">${typeof value === 'string' ? value : JSON.stringify(value)}</dd>`
    )}`;
}

/**
 * One entry per attempt, rather than one row of seven columns.
 *
 * The order is the order the questions get asked: what happened, to what, with
 * which arguments, and — only when there is one — what the service said back.
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
            ${argFields(r.args)}
        </dl>
        ${r.detail === null || r.detail === '' ? raw('') : html`<div class="remedy">${r.detail}</div>`}
    </article>`;
}

export function auditPage(opts: { csrf: string; version: string; rows: AuditRow[]; theme?: Theme | undefined }): string {
    const body = html`<h2>Write audit</h2>
        <p class="note">
            Every write attempt, including previews and refusals. An entry still reading
            <span class="mono">attempted</span> means arr-mcp stopped mid-write.
        </p>

        ${opts.rows.length === 0
            ? html`<p class="note">Nothing has tried to write yet.</p>`
            : html`<div class="trail">${opts.rows.map(auditEntry)}</div>`}`;

    return layout({ title: 'Write audit', nav: 'audit', csrf: opts.csrf, version: opts.version, body, theme: opts.theme });
}

