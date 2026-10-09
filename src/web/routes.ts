import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, Hono } from 'hono';
import { sameUrl } from '../api/bodies.ts';
import { commitConfig } from '../config/commit.ts';
import { configEtag } from '../config/etag.ts';
import { listInstances } from '../config/instances.ts';
import { clearManagementKey, setImdb, setManagementKey, setMcpEndpoint } from '../config/edits.ts';
import { ConfigUnloadableError, saveConfig } from '../config/save.ts';
import { MediaServerIdSchema, OAuthSchema, ServiceIdSchema, ThemeSchema, type Config, type OAuthConfig, type Theme } from '../config/schema.ts';
import type { WriteAudit } from '../core/audit.ts';
import { logger } from '../core/logger.ts';
import { LoginThrottle } from '../core/loginThrottle.ts';
import { logFields, type LogStore } from '../core/logs.ts';
import type { Runtime } from '../core/runtime.ts';
import {
    clearedSessionCookie,
    hashPassword,
    readCookie,
    sessionCookie,
    SESSION_COOKIE,
    SESSION_TTL_MS,
    verifyPassword
} from '../core/session.ts';
import { buildAdapters } from '../services/registry.ts';
import { hasUserDirectory } from '../services/types.ts';
import { buildStackHealth } from '../tools/stackHealth.ts';
import { CSS, JS } from './assets.ts';
import { MARK_SVG } from './icons.ts';
import {
    addCandidate,
    addToken,
    ConfigEditError,
    CredentialWouldMoveError,
    removeInstance,
    revokeToken,
    updateInstance,
    type InstanceFields
} from '../config/mutate.ts';
import type { ExpiryChoice, TokenTier } from '../core/mcpTokens.ts';
import { configPage, type OAuthDraft } from './configPage.ts';
import { probeJwks } from './jwksProbe.ts';
import { apiEndpoint, mcpEndpoint, sameOrigin } from './origin.ts';
import {
    auditPage,
    dashboardPage,
    loginPage,
    logsPage,
    setupPage,
    LOG_STREAMS,
    type LogStreamKey
} from './pages.ts';

/** Length only, no character-class rules: the classes push people towards
 *  `Password1!` and buy nothing a longer passphrase does not. */
const MIN_PASSWORD = 12;

export type WebDeps = { runtime: Runtime; audit: WriteAudit; logs: LogStore; version: string };

/**
 * The config UI: a dashboard, connection tests that diagnose
 * rather than pass/fail, log streams, the write audit, and configuration
 * editing that applies without a restart.
 *
 * Server rendered, no build step. The only client JavaScript polls the log
 * stream and copies a freshly created token.
 */
export function registerWebRoutes(app: Hono, deps: WebDeps): void {
    const { runtime, audit, logs, version } = deps;

    // --- assets ---------------------------------------------------------
    //
    // Unauthenticated on purpose: they are constants compiled into the binary
    // and reveal nothing. Requiring a session for the stylesheet would make
    // the login page render unstyled, which looks broken.
    app.get('/ui/app.css', c => c.body(CSS, 200, { 'content-type': 'text/css; charset=utf-8', ...CACHE }));
    app.get('/ui/app.js', c => c.body(JS, 200, { 'content-type': 'text/javascript; charset=utf-8', ...CACHE }));
    app.get('/ui/icon.svg', c => c.body(MARK_SVG, 200, { 'content-type': 'image/svg+xml; charset=utf-8', ...CACHE }));

    // --- setup ----------------------------------------------------------
    //
    // An instance with no `password_hash` is *unclaimed*: nothing has been set
    // up yet, so there is no password any sign-in could satisfy. Every UI route
    // funnels here until someone claims it.

    const unclaimed = (): boolean => runtime.config.auth.password_hash === undefined;
    const entry = (): string => (unclaimed() ? '/ui/setup' : '/ui/login');

    // Read per render rather than captured: `runtime.config` is replaced on
    // reload, and saving the theme is itself a reload — so a captured value
    // would leave the page that just saved showing the previous theme.
    const theme = (): Theme => runtime.config.ui?.theme ?? 'system';

    app.get('/ui/setup', c => {
        if (!unclaimed()) return c.redirect('/ui/login', 302);
        return c.html(setupPage({ version, theme: theme() }));
    });

    /**
     * No CSRF token on this form: there is no session yet to bind one to. The
     * request's origin is the binding that does exist, so it is checked
     * instead. Every other form in this file carries a token, because every
     * other form acts on an instance someone already owns.
     */
    app.post('/ui/setup', async c => {
        if (!unclaimed()) return c.redirect('/ui/login', 302);
        if (!sameOrigin(c)) return c.text('cross-origin setup request refused', 403);

        const body = await c.req.parseBody();
        const username = str(body.username).trim();
        const password = str(body.password);

        const reject = (text: string) => c.html(setupPage({ version, error: text, theme: theme() }), 400);
        if (username === '') return reject('Choose a username.');
        if (password.length < MIN_PASSWORD) return reject(`Use a password of at least ${MIN_PASSWORD} characters.`);
        if (password !== str(body.confirm)) return reject('Those two passwords do not match.');

        // Re-checked, and with the compare-and-swap every other config mutation
        // uses: `parseBody` and `saveConfig` both yield, so the check at the top
        // of this handler is not still true by the time the write lands.
        if (!unclaimed()) return c.redirect('/ui/login', 302);
        // Captured before hashPassword yields, so a concurrent reload cannot
        // make `expected` newer than the config this write was built from.
        const expected = runtime.config;
        try {
            await saveConfig(
                runtime.configDir,
                {
                    ...expected,
                    auth: { ...expected.auth, username, password_hash: await hashPassword(password) }
                },
                { expected }
            );
        } catch {
            // Someone else claimed it while this request was in flight.
            return c.redirect('/ui/login', 302);
        }
        await runtime.reload();

        const token = runtime.sessions.issue();
        c.header('set-cookie', sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)));
        logger.info({ ...originOf(c), username }, 'config UI claimed');
        return c.redirect('/ui', 302);
    });

    // --- login ----------------------------------------------------------

    // Per app, not per module: tests build many apps and must not share a
    // counter, and a real deployment builds exactly one.
    const loginThrottle = new LoginThrottle();

    app.get('/ui/login', c => {
        if (unclaimed()) return c.redirect('/ui/setup', 302);
        if (sessionOf(c, runtime) !== undefined) return c.redirect('/ui', 302);
        return c.html(loginPage({ version, theme: theme() }));
    });

    app.post('/ui/login', async c => {
        if (unclaimed()) return c.redirect('/ui/setup', 302);

        const waitMs = loginThrottle.blockedFor();
        if (waitMs > 0) {
            const seconds = Math.ceil(waitMs / 1000);
            c.header('retry-after', String(seconds));
            return c.html(
                loginPage({
                    version,
                    error: `Too many failed attempts. Try again in ${seconds}s.`,
                    theme: theme()
                }),
                429
            );
        }

        // Reserved before the first await, not after verifying: a burst of
        // concurrent posts all read `blockedFor() === 0` before any of them
        // resolves `verifyPassword`, so without this every one of them would
        // reach the scrypt hash regardless of FREE_ATTEMPTS. A real login
        // clears the reservation below, via `recordSuccess`.
        const justBlocked = loginThrottle.recordFailure();
        if (justBlocked) {
            const seconds = Math.ceil(loginThrottle.blockedFor() / 1000);
            logger.warn({ ...originOf(c), seconds }, 'throttled config UI sign-in');
        }

        const form = await c.req.parseBody();
        const username = str(form.username);
        const password = str(form.password);
        const auth = runtime.config.auth;

        // One message for both wrong username and wrong password, and the hash
        // check runs either way — a form that answers faster for an unknown
        // user tells an attacker which names exist. A missing hash must never
        // read as a valid login.
        const nameOk = username === auth.username;
        const passOk = auth.password_hash !== undefined && (await verifyPassword(password, auth.password_hash));

        if (!nameOk || !passOk) {
            // No username: this field routinely catches a password typed into
            // the wrong box, and the record is rendered at /ui/logs.
            logger.warn({ ...originOf(c) }, 'rejected config UI sign-in');
            return c.html(loginPage({ version, error: 'Wrong username or password.', theme: theme() }), 401);
        }

        loginThrottle.recordSuccess();
        const token = runtime.sessions.issue();
        c.header('set-cookie', sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)));
        logger.info({ ...originOf(c), username }, 'config UI sign-in');
        return c.redirect('/ui', 302);
    });

    app.post('/ui/logout', async c => {
        const session = sessionOf(c, runtime);
        const form = await c.req.parseBody();
        if (session === undefined || !runtime.sessions.csrfValid(session, str(form.csrf))) {
            return c.redirect(entry(), 302);
        }
        // Clearing the cookie only ends the session for the browser holding it.
        // Anyone with a copy of the token kept access until it expired.
        runtime.sessions.revoke(session);
        c.header('set-cookie', clearedSessionCookie());
        return c.redirect('/ui/login', 302);
    });

    // --- everything below requires a session ----------------------------

    // Unclaimed counts as "no session" regardless of what cookie was presented:
    // a session predating a credential reset must not outlive it.
    const guard = (c: Context): string | undefined => (unclaimed() ? undefined : sessionOf(c, runtime));

    // Every page behind `guard` sends `cache-control: no-store`. The dashboard
    // renders no token, but the config page reveals a new one once, and a
    // cached copy would outlive that.

    app.get('/', c => c.redirect(guard(c) === undefined ? entry() : '/ui', 302));

    app.get('/ui', async c => {
        const session = guard(c);
        if (session === undefined) return c.redirect(entry(), 302);
        c.header('cache-control', 'no-store');

        const snapshot = runtime.current;

        // Through `buildStackHealth`, the same function `stack_health` answers
        // from. Two implementations of "is the stack healthy" is how the page
        // and the tool come to disagree.
        // It is live, not cached: a dashboard showing cached status is one
        // that tells you a dead service is fine, and it degrades rather than
        // failing when a service is unreachable.
        const health = await buildStackHealth(snapshot.adapters, { detail: 'full', limit: 50 });

        return c.html(
            dashboardPage({
                csrf: runtime.sessions.csrfFor(session),
                theme: theme(),
                version,
                diagnoses: health.services,
                configured: snapshot.adapters.map(a => a.id),
                tokens: snapshot.config.auth.tokens,
                plaintextOnDisk: runtime.plaintextOnDisk,
                now: new Date(),
                mcpUrl: mcpEndpoint(c.req.url, c.req.header('x-forwarded-proto')),
                ...(runtime.dataset === undefined ? {} : { imdb: runtime.dataset.status() }),
                disks: health.disks.items,
                failures: health.failures.items,
                scans: health.scans,
                writeCounts: audit.counts()
            })
        );
    });

    // --- logs -----------------------------------------------------------

    app.get('/ui/logs', c => {
        const session = guard(c);
        if (session === undefined) return c.redirect(entry(), 302);
        c.header('cache-control', 'no-store');

        const { stream, minLevel, service } = logQuery(c, logs);
        const url = `/ui/logs.json?stream=${stream}&service=${encodeURIComponent(service ?? '')}`;

        return c.html(
            logsPage({
                csrf: runtime.sessions.csrfFor(session),
                theme: theme(),
                version,
                services: logs.services(),
                selectedService: service ?? '',
                stream,
                streamUrl: url,
                rows: logs.recent({ minLevel, service, limit: 300 })
            })
        );
    });

    /** JSON, not HTML — the client builds rows with textContent, because log
     *  lines carry release names from public indexers. See web/assets.ts. */
    app.get('/ui/logs.json', c => {
        if (guard(c) === undefined) return c.json({ error: 'unauthorized' }, 401);

        const { minLevel, service } = logQuery(c, logs);
        // `detail` is flattened here rather than in the browser so the polled
        // table and the server-rendered one cannot disagree about what a row
        // says.
        const rows = logs
            .recent({ minLevel, service, limit: 300 })
            .map(r => ({ ...r, detail: logFields(r.fields) }));
        return c.json({ rows }, 200, NO_STORE);
    });

    // --- write audit ----------------------------------------------------

    app.get('/ui/audit', c => {
        const session = guard(c);
        if (session === undefined) return c.redirect(entry(), 302);
        c.header('cache-control', 'no-store');
        return c.html(
            auditPage({
                csrf: runtime.sessions.csrfFor(session),
                version,
                rows: audit.recent(300),
                theme: theme()
            })
        );
    });

    // --- configuration --------------------------------------------------

    /**
     * Who each user-aware service says its users are, to suggest in the
     * default-user field.
     *
     * Capped well below the services' own timeouts: this is the page you open
     * *because* something is unreachable, so a dead Jellyfin must cost a
     * moment, not ten seconds. A service that misses the cap is absent from the
     * result and the card says so — never an empty dropdown, which reads as
     * "this service has no users".
     */
    const USER_LOOKUP_MS = 2500;

    const usersByInstance = async (): Promise<Record<string, readonly string[]>> => {
        const found: Record<string, readonly string[]> = {};

        await Promise.all(
            runtime.current.adapters.filter(hasUserDirectory).map(async adapter => {
                try {
                    const users = await Promise.race([
                        adapter.listUsers(),
                        new Promise<never>((_, reject) =>
                            setTimeout(() => reject(new Error('timed out')), USER_LOOKUP_MS).unref()
                        )
                    ]);
                    found[adapter.id] = users.map(u => u.name);
                } catch (err) {
                    logger.warn({ service: adapter.id, err }, 'could not list users for the configuration page');
                }
            })
        );

        return found;
    };

    app.get('/ui/config', async c => {
        const session = guard(c);
        if (session === undefined) return c.redirect(entry(), 302);
        c.header('cache-control', 'no-store');
        return c.html(
            configPage({
                version,
                config: runtime.config,
                csrf: runtime.sessions.csrfFor(session),
                users: await usersByInstance(),
                plaintextOnDisk: runtime.plaintextOnDisk
            })
        );
    });

    /**
     * The config mutations share everything except the one line that
     * decides what the next config is, so they share a handler.
     *
     * `render` carries the `confirmingRemoval` id through, which is what makes
     * the two-step remove work without JavaScript: the first post returns the
     * page with that card asking, and the second carries `confirm`. Revoking a
     * token does the same with `confirmingRevoke`.
     */
    const configMutation =
        (
            what: string,
            next: (form: Record<string, unknown>) => MutationResult | Promise<MutationResult>,
            opts: {
                /** The add form is a dialog, so a refusal has to bring it back —
                 *  a message about a form nobody can see explains nothing. */
                reopensAdd?: boolean;
                /** Whether this save changed the credentials, and so has to end
                 *  sessions signed with the old key. */
                endsSessions?: (form: Record<string, unknown>) => boolean;
                /** The outcome belongs under the OAuth card, which the post
                 *  scrolls to, and a refusal keeps what was typed. */
                oauthCard?: boolean;
            } = {}
        ): ((c: Context) => Promise<Response>) =>
        async (c: Context) => {
            const session = guard(c);
            if (session === undefined) return c.redirect(entry(), 302);

            // Reassigned when the credentials change: the page rendered below
            // has to carry a CSRF token bound to the *new* session, or the next
            // form post from it is rejected.
            let activeSession = session;

            const form = await c.req.parseBody();

            // Captured before `next(form)` yields (`buildAccountConfig` awaits
            // `hashPassword`), so a concurrent reload cannot make this newer
            // than the config the form below was built from.
            const expected = runtime.config;

            // Cards collapse by default, so the one you just submitted has to be
            // named or the page swallows the outcome of what you did. Absent on
            // an add, whose form carries no instance id — there is no card yet.
            const touched = str(form.instance) === '' ? undefined : str(form.instance);

            // Re-asks who the users are, as a plain page load does: a save that
            // dropped the suggestions would have the card claim the service went
            // quiet, and a save that changed a Jellyfin key is exactly when the
            // list is worth refreshing.
            const render = async (
                message: { kind: 'ok' | 'err'; text: string } | undefined,
                status: 200 | 400 | 403 | 409,
                extra: Partial<Parameters<typeof configPage>[0]> = {}
            ) => {
                c.header('cache-control', 'no-store');
                return c.html(
                    configPage({
                        version,
                        config: runtime.config,
                        csrf: runtime.sessions.csrfFor(activeSession),
                        users: await usersByInstance(),
                        plaintextOnDisk: runtime.plaintextOnDisk,
                        ...(touched === undefined ? {} : { openInstance: touched }),
                        ...(opts.reopensAdd === true && status !== 200 ? { openAdd: true } : {}),
                        ...(opts.oauthCard === true
                            ? {
                                  oauth: {
                                      ...(message === undefined ? {} : { message }),
                                      // A stale page's draft is what the 409 refused to apply.
                                      ...(status === 200 || status === 409 ? {} : { draft: oauthDraftFrom(form) })
                                  }
                              }
                            : message === undefined
                              ? {}
                              : { message }),
                        ...extra
                    }),
                    status
                );
            };

            if (!runtime.sessions.csrfValid(session, str(form.csrf))) {
                logger.warn({ ...originOf(c) }, 'rejected config save with a bad CSRF token');
                return render({ kind: 'err', text: 'That form was stale. Reload the page and try again.' }, 403);
            }

            // Each card posts its whole form, so a save built on an older page
            // would quietly undo whatever changed since. No etag keeps the old
            // behaviour for a hand-built post.
            const etag = str(form.etag);
            if (etag !== '' && etag !== configEtag(expected)) {
                return render(
                    {
                        kind: 'err',
                        text: 'This page is out of date: the configuration changed after it loaded. Your edit was not saved. Review the page and make it again.'
                    },
                    409
                );
            }

            let updated: Config;
            let reveal: { name: string; token: string } | undefined;
            let revealKey: string | undefined;
            try {
                const result = await next(form);
                // Not an error: the removal is waiting for a second click.
                if ('ask' in result) return render(undefined, 200, { confirmingRemoval: result.ask });
                if ('askRevoke' in result) return render(undefined, 200, { confirmingRevoke: result.askRevoke });
                if ('askOAuthRemoval' in result) return render(undefined, 200, { oauth: { confirmingRemoval: true } });
                if ('askKeyRemoval' in result) return render(undefined, 200, { confirmingKeyRemoval: true });
                if ('revealKey' in result) {
                    updated = result.config;
                    revealKey = result.revealKey;
                } else if ('reveal' in result) {
                    updated = result.config;
                    reveal = { name: result.revealName, token: result.reveal };
                } else {
                    updated = result;
                }
            } catch (err) {
                warnIfCredentialMove(c, err);
                return render({ kind: 'err', text: (err as Error).message }, 400);
            }

            try {
                // `expected` is the snapshot this page's form was built from,
                // so a service hand-added to config.yaml since then is a
                // refusal rather than a silent deletion under a "Saved" banner.
                await commitConfig(runtime, expected, updated);

                if (opts.endsSessions?.(form) === true) {
                    // Sessions signed with the old key must not outlive the
                    // credentials they were issued under. The editor gets a
                    // fresh one so changing your own password does not sign
                    // you out of the page you changed it on.
                    runtime.sessions.rotateKey();
                    activeSession = runtime.sessions.issue();
                    c.header('set-cookie', sessionCookie(activeSession, Math.floor(SESSION_TTL_MS / 1000)));
                }
            } catch (err) {
                // The file is written atomically and validated first, so
                // reaching here means the config on disk is still the working
                // one.
                // commitConfig already warned about an unloadable hand edit.
                if (!(err instanceof ConfigUnloadableError)) logger.error({ err }, 'config save failed');
                return render({ kind: 'err', text: (err as Error).message }, 400);
            }

            logger.info({ ...originOf(c), what }, 'configuration saved from the config UI');
            return render(
                { kind: 'ok', text: `${what} Applied immediately; no restart needed.` },
                200,
                {
                    ...(reveal === undefined
                        ? {}
                        : {
                              revealed: {
                                  ...reveal,
                                  mcpUrl: mcpEndpoint(c.req.url, c.req.header('x-forwarded-proto')),
                                  urlToken: runtime.config.auth.allow_token_in_url
                              }
                          }),
                    ...(revealKey === undefined
                        ? {}
                        : {
                              revealedKey: {
                                  key: revealKey,
                                  apiUrl: apiEndpoint(c.req.url, c.req.header('x-forwarded-proto'))
                              }
                          })
                }
            );
        };

    app.post(
        '/ui/config/add',
        configMutation('Added.', form => addCandidateFrom(runtime.config, form).candidate, { reopensAdd: true })
    );

    app.post(
        '/ui/config/save',
        configMutation('Saved.', form =>
            updateInstance(runtime.config, str(form.instance), instanceFieldsFrom(form, storedUrl(runtime.config, str(form.instance))))
        )
    );

    app.post(
        '/ui/config/remove',
        configMutation('Removed.', form => {
            const instance = str(form.instance);
            // Server-side rather than a `confirm()` call: with scripting
            // unavailable a JS confirmation would delete silently on the first
            // click, which is the failure a confirmation exists to prevent.
            if (str(form.confirm) !== 'yes') return { ask: instance };
            return removeInstance(runtime.config, instance);
        })
    );

    // One route per card, matching one form per card. A single `/access` route
    // taking all three was what let the page grow a button that looked global.
    app.post(
        '/ui/config/account',
        configMutation('Config UI sign-in saved.', form => buildAccountConfig(runtime.config, form), {
            // Only when the password field was actually filled in — a username
            // edit is not a credential change.
            endsSessions: form => str(form['auth.password']) !== ''
        })
    );

    app.post(
        '/ui/config/media-servers',
        configMutation('Primary media server saved.', form => buildMediaServerConfig(runtime.config, form))
    );

    app.post(
        '/ui/config/appearance',
        configMutation('Appearance saved.', form => buildAppearanceConfig(runtime.config, form))
    );

    app.post(
        '/ui/config/imdb',
        configMutation('IMDb dataset settings saved.', form => buildImdbConfig(runtime.config, form))
    );

    app.post(
        '/ui/config/mcp',
        configMutation('MCP endpoint settings saved.', form => buildMcpConfig(runtime.config, form))
    );

    app.post(
        '/ui/config/tokens/add',
        configMutation('Token created.', form => {
            const tier = str(form['token.tier']);
            const expiry = str(form['token.expiry']);
            if (!['read', 'write', 'destructive'].includes(tier)) throw new ConfigEditError('Pick a tier.');
            if (!['30', '90', 'never'].includes(expiry)) throw new ConfigEditError('Pick an expiry.');
            const name = str(form['token.name']).trim();
            const { config, plaintext } = addToken(
                runtime.config,
                { name, tier: tier as TokenTier, expiry: expiry as ExpiryChoice },
                new Date()
            );
            return { config, reveal: plaintext, revealName: name };
        })
    );

    app.post(
        '/ui/config/tokens/revoke',
        configMutation('Token revoked.', form => {
            const name = str(form.token);
            if (str(form.confirm) !== 'yes') return { askRevoke: name };
            return revokeToken(runtime.config, name);
        })
    );

    app.post(
        '/ui/config/api-key',
        configMutation('Management API key generated.', () => {
            const { config, plaintext } = setManagementKey(runtime.config, new Date());
            return { config, revealKey: plaintext };
        })
    );

    app.post(
        '/ui/config/api-key/remove',
        configMutation('Management API turned off.', form => {
            if (str(form.confirm) !== 'yes') return { askKeyRemoval: true };
            return clearManagementKey(runtime.config);
        })
    );

    app.post(
        '/ui/config/oauth',
        configMutation('OAuth settings saved.', form => buildOAuthConfig(runtime.config, form), { oauthCard: true })
    );

    app.post(
        '/ui/config/oauth/remove',
        configMutation(
            'OAuth removed.',
            form => {
                if (str(form.confirm) !== 'yes') return { askOAuthRemoval: true };
                const { oauth: _dropped, ...auth } = runtime.config.auth;
                return { ...runtime.config, auth };
            },
            { oauthCard: true }
        )
    );

    /**
     * Fetches `jwks_uri` as typed and reports what the verifier would find
     * there. Like `/ui/config/test`, never saves.
     */
    app.post('/ui/config/oauth/test', async c => {
        const session = guard(c);
        if (session === undefined) return c.redirect(entry(), 302);
        c.header('cache-control', 'no-store');

        const form = await c.req.parseBody();
        const draft = oauthDraftFrom(form);

        const render = async (status: 200 | 400 | 403, oauth: NonNullable<Parameters<typeof configPage>[0]['oauth']>) =>
            c.html(
                configPage({
                    version,
                    config: runtime.config,
                    csrf: runtime.sessions.csrfFor(session),
                    users: await usersByInstance(),
                    plaintextOnDisk: runtime.plaintextOnDisk,
                    oauth: { draft, ...oauth }
                }),
                status
            );

        if (!runtime.sessions.csrfValid(session, str(form.csrf))) {
            logger.warn({ ...originOf(c) }, 'rejected an OAuth test with a bad CSRF token');
            return render(403, { message: { kind: 'err', text: 'That form was stale. Reload the page and try again.' } });
        }

        // Not `buildOAuthConfig`: its URL-token refusal is about saving, and
        // a test saves nothing.
        let jwksUri: string;
        try {
            jwksUri = parseOAuthDraft(form).jwks_uri;
        } catch (err) {
            return render(400, { message: { kind: 'err', text: (err as Error).message } });
        }

        const probe = await probeJwks(jwksUri);
        // The outcome word only: a summary can carry a redirect's Location.
        logger.info({ host: new URL(jwksUri).host, outcome: probe.outcome }, 'OAuth key set tested from the config UI');
        return render(200, {
            tested: probe,
            ...(probe.ok && runtime.config.auth.allow_token_in_url
                ? { testedNote: "Saving will be refused until 'Accept the token in the URL' is off." }
                : {})
        });
    });

    /**
     * Test one instance against the fields as they stand, not as they are
     * saved — replacing "save it and see if the dashboard goes green", which
     * writes a URL you already suspect is wrong and answers on another page.
     * The candidate is built exactly as a save would build it and thrown away.
     *
     * The add dialog posts here too, with no `instance`. That candidate comes
     * from `addInstance`, the same call Add makes, so a passing test is one Add
     * will accept — and it inherits Add's validation, so an unnamed second
     * radarr answers "name it" rather than a latency.
     *
     * Not a `configMutation`, despite the shape: that helper ends in
     * `saveConfig`.
     */
    app.post('/ui/config/test', async c => {
        const session = guard(c);
        if (session === undefined) return c.redirect(entry(), 302);
        c.header('cache-control', 'no-store');

        const form = await c.req.parseBody();
        const id = str(form.instance);
        const isAdd = id === '';

        // The dialog's Test is fetched, not posted, so the result lands in a
        // dialog that still holds what you typed. A re-render could not:
        // `addDialog` renders its fields blank, and refilling them would mean
        // writing the API key into the HTML — the one thing `configPage` never
        // does. Unscripted falls through to the ordinary render.
        const wantsJson = c.req.header('accept')?.includes('application/json') === true;

        const render = async (status: 200 | 400 | 403, extra: Partial<Parameters<typeof configPage>[0]>) =>
            c.html(
                configPage({
                    version,
                    config: runtime.config,
                    csrf: runtime.sessions.csrfFor(session),
                    users: await usersByInstance(),
                    plaintextOnDisk: runtime.plaintextOnDisk,
                    ...(isAdd ? { openAdd: true } : {}),
                    ...extra
                }),
                status
            );

        const fail = async (status: 400 | 403, text: string) =>
            wantsJson ? c.json({ ok: false, detail: text }, status) : render(status, { message: { kind: 'err', text } });

        if (!runtime.sessions.csrfValid(session, str(form.csrf))) {
            logger.warn({ ...originOf(c) }, 'rejected a connection test with a bad CSRF token');
            return fail(403, 'That form was stale. Reload the page and try again.');
        }

        try {
            const { candidate, target } = isAdd
                ? addCandidateFrom(runtime.config, form)
                : {
                      candidate: updateInstance(runtime.config, id, instanceFieldsFrom(form, storedUrl(runtime.config, id))),
                      target: id
                  };

            const adapter = buildAdapters(candidate).find(a => a.id === target);
            if (adapter === undefined) throw new Error(`${target} is not configured.`);

            const diagnosis = await adapter.testConnection();
            logger.info({ ...originOf(c), service: target, ok: diagnosis.ok }, 'connection tested from the config UI');

            if (wantsJson) return c.json(diagnosis, 200);
            return render(200, isAdd ? { testedAdd: diagnosis } : { tested: { instance: target, diagnosis } });
        } catch (err) {
            // A config that will not even build — a URL that is not a URL, a
            // timeout that is not a number. testConnection never gets to run,
            // so the message is the validation one, which names the field.
            warnIfCredentialMove(c, err);
            if (!wantsJson && !isAdd) {
                return render(400, { message: { kind: 'err', text: (err as Error).message }, openInstance: id });
            }
            return fail(400, (err as Error).message);
        }
    });
}

/** What a config mutation decided: a config to save, a second click to ask
 *  for, or a new token whose plaintext is shown once after the save. */
type MutationResult =
    | Config
    | { ask: string }
    | { askRevoke: string }
    | { askOAuthRemoval: true }
    | { config: Config; reveal: string; revealName: string }
    | { config: Config; revealKey: string }
    | { askKeyRemoval: true };

const CACHE = { 'cache-control': 'public, max-age=3600' };
const NO_STORE = { 'cache-control': 'no-store' };

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const on = (value: unknown): boolean => value === 'on' || value === 'true';
/**
 * Who connected, for a log line — the peer address, plus what they claimed.
 *
 * `ip` used to be `X-Forwarded-For` alone, which recorded a literal "unknown"
 * for every request on a direct LAN deployment: no proxy sets the header, and
 * that is the common install. A refused sign-in or a refused `/mcp` call named
 * nobody, which is the one thing those lines exist to do.
 *
 * The peer address is the socket fact and cannot be forged; the header is
 * caller-supplied and can. So the header is recorded *beside* the peer under
 * its own name rather than in place of it — behind a real proxy both are
 * wanted anyway, and a client inventing a header can no longer overwrite the
 * only identifying field on the line.
 */
export const originOf = (c: Context): { ip: string; forwardedFor?: string } => {
    const claimed = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    return {
        ip: peerAddress(c),
        ...(claimed === undefined || claimed === '' ? {} : { forwardedFor: claimed })
    };
};

export const warnIfCredentialMove = (c: Context, err: unknown): void => {
    if (err instanceof CredentialWouldMoveError) {
        logger.warn({ ...originOf(c), target: err.target }, 'refused to send a stored credential to a new host');
    }
};

const peerAddress = (c: Context): string => {
    try {
        // IPv4-mapped IPv6 is what a dual-stack listener reports for a plain
        // IPv4 client; the prefix is noise to a reader chasing a LAN address.
        return (getConnInfo(c).remote.address ?? 'unknown').replace(/^::ffff:/, '');
    } catch {
        // No node socket behind the context — a Request built in a test.
        return 'unknown';
    }
};

function sessionOf(c: Context, runtime: Runtime): string | undefined {
    const token = readCookie(c.req.header('cookie'), SESSION_COOKIE);
    return runtime.sessions.verify(token).valid ? token : undefined;
}

/**
 * Which of the three streams was asked for, as a query.
 *
 * The service filter goes through `ServiceIdSchema`, so an unknown value
 * becomes "no filter" rather than reaching the store. "By service" with none
 * chosen defaults to the first that has actually logged, so the tab is never a
 * blank page with a dropdown.
 */
function logQuery(
    c: Context,
    logs: LogStore
): { stream: LogStreamKey; minLevel: number; service: string | undefined } {
    const requested = c.req.query('stream') ?? 'all';
    const stream = LOG_STREAMS.find(s => s.key === requested) ?? LOG_STREAMS[0];

    // Validated against what has actually been logged, not against the
    // eight-name service enum. The column holds instance ids (`radarr/4k`) and
    // source ids (`jellyfin:seasons`), and `services()` builds the dropdown
    // from those same values — so parsing the choice as a bare ServiceId threw
    // away every selection the dropdown offered on a multi-instance install,
    // returned every line from every service, and looked like "nothing logged".
    const known = logs.services();
    const requestedService = c.req.query('service');
    let service = requestedService !== undefined && known.includes(requestedService) ? requestedService : undefined;

    if (stream.key === 'service' && service === undefined) service = known[0];
    // Only the by-service stream filters by service; picking one and then
    // switching to Problems must not silently keep filtering.
    if (stream.key !== 'service') service = undefined;

    return { stream: stream.key, minLevel: stream.minLevel, service };
}

/**
 * The instance fields a card's form carries, under bare names — each card is
 * its own form, and an id containing a `/` has no sensible prefix anyway.
 *
 * A blank credential means "unchanged", never "clear". The page never renders a
 * secret back, so blank is what an untouched field always looks like; clearing
 * is expressed by removing the instance, which is confirmed.
 */
const storedUrl = (config: Config, id: string): string | undefined =>
    (listInstances(config).find(i => i.id === id)?.config as { url?: string } | undefined)?.url;

/**
 * The page shows a URL without its `user:pass@`, so getting that URL back
 * means unchanged, not "drop the credentials". The API does the same.
 */
export function instanceFieldsFrom(form: Record<string, unknown>, stored?: string): InstanceFields {
    const timeout = Number(str(form.timeout_ms));
    const url = str(form.url).trim();

    return {
        url: stored !== undefined && sameUrl(url, stored) ? '' : url,
        api_key: str(form.api_key).trim(),
        username: str(form.username).trim(),
        password: str(form.password),
        default_user: str(form.default_user).trim(),
        allow_other_users: on(form.allow_other_users),
        ...(Number.isFinite(timeout) && timeout > 0 ? { timeout_ms: Math.trunc(timeout) } : {}),
        safe_write: on(form.safe_write),
        destructive: on(form.destructive),
        allow_metadata_repair: on(form.allow_metadata_repair)
    };
}

/**
 * What the add dialog describes: the config it would produce, and the id the
 * new instance would take.
 *
 * Shared by `/ui/config/add` and the dialog's Test so the two cannot drift.
 * A Test that builds its candidate any other way is a Test that can pass
 * against something Add would then refuse.
 */
export function addCandidateFrom(
    config: Config,
    form: Record<string, unknown>
): { candidate: Config; target: string } {
    const type = ServiceIdSchema.parse(str(form.type));
    const name = str(form.name).trim();
    const renameExistingTo = str(form.rename_existing_to).trim();

    return addCandidate(config, {
        type,
        name: name === '' ? undefined : name,
        renameExistingTo: renameExistingTo === '' ? undefined : renameExistingTo,
        fields: instanceFieldsFrom(form)
    });
}

/**
 * The three cards below the services, one builder each.
 *
 * They were a single `buildAuthConfig` behind a single button, which is what
 * made the page have two save models at once — every service card saved
 * itself, and then one button at the bottom of the page saved three unrelated
 * things together while looking, by position, like it saved everything.
 *
 * Splitting them makes the rule uniform: **the card you edited is the card you
 * save.** It also creates the one hazard worth naming, which is why each of
 * these carries forward every field it does not own rather than rebuilding the
 * config from its own form. A form that never contained `auth.allowed_hosts`
 * submits nothing for it, and "nothing" is indistinguishable from "the user
 * cleared the box" unless the builder knows which fields are its business.
 * `test/configUi.test.ts` holds one test per way of getting that wrong.
 */

/** The Config UI's own credentials. Owns `username` and `password_hash`. */
export async function buildAccountConfig(current: Config, form: Record<string, unknown>): Promise<Config> {
    const username = str(form['auth.username']).trim();
    const password = str(form['auth.password']);

    // Refused rather than carried forward as `undefined`. Since `password_hash`
    // became optional this assignment type-checks either way, so nothing but
    // this guard stops a blank password field on a config save from writing a
    // config with no hash — silently un-claiming a live instance and handing it
    // to whoever loads /ui/setup next.
    const carriedHash = password === '' ? current.auth.password_hash : await hashPassword(password);
    if (carriedHash === undefined) {
        throw new Error('This instance has no password set yet. Reload the page and set one up.');
    }

    return {
        ...current,
        auth: {
            ...current.auth,
            username: username === '' ? current.auth.username : username,
            password_hash: carriedHash
        }
    };
}

/**
 * The IMDb dataset. Owns `metadata` and nothing else.
 *
 * Its checkbox is authoritative because an unchecked box submits nothing, and
 * this is the only form that carries it — so absent genuinely means off here,
 * where on any other card it would mean "not mine to touch".
 */
export function buildImdbConfig(current: Config, form: Record<string, unknown>): Config {
    return setImdb(current, on(form['metadata.imdb']));
}

/**
 * The theme. Owns `ui` and nothing else.
 *
 * `system` drops the block rather than writing `theme: system`, so choosing the
 * default leaves the file as clean as it was — the same rule the IMDb card
 * follows. An unparseable value falls back to `system` instead of being written
 * through: this comes from a form, and the schema would refuse the file on the
 * next load, which turns a bad select into a server that will not start.
 */
export function buildAppearanceConfig(current: Config, form: Record<string, unknown>): Config {
    const { ui: _dropped, ...rest } = current;
    const parsed = ThemeSchema.safeParse(str(form['ui.theme']));
    const theme = parsed.success ? parsed.data : 'system';

    return { ...rest, ...(theme === 'system' ? {} : { ui: { theme } }) };
}

/** The primary media server. Owns `primary_media_server` and nothing else. */
export function buildMediaServerConfig(current: Config, form: Record<string, unknown>): Config {
    const parsed = MediaServerIdSchema.safeParse(str(form.primary_media_server));
    if (!parsed.success) throw new ConfigEditError('Pick jellyfin or plex as the primary media server.');
    return { ...current, primary_media_server: parsed.data };
}

export function oauthDraftFrom(form: Record<string, unknown>): OAuthDraft {
    const f = (name: string) => str(form[`auth.oauth.${name}`]).trim();
    return {
        issuer: f('issuer'),
        audience: f('audience'),
        jwks_uri: f('jwks_uri'),
        read: f('scopes.read'),
        write: f('scopes.write'),
        destructive: f('scopes.destructive')
    };
}

const OAUTH_LABELS: Record<string, string> = {
    issuer: 'Issuer',
    audience: 'Audience',
    jwks_uri: 'JWKS URI',
    'scopes.read': 'Read scope',
    'scopes.write': 'Write scope',
    'scopes.destructive': 'Destructive scope',
    scopes: 'Scopes'
};

/**
 * The OAuth card's fields as an `auth.oauth` block, shared by Save and Test.
 *
 * Validated against the block's own schema so a refusal names the field in a
 * sentence, rather than arriving as `saveConfig`'s whole-config dump.
 */
export function parseOAuthDraft(form: Record<string, unknown>): OAuthConfig {
    const d = oauthDraftFrom(form);
    const parsed = OAuthSchema.safeParse({
        issuer: d.issuer,
        audience: d.audience,
        jwks_uri: d.jwks_uri,
        scopes: { read: d.read, write: d.write, destructive: d.destructive }
    });
    if (!parsed.success) {
        const lines = parsed.error.issues.map(issue => {
            const label = OAUTH_LABELS[issue.path.join('.')] ?? 'OAuth';
            return issue.code === 'too_small' ? `${label} is required.` : `${label}: ${issue.message}.`;
        });
        throw new Error([...new Set(lines)].join('\n'));
    }
    return parsed.data;
}

/** The OAuth card. Owns `auth.oauth` and nothing else. */
export function buildOAuthConfig(current: Config, form: Record<string, unknown>): Config {
    if (current.auth.allow_token_in_url) {
        throw new Error(
            "Turn off 'Accept the token in the URL' on the MCP endpoint card first. A JWT in the URL reaches every proxy log."
        );
    }
    return { ...current, auth: { ...current.auth, oauth: parseOAuthDraft(form) } };
}

/** The MCP endpoint. Owns `allowed_hosts` and `allow_token_in_url`. */
export function buildMcpConfig(current: Config, form: Record<string, unknown>): Config {
    return setMcpEndpoint(current, {
        allowedHosts: str(form['auth.allowed_hosts']).split(','),
        allowTokenInUrl: on(form['auth.allow_token_in_url'])
    });
}
