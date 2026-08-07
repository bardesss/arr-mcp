import type { ServiceId } from '../config/schema.ts';
import type { LogRow } from '../core/logs.ts';
import type { ConnectionDiagnosis, DiskSpace, HealthCheck, ScanState } from '../services/types.ts';
import { esc, html, humanBytes, raw, shortTime, type SafeHtml } from './html.ts';

/**
 * Every page, server rendered. No client framework and no build step — the
 * only JavaScript is `assets.ts`, and every page here works without it except
 * the log auto-refresh.
 */

export type Nav = 'dashboard' | 'config' | 'logs' | 'audit';

const NAV: { key: Nav; href: string; label: string }[] = [
    { key: 'dashboard', href: '/ui', label: 'Dashboard' },
    { key: 'config', href: '/ui/config', label: 'Configuration' },
    { key: 'logs', href: '/ui/logs', label: 'Logs' },
    { key: 'audit', href: '/ui/audit', label: 'Write audit' }
];

export function layout(opts: {
    title: string;
    nav?: Nav;
    version: string;
    body: SafeHtml;
    message?: { kind: 'ok' | 'err'; text: string } | undefined;
}): string {
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
              <form method="post" action="/ui/logout"><button class="ghost" type="submit">Sign out</button></form>`;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} · arr-mcp</title>
<link rel="stylesheet" href="/ui/app.css">
</head>
<body>
<header><h1>arr-mcp <span>${esc(opts.version)}</span></h1>${nav}</header>
<main>${message}${opts.body}</main>
<script src="/ui/app.js" defer></script>
</body>
</html>`;
}

/**
 * Shown until someone claims the instance — a fresh install has no password at
 * all, so there is nothing a login form could accept.
 *
 * No `nav`: there is nowhere else to go yet, and a sign-out button on a page
 * with no session is nonsense. The warning is not decoration — between the
 * container starting and this form being submitted, the instance belongs to
 * whoever reaches it first.
 */
export function setupPage(opts: { version: string; error?: string | undefined }): string {
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
        ...(opts.error === undefined ? {} : { message: { kind: 'err' as const, text: opts.error } })
    });
}

export function loginPage(opts: { version: string; error?: string | undefined }): string {
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
        ...(opts.error === undefined ? {} : { message: { kind: 'err' as const, text: opts.error } })
    });
}

const statusDot = (d: ConnectionDiagnosis): SafeHtml =>
    html`<span class="dot ${d.ok ? 'ok' : 'bad'}" title="${d.ok ? 'reachable' : 'unreachable'}"></span>`;

/**
 * A card per service, showing the *diagnosis* rather than a tick or a cross.
 *
 * §6/§14: a connection test that returns true/false tells you nothing about
 * what to fix. `testConnection` already returns kind, detail and remedy — this
 * is the first surface that shows all three to a human.
 */
export function dashboardPage(opts: {
    version: string;
    diagnoses: ConnectionDiagnosis[];
    configured: ServiceId[];
    bearerToken: string;
    /** Absent when the request carried no usable `Host` — see `origin.ts`. */
    mcpUrl?: string | undefined;
    writeCounts: { applied: number; denied: number; total: number };
    disks: DiskSpace[];
    failures: HealthCheck[];
    scans: ScanState[];
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
                          <h3>${statusDot(d)} ${d.service}</h3>
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

    const disks =
        opts.disks.length === 0
            ? html`<p class="note">No service reported disk space.</p>`
            : html`<table>
                  <thead><tr><th>Service</th><th>Location</th><th>Free</th><th>Total</th></tr></thead>
                  <tbody>
                      ${opts.disks.map(
                          d => html`<tr>
                              <td>${d.service}</td>
                              <td class="mono">${d.path ?? d.label}</td>
                              <td>${humanBytes(d.freeSpace)}</td>
                              <td>${d.totalSpace === undefined ? '—' : humanBytes(d.totalSpace)}</td>
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

        <h2>Disk space</h2>
        <div class="panel">${disks}</div>

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

    return layout({ title: 'Dashboard', nav: 'dashboard', version: opts.version, body });
}

/**
 * The three streams.
 *
 * `logger.ts` has promised "the config UI's three log streams" since Phase 1,
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
    version: string;
    services: string[];
    selectedService: string;
    stream: LogStreamKey;
    streamUrl: string;
    rows: LogRow[];
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

    return layout({ title: 'Logs', nav: 'logs', version: opts.version, body });
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

export function auditPage(opts: { version: string; rows: AuditRow[] }): string {
    const body = html`<h2>Write audit</h2>
        <p class="note">
            Every write attempt, including previews and refusals. A row still reading
            <span class="mono">attempted</span> means arr-mcp stopped mid-write.
        </p>

        ${opts.rows.length === 0
            ? html`<p class="note">Nothing has tried to write yet.</p>`
            : html`<div class="scroll">
                  <table>
                      <thead>
                          <tr>
                              <th>Time</th><th>Outcome</th><th>Tool</th><th>Service</th>
                              <th>Target</th><th>Arguments</th><th>Detail</th>
                          </tr>
                      </thead>
                      <tbody>
                          ${opts.rows.map(
                              r => html`<tr>
                                  <td class="mono">${shortTime(r.at)}</td>
                                  <td>${r.outcome}</td>
                                  <td>${r.tool}</td>
                                  <td>${r.service}</td>
                                  <td class="mono">${r.target}</td>
                                  <td class="mono">${r.args}</td>
                                  <td>${r.detail ?? ''}</td>
                              </tr>`
                          )}
                      </tbody>
                  </table>
              </div>`}`;

    return layout({ title: 'Write audit', nav: 'audit', version: opts.version, body });
}

export { humanBytes };
