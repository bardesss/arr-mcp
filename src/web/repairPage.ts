import { html } from './html.ts';
import { layout } from './pages.ts';

/**
 * The file as text, because there is no parsed config to build a form from.
 * This is the one page in the UI that renders credentials back to the browser;
 * `docs/security.md` records why.
 */
export function repairPage(opts: { version: string; raw: string; detail: string; csrf: string }): string {
    const body = html`<div class="repair">
        <h2>config.yaml could not be loaded</h2>
        <p class="note">
            arr-mcp is running with this page only — no MCP endpoint, no services — until the file
            below is valid. Fix it and save; the server starts without a restart.
        </p>
        <form method="post" action="/ui/repair">
            <input type="hidden" name="csrf" value="${opts.csrf}">
            <textarea name="config" spellcheck="false" autocapitalize="off" autocorrect="off"
                      autocomplete="off" wrap="off">${opts.raw}</textarea>
            <button type="submit">Validate and save</button>
        </form>
        <p class="note">
            This shows the file exactly as it is on disk, credentials included — it is the only way
            to edit a file that could not be parsed.
        </p>
    </div>`;

    return layout({
        title: 'Configuration invalid',
        version: opts.version,
        body,
        message: { kind: 'err', text: opts.detail }
    });
}

/**
 * Read-only, because `auth` itself did not parse: no password can be checked,
 * and offering the setup page would let anyone who reaches the port claim the
 * instance by corrupting its config.
 */
export function unreadableAuthPage(opts: { version: string; detail: string }): string {
    const body = html`<div class="repair">
        <h2>config.yaml could not be loaded</h2>
        <p class="note">
            The <code>auth</code> block could not be read either, so there is no password this page
            could check — editing has to happen in <code>config.yaml</code> directly. Fix the error
            below and restart, and this page will let you do the rest in the browser.
        </p>
    </div>`;

    return layout({
        title: 'Configuration invalid',
        version: opts.version,
        body,
        message: { kind: 'err', text: opts.detail }
    });
}
