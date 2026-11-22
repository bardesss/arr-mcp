import { configEtag } from '../config/etag.ts';
import { listInstances, type ServiceInstance } from '../config/instances.ts';
import { isMultiInstance } from '../config/instances.ts';
import { describeSource, secretSource } from '../config/secretSources.ts';
import {
    MEDIA_SERVER_NAMES,
    MediaServerIdSchema,
    mediaServersIn,
    MULTI_INSTANCE,
    OAuthSchema,
    secretFieldOf,
    ServiceIdSchema,
    serviceTraits,
    type Config,
    type ServiceId,
    type Theme
} from '../config/schema.ts';
import { unfence } from '../core/fence.ts';
import { UNDISCOVERABLE } from '../discovery/catalog.ts';
import type { ResultRow } from '../discovery/match.ts';
import type { RunState } from '../discovery/run.ts';
import { bearerCaller, daysLeft, expiringSoon, isExpired } from '../core/mcpTokens.ts';
import { fingerprint } from '../core/secrets.ts';
import { WEBHOOK_SERVICES, WEBHOOK_USERNAME } from '../services/arrWebhook.ts';
import type { ConnectionDiagnosis } from '../services/types.ts';
import { withoutCredentials } from '../tools/stackHealth.ts';
import { html, raw, type SafeHtml } from './html.ts';
import { serviceIcon } from './icons.ts';
import type { JwksProbe } from './jwksProbe.ts';
import { layout } from './pages.ts';

/**
 * One card per configured instance, and nothing else. Three rules shape it.
 *
 * **A secret is never rendered back.** Credentials render as empty fields
 * meaning "unchanged", so a saved page or a screenshot cannot carry them. Blank
 * therefore never means "clear this"; removing the instance does.
 *
 * **Each card is its own form**, so a save touches exactly the instance it came
 * from rather than rewriting every other service on screen. That holds for the
 * three access cards at the bottom too, and did not always: they shared one
 * button, which by sitting last on the page read as a global save while every
 * card above saved itself. One rule now (the card you edited is the card you
 * save) and one route per card in `routes.ts` to enforce it, each carrying
 * forward the config it does not own.
 *
 * **Nothing here is `type="password"`.** That attribute is what makes browsers
 * and password managers read a card as a login form and fill the URL and key on
 * every load, so editing a timeout meant re-pasting both. `autocomplete="off"`
 * is ignored for those fields deliberately, so the secrets are masked in CSS
 * instead, leaving nothing for the heuristics to find.
 */

export const SERVICE_IDS = ServiceIdSchema.options;

/** Labelled rather than title-cased from the key: "System" alone does not say
 *  what it follows, and this is the only place it is explained. */
const THEMES: readonly { key: Theme; label: string }[] = [
    { key: 'system', label: 'Follow the system' },
    { key: 'dark', label: 'Dark' },
    { key: 'light', label: 'Light' }
];

/** Alphabetical, unlike `ServiceIdSchema.options`, which is declaration order
 *  and reads as arbitrary to anyone looking for their service in the list. */
const SERVICE_IDS_ALPHABETICAL: readonly ServiceId[] = [...SERVICE_IDS].sort();

/**
 * The types the add dialog offers. A service that cannot have a second
 * instance and already has one is not a choice: offering it only to answer
 * "already configured" wastes the click. Nor is a third media server beside
 * two, which saving refuses. The multi-instance types are always here, so this
 * list is never empty.
 */
export function offerableTypes(config: Config): ServiceId[] {
    const configured = new Set(listInstances(config).map(i => i.type));
    const mediaServersFull = mediaServersIn(config.services).length >= 2;
    const isMediaServer = (id: ServiceId): boolean => MediaServerIdSchema.safeParse(id).success;
    return SERVICE_IDS_ALPHABETICAL.filter(id => isMultiInstance(id) || !(configured.has(id) || (mediaServersFull && isMediaServer(id))));
}

/** The services that sign in with a username and password rather than an API key. */
const PASSWORD_SERVICES: readonly ServiceId[] = SERVICE_IDS.filter(id => secretFieldOf(id) === 'password');

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
 * `autocomplete="off"` is the standard one and does nothing on its own: Chrome
 * and every major extension ignore it for fields they consider credentials. The
 * rest are per-vendor opt-outs, which they do honour. Dashlane reads
 * `data-form-type` off the form, so that one is on the `<form>` tags.
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
    /** The instance whose users the page fetches after it loads and offers in
     *  this field. A `<datalist>` rather than a `<select>` on purpose: the
     *  service is often unreachable at exactly the moment you are configuring
     *  it, and a dropdown with nothing in it would make the field unfillable.
     *  Rendered empty for the client to fill; without scripting the field is
     *  simply a text box. */
    usersFor?: string;
    /** Set from a file or the environment (#636): shown, never editable here. */
    readOnly?: boolean;
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
        ${opts.readOnly === true ? raw('readonly ') : raw('')}${opts.usersFor === undefined ? raw('') : html`list="${opts.id}.options" data-users-for="${opts.usersFor}" `}${IGNORE}
    >
    ${opts.usersFor === undefined ? raw('') : html`<datalist id="${opts.id}.options"></datalist>`}
    ${opts.note === undefined ? raw('') : html`<p class="note" id="${opts.id}.note">${opts.note}</p>`}
</div>`;

const checkbox = (id: string, name: string, label: string, checked: boolean, disabled = false): SafeHtml =>
    html`<label class="row" style="margin:.25rem 0">
        <input type="checkbox" id="${id}" name="${name}" ${checked ? raw('checked') : raw('')} ${disabled ? raw('disabled') : raw('')}> ${label}
    </label>`;

/**
 * What to say about the default user, which depends on whether the service was
 * able to tell us who its users are.
 *
 * `undefined` and `[]` are different answers: the first is "we could not ask",
 * which is worth saying because the empty suggestion list is otherwise
 * indistinguishable from a service with no users at all.
 */
export function defaultUserNote(type: string, users: readonly string[] | undefined | 'pending'): string {
    const purpose =
        type === 'jellyfin' || type === 'emby'
            ? `Optional. Without it, get_library returns the Radarr and Sonarr halves with ${MEDIA_SERVER_NAMES[type]} marked degraded.`
            : 'Optional.';

    if (users === 'pending') {
        return `${purpose} Type the name. With scripting on, the users ${type} reports are offered as you type.`;
    }
    if (users === undefined) {
        return `${purpose} ${type} did not answer when asked who its users are, so there is nothing to pick from. Type the name.`;
    }
    if (users.length === 0) return `${purpose} ${type} reports no users yet.`;
    return `${purpose} Pick one of the ${users.length} users ${type} reported, or type another.`;
}

/** The credential and identity fields a given service actually has. */
function serviceFields(instance: ServiceInstance, prefix: string): SafeHtml {
    const type = instance.type;
    const service = instance.config as AnyService;
    const { fields, required } = serviceTraits(type);
    const secret = secretFieldOf(type);
    // A reference set in config.yaml is shown as one and cannot be typed
    // over: the save keeps it, and the edit would be refused anyway (#636).
    const source = secretSource(service, secret);
    const secretInput = (label: string, keep: string) =>
        source === undefined
            ? field({
                  id: `${prefix}.${secret}`,
                  name: secret,
                  label,
                  secret: true,
                  placeholder: 'unchanged',
                  note: `Leave blank to keep the current ${keep}. A new host, port or scheme needs it entered again.`
              })
            : field({
                  id: `${prefix}.${secret}`,
                  name: secret,
                  label,
                  readOnly: true,
                  placeholder: source.kind === 'file' ? 'set from file' : 'set from environment',
                  note: `This ${keep} is ${describeSource(source, secret)}. Change it there; arr-mcp reads it when it starts.`
              });

    return html`${secret === 'password'
        ? html`${field({ id: `${prefix}.username`, name: 'username', label: required.has('username') ? 'Username' : 'Username (optional)', value: service.username ?? '' })}
          ${secretInput('Password', 'password')}`
        : secretInput('API key', 'key')}
    ${fields.has('default_user')
        ? html`${field({
              id: `${prefix}.default_user`,
              name: 'default_user',
              label: 'Default user',
              value: service.default_user ?? '',
              usersFor: instance.id,
              note: defaultUserNote(type, 'pending')
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
 * dashboard shows a diagnosis rather than a tick; the same reasoning applies
 * here, and more so: this is the page you are on *because* something is wrong.
 */
function testResult(d: ConnectionDiagnosis): SafeHtml {
    if (d.ok) {
        return html`<div class="msg ok" style="margin:.75rem 0 0">
            Reachable in ${d.latency_ms} ms${d.version === undefined ? raw('') : html`, version ${d.version}`}. Not
            saved yet: this tested the fields as they are on screen.
        </div>`;
    }

    return html`<div class="msg err" style="margin:.75rem 0 0">
        ${d.error === undefined ? 'Unreachable.' : unfence(d.error.detail)}${d.error?.remedy === undefined ? raw('') : html`\n${unfence(d.error.remedy)}`}
    </div>`;
}

/** What the collapsed row says about a card's writes, in one word. */
function writeLabel(permissions: { safe_write: boolean; destructive: boolean }): string {
    if (permissions.destructive) return 'destructive';
    if (permissions.safe_write) return 'safe_write';
    return 'read-only';
}

function instanceCard(
    instance: ServiceInstance,
    keys: SafeHtml,
    confirming: string | undefined,
    tested: ConnectionDiagnosis | undefined,
    open: boolean
): SafeHtml {
    const service = instance.config as AnyService;
    const p = `svc.${instance.id}`;
    const pendingRemoval = confirming === instance.id;

    return html`<form method="post" action="/ui/config/save" class="panel" ${IGNORE_FORM}>
        ${keys}
        <input type="hidden" name="instance" value="${instance.id}">

        <details class="svc"${open ? raw(' open') : raw('')}>
        <summary class="svc-title">
            ${serviceIcon(instance.id)}
            <span class="mono">${instance.id}</span>
            <span class="svc-host mono">${withoutCredentials(service.url)}</span>
            <span class="svc-writes">${writeLabel(service.permissions)}</span>
        </summary>

        ${field({ id: `${p}.url`, name: 'url', label: 'URL', value: withoutCredentials(service.url) })}
        ${serviceFields(instance, p)}
        ${field({ id: `${p}.timeout_ms`, name: 'timeout_ms', label: 'Timeout (ms)', type: 'number', value: service.timeout_ms })}

        ${serviceTraits(instance.type).readOnly
            ? html`<p class="note" style="margin-top:.75rem">Read-only: arr-mcp never writes to ${instance.type}, so there is nothing to grant.</p>`
            : html`<p class="note" style="margin-top:.75rem">Writes: both off by default, and granted per instance.</p>
                  ${checkbox(`${p}.safe_write`, 'safe_write', 'safe_write: searches, monitoring, request verdicts', service.permissions.safe_write)}
                  ${checkbox(
                      `${p}.destructive`,
                      'destructive',
                      'destructive: deletes files, queue items and requests (implies safe_write)',
                      service.permissions.destructive
                  )}`}
        ${serviceTraits(instance.type).fields.has('allow_metadata_repair')
            ? html`${checkbox(
                  `${p}.allow_metadata_repair`,
                  'allow_metadata_repair',
                  'allow_metadata_repair: let fix_metadata repair Plex metadata',
                  (service as { allow_metadata_repair?: boolean }).allow_metadata_repair ?? true
              )}
              <p class="note">On by default. The repair also needs destructive.</p>`
            : raw('')}

        <div class="row" style="margin-top:1rem">
            <button type="submit">Save</button>
            <!-- Tests the fields as they stand, saved or not: the question this
                 button answers is "is this URL and key right", which is worth
                 asking *before* writing it to disk. A blank key still means
                 unchanged, so testing a card you have not touched tests what is
                 already configured. -->
            <button type="submit" formaction="/ui/config/test" formnovalidate class="ghost">Test</button>
            ${pendingRemoval
                ? html`<button type="submit" formaction="/ui/config/remove" name="confirm" value="yes" class="danger">
                          Yes, remove ${instance.id}
                      </button>`
                : html`<button type="submit" formaction="/ui/config/remove" class="danger">Remove</button>`}
        </div>
        ${pendingRemoval
            ? html`<p class="note" style="margin-top:.5rem">
                  Removing <span class="mono">${instance.id}</span> discards its API key from this config. Re-adding it
                  means fetching the key from the service again. Save or reload to cancel.
              </p>`
            : raw('')}
        ${tested === undefined ? raw('') : testResult(tested)}
        </details>
    </form>`;
}

/* --- credentials -------------------------------------------------------
 *
 * An MCP token and a management API key are one thing under two names: a named
 * credential with a tier, a fingerprint, and a button that withdraws it. They
 * were written twice and drifted, and the drift was most of what this page felt
 * like to use. The two tables disagreed on columns. One confirmation told you
 * how to back out and the other left you to guess. One card showed its own
 * errors and the other posted them to a banner at the top of a page its own
 * anchor had already scrolled four screens past.
 *
 * So: one table, one revoke form, one card shape, and the next change to any of
 * it lands on both.
 */

type CredentialRow = {
    name: string;
    tier: string;
    /** Absent on a token made before the field existed, or hand-written into config.yaml. */
    created: string | undefined;
    expires: SafeHtml;
    /** Linked where the credential appears in the write trail, plain where it cannot. */
    fingerprint: SafeHtml;
    /** Its own line under the fingerprint, in the warning colour. */
    flag?: string | undefined;
    revoke: SafeHtml;
};

const credentialTable = (rows: readonly CredentialRow[]): SafeHtml => html`<table class="stacked creds">
    <thead>
        <tr><th>Name</th><th>Tier</th><th>Created</th><th>Expires</th><th>Fingerprint</th><th></th></tr>
    </thead>
    <tbody>
        ${rows.map(
            r => html`<tr>
                <td class="mono">${r.name}</td>
                <td>${r.tier}</td>
                <td>${r.created === undefined ? html`<span class="dim">unknown</span>` : r.created}</td>
                <td>${r.expires}</td>
                <td class="mono">${r.fingerprint}${r.flag === undefined
                    ? raw('')
                    : html`<span class="flag">${r.flag}</span>`}</td>
                <td>${r.revoke}</td>
            </tr>`
        )}
    </tbody>
</table>`;

/**
 * Revoke, confirm, and a way out of the confirmation.
 *
 * The second click is a second button rather than a `confirm()` call, for the
 * reason the service removal is: with scripting off, a scripted confirmation
 * revokes on the first click. The sentence says how to cancel because the OAuth
 * card said it and these two did not, leaving a button whose only exit was a
 * reload you had to think of yourself.
 */
function revokeForm(opts: {
    action: string;
    field: string;
    name: string;
    keys: SafeHtml;
    confirming: boolean;
    /** What revoking this one costs, which differs when it is the last of its kind. */
    consequence: string;
}): SafeHtml {
    return html`<form method="post" action="${opts.action}" ${IGNORE_FORM}>
        ${opts.keys}
        <input type="hidden" name="${opts.field}" value="${opts.name}">
        ${opts.confirming
            ? html`<button type="submit" name="confirm" value="yes" class="danger">Yes, revoke ${opts.name}</button>
                  <p class="note">${opts.consequence} Reload to cancel.</p>`
            : html`<button type="submit" class="danger">Revoke</button>`}
    </form>`;
}

/**
 * How long a credential has left, in the words the dashboard uses.
 *
 * The dashboard coloured "4 days left" and said to rotate it. This page, the
 * one carrying the Revoke button and the create form, printed the date and
 * nothing else, so the warning appeared everywhere except where you act on it.
 */
function expiryCell(expires: string | undefined, now: Date): SafeHtml {
    if (expires === undefined) return html`<span class="dim">never</span>`;
    if (isExpired(expires, now)) return html`<span class="warn"><strong>expired</strong> ${expires}</span>`;
    if (expiringSoon(expires, now)) return html`<span class="warn">${expires} (${daysLeft(expires, now)})</span>`;
    return html`${expires}`;
}

/**
 * The address a client is pointed at, with the button that copies it.
 *
 * Both credential cards carry one. The MCP endpoint used to be on the dashboard
 * only, and the client config could be copied during exactly one response: the
 * one that revealed a new token. Anyone adding a second client a month later
 * opened the page that manages tokens and found neither.
 */
const endpointRow = (opts: {
    id: string;
    label: string;
    url: string | undefined;
    absent: SafeHtml;
    extras?: SafeHtml | undefined;
}): SafeHtml =>
    opts.url === undefined
        ? opts.absent
        : html`<label for="${opts.id}">${opts.label}</label>
              <div class="token">
                  <input id="${opts.id}" type="text" value="${opts.url}" readonly ${IGNORE}>
                  <button class="ghost" type="button" data-copy="${opts.id}">Copy</button>
              </div>
              ${opts.extras ?? raw('')}`;

/**
 * The shape both credential cards take, in the order the questions get asked:
 * what this is, what just happened to it, where to point a client, what exists
 * already, and how to make another.
 *
 * `message` is rendered inside the card rather than in the page banner because
 * both cards are anchored and their posts carry the fragment, so the answer
 * lands on the card. A refusal in a banner four screens above the control that
 * caused it is a refusal nobody reads.
 */
function credentialCard(opts: {
    id: string;
    title: string;
    message: { kind: 'ok' | 'err'; text: string } | undefined;
    reveal: SafeHtml;
    note: SafeHtml;
    endpoint: SafeHtml;
    rows: SafeHtml;
    formTitle: string;
    form: SafeHtml;
}): SafeHtml {
    return html`<section class="panel" id="${opts.id}">
        <h2>${opts.title}</h2>
        ${opts.message === undefined ? raw('') : html`<div class="msg ${opts.message.kind}">${opts.message.text}</div>`}
        ${opts.reveal}
        ${opts.note}
        ${opts.endpoint}
        ${opts.rows}
        <h3>${opts.formTitle}</h3>
        ${opts.form}
    </section>`;
}

type Revealed = { name: string; token: string };

/**
 * The one response a token's plaintext exists in.
 *
 * The buttons that assemble a client config live in the endpoint row above and
 * read this field while it is present, so the page has one set of them rather
 * than one set here and nothing at all afterwards.
 */
const revealPanel = (r: Revealed): SafeHtml => html`<div class="panel reveal">
    <p><strong>Copy the token for ${r.name} now.</strong> It is shown once and cannot be read back.</p>
    <div class="token">
        <input id="bearer" type="text" value="${r.token}" readonly ${IGNORE}>
        <button class="ghost" type="button" data-copy="bearer">Copy</button>
    </div>
</div>`;

/** The same panel for a management key, revealed the same way and once. */
const revealKeyPanel = (key: string): SafeHtml => html`<div class="panel reveal">
    <p><strong>Copy this key now.</strong> It is shown once and cannot be read back.</p>
    <div class="token">
        <input id="management-key" type="text" value="${key}" readonly ${IGNORE}>
        <button class="ghost" type="button" data-copy="management-key">Copy</button>
    </div>
</div>`;

const TIERS: readonly { key: string; label: string }[] = [
    { key: 'read', label: 'read: no writes' },
    { key: 'write', label: 'write: searches, monitoring, request verdicts' },
    { key: 'destructive', label: 'destructive: deletes files, queue items and requests (implies write)' }
];

const EXPIRIES: readonly { key: string; label: string }[] = [
    { key: '90', label: '90 days' },
    { key: '30', label: '30 days' },
    { key: 'never', label: 'Never' }
];

const tokenCreateForm = (keys: SafeHtml): SafeHtml => html`<form method="post" action="/ui/config/tokens/add#tokens" ${IGNORE_FORM}>
    ${keys}
    ${field({ id: 'token.name', name: 'token.name', label: 'Name', placeholder: 'phone' })}
    <div class="field">
        <label for="token.tier">Tier</label>
        <select id="token.tier" name="token.tier">
            ${TIERS.map(t => html`<option value="${t.key}" ${t.key === 'read' ? raw('selected') : raw('')}>${t.label}</option>`)}
        </select>
        <p class="note">Each instance's own write switches still apply; a token never grants more than they do.</p>
    </div>
    <div class="field">
        <label for="token.expiry">Expires</label>
        <select id="token.expiry" name="token.expiry">
            ${EXPIRIES.map(e => html`<option value="${e.key}" ${e.key === '90' ? raw('selected') : raw('')}>${e.label}</option>`)}
        </select>
    </div>
    <div class="row" style="margin-top:1rem">
        <button type="submit">Create token</button>
    </div>
</form>`;

const KEY_TIERS: readonly { key: string; label: string }[] = [
    { key: 'read', label: 'read: looks only, for dashboards' },
    { key: 'admin', label: 'admin: can change services, settings and MCP tokens' }
];

const keyCreateForm = (keys: SafeHtml): SafeHtml => html`<form method="post" action="/ui/config/api-keys/add#management-api" ${IGNORE_FORM}>
    ${keys}
    ${field({ id: 'api-key.name', name: 'api-key.name', label: 'Name', placeholder: 'nzb360' })}
    <div class="field">
        <label for="api-key.tier">Tier</label>
        <select id="api-key.tier" name="api-key.tier">
            ${KEY_TIERS.map(t => html`<option value="${t.key}" ${t.key === 'read' ? raw('selected') : raw('')}>${t.label}</option>`)}
        </select>
    </div>
    <div class="row" style="margin-top:1rem">
        <button type="submit">Create key</button>
    </div>
</form>`;

/**
 * The add form, in a dialog behind a button.
 *
 * It used to sit under the cards with every field showing at once, because
 * following the service picker needs scripting and this page keeps its
 * JavaScript to what genuinely needs it. That is still the rule; it is just no
 * longer a reason to make everyone read four fields that do not apply to them.
 * Both behaviours here are enhancements: `data-only` says which types a field
 * belongs to and the picker hides the rest, and the dialog is opened by
 * `showModal()`. With scripting off, a `<noscript>` rule in `layout` styles the
 * dialog back into the page and every field shows, exactly the form as it was.
 *
 * The server still validates either way, and answers with the specific thing to
 * do; those messages are written for a reader who saw everything at once.
 */
function addDialog(
    config: Config,
    keys: SafeHtml,
    open: boolean,
    tested: ConnectionDiagnosis | undefined,
    prefill: { type: ServiceId; url: string } | undefined
): SafeHtml {
    const instances = listInstances(config);
    const configured = new Set(instances.map(i => i.type));
    const offerable = offerableTypes(config);

    const keyed = offerable.filter(id => secretFieldOf(id) === 'api_key');
    const needsName = MULTI_INSTANCE.filter(t => configured.has(t));
    const unnamedSingle = MULTI_INSTANCE.filter(t =>
        instances.some(i => i.type === t && i.name === undefined)
    );

    return html`<dialog id="add-service"${open ? raw(' open') : raw('')}>
        <form method="post" action="/ui/config/add" class="panel" ${IGNORE_FORM}>
            ${keys}
            <h2>Add a service</h2>

            <div class="field">
                <label for="add.type">Service</label>
                <select id="add.type" name="type">
                    ${offerable.map(
                        id => html`<option value="${id}"${prefill?.type === id ? raw(' selected') : raw('')}>${id}</option>`
                    )}
                </select>
                ${offerable.length === SERVICE_IDS.length
                    ? raw('')
                    : html`<p class="note">
                          ${(() => {
                              const alreadyConfigured = SERVICE_IDS_ALPHABETICAL.filter(id => !offerable.includes(id) && configured.has(id));
                              return alreadyConfigured.length === 0
                                  ? raw('')
                                  : html`Already configured, and limited to one instance:
                                        <span class="mono">${alreadyConfigured.join(', ')}</span>. Edit those on the
                                        card above. `;
                          })()}
                          ${(() => {
                              const thirdServer = SERVICE_IDS_ALPHABETICAL.filter(id => !offerable.includes(id) && !configured.has(id));
                              return thirdServer.length === 0
                                  ? raw('')
                                  : html`At most two of <span class="mono">${MediaServerIdSchema.options.join(', ')}</span> can
                                        be configured together, so <span class="mono">${thirdServer.join(', ')}</span> is not
                                        offered.`;
                          })()}
                      </p>`}
            </div>

            ${field({
                id: 'add.url',
                name: 'url',
                label: 'URL',
                placeholder: 'http://192.168.1.20:7878',
                ...(prefill === undefined ? {} : { value: prefill.url })
            })}
            ${field({
                id: 'add.api_key',
                name: 'api_key',
                label: 'API key',
                secret: true,
                only: keyed,
                note: "From the service's Settings → General page. Shelfmark sets its keys in the environment, and needs none until authentication is on."
            })}
            ${offerable.length === keyed.length
                ? raw('')
                : html`${field({
                      id: 'add.username',
                      name: 'username',
                      label: 'Username',
                      note: 'Optional for Transmission, qBittorrent and NZBGet. Grimmory needs one.',
                      only: PASSWORD_SERVICES
                  })}
                  ${field({
                      id: 'add.password',
                      name: 'password',
                      label: 'Password',
                      secret: true,
                      only: PASSWORD_SERVICES
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
                <!-- The question this dialog exists to get wrong is "is this URL
                     and this key right", and the cheapest place to answer it is
                     before anything is written to config.yaml.

                     Scripted, this posts through fetch and fills #add-test-result
                     below without leaving the page, because a re-render would
                     have to either clear the key you just typed or echo it back
                     into the HTML, and this file does not echo secrets. With
                     scripting off it is an ordinary submit: the server renders
                     the page with the dialog open and the diagnosis on it, the
                     fields blank, exactly as a refused Add already does. -->
                <button type="submit" formaction="/ui/config/test" formnovalidate class="ghost">Test</button>
                <!-- Native: closes the dialog without posting, no script involved.
                     Hidden with scripting off, where the dialog is the page. -->
                <button type="submit" formmethod="dialog" formnovalidate class="ghost close">Cancel</button>
            </div>
            <div id="add-test-result">${tested === undefined ? raw('') : testResult(tested)}</div>
        </form>
    </dialog>`;
}

/** What the OAuth card's fields hold, as typed. */
export type OAuthDraft = {
    issuer: string;
    audience: string;
    jwks_uri: string;
    read: string;
    write: string;
    destructive: string;
};

type OAuthCardState = {
    draft?: OAuthDraft;
    message?: { kind: 'ok' | 'err'; text: string };
    tested?: JwksProbe;
    /** One more line for a passing Test, such as a Save that would be refused. */
    testedNote?: string;
    confirmingRemoval?: boolean;
};

const oauthTestResult = (p: JwksProbe, note: string | undefined): SafeHtml =>
    html`<div class="msg ${p.ok ? 'ok' : 'err'}" style="margin:.75rem 0 0">${p.summary}${p.keys.length === 0
        ? raw('')
        : html`<ul style="margin:.4rem 0">${p.keys.map(
              k =>
                  html`<li><span class="mono">${k.kid}</span> (${k.alg})${k.refused === undefined
                      ? raw('')
                      : html`: not accepted, ${k.refused}`}</li>`
          )}</ul>`}${p.ok ? 'Not saved yet: this tested the fields as they are on screen.' : ''}${note === undefined
        ? raw('')
        : html`<br>${note}`}</div>`;

/**
 * `auth.oauth`. The actions carry `#oauth` so the page that comes back is
 * scrolled to this card, which is also where its outcome is shown.
 */
function oauthCard(config: Config, keys: SafeHtml, state: OAuthCardState): SafeHtml {
    const current = config.auth.oauth;
    const defaults = OAuthSchema.shape.scopes.parse(undefined);
    const d: OAuthDraft = state.draft ?? {
        issuer: current?.issuer ?? '',
        audience: current?.audience ?? '',
        jwks_uri: current?.jwks_uri ?? '',
        read: current?.scopes.read ?? defaults.read,
        write: current?.scopes.write ?? defaults.write,
        destructive: current?.scopes.destructive ?? defaults.destructive
    };
    const confirming = state.confirmingRemoval === true;

    return html`<form id="oauth" method="post" action="/ui/config/oauth#oauth" class="panel" ${IGNORE_FORM}>
        ${keys}
        <h2>OAuth</h2>
        <p class="note">
            arr-mcp only verifies access tokens: your identity provider issues them, and this is where to
            tell arr-mcp which ones to trust. Named MCP tokens keep working whatever is set here.
        </p>
        ${field({ id: 'auth.oauth.issuer', name: 'auth.oauth.issuer', label: 'Issuer', value: d.issuer, placeholder: 'https://auth.example.com/application/o/arr-mcp/' })}
        ${field({ id: 'auth.oauth.audience', name: 'auth.oauth.audience', label: 'Audience', value: d.audience, placeholder: 'arr-mcp' })}
        ${field({ id: 'auth.oauth.jwks_uri', name: 'auth.oauth.jwks_uri', label: 'JWKS URI', value: d.jwks_uri, placeholder: 'https://auth.example.com/application/o/arr-mcp/jwks/' })}
        ${field({ id: 'auth.oauth.scopes.read', name: 'auth.oauth.scopes.read', label: 'Read scope', value: d.read })}
        ${field({ id: 'auth.oauth.scopes.write', name: 'auth.oauth.scopes.write', label: 'Write scope', value: d.write })}
        ${field({ id: 'auth.oauth.scopes.destructive', name: 'auth.oauth.scopes.destructive', label: 'Destructive scope', value: d.destructive })}
        <div class="row" style="margin-top:1rem">
            <button type="submit">Save</button>
            <button type="submit" formaction="/ui/config/oauth/test#oauth" formnovalidate class="ghost">Test</button>
            ${current === undefined
                ? raw('')
                : confirming
                  ? html`<button type="submit" formaction="/ui/config/oauth/remove#oauth" formnovalidate name="confirm" value="yes" class="danger">Yes, remove OAuth</button>`
                  : html`<button type="submit" formaction="/ui/config/oauth/remove#oauth" formnovalidate class="danger">Remove</button>`}
        </div>
        ${confirming
            ? html`<p class="note" style="margin-top:.5rem">
                  OAuth clients are refused from the next request. Named MCP tokens keep working. Reload to cancel.
              </p>`
            : raw('')}
        ${state.message === undefined
            ? raw('')
            : html`<div class="msg ${state.message.kind}" style="margin:.75rem 0 0">${state.message.text}</div>`}
        ${state.tested === undefined ? raw('') : oauthTestResult(state.tested, state.testedNote)}
    </form>`;
}

const COPY = raw(
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
);

/** The slash appears while the secret is showing. See `[data-reveal]` in the stylesheet. */
const EYE = raw(
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>' +
        '<line class="eye-slash" x1="3" y1="3" x2="21" y2="21"/></svg>'
);

const REGENERATE = raw(
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>'
);

/**
 * The opt-in for the event log, and what to paste into each service once it is on.
 *
 * Paths rather than full addresses: what an *arr has to use is however it reaches
 * this server, which in Docker is usually not the host name in this browser.
 */
/**
 * How to point Jellyfin's Webhook plugin at the play store, shown once there is
 * a Jellyfin to point. The header value is given whole, already encoded, since
 * the plugin takes a raw header and nobody should have to base64 a password.
 */
function jellyfinPlays(config: Config, secret: string): SafeHtml {
    const servers = listInstances(config).filter(i => i.type === 'jellyfin');
    if (servers.length === 0) return raw('');
    const header = `Basic ${Buffer.from(`${WEBHOOK_USERNAME}:${secret}`).toString('base64')}`;
    return html`<h3>Jellyfin plays</h3>
        <p class="note">
            Jellyfin's Webhook plugin can report each finished play the moment it ends, so a title watched and
            deleted before the next hourly sync is still kept. In the plugin, add a Generic Destination with the
            address arr-mcp has on Jellyfin's network followed by the path below.
        </p>
        <ul class="note">
            ${servers.map(i => html`<li>${i.id}: <span class="mono">/webhooks/${i.id}</span></li>`)}
        </ul>
        <p class="note">
            Notification Type: Playback Stop. Item Type: Movies and Episodes, and Music too if you want your
            listening kept. Tick Send All Properties and leave the template empty. Then add a request header named
            <span class="mono">Authorization</span> with this value:
        </p>
        <div class="field">
            <label for="webhooks.jellyfin-header">Authorization header</label>
            <div class="token">
                <input id="webhooks.jellyfin-header" class="secret" type="text" readonly value="${header}" ${IGNORE}>
                <button
                    class="ghost"
                    type="button"
                    data-icon
                    data-reveal="webhooks.jellyfin-header"
                    data-what="header"
                    aria-pressed="false"
                    aria-label="Show header"
                    title="Show header"
                >${EYE}</button>
                <button
                    class="ghost"
                    type="button"
                    data-icon
                    data-copy="webhooks.jellyfin-header"
                    aria-label="Copy header"
                    title="Copy header"
                >${COPY}</button>
            </div>
        </div>`;
}

function webhooksCard(config: Config, keys: SafeHtml, confirmingNewSecret: boolean): SafeHtml {
    const webhooks = config.webhooks;
    const targets = listInstances(config).filter(i => Object.hasOwn(WEBHOOK_SERVICES, i.type));

    return html`<form method="post" action="/ui/config/webhooks" class="panel" ${IGNORE_FORM}>
        ${keys}
        <h2 id="webhooks">Library event log</h2>
        ${checkbox('webhooks.enabled', 'webhooks.enabled', 'Keep a log of library events', webhooks?.enabled === true)}
        <p class="note">
            Keeps a log of what Radarr, Sonarr and Lidarr report: grabs, imports, renames and deletes. The services
            lose a title's history when it's deleted, so this is how arr-mcp can still tell you
            what happened to it. Off by default, and it needs a webhook connection in each service.
        </p>
        ${field({
            id: 'webhooks.retention_days',
            name: 'webhooks.retention_days',
            label: 'Keep events for (days)',
            type: 'number',
            value: webhooks?.retention_days ?? 30
        })}
        ${webhooks?.enabled === true && webhooks.secret !== undefined
            ? html`<p class="note">
                      In each service, go to Settings, Connect, and add a Webhook using the POST method, with
                      the address arr-mcp has on that service's network followed by the path below.
                  </p>
                  ${targets.length === 0
                      ? html`<p class="note">Add a Radarr, Sonarr or Lidarr instance first.</p>`
                      : html`<ul class="note">
                            ${targets.map(i => html`<li>${i.id}: <span class="mono">/webhooks/${i.id}</span></li>`)}
                        </ul>`}
                  <p class="note">
                      Tick these triggers: On Grab, On File Import, On File Upgrade, On Movie Added or On Series Add,
                      On Movie Delete or On Series Delete, and On Movie File Delete or On Episode File Delete.
                      The file delete for an upgrade, On Rename and On Manual Interaction Required are optional.
                      Leave the health triggers and On Application Update off, because they aren't about a title.
                      In Sonarr, also leave On Import Complete off: On File Import already reports each import,
                      and with both on you may get a second row.
                  </p>
                  <p class="note">Username: <span class="mono">${WEBHOOK_USERNAME}</span></p>
                  <div class="field">
                      <label for="webhooks.secret">Password</label>
                      <div class="token">
                          <input id="webhooks.secret" class="secret" type="text" readonly value="${webhooks.secret}" ${IGNORE}>
                          <button
                              class="ghost"
                              type="button"
                              data-icon
                              data-reveal="webhooks.secret"
                              data-what="password"
                              aria-pressed="false"
                              aria-label="Show password"
                              title="Show password"
                          >${EYE}</button>
                          <button
                              class="ghost"
                              type="button"
                              data-icon
                              data-copy="webhooks.secret"
                              aria-label="Copy password"
                              title="Copy password"
                          >${COPY}</button>
                          <button
                              class="ghost"
                              type="submit"
                              form="webhooks-new-secret"
                              data-icon
                              aria-label="Generate a new password"
                              title="Generate a new password"
                          >${REGENERATE}</button>
                      </div>
                      ${confirmingNewSecret
                          ? html`<button type="submit" form="webhooks-new-secret" name="confirm" value="yes" class="danger">
                                    Yes, replace the password
                                </button>
                                <p class="note" style="margin-top:.5rem">
                                    The old one stops working at once, so every service will need the new one.
                                    Save or reload to cancel.
                                </p>`
                          : raw('')}
                  </div>
                  ${jellyfinPlays(config, webhooks.secret)}`
            : raw('')}
        <div class="row" style="margin-top:1rem">
            <button type="submit">Save event log settings</button>
        </div>
    </form>
    ${webhooks?.enabled === true && webhooks.secret !== undefined
        ? // A form of its own, reached through the button's `form` attribute. Inside the
          // card's form it would be that form's first submit button, which is the one
          // Enter presses, so Enter in the days field would replace the password.
          html`<form id="webhooks-new-secret" method="post" action="/ui/config/webhooks#webhooks" hidden ${IGNORE_FORM}>
              ${keys}
              <input type="hidden" name="webhooks.enabled" value="on">
              <input type="hidden" name="webhooks.retention_days" value="${webhooks.retention_days}">
              <input type="hidden" name="webhooks.new_secret" value="1">
          </form>`
        : raw('')}`;
}

/** Seconds between reloads while a run is going. */
const DISCOVERY_REFRESH_SECONDS = 2;

const addLink = (r: ResultRow): SafeHtml =>
    html`<a href="/ui/config?tab=services&amp;add_type=${r.type}&amp;add_url=${encodeURIComponent(r.url)}">Add</a>`;

function discoveryStatus(r: ResultRow): SafeHtml {
    switch (r.status) {
        case 'added':
            return html`already added`;
        case 'configured':
            return html`already configured at <span class="mono">${r.existingUrl ?? ''}</span>`;
        case 'maybe-second':
            return html`${r.type} is already configured at <span class="mono">${r.existingUrl ?? ''}</span>.
                If this is a different one, add it as a second instance. ${addLink(r)}`;
        default:
            return addLink(r);
    }
}

/**
 * What the last Find services run saw, above the service cards. A run that
 * is still going shows the rows so far and the page reloads itself; the
 * layout adds the meta refresh.
 *
 * Nothing here saves anything. Add opens the add dialog with the type and the
 * address filled in, and the credential stays empty.
 */
function discoveryPanel(run: RunState, keys: SafeHtml, refreshing: boolean): SafeHtml {
    // A quick search tries one host and a handful of names, so a counter says
    // nothing; it names its sources, and the Skipped list explains the rest.
    const what =
        run.phase === 'sweep'
            ? html`the range ${run.range ?? ''}: ${run.tried} of ${run.total} addresses tried`
            : html`${run.hostTried === undefined
                  ? raw('')
                  : html`this host (${run.hostAddress === undefined || run.hostAddress === run.hostTried
                        ? run.hostTried
                        : `${run.hostTried}, ${run.hostAddress}`}) and `}container names: ${run.containersResolved ?? 0} resolved`;
    const reload = html`<a href="/ui/config?tab=services">Reload</a>`;
    return html`<div class="panel" id="discovery"${refreshing ? raw(` data-reload="${DISCOVERY_REFRESH_SECONDS}"`) : raw('')}>
        <div class="row" style="justify-content:space-between;margin:0 0 .75rem">
            <h2 style="margin:0">Found services</h2>
            ${run.running
                ? raw('')
                : html`<form method="post" action="/ui/config/discover/clear" ${IGNORE_FORM}>
                      ${keys}
                      <button type="submit" class="ghost">Close</button>
                  </form>`}
        </div>
        ${run.running
            ? html`<p class="note">
                  Looking at ${what}.
                  ${refreshing
                      ? html`This page reloads until it is done.
                            <span data-paused hidden>It has stopped reloading while you have something open or typed in. ${reload}</span>`
                      : html`This view does not reload by itself. ${reload}`}
              </p>`
            : html`<p class="note">Looked at ${what}.</p>`}
        ${run.failed === true
            ? html`<p class="note">The search failed; the logs page has the error.</p>`
            : run.rows.length === 0
              ? run.running
                  ? raw('')
                  : html`<p class="note">
                        Nothing found. Add a service by hand with the button above, or scan a range below.
                    </p>`
            : html`<table class="stacked">
                  <thead><tr><th>Service</th><th>Address</th><th>Version</th><th></th></tr></thead>
                  <tbody>
                      ${run.rows.map(
                          r => html`<tr>
                              <td class="mono">${r.type}</td>
                              <td class="mono">${r.url}${r.alsoAt === undefined
                                  ? raw('')
                                  : html` <span class="dim">also reachable at ${r.alsoAt}</span>`}</td>
                              <td>${r.version ?? ''}</td>
                              <td>${discoveryStatus(r)}</td>
                          </tr>`
                      )}
                  </tbody>
              </table>`}
        ${run.skipped.length === 0
            ? raw('')
            : html`<p class="note">Skipped:</p>
                  <ul class="note">
                      ${run.skipped.map(s => html`<li><span class="mono">${s.what}</span>: ${s.reason}</li>`)}
                  </ul>`}
        ${UNDISCOVERABLE.length === 0
            ? raw('')
            : html`<p class="note">These cannot be found this way:</p>
                  <ul class="note">
                      ${UNDISCOVERABLE.map(u => html`<li><span class="mono">${u.type}</span>: ${u.reason}</li>`)}
                  </ul>`}
        <form method="post" action="/ui/config/discover/sweep" ${IGNORE_FORM}>
            ${keys}
            ${field({
                id: 'discover.range',
                name: 'range',
                label: 'Scan a range',
                value: run.range ?? run.suggestedRange ?? '',
                placeholder: '192.168.1.0/24',
                note: 'A port scan: it tries each service port on every address in the range. Routers and intrusion detection may flag it. It only reads, and no key is sent.'
            })}
            <div class="row" style="margin-top:1rem">
                <button type="submit" class="ghost"${run.running ? raw(' disabled') : raw('')}>Scan this range</button>
            </div>
        </form>
    </div>`;
}

/** What each tab answers: what is connected, who can get in, how it behaves. */
export const CONFIG_TABS = [
    { key: 'services', label: 'Services' },
    { key: 'access', label: 'Access' },
    { key: 'settings', label: 'Settings' }
] as const;

type ConfigTab = (typeof CONFIG_TABS)[number]['key'];

/** Anything unknown lands on the first tab, as an unknown log stream does. */
export const configTabNamed = (name: string | undefined): ConfigTab =>
    CONFIG_TABS.find(t => t.key === name)?.key ?? 'services';

const ACCESS_POSTS = ['account', 'mcp', 'tokens', 'api-keys', 'oauth'];
const SETTINGS_POSTS = ['appearance', 'media-servers', 'imdb', 'webhooks'];

/**
 * The tab a config post came from, read off its path.
 *
 * The answer to a post is the only place a new token or management key is ever
 * shown. Rendered on any other tab, that secret is gone and has to be created
 * again, so the server decides this rather than trusting anything in the browser
 * to bring you back.
 */
export function configTabForPost(path: string): ConfigTab {
    const section = path.replace(/^\/ui\/config\//, '').split(/[/?#]/)[0] ?? '';
    if (ACCESS_POSTS.includes(section)) return 'access';
    if (SETTINGS_POSTS.includes(section)) return 'settings';
    return 'services';
}

export function configPage(opts: {
    /** Which tab to render. Only that one is in the response. */
    tab: ConfigTab;
    version: string;
    config: Config;
    csrf: string;
    /** The instance whose Remove button was pressed but not yet confirmed. */
    confirmingRemoval?: string | undefined;
    /** Set when an add was refused: the message and the form it is about have to
     *  arrive together, or the dialog has swallowed the reason. */
    openAdd?: boolean;
    /** The one instance whose Test button was pressed, and what came back. */
    tested?: { instance: string; diagnosis: ConnectionDiagnosis } | undefined;
    /** The instance a submit just touched, so its card is not collapsed over
     *  the result of what you did. */
    openInstance?: string | undefined;
    /** The add dialog's own Test, which has no instance id to key on because
     *  the instance does not exist yet. Only the unscripted path reaches this:
     *  with scripting the result is fetched and filled in client-side. */
    testedAdd?: ConnectionDiagnosis | undefined;
    message?: { kind: 'ok' | 'err'; text: string } | undefined;
    /** A token just created: its plaintext, shown in this one response only. */
    revealed?: Revealed | undefined;
    /** The token whose Revoke button was pressed but not yet confirmed. */
    confirmingRevoke?: string | undefined;
    /** A key just generated: shown in this one response only. */
    revealedKey?: string | undefined;
    confirmingKeyRevoke?: string | undefined;
    /** The management key card's own outcome, rendered on the card. Its posts
     *  carry `#management-api`, so a banner at the top of the page arrives
     *  already scrolled off screen. */
    keyMessage?: { kind: 'ok' | 'err'; text: string } | undefined;
    /** The absolute MCP endpoint and management API base, derived from the
     *  request that asked for this page. Absent when it carried no usable Host. */
    mcpUrl?: string | undefined;
    apiUrl?: string | undefined;
    /** The event log's new-password button was pressed but not yet confirmed. */
    confirmingNewSecret?: boolean;
    plaintextOnDisk?: readonly string[];
    now?: Date;
    /** What the last OAuth post left for its card: a result, a pending
     *  removal, or the fields as typed after a refusal or a Test. */
    oauth?: OAuthCardState | undefined;
    /** The last Find services run, shown above the cards on the services tab. */
    discovery?: RunState | undefined;
    /** The Add link's choice, to select in the add dialog. */
    addPrefill?: { type: ServiceId; url: string } | undefined;
}): string {
    const instances = listInstances(opts.config);
    // Two of the three at most (ConfigSchema), so two is both.
    const configuredMediaServers = mediaServersIn(opts.config.services);
    const bothMediaServers = configuredMediaServers.length === 2;
    // The etag is what lets a save tell that the config moved since this page was built.
    const keys = html`<input type="hidden" name="csrf" value="${opts.csrf}">
        <input type="hidden" name="etag" value="${configEtag(opts.config)}">`;

    // A reload re-renders every form empty, so it would eat a key being typed.
    // It is also a GET of whatever URL this page answered, which for a post
    // render is a 404. So only a plain view of the tab reloads itself.
    const refreshes =
        opts.tab === 'services' &&
        opts.discovery?.running === true &&
        opts.message === undefined &&
        opts.openAdd !== true &&
        opts.addPrefill === undefined &&
        opts.testedAdd === undefined &&
        opts.openInstance === undefined &&
        opts.tested === undefined &&
        opts.confirmingRemoval === undefined;

    const services = html`<div class="row" style="margin-bottom:1rem">
            <button type="button" data-open="add-service">Add a service</button>
            <button type="submit" form="discover-form" class="ghost">Find services</button>
            <span class="note" style="margin:0">
                ${instances.length === 0
                    ? raw('Nothing is configured yet. Anything you leave out is simply absent, not broken.')
                    : raw('Saving applies immediately, with no restart. Each instance is saved on its own.')}
            </span>
        </div>

        <form id="discover-form" method="post" action="/ui/config/discover" hidden ${IGNORE_FORM}>${keys}</form>
        ${opts.discovery === undefined ? raw('') : discoveryPanel(opts.discovery, keys, refreshes)}

        ${instances.map(i =>
            instanceCard(
                i,
                keys,
                opts.confirmingRemoval,
                opts.tested?.instance === i.id ? opts.tested.diagnosis : undefined,
                // Collapsed by default: the page is a stack inventory first.
                // Three things reopen a card: a Test whose result is inside it,
                // a removal waiting on a second click, and whatever you last
                // submitted.
                opts.tested?.instance === i.id || opts.confirmingRemoval === i.id || opts.openInstance === i.id
            )
        )}
        ${addDialog(opts.config, keys, opts.openAdd === true, opts.testedAdd, opts.addPrefill)}`;

    const savedAlone = html`<p class="note">Each card is saved on its own. A Save writes only its own card.</p>`;

    /**
     * What the five cards below are for, before the first of them.
     *
     * The slot used to hold `savedAlone` alone, which answers a question about
     * the Save buttons to someone who has not yet worked out which card they
     * need. There are four separate ways in on this page and nothing said so.
     */
    const accessIntro = html`<p class="note">
            Four ways in, and they do not overlap: a <strong>token</strong> for MCP clients, a
            <strong>management key</strong> for companion apps, <strong>OAuth</strong> for tokens an
            identity provider issues, and the <strong>sign-in</strong> for this page. Each card is
            saved on its own.
        </p>`;

    const signIn = html`<form method="post" action="/ui/config/account" class="panel" ${IGNORE_FORM}>
            ${keys}
            <h2>Config UI sign-in</h2>
            <p class="note">The password for this page, and nothing else. MCP clients and companion apps never use it.</p>
            ${field({ id: 'auth.username', name: 'auth.username', label: 'Username', value: opts.config.auth.username })}
            ${field({
                id: 'auth.current_password',
                name: 'auth.current_password',
                label: 'Current password',
                secret: true,
                note: 'Needed only to change the password below. A live session is not enough on its own.'
            })}
            ${field({
                id: 'auth.password',
                name: 'auth.password',
                label: 'New password',
                secret: true,
                placeholder: 'unchanged',
                note: 'Leave blank to keep the current password. Only a hash is stored, so it cannot be read back. Saving a new one signs out every other session; this one stays.'
            })}
            <div class="row" style="margin-top:1rem">
                <button type="submit">Save sign-in</button>
            </div>
        </form>`;

    const appearance = html`<form method="post" action="/ui/config/appearance" class="panel" ${IGNORE_FORM}>
            ${keys}
            <h2>Appearance</h2>
            <div class="field">
                <label for="ui.theme">Theme</label>
                <select id="ui.theme" name="ui.theme">
                    ${THEMES.map(
                        t =>
                            html`<option value="${t.key}" ${
                                (opts.config.ui?.theme ?? 'system') === t.key ? raw('selected') : raw('')
                            }>${t.label}</option>`
                    )}
                </select>
            </div>
            <p class="note">
                Saved here rather than in the browser, so it holds wherever you sign in from. Follow
                the system is the default and tracks your OS setting as it changes.
            </p>
            <button type="submit">Save</button>
        </form>`;

    const mediaServers = bothMediaServers
            ? html`<form method="post" action="/ui/config/media-servers" class="panel" ${IGNORE_FORM}>
                  ${keys}
                  <h2>Media servers</h2>
                  <div class="field">
                      <label for="primary_media_server">Primary</label>
                      <select id="primary_media_server" name="primary_media_server">
                          ${configuredMediaServers.map(id => html`<option value="${id}" ${opts.config.primary_media_server === id ? raw('selected') : raw('')}>${id}</option>`)}
                      </select>
                  </div>
                  <p class="note">The one every tool reads by default. The other still answers when a tool is given its name.</p>
                  <button type="submit">Save</button>
              </form>`
            : raw('');

    const imdb = html`<form method="post" action="/ui/config/imdb" class="panel" ${IGNORE_FORM}>
            ${keys}
            <h2>IMDb dataset</h2>
            ${checkbox(
                'metadata.imdb',
                'metadata.imdb',
                'Download IMDb’s dataset for ratings',
                opts.config.metadata?.imdb?.enabled ?? false
            )}
            <!-- The required-for-series line comes first and is unhedged. It
                 used to be the second half of the second paragraph, under a
                 heading that said "most stacks do not need this", so someone
                 looking for a series' IMDb score read the discouragement and
                 stopped. That is not a hypothetical: it is how this page was
                 found to be wrong. -->
            <p class="note">
                <strong>Required for IMDb ratings on TV series.</strong> Leave this off and
                <span class="mono">rating_source: imdb</span> on a series matches nothing at all, not
                because your shows are unrated, but because nothing else in the stack has that number.
                Sonarr reports one flat TVDB rating, and Seerr’s <span class="mono">/tv</span> ratings are
                Rotten Tomatoes only; there is no combined endpoint for TV upstream. Films are unaffected:
                Radarr and Seerr both supply IMDb for those.
            </p>
            <p class="note">
                <strong>For everything else it is only a fallback.</strong> If you run Seerr you already have
                TMDB and Rotten Tomatoes for films and series, plus IMDb for films, at no disk cost. So the
                other reasons to switch this on are that you <strong>do not run Seerr</strong>, or you want
                ratings to keep working while Seerr is down.
            </p>
            <p class="note">
                <strong>About 81 MB on disk, and a 223 MB download each week.</strong> Refreshed weekly
                rather than daily: an average over millions of votes barely moves, so a nightly re-download
                spent 6.5 GB a month to change third decimal places. The cost is that a title published in
                the last week may not be there yet. The first ingest takes a few minutes; everything keeps
                working meanwhile, and the dashboard says when it has finished. Nothing is sent anywhere,
                and there is no account or key.
            </p>
            <div class="row" style="margin-top:1rem">
                <button type="submit">Save IMDb settings</button>
            </div>
        </form>`;

    const now = opts.now ?? new Date();
    const plaintextOnDisk = opts.plaintextOnDisk ?? [];
    const lastToken = opts.config.auth.tokens.length === 1;

    const tokenRows = opts.config.auth.tokens.map(
        (t): CredentialRow => ({
            name: t.name,
            tier: t.tier,
            created: t.created,
            expires: expiryCell(t.expires, now),
            // The write trail records `bearer:<name>#<fingerprint>`, so this
            // column is the one thing on the page that can answer "what has
            // this token been doing". Unlinked, it was eight characters with
            // nothing to do.
            fingerprint: html`<a href="/ui/audit?caller=${encodeURIComponent(bearerCaller(t))}">${fingerprint(t.hash)}</a>`,
            ...(plaintextOnDisk.includes(t.name) ? { flag: 'still plaintext in config.yaml' } : {}),
            revoke: revokeForm({
                action: '/ui/config/tokens/revoke#tokens',
                field: 'token',
                name: t.name,
                keys,
                confirming: opts.confirmingRevoke === t.name,
                consequence: lastToken
                    ? 'This is the last token: every MCP client will be refused until you create a new one.'
                    : 'Clients using it are refused from the next request.'
            })
        })
    );

    const tokens = credentialCard({
        id: 'tokens',
        title: 'MCP tokens',
        message: undefined,
        reveal: opts.revealed === undefined ? raw('') : revealPanel(opts.revealed),
        note: html`<p class="note">What an MCP client signs in with, as a <span class="mono">Bearer</span> header.</p>`,
        endpoint: endpointRow({
            id: 'mcp-url',
            label: 'Endpoint',
            url: opts.mcpUrl,
            absent: html`<p class="note">Use <span class="mono">/mcp</span> on the address you reached this page on.</p>`,
            // The handlers fill in a token while the reveal panel is on screen
            // and a placeholder when it is not, so both buttons are worth
            // having on every render rather than on one response in a hundred.
            extras: html`<div class="row" style="margin-bottom:1rem">
                <button class="ghost" type="button" data-copy-config="mcp-config">Copy client config</button>
                ${opts.config.auth.allow_token_in_url
                    ? html`<button class="ghost" type="button" data-copy-url-token="mcp-url">Copy URL with token</button>`
                    : raw('')}
            </div>
            <textarea id="mcp-config" class="mono" rows="9" readonly hidden></textarea>
            <input id="mcp-url-token" type="text" readonly hidden>`
        }),
        rows:
            tokenRows.length === 0
                ? html`<p class="note">No MCP tokens yet. Every MCP client is refused until you create one.</p>`
                : credentialTable(tokenRows),
        formTitle: 'New token',
        form: tokenCreateForm(keys)
    });

    const managementKeys = opts.config.auth.management_keys ?? [];
    const lastKey = managementKeys.length === 1;

    const keyRows = managementKeys.map(
        (k): CredentialRow => ({
            name: k.name,
            tier: k.tier,
            created: k.created,
            // Not a column the data can fill: management keys have no expiry.
            // Saying so in the table beats leaving the reader to infer it from
            // a missing column, which is how it read before.
            expires: html`<span class="dim">never</span>`,
            // No link: a key's writes go to config.yaml, not through the write
            // trail, so what it did is in the Logs. The card says so.
            fingerprint: html`${fingerprint(k.hash)}`,
            revoke: revokeForm({
                action: '/ui/config/api-keys/revoke#management-api',
                field: 'key',
                name: k.name,
                keys,
                confirming: opts.confirmingKeyRevoke === k.name,
                consequence: lastKey
                    ? 'This is the last key: the management API turns off until you create a new one.'
                    : 'Apps using it are refused from the next request.'
            })
        })
    );

    const managementApi = credentialCard({
        id: 'management-api',
        title: 'Management API',
        message: opts.keyMessage,
        reveal: opts.revealedKey === undefined ? raw('') : revealKeyPanel(opts.revealedKey),
        note: html`<p class="note">
                For companion apps that read arr-mcp the way they read Sonarr. Give each app its own, sent as
                <span class="mono">X-Api-Key</span>. No key can touch this sign-in, OAuth or the keys
                themselves, and what one did is in the <a href="/ui/logs">Logs</a> rather than in Writes.
            </p>`,
        endpoint: endpointRow({
            id: 'api-url',
            label: 'Base URL',
            url: opts.apiUrl,
            absent: html`<p class="note">Use <span class="mono">/api/v1</span> on the address you reached this page on.</p>`
        }),
        rows:
            keyRows.length === 0
                ? html`<p class="note">Off. Nothing answers under <span class="mono">/api/v1</span> until you create a key.</p>`
                : credentialTable(keyRows),
        formTitle: 'New key',
        form: keyCreateForm(keys)
    });

    const hostAndProxy = html`<form method="post" action="/ui/config/mcp" class="panel" ${IGNORE_FORM}>
            ${keys}
            <h2>Host and proxy</h2>
            <p class="note">Which requests this server answers at all, before any token is looked at.</p>
            ${field({
                id: 'auth.allowed_hosts',
                name: 'auth.allowed_hosts',
                label: 'Allowed hosts (comma separated)',
                value: opts.config.auth.allowed_hosts.join(', '),
                note: 'Empty accepts any Host, which is right for a LAN container reached by IP. Pin the wrong name and you lock yourself out until you edit config.yaml by hand.'
            })}
            ${field({
                id: 'auth.trusted_proxies',
                name: 'auth.trusted_proxies',
                label: 'Trusted proxies (comma separated)',
                value: (opts.config.auth.trusted_proxies ?? []).join(', '),
                note: "Addresses or ranges (172.18.0.0/16) of your reverse proxy, so each client gets its own sign-in throttle rather than sharing the proxy's."
            })}
            ${checkbox(
                'auth.allow_token_in_url',
                'auth.allow_token_in_url',
                'Accept the token in the URL (?token=\u2026)',
                opts.config.auth.allow_token_in_url,
                opts.config.auth.oauth !== undefined
            )}
            ${opts.config.auth.oauth === undefined
                ? html`<p class="note">
                      For clients that can only be given a URL and no headers. The token then travels in the
                      address, where a proxy's access log will keep it.
                      <a href="https://github.com/bardesss/arr-mcp/blob/main/docs/configuration.md#allow_token_in_url" target="_blank" rel="noreferrer">What this costs</a>.
                  </p>`
                : html`<p class="note">
                      Unavailable while OAuth is configured: an access token in the address would reach every
                      proxy log. Remove OAuth on the <a href="#oauth">OAuth card</a> below to use it.
                  </p>`}
            <div class="row" style="margin-top:1rem">
                <button type="submit">Save host and proxy</button>
            </div>
        </form>`;

    /**
     * Tokens first: the response that reveals one opens with it on screen. Then
     * the other two credentials, then what the server will answer at all, then
     * the password for this page. Credentials before plumbing, in the order
     * someone setting this up needs them.
     */
    const sections: Record<ConfigTab, () => SafeHtml> = {
        services: () => services,
        access: () =>
            html`${accessIntro}${tokens}${managementApi}${oauthCard(opts.config, keys, opts.oauth ?? {})}${hostAndProxy}${signIn}`,
        settings: () =>
            html`${savedAlone}${appearance}${mediaServers}${imdb}${webhooksCard(opts.config, keys, opts.confirmingNewSecret === true)}`
    };

    // No tab row: each tab is its own entry in the sidebar.
    const body = sections[opts.tab]();

    return layout({
        csrf: opts.csrf,
        title: CONFIG_TABS.find(t => t.key === opts.tab)?.label ?? 'Services',
        nav: opts.tab,
        version: opts.version,
        body,
        // Derived, not passed in: this page already has the config, and a
        // second source for one value is a way for them to disagree.
        theme: opts.config.ui?.theme,
        ...(refreshes
            ? { refreshSeconds: DISCOVERY_REFRESH_SECONDS }
            : {}),
        ...(opts.message === undefined ? {} : { message: opts.message })
    });
}
