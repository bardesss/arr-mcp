import { listInstances, type ServiceInstance } from '../config/instances.ts';
import { MULTI_INSTANCE, ServiceIdSchema, type Config, type ServiceId } from '../config/schema.ts';
import type { ConnectionDiagnosis } from '../services/types.ts';
import { html, raw, type SafeHtml } from './html.ts';
import { layout } from './pages.ts';

/**
 * The configuration page: one card per configured instance, and nothing else.
 *
 * Three rules shape it.
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
 *
 * **Nothing here is `type="password"`.** That one attribute is what makes a
 * browser, and every password-manager extension, read a card as a login form:
 * a text input for the username, a password input below it. They then filled
 * the URL with a saved username and the key with a saved password on every
 * single load, so editing a timeout meant re-pasting both. `autocomplete="off"`
 * does not stop it — it is ignored for exactly these fields, deliberately. So
 * the secrets are masked in CSS instead (`IGNORE`, and `.secret` in
 * `assets.ts`), which leaves nothing for the heuristics to find.
 */

export const SERVICE_IDS = ServiceIdSchema.options;

/** Alphabetical, unlike `ServiceIdSchema.options` — which is declaration order
 *  and reads as arbitrary to anyone looking for their service in the list. */
export const SERVICE_IDS_ALPHABETICAL: readonly ServiceId[] = [...SERVICE_IDS].sort();

/** Which extra fields each service actually has, so a card matches the schema
 *  rather than showing eight identical boxes. */
const MULTI_USER: ReadonlySet<string> = new Set(['jellyfin', 'seerr']);
const NO_API_KEY_IDS: readonly ServiceId[] = ['transmission'];
const NO_API_KEY: ReadonlySet<string> = new Set(NO_API_KEY_IDS);

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

/**
 * Every way of saying "do not fill this in" that anything actually reads.
 *
 * `autocomplete="off"` is first because it is the standard one, and last
 * because on its own it does nothing here: Chrome and every major extension
 * ignore it for fields they have decided are credentials. The rest are each
 * vendor's own opt-out, which they do honour. Dashlane reads `data-form-type`
 * off the form rather than the input, so that one is on the `<form>` tags.
 */
const IGNORE = raw(
    'autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-protonpass-ignore'
);

/** Goes on every form on this page, alongside `IGNORE` on every input. */
const IGNORE_FORM = raw('autocomplete="off" data-form-type="other"');

const field = (opts: {
    id: string;
    name: string;
    label: string;
    value?: string | number | undefined;
    type?: string;
    placeholder?: string;
    note?: string;
    /** A credential: masked by `.secret` in CSS rather than by `type="password"`,
     *  which is the attribute that invites the autofill in the first place. */
    secret?: boolean;
    /** The service types this field belongs to. The add dialog's picker hides it
     *  for every other type; without scripting it simply stays visible. */
    only?: readonly string[];
    /** Suggestions from the service itself. A `<datalist>` rather than a
     *  `<select>` on purpose: the service is often unreachable at exactly the
     *  moment you are configuring it, and a dropdown with nothing in it would
     *  make the field unfillable until it came back. */
    suggestions?: readonly string[];
}): SafeHtml => html`<div class="field"${
    opts.only === undefined ? raw('') : html` data-only="${opts.only.join(' ')}"`
}>
    <label for="${opts.id}">${opts.label}</label>
    <input
        id="${opts.id}"
        ${opts.secret === true ? raw('class="secret" ') : raw('')}name="${opts.name}"
        type="${opts.secret === true ? 'text' : (opts.type ?? 'text')}"
        value="${opts.value ?? ''}"
        placeholder="${opts.placeholder ?? ''}"
        ${opts.suggestions === undefined ? raw('') : html`list="${opts.id}.options" `}${IGNORE}
    >
    ${opts.suggestions === undefined
        ? raw('')
        : html`<datalist id="${opts.id}.options">
              ${opts.suggestions.map(value => html`<option value="${value}"></option>`)}
          </datalist>`}
    ${opts.note === undefined ? raw('') : html`<p class="note">${opts.note}</p>`}
</div>`;

const checkbox = (id: string, name: string, label: string, checked: boolean): SafeHtml =>
    html`<label class="row" style="margin:.25rem 0">
        <input type="checkbox" id="${id}" name="${name}" ${checked ? raw('checked') : raw('')}> ${label}
    </label>`;

/**
 * What to say about the default user, which depends on whether the service was
 * able to tell us who its users are.
 *
 * `undefined` and `[]` are different answers: the first is "we could not ask",
 * which is worth saying because the empty suggestion list is otherwise
 * indistinguishable from a service with no users at all.
 */
function defaultUserNote(type: string, users: readonly string[] | undefined): string {
    const purpose =
        type === 'jellyfin'
            ? 'Required if Jellyfin is configured — get_library, get_media_details and diagnose all need it.'
            : 'Optional.';

    if (users === undefined) {
        return `${purpose} ${type} did not answer when asked who its users are, so there is nothing to pick from — type the name.`;
    }
    if (users.length === 0) return `${purpose} ${type} reports no users yet.`;
    return `${purpose} Pick one of the ${users.length} users ${type} reported, or type another.`;
}

/** The credential and identity fields a given service actually has. */
function serviceFields(
    instance: ServiceInstance,
    prefix: string,
    users: readonly string[] | undefined
): SafeHtml {
    const type = instance.type;
    const service = instance.config as AnyService;

    return html`${NO_API_KEY.has(type)
        ? html`${field({ id: `${prefix}.username`, name: 'username', label: 'Username (optional)', value: service.username ?? '' })}
          ${field({
              id: `${prefix}.password`,
              name: 'password',
              label: 'Password',
              secret: true,
              placeholder: 'unchanged',
              note: 'Leave blank to keep the current password.'
          })}`
        : field({
              id: `${prefix}.api_key`,
              name: 'api_key',
              label: 'API key',
              secret: true,
              placeholder: 'unchanged',
              note: 'Leave blank to keep the current key.'
          })}
    ${MULTI_USER.has(type)
        ? html`${field({
              id: `${prefix}.default_user`,
              name: 'default_user',
              label: 'Default user',
              value: service.default_user ?? '',
              ...(users === undefined ? {} : { suggestions: users }),
              note: defaultUserNote(type, users)
          })}
          ${checkbox(
              `${prefix}.allow_other_users`,
              'allow_other_users',
              'Allow answering as other users',
              service.allow_other_users ?? false
          )}`
        : raw('')}`;
}

/**
 * The result of a **Test**, in the card that asked for it.
 *
 * `testConnection` already returns kind, detail and remedy, which is why the
 * dashboard shows a diagnosis rather than a tick — the same reasoning applies
 * here, and more so: this is the page you are on *because* something is wrong.
 */
function testResult(d: ConnectionDiagnosis): SafeHtml {
    if (d.ok) {
        return html`<div class="msg ok" style="margin:.75rem 0 0">
            Reachable in ${d.latency_ms} ms${d.version === undefined ? raw('') : html` — version ${d.version}`}. Not
            saved yet: this tested the fields as they are on screen.
        </div>`;
    }

    return html`<div class="msg err" style="margin:.75rem 0 0">
        ${d.error?.detail ?? 'Unreachable.'}${d.error?.remedy === undefined ? raw('') : html`\n${d.error.remedy}`}
    </div>`;
}

function instanceCard(
    instance: ServiceInstance,
    csrf: string,
    confirming: string | undefined,
    users: readonly string[] | undefined,
    tested: ConnectionDiagnosis | undefined
): SafeHtml {
    const service = instance.config as AnyService;
    const p = `svc.${instance.id}`;
    const pendingRemoval = confirming === instance.id;

    return html`<form method="post" action="/ui/config/save" class="panel" ${IGNORE_FORM}>
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="instance" value="${instance.id}">

        <h3 style="margin:0 0 .75rem">
            <span class="mono">${instance.id}</span>
        </h3>

        ${field({ id: `${p}.url`, name: 'url', label: 'URL', value: service.url })}
        ${serviceFields(instance, p, users)}
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
            <!-- Tests the fields as they stand, saved or not: the question this
                 button answers is "is this URL and key right", which is worth
                 asking *before* writing it to disk. A blank key still means
                 unchanged, so testing a card you have not touched tests what is
                 already configured. -->
            <button type="submit" formaction="/ui/config/test" formnovalidate class="ghost">Test</button>
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
        ${tested === undefined ? raw('') : testResult(tested)}
    </form>`;
}

/**
 * The add form, in a dialog behind a button.
 *
 * It used to sit under the cards with every field showing at once, because
 * following the service picker needs scripting and this page keeps its
 * JavaScript to what genuinely needs it. That is still the rule — it is just no
 * longer a reason to make everyone read four fields that do not apply to them.
 * Both behaviours here are enhancements: `data-only` says which types a field
 * belongs to and the picker hides the rest, and the dialog is opened by
 * `showModal()`. With scripting off, a `<noscript>` rule in `layout` styles the
 * dialog back into the page and every field shows — exactly the form as it was.
 *
 * The server still validates either way, and answers with the specific thing to
 * do; those messages are written for a reader who saw everything at once.
 */
function addDialog(config: Config, csrf: string, open: boolean): SafeHtml {
    const instances = listInstances(config);
    const configured = new Set(instances.map(i => i.type));

    /** A service that cannot have a second instance and already has one is not
     *  a choice — offering it only to answer "already configured" wastes the
     *  click. The three multi-instance types are always here, so this list is
     *  never empty. */
    const offerable = SERVICE_IDS_ALPHABETICAL.filter(
        id => MULTI_INSTANCE.includes(id) || !configured.has(id)
    );

    const keyed = offerable.filter(id => !NO_API_KEY.has(id));
    const needsName = MULTI_INSTANCE.filter(t => configured.has(t));
    const unnamedSingle = MULTI_INSTANCE.filter(t =>
        instances.some(i => i.type === t && i.name === undefined)
    );

    return html`<dialog id="add-service"${open ? raw(' open') : raw('')}>
        <form method="post" action="/ui/config/add" class="panel" ${IGNORE_FORM}>
            <input type="hidden" name="csrf" value="${csrf}">
            <h3 style="margin:0 0 .75rem">Add a service</h3>

            <div class="field">
                <label for="add.type">Service</label>
                <select id="add.type" name="type">
                    ${offerable.map(id => html`<option value="${id}">${id}</option>`)}
                </select>
                ${offerable.length === SERVICE_IDS.length
                    ? raw('')
                    : html`<p class="note">
                          Already configured, and limited to one instance:
                          <span class="mono">${SERVICE_IDS_ALPHABETICAL.filter(
                              id => !offerable.includes(id)
                          ).join(', ')}</span>. Edit those on the card above.
                      </p>`}
            </div>

            ${field({ id: 'add.url', name: 'url', label: 'URL', placeholder: 'http://192.168.1.20:7878' })}
            ${field({
                id: 'add.api_key',
                name: 'api_key',
                label: 'API key',
                secret: true,
                only: keyed,
                note: "From the service's Settings → General page."
            })}
            ${offerable.length === keyed.length
                ? raw('')
                : html`${field({
                      id: 'add.username',
                      name: 'username',
                      label: 'Username (optional)',
                      only: NO_API_KEY_IDS
                  })}
                  ${field({
                      id: 'add.password',
                      name: 'password',
                      label: 'Password',
                      secret: true,
                      only: NO_API_KEY_IDS
                  })}`}

            ${needsName.length === 0
                ? raw('')
                : field({
                      id: 'add.name',
                      name: 'name',
                      label: 'Instance name',
                      placeholder: '4k',
                      only: needsName,
                      note: 'Required, because this service already has an instance. It becomes part of the id, as radarr/4k.'
                  })}

            ${unnamedSingle.length === 0
                ? raw('')
                : field({
                      id: 'add.rename_existing_to',
                      name: 'rename_existing_to',
                      label: 'Name for the existing instance',
                      placeholder: 'hd',
                      only: unnamedSingle,
                      note: 'Adding a second one means naming the one you already have. Its permissions move with it, and any saved prompt naming the bare service will start asking which instance you meant.'
                  })}

            <div class="row" style="margin-top:1rem">
                <button type="submit">Add</button>
                <!-- Native: closes the dialog without posting, no script involved.
                     Hidden with scripting off, where the dialog is the page. -->
                <button type="submit" formmethod="dialog" formnovalidate class="ghost close">Cancel</button>
            </div>
        </form>
    </dialog>`;
}

export function configPage(opts: {
    version: string;
    config: Config;
    csrf: string;
    /** The instance whose Remove button was pressed but not yet confirmed. */
    confirmingRemoval?: string | undefined;
    /** Set when an add was refused: the message and the form it is about have to
     *  arrive together, or the dialog has swallowed the reason. */
    openAdd?: boolean;
    /** Per instance id, the users that instance reported. An absent id means it
     *  was not asked or did not answer — which the card says out loud. */
    users?: Record<string, readonly string[]>;
    /** The one instance whose Test button was pressed, and what came back. */
    tested?: { instance: string; diagnosis: ConnectionDiagnosis } | undefined;
    message?: { kind: 'ok' | 'err'; text: string } | undefined;
}): string {
    const instances = listInstances(opts.config);

    const body = html`<h2>Services</h2>
        <div class="row" style="margin-bottom:1rem">
            <button type="button" data-open="add-service">Add a service</button>
            <span class="note" style="margin:0">
                ${instances.length === 0
                    ? raw('Nothing is configured yet — anything you leave out is simply absent, not broken.')
                    : raw('Saving applies immediately — no restart. Each instance is saved on its own.')}
            </span>
        </div>

        ${instances.map(i =>
            instanceCard(
                i,
                opts.csrf,
                opts.confirmingRemoval,
                opts.users?.[i.id],
                opts.tested?.instance === i.id ? opts.tested.diagnosis : undefined
            )
        )}
        ${addDialog(opts.config, opts.csrf, opts.openAdd === true)}

        <h2>Access</h2>
        <form method="post" action="/ui/config/access" ${IGNORE_FORM}>
            <input type="hidden" name="csrf" value="${opts.csrf}">
            <fieldset>
                <legend>Config UI</legend>
                ${field({ id: 'auth.username', name: 'auth.username', label: 'Username', value: opts.config.auth.username })}
                ${field({
                    id: 'auth.password',
                    name: 'auth.password',
                    label: 'New password',
                    secret: true,
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
