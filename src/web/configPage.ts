import { listInstances, type ServiceInstance } from '../config/instances.ts';
import { MULTI_INSTANCE, ServiceIdSchema, type Config, type ServiceId, type Theme } from '../config/schema.ts';
import type { ConnectionDiagnosis } from '../services/types.ts';
import { html, raw, type SafeHtml } from './html.ts';
import { serviceIcon } from './icons.ts';
import { layout } from './pages.ts';

/**
 * One card per configured instance, and nothing else. Three rules shape it.
 *
 * **A secret is never rendered back.** Credentials render as empty fields
 * meaning "unchanged", so a saved page or a screenshot cannot carry them. Blank
 * therefore never means "clear this" — removing the instance does.
 *
 * **Each card is its own form**, so a save touches exactly the instance it came
 * from rather than rewriting every other service on screen. That holds for the
 * three access cards at the bottom too, and did not always: they shared one
 * button, which by sitting last on the page read as a global save while every
 * card above saved itself. One rule now — the card you edited is the card you
 * save — and one route per card in `routes.ts` to enforce it, each carrying
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

/** Alphabetical, unlike `ServiceIdSchema.options` — which is declaration order
 *  and reads as arbitrary to anyone looking for their service in the list. */
export const SERVICE_IDS_ALPHABETICAL: readonly ServiceId[] = [...SERVICE_IDS].sort();

/** Which extra fields each service actually has, so a card matches the schema
 *  rather than showing eight identical boxes. */
const MULTI_USER: ReadonlySet<string> = new Set(['jellyfin', 'plex', 'seerr']);
/** arr-mcp joins against exactly one media server — see the schema refinement
 *  in `schema.ts` that this UI rule mirrors. */
const MEDIA_SERVERS: readonly ServiceId[] = ['jellyfin', 'plex'];
const NO_API_KEY_IDS: readonly ServiceId[] = ['transmission', 'qbittorrent'];
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
 * `autocomplete="off"` is the standard one and does nothing on its own — Chrome
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
            ? 'Optional. Without it, get_library returns the Radarr and Sonarr halves with Jellyfin marked degraded.'
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

/** What the collapsed row says about a card's writes, in one word. */
function writeLabel(permissions: { safe_write: boolean; destructive: boolean }): string {
    if (permissions.destructive) return 'destructive';
    if (permissions.safe_write) return 'safe_write';
    return 'read-only';
}

function instanceCard(
    instance: ServiceInstance,
    csrf: string,
    confirming: string | undefined,
    users: readonly string[] | undefined,
    tested: ConnectionDiagnosis | undefined,
    open: boolean
): SafeHtml {
    const service = instance.config as AnyService;
    const p = `svc.${instance.id}`;
    const pendingRemoval = confirming === instance.id;

    return html`<form method="post" action="/ui/config/save" class="panel" ${IGNORE_FORM}>
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="instance" value="${instance.id}">

        <details class="svc"${open ? raw(' open') : raw('')}>
        <summary class="svc-title">
            ${serviceIcon(instance.id)}
            <span class="mono">${instance.id}</span>
            <span class="svc-host mono">${service.url}</span>
            <span class="svc-writes">${writeLabel(service.permissions)}</span>
        </summary>

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
        </details>
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
function addDialog(
    config: Config,
    csrf: string,
    open: boolean,
    tested: ConnectionDiagnosis | undefined
): SafeHtml {
    const instances = listInstances(config);
    const configured = new Set(instances.map(i => i.type));

    // The schema already refuses jellyfin and plex together — arr-mcp joins
    // against exactly one media server — so offering the rival here would
    // only lead to a save that fails.
    const mediaServer = MEDIA_SERVERS.find(id => configured.has(id));
    const rivalMediaServer = mediaServer === undefined ? undefined : MEDIA_SERVERS.find(id => id !== mediaServer);

    /** A service that cannot have a second instance and already has one is not
     *  a choice — offering it only to answer "already configured" wastes the
     *  click. The three multi-instance types are always here, so this list is
     *  never empty. */
    const offerable = SERVICE_IDS_ALPHABETICAL.filter(
        id => id !== rivalMediaServer && (MULTI_INSTANCE.includes(id) || !configured.has(id))
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
                          ${(() => {
                              const alreadyConfigured = SERVICE_IDS_ALPHABETICAL.filter(
                                  id => !offerable.includes(id) && id !== rivalMediaServer
                              );
                              return alreadyConfigured.length === 0
                                  ? raw('')
                                  : html`Already configured, and limited to one instance:
                                        <span class="mono">${alreadyConfigured.join(', ')}</span>. Edit those on the
                                        card above. `;
                          })()}
                          ${rivalMediaServer === undefined
                              ? raw('')
                              : html`<span class="mono">${rivalMediaServer}</span> is hidden because
                                    <span class="mono">${mediaServer}</span> is already your media server —
                                    arr-mcp joins against exactly one.`}
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
                <!-- The question this dialog exists to get wrong is "is this URL
                     and this key right", and the cheapest place to answer it is
                     before anything is written to config.yaml.

                     Scripted, this posts through fetch and fills #add-test-result
                     below without leaving the page — because a re-render would
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
    /** The instance a submit just touched, so its card is not collapsed over
     *  the result of what you did. */
    openInstance?: string | undefined;
    /** The add dialog's own Test, which has no instance id to key on because
     *  the instance does not exist yet. Only the unscripted path reaches this —
     *  with scripting the result is fetched and filled in client-side. */
    testedAdd?: ConnectionDiagnosis | undefined;
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
                opts.tested?.instance === i.id ? opts.tested.diagnosis : undefined,
                // Collapsed by default — the page is a stack inventory first.
                // Three things reopen a card: a Test whose result is inside it,
                // a removal waiting on a second click, and whatever you last
                // submitted.
                opts.tested?.instance === i.id || opts.confirmingRemoval === i.id || opts.openInstance === i.id
            )
        )}
        ${addDialog(opts.config, opts.csrf, opts.openAdd === true, opts.testedAdd)}

        <h2>Access</h2>
        <p class="note" style="margin:-.5rem 0 1rem">
            Three separate settings, saved separately — like the service cards above. Each Save writes only
            its own card.
        </p>

        <form method="post" action="/ui/config/account" class="panel" ${IGNORE_FORM}>
            <input type="hidden" name="csrf" value="${opts.csrf}">
            <h3 style="margin:0 0 .75rem">Config UI sign-in</h3>
            ${field({ id: 'auth.username', name: 'auth.username', label: 'Username', value: opts.config.auth.username })}
            ${field({
                id: 'auth.password',
                name: 'auth.password',
                label: 'New password',
                secret: true,
                placeholder: 'unchanged',
                note: 'Leave blank to keep the current password. Only a hash is stored — it cannot be read back.'
            })}
            <div class="row" style="margin-top:1rem">
                <button type="submit">Save sign-in</button>
            </div>
        </form>

        <form method="post" action="/ui/config/appearance" class="panel" ${IGNORE_FORM}>
            <input type="hidden" name="csrf" value="${opts.csrf}">
            <h3 style="margin:0 0 .75rem">Appearance</h3>
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
        </form>

        <form method="post" action="/ui/config/imdb" class="panel" ${IGNORE_FORM}>
            <input type="hidden" name="csrf" value="${opts.csrf}">
            <h3 style="margin:0 0 .75rem">IMDb dataset</h3>
            ${checkbox(
                'metadata.imdb',
                'metadata.imdb',
                'Download IMDb’s dataset for ratings',
                opts.config.metadata?.imdb?.enabled ?? false
            )}
            <!-- The required-for-series line comes first and is unhedged. It
                 used to be the second half of the second paragraph, under a
                 heading that said "most stacks do not need this" — so someone
                 looking for a series' IMDb score read the discouragement and
                 stopped. That is not a hypothetical: it is how this page was
                 found to be wrong. -->
            <p class="note">
                <strong>Required for IMDb ratings on TV series.</strong> Leave this off and
                <span class="mono">rating_source: imdb</span> on a series matches nothing at all — not
                because your shows are unrated, but because nothing else in the stack has that number.
                Sonarr reports one flat TVDB rating, and Seerr’s <span class="mono">/tv</span> ratings are
                Rotten Tomatoes only; there is no combined endpoint for TV upstream. Films are unaffected —
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
        </form>

        <form method="post" action="/ui/config/mcp" class="panel" ${IGNORE_FORM}>
            <input type="hidden" name="csrf" value="${opts.csrf}">
            <h3 style="margin:0 0 .75rem">MCP endpoint</h3>
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
            ${checkbox(
                'auth.allow_token_in_url',
                'auth.allow_token_in_url',
                'Accept the token in the URL (?token=…)',
                opts.config.auth.allow_token_in_url
            )}
            <p class="note">
                For clients that can only be given a URL and no headers. The token then travels in the
                address, so a reverse proxy's access log or the client's own logs will hold a working
                credential — rotate it above if that happens. This does not make Home Assistant work on
                its own: its MCP client also needs the older SSE transport, which this server does not
                serve.
            </p>
            <div class="row" style="margin-top:1rem">
                <button type="submit">Save MCP settings</button>
            </div>
        </form>

        <p class="note"><a href="/ui">Back to the dashboard</a></p>`;

    return layout({
        csrf: opts.csrf,
        title: 'Configuration',
        nav: 'config',
        version: opts.version,
        body,
        // Derived, not passed in: this page already has the config, and a
        // second source for one value is a way for them to disagree.
        theme: opts.config.ui?.theme,
        ...(opts.message === undefined ? {} : { message: opts.message })
    });
}
