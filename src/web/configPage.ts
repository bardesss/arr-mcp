import { ServiceIdSchema, type Config, type ServiceId } from '../config/schema.ts';
import { html, raw, type SafeHtml } from './html.ts';
import { layout } from './pages.ts';

/**
 * The configuration form.
 *
 * One rule shapes the whole page: **a secret is never rendered back**. API
 * keys, the Transmission password and the UI password all render as empty
 * fields that mean "unchanged", so a saved page, a screenshot or a browser's
 * autofill history cannot carry them. That also means an empty field can never
 * mean "clear this" — clearing is done by disabling the service, which is
 * unambiguous.
 */

export const SERVICE_IDS = ServiceIdSchema.options;

/** Which extra fields each service actually has, so the form matches the
 *  schema rather than showing eight identical boxes. */
const MULTI_USER: ReadonlySet<string> = new Set(['jellyfin', 'seerr']);
const NO_API_KEY: ReadonlySet<string> = new Set(['transmission']);

type AnyService = {
    url: string;
    timeout_ms: number;
    permissions: { safe_write: boolean; destructive: boolean };
    api_key?: string;
    default_user?: string;
    allow_other_users?: boolean;
    username?: string;
    password?: string;
};

const field = (opts: {
    id: string;
    name: string;
    label: string;
    value?: string | number | undefined;
    type?: string;
    placeholder?: string;
    note?: string;
}): SafeHtml => html`<div class="field">
    <label for="${opts.id}">${opts.label}</label>
    <input
        id="${opts.id}"
        name="${opts.name}"
        type="${opts.type ?? 'text'}"
        value="${opts.value ?? ''}"
        placeholder="${opts.placeholder ?? ''}"
        autocomplete="off"
    >
    ${opts.note === undefined ? raw('') : html`<p class="note">${opts.note}</p>`}
</div>`;

const checkbox = (id: string, name: string, label: string, checked: boolean): SafeHtml =>
    html`<label class="row" style="margin:.25rem 0">
        <input type="checkbox" id="${id}" name="${name}" ${checked ? raw('checked') : raw('')}> ${label}
    </label>`;

function serviceFieldset(id: ServiceId, service: AnyService | undefined): SafeHtml {
    const on = service !== undefined;
    const p = `svc.${id}`;

    return html`<fieldset>
        <legend>${id}</legend>
        ${checkbox(`${p}.enabled`, `${p}.enabled`, `Configure ${id}`, on)}
        ${field({
            id: `${p}.url`,
            name: `${p}.url`,
            label: 'URL',
            value: service?.url ?? '',
            placeholder: 'http://192.168.1.20:7878'
        })}
        ${NO_API_KEY.has(id)
            ? html`${field({
                  id: `${p}.username`,
                  name: `${p}.username`,
                  label: 'Username (optional)',
                  value: service?.username ?? ''
              })}
              ${field({
                  id: `${p}.password`,
                  name: `${p}.password`,
                  label: 'Password',
                  type: 'password',
                  placeholder: on ? 'unchanged' : '',
                  note: 'Leave blank to keep the current password.'
              })}`
            : field({
                  id: `${p}.api_key`,
                  name: `${p}.api_key`,
                  label: 'API key',
                  type: 'password',
                  placeholder: on ? 'unchanged' : '',
                  note: on ? 'Leave blank to keep the current key.' : "From the service's Settings → General page."
              })}
        ${MULTI_USER.has(id)
            ? html`${field({
                  id: `${p}.default_user`,
                  name: `${p}.default_user`,
                  label: 'Default user',
                  value: service?.default_user ?? '',
                  note:
                      id === 'jellyfin'
                          ? 'Required if Jellyfin is configured — get_library, get_media_details and diagnose all need it.'
                          : 'Optional.'
              })}
              ${checkbox(
                  `${p}.allow_other_users`,
                  `${p}.allow_other_users`,
                  'Allow answering as other users',
                  service?.allow_other_users ?? false
              )}`
            : raw('')}
        ${field({
            id: `${p}.timeout_ms`,
            name: `${p}.timeout_ms`,
            label: 'Timeout (ms)',
            type: 'number',
            value: service?.timeout_ms ?? 10_000
        })}
        <p class="note" style="margin-top:.75rem">Writes — both off by default.</p>
        ${checkbox(
            `${p}.safe_write`,
            `${p}.safe_write`,
            'safe_write — searches, monitoring, request verdicts',
            service?.permissions.safe_write ?? false
        )}
        ${checkbox(
            `${p}.destructive`,
            `${p}.destructive`,
            'destructive — deletes files, queue items and requests (implies safe_write)',
            service?.permissions.destructive ?? false
        )}
    </fieldset>`;
}

export function configPage(opts: {
    version: string;
    config: Config;
    csrf: string;
    message?: { kind: 'ok' | 'err'; text: string } | undefined;
}): string {
    const services = opts.config.services as Partial<Record<ServiceId, AnyService>>;

    const body = html`<form method="post" action="/ui/config">
        <input type="hidden" name="csrf" value="${opts.csrf}">

        <h2>Services</h2>
        <p class="note">
            Saving applies immediately — no restart. Configure only what you run; anything left off is simply
            absent, not broken.
        </p>
        <div class="svc-grid">${SERVICE_IDS.map(id => serviceFieldset(id, services[id]))}</div>

        <h2>Access</h2>
        <fieldset>
            <legend>Config UI</legend>
            ${field({
                id: 'auth.username',
                name: 'auth.username',
                label: 'Username',
                value: opts.config.auth.username
            })}
            ${field({
                id: 'auth.password',
                name: 'auth.password',
                label: 'New password',
                type: 'password',
                placeholder: 'unchanged',
                note: 'Leave blank to keep the current password. Only a hash is stored — it cannot be read back.'
            })}
        </fieldset>

        <fieldset>
            <legend>MCP endpoint</legend>
            ${checkbox('auth.rotate_token', 'auth.rotate_token', 'Generate a new bearer token', false)}
            <p class="note">
                Rotating invalidates the current token immediately; every MCP client will need the new one,
                which appears on the dashboard.
            </p>
            ${field({
                id: 'auth.allowed_hosts',
                name: 'auth.allowed_hosts',
                label: 'Allowed hosts (comma separated)',
                value: opts.config.auth.allowed_hosts.join(', '),
                note: 'Leave empty to accept any Host — right for a LAN container reached by IP. Applies immediately; pin the wrong name and you will lock yourself out until you edit config.yaml by hand.'
            })}
        </fieldset>

        <div class="row">
            <button type="submit">Save and apply</button>
            <a href="/ui" style="margin-left:.5rem">Cancel</a>
        </div>
    </form>`;

    return layout({
        title: 'Configuration',
        nav: 'config',
        version: opts.version,
        body,
        ...(opts.message === undefined ? {} : { message: opts.message })
    });
}
