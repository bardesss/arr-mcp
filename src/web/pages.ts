import type { ServiceId } from '../config/schema.ts';
import type { LogRow } from '../core/logs.ts';
import type { ConnectionDiagnosis } from '../services/types.ts';
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

export function loginPage(opts: { version: string; error?: string | undefined }): string {
    const body = html`<div class="login">
        <div class="panel">
            <h2>Sign in</h2>
            <p class="note">
                The password was printed to the container log on first start —
                <span class="mono">docker logs arr-mcp</span>.
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
    writeCounts: { applied: number; denied: number; total: number };
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

    const body = html`<h2>Services</h2>
        <p class="note">
            Tested live, just now. A failure shows what to fix rather than only that it failed.
        </p>
        ${cards}

        <h2>MCP endpoint</h2>
        <div class="panel">
            <p class="note">
                Point your MCP client at <span class="mono">/mcp</span> on this host and give it this bearer
                token. It is the same token printed on first start.
            </p>
            <div class="token">
                <input id="bearer" type="password" value="${opts.bearerToken}" readonly>
                <button class="ghost" type="button" data-reveal="bearer">Show</button>
                <button class="ghost" type="button" data-copy="bearer">Copy</button>
            </div>
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

export function logsPage(opts: {
    version: string;
    services: string[];
    selectedService: string;
    minLevel: number;
    streamUrl: string;
    rows: LogRow[];
}): string {
    const levels: [number, string][] = [
        [10, 'Everything'],
        [30, 'Info and above'],
        [40, 'Warnings and errors'],
        [50, 'Errors only']
    ];

    const body = html`<h2>Logs</h2>
        <p class="note">
            The last few thousand lines, kept in a ring buffer beside your config. Full history stays in
            <span class="mono">docker logs</span>.
        </p>

        <form class="inline" method="get" action="/ui/logs">
            <div>
                <label for="level">Level</label>
                <select id="level" name="level">
                    ${levels.map(
                        ([value, label]) =>
                            html`<option value="${value}" ${value === opts.minLevel ? raw('selected') : raw('')}>
                                ${label}
                            </option>`
                    )}
                </select>
            </div>
            <div>
                <label for="service">Service</label>
                <select id="service" name="service">
                    <option value="">All services</option>
                    ${opts.services.map(
                        s =>
                            html`<option value="${s}" ${s === opts.selectedService ? raw('selected') : raw('')}>
                                ${s}
                            </option>`
                    )}
                </select>
            </div>
            <button type="submit">Apply</button>
            <label class="row" style="margin:0"><input type="checkbox" id="follow" checked> Auto-refresh</label>
        </form>

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
