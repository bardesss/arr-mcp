import { listInstances, type ServiceInstance } from '../config/instances.ts';
import { MULTI_INSTANCE, ServiceIdSchema, type Config, type ServiceId } from '../config/schema.ts';
import { html, raw, type SafeHtml } from './html.ts';
import { layout } from './pages.ts';

/**
 * The configuration page: one card per configured instance, and nothing else.
 *
 * Two rules shape it.
 *
 * **A secret is never rendered back.** API keys, the Transmission password and
 * the UI password all render as empty fields meaning "unchanged", so a saved
 * page, a screenshot or a browser's autofill history cannot carry them. An empty
 * credential field therefore can never mean "clear this"; removing the instance
 * is how you clear it, which is unambiguous.
 *
 * **Each card is its own form.** The page used to render all eight services
 * inside one form and rebuild every service from `svc.<id>.<field>` prefixes on
 * every save. With instances that prefix would have to carry `radarr/4k`. A form
 * per card means bare field names, and a save that touches exactly the instance
 * it came from rather than rewriting seven others that happened to be on screen.
 */

export const SERVICE_IDS = ServiceIdSchema.options;

/** Alphabetical, unlike `ServiceIdSchema.options` — which is declaration order
 *  and reads as arbitrary to anyone looking for their service in the list. */
export const SERVICE_IDS_ALPHABETICAL: readonly ServiceId[] = [...SERVICE_IDS].sort();

/** Which extra fields each service actually has, so a card matches the schema
 *  rather than showing eight identical boxes. */
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

/** The credential and identity fields a given service actually has. */
function serviceFields(instance: ServiceInstance, prefix: string): SafeHtml {
    const type = instance.type;
    const service = instance.config as AnyService;

    return html`${NO_API_KEY.has(type)
        ? html`${field({ id: `${prefix}.username`, name: 'username', label: 'Username (optional)', value: service.username ?? '' })}
          ${field({
              id: `${prefix}.password`,
              name: 'password',
              label: 'Password',
              type: 'password',
              placeholder: 'unchanged',
              note: 'Leave blank to keep the current password.'
          })}`
        : field({
              id: `${prefix}.api_key`,
              name: 'api_key',
              label: 'API key',
              type: 'password',
              placeholder: 'unchanged',
              note: 'Leave blank to keep the current key.'
          })}
    ${MULTI_USER.has(type)
        ? html`${field({
              id: `${prefix}.default_user`,
              name: 'default_user',
              label: 'Default user',
              value: service.default_user ?? '',
              note:
                  type === 'jellyfin'
                      ? 'Required if Jellyfin is configured — get_library, get_media_details and diagnose all need it.'
                      : 'Optional.'
          })}
          ${checkbox(
              `${prefix}.allow_other_users`,
              'allow_other_users',
              'Allow answering as other users',
              service.allow_other_users ?? false
          )}`
        : raw('')}`;
}

function instanceCard(instance: ServiceInstance, csrf: string, confirming: string | undefined): SafeHtml {
    const service = instance.config as AnyService;
    const p = `svc.${instance.id}`;
    const pendingRemoval = confirming === instance.id;

    return html`<form method="post" action="/ui/config/save" class="panel">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="instance" value="${instance.id}">

        <h3 style="margin:0 0 .75rem">
            <span class="mono">${instance.id}</span>
        </h3>

        ${field({ id: `${p}.url`, name: 'url', label: 'URL', value: service.url })}
        ${serviceFields(instance, p)}
        ${field({ id: `${p}.timeout_ms`, name: 'timeout_ms', label: 'Timeout (ms)', type: 'number', value: service.timeout_ms })}

        <p class="note" style="margin-top:.75rem">Writes — both off by default, and granted per instance.</p>
        ${checkbox(`${p}.safe_write`, 'safe_write', 'safe_write — searches, monitoring, request verdicts', service.permissions.safe_write)}
        ${checkbox(
            `${p}.destructive`,
            'destructive',
            'destructive — deletes files, queue items and requests (implies safe_write)',
            service.permissions.destructive
        )}

        <div class="row" style="margin-top:1rem">
            <button type="submit">Save</button>
            ${pendingRemoval
                ? html`<button type="submit" formaction="/ui/config/remove" name="confirm" value="yes" class="ghost">
                          Yes, remove ${instance.id}
                      </button>`
                : html`<button type="submit" formaction="/ui/config/remove" class="ghost">Remove</button>`}
        </div>
        ${pendingRemoval
            ? html`<p class="note" style="margin-top:.5rem">
                  Removing <span class="mono">${instance.id}</span> discards its API key from this config. Re-adding it
                  means fetching the key from the service again. Save or reload to cancel.
              </p>`
            : raw('')}
    </form>`;
}

/**
 * The add form.
 *
 * Every field is always shown rather than revealed by the service picker,
 * because doing that without JavaScript is not possible and this page keeps its
 * JavaScript to the two behaviours that genuinely need it. The server validates
 * and answers with the specific thing to do — those messages are written for
 * exactly this.
 */
function addForm(config: Config, csrf: string): SafeHtml {
    const instances = listInstances(config);
    const configured = new Set(instances.map(i => i.type));

    const needsName = MULTI_INSTANCE.filter(t => configured.has(t));
    const unnamedSingle = MULTI_INSTANCE.filter(t =>
        instances.some(i => i.type === t && i.name === undefined)
    );

    return html`<form method="post" action="/ui/config/add" class="panel">
        <input type="hidden" name="csrf" value="${csrf}">
        <h3 style="margin:0 0 .75rem">Add a service</h3>

        <div class="field">
            <label for="add.type">Service</label>
            <select id="add.type" name="type">
                ${SERVICE_IDS_ALPHABETICAL.map(id => html`<option value="${id}">${id}</option>`)}
            </select>
        </div>

        ${field({ id: 'add.url', name: 'url', label: 'URL', placeholder: 'http://192.168.1.20:7878' })}
        ${field({
            id: 'add.api_key',
            name: 'api_key',
            label: 'API key',
            type: 'password',
            note: "From the service's Settings → General page. Leave blank for Transmission, which uses a username and password."
        })}
        ${field({ id: 'add.username', name: 'username', label: 'Username (Transmission only, optional)' })}
        ${field({ id: 'add.password', name: 'password', label: 'Password (Transmission only)', type: 'password' })}

        ${needsName.length === 0
            ? raw('')
            : html`<div class="field">
                      <label for="add.name">Instance name</label>
                      <input id="add.name" name="name" type="text" placeholder="4k" autocomplete="off">
                      <p class="note">
                          Required when a service already has one:
                          <span class="mono">${needsName.join(', ')}</span>. It becomes part of the id, as
                          <span class="mono">radarr/4k</span>.
                      </p>
                  </div>`}

        ${unnamedSingle.length === 0
            ? raw('')
            : html`<div class="field">
                      <label for="add.rename_existing_to">Name for the existing instance</label>
                      <input id="add.rename_existing_to" name="rename_existing_to" type="text" placeholder="hd" autocomplete="off">
                      <p class="note">
                          Adding a second <span class="mono">${unnamedSingle.join(' or ')}</span> means naming the one
                          you already have. Its permissions move with it, and any saved prompt naming the bare service
                          will start asking which instance you meant.
                      </p>
                  </div>`}

        <div class="row" style="margin-top:1rem"><button type="submit">Add</button></div>
    </form>`;
}

export function configPage(opts: {
    version: string;
    config: Config;
    csrf: string;
    /** The instance whose Remove button was pressed but not yet confirmed. */
    confirmingRemoval?: string | undefined;
    message?: { kind: 'ok' | 'err'; text: string } | undefined;
}): string {
    const instances = listInstances(opts.config);

    const body = html`<h2>Services</h2>
        ${instances.length === 0
            ? html`<div class="panel">
                  <p class="note" style="margin:0">
                      Nothing is configured yet. Add the services you run — anything you leave out is simply absent,
                      not broken. Saving applies immediately; there is no restart.
                  </p>
              </div>`
            : html`<p class="note">
                      Saving applies immediately — no restart. Each instance is saved on its own.
                  </p>
                  ${instances.map(i => instanceCard(i, opts.csrf, opts.confirmingRemoval))}`}

        ${addForm(opts.config, opts.csrf)}

        <h2>Access</h2>
        <form method="post" action="/ui/config/access">
            <input type="hidden" name="csrf" value="${opts.csrf}">
            <fieldset>
                <legend>Config UI</legend>
                ${field({ id: 'auth.username', name: 'auth.username', label: 'Username', value: opts.config.auth.username })}
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
                <button type="submit">Save access settings</button>
                <a href="/ui" style="margin-left:.5rem">Back to the dashboard</a>
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
