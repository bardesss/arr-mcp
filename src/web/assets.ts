/**
 * CSS and JS as exported strings, served from memory.
 *
 * Not files on disk: the Dockerfile copies `src` and runs `tsc`, and tsc does
 * not emit non-TypeScript files — so a `public/` directory would be silently
 * absent from the image while working perfectly in development. Keeping the
 * assets in modules means the thing that is tested is the thing that ships.
 *
 * There is no build step and no framework, by design. The page is server
 * rendered; this is the small amount of behaviour that genuinely needs a
 * client — polling the log stream and copying the token.
 */

/**
 * The light palette, in one place and applied twice.
 *
 * It has to appear under both a media query and an attribute selector, and CSS
 * cannot combine those into one rule. Writing it out twice is how `--ok`,
 * `--warn` and `--bad` came to be missing from the light theme for as long as
 * they were: the status colours were tuned against a near-black panel, and on
 * white the warn amber landed near 1.8:1 — illegible on the one row of the log
 * table anyone urgently needs to read. Interpolating a single constant means
 * the next token added cannot be added to only one of them.
 */
const LIGHT = `
  --bg: #f6f7f9; --panel: #fff; --panel-2: #f0f2f5; --line: #d9dee7;
  --text: #1a1d26; --dim: #5b6472; --accent: #1a56db;
  --ok: #15803d; --warn: #b45309; --bad: #b91c1c;
`;

export const CSS = `
:root {
  --bg: #12141a; --panel: #1a1d26; --panel-2: #21252f; --line: #2c313d;
  --text: #e6e8ee; --dim: #9aa2b1; --accent: #6ea8fe;
  --ok: #4ade80; --warn: #fbbf24; --bad: #f87171;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
/* Follow the OS, unless the config says otherwise. The :not() is what lets an
   explicit dark choice win on a machine set to light. */
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {${LIGHT}}
}
:root[data-theme="light"] {${LIGHT}}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}
a { color: var(--accent); }
header {
  display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap;
  padding: .9rem 1.25rem; background: var(--panel); border-bottom: 1px solid var(--line);
}
header h1 { font-size: 1rem; margin: 0; letter-spacing: .02em; }
header h1 span { color: var(--dim); font-weight: 400; }
nav { display: flex; gap: .25rem; flex: 1; flex-wrap: wrap; }
nav a {
  padding: .35rem .7rem; border-radius: 6px; text-decoration: none;
  color: var(--dim); font-size: .9rem;
}
nav a:hover { background: var(--panel-2); color: var(--text); }
nav a.on { background: var(--panel-2); color: var(--text); }
main { max-width: 1100px; margin: 0 auto; padding: 1.5rem 1.25rem 2rem; }
footer {
  max-width: 1100px; margin: 0 auto; padding: 1rem 1.25rem 2.5rem;
  border-top: 1px solid var(--line); color: var(--dim); font-size: .85rem;
  display: flex; flex-wrap: wrap; gap: .3rem 1.1rem; align-items: baseline;
}
h2 { font-size: 1.05rem; margin: 2rem 0 .75rem; }
h2:first-child { margin-top: 0; }
p.note { color: var(--dim); font-size: .9rem; margin: .35rem 0 1rem; }
.panel {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 10px; padding: 1rem 1.1rem; margin-bottom: 1rem;
}
.grid { display: grid; gap: .85rem; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: .9rem 1rem; }
.card h3 { margin: 0 0 .4rem; font-size: .95rem; display: flex; align-items: center; gap: .5rem; }
.card dl { margin: .5rem 0 0; display: grid; grid-template-columns: auto 1fr; gap: .2rem .75rem; font-size: .88rem; }
.card dt { color: var(--dim); }
.card dd { margin: 0; word-break: break-word; }
.svc-icon { width: 20px; height: 20px; flex: none; color: var(--dim); }
.svc-title { display: flex; align-items: center; gap: .5rem; margin: 0 0 .75rem; }
/* Status to the right edge, so the dots line up down the grid rather than
   sitting at eight different offsets after eight different service names. */
.card h3 .dot { margin-left: auto; }
.dot { width: .6rem; height: .6rem; border-radius: 50%; display: inline-block; flex: none; }
.dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); } .dot.off { background: var(--dim); }
.remedy {
  margin-top: .6rem; padding: .5rem .6rem; border-left: 3px solid var(--warn);
  background: var(--panel-2); border-radius: 0 6px 6px 0; font-size: .85rem; color: var(--text);
}
table { width: 100%; border-collapse: collapse; font-size: .87rem; }
/* A health message, a mount path, a URL: one long unbroken value in a cell is
   enough to push the whole page sideways on a phone. overflow-wrap is
   "anywhere" rather than "break-word" because only that value lets the cell's
   min-content width shrink, which is the part that stops the overflow. */
th, td {
  text-align: left; padding: .45rem .6rem; border-bottom: 1px solid var(--line);
  vertical-align: top; overflow-wrap: anywhere;
}
th { color: var(--dim); font-weight: 500; position: sticky; top: 0; background: var(--panel); }
td.mono, .mono { font-family: var(--mono); font-size: .85em; }
tr.lvl-40 td { color: var(--warn); } tr.lvl-50 td, tr.lvl-60 td { color: var(--bad); }
.scroll { max-height: 65vh; overflow: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
form.inline { display: flex; gap: .5rem; flex-wrap: wrap; align-items: end; margin-bottom: 1rem; }
label { display: block; font-size: .85rem; color: var(--dim); margin-bottom: .2rem; }
input, select, textarea {
  background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
  border-radius: 7px; padding: .45rem .6rem; font: inherit; min-width: 0;
}
input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
input[type=checkbox] { min-width: auto; }
button {
  background: var(--accent); color: #fff; border: 0; border-radius: 7px;
  padding: .5rem .9rem; font: inherit; cursor: pointer;
}
button.ghost { background: var(--panel-2); color: var(--text); border: 1px solid var(--line); }
button:hover { filter: brightness(1.1); }
.row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.msg { padding: .7rem .9rem; border-radius: 8px; margin-bottom: 1rem; font-size: .9rem; }
.msg.ok { background: #14351f; color: #b7f7cd; }
.msg.err { background: #3a1618; color: #ffc9cc; white-space: pre-wrap; }
@media (prefers-color-scheme: light) {
  .msg.ok { background: #dcfce7; color: #14532d; }
  .msg.err { background: #fee2e2; color: #7f1d1d; }
}
.login { max-width: 380px; margin: 12vh auto; }
.login .panel { padding: 1.5rem; }
.field { margin-bottom: .9rem; }
.field input { width: 100%; }
fieldset { border: 1px solid var(--line); border-radius: 10px; padding: .9rem 1rem; margin: 0 0 1rem; }
legend { padding: 0 .4rem; color: var(--dim); font-size: .85rem; }
.svc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: .75rem; }
/* What type=password used to do, minus the part that made every password
   manager fill the card as a login form. Chrome, Edge and Safari have had the
   prefixed property for years; Firefox since 116. Where it is unsupported the
   field is a plain text input, which is the honest failure — the server never
   renders a secret into it, so nothing is ever on screen that was not just
   typed. */
.secret { -webkit-text-security: disc; }
dialog {
  background: var(--panel); color: var(--text); border: 1px solid var(--line);
  border-radius: 10px; padding: 0; max-width: 560px; width: calc(100% - 2rem);
}
dialog::backdrop { background: rgba(0, 0, 0, .6); }
dialog .panel { margin: 0; border: 0; border-radius: 10px; max-height: 82vh; overflow: auto; }
.token { display: flex; gap: .5rem; align-items: center; margin-bottom: .5rem; flex-wrap: wrap; }
/* Wraps rather than shrinking: squeezed onto one phone-width line, the field
   holding the token is narrower than the two buttons beside it, and a token
   you cannot see any of is worse than one on its own line. */
.token input { flex: 1 1 14rem; font-family: var(--mono); font-size: .8rem; }
#mcp-config { width: 100%; margin-top: .6rem; font-size: .78rem; white-space: pre; }
.dim { color: var(--dim); }

/* --- the write audit ---------------------------------------------------
   Seven columns, one of them a JSON blob of arguments, was unreadable before
   it was unresponsive — no width makes that table scannable. An entry per
   attempt puts the answer on the first line (what happened, which tool, when)
   and moves the arguments underneath, where their length costs nothing. */
.trail { display: grid; gap: .6rem; }
.entry {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 10px; padding: .75rem .9rem;
}
.entry-top { display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
.entry-top .tool { font-weight: 600; }
.entry-top time { margin-left: auto; color: var(--dim); font-size: .8rem; }
.entry dl {
  margin: .55rem 0 0; display: grid; grid-template-columns: auto 1fr;
  gap: .15rem .75rem; font-size: .86rem;
}
.entry dt { color: var(--dim); }
.entry dd { margin: 0; overflow-wrap: anywhere; }
.badge {
  font-size: .72rem; text-transform: uppercase; letter-spacing: .04em;
  padding: .1rem .45rem; border-radius: 999px; white-space: nowrap;
  border: 1px solid var(--line); background: var(--panel-2); color: var(--dim);
}
/* Only the outcomes worth stopping on are coloured. A preview and a dry run
   are the system working, and colouring those too would leave nothing for a
   refusal or a half-finished write to stand out against. */
.badge.applied { color: var(--ok); border-color: currentColor; }
.badge.denied, .badge.attempted { color: var(--warn); border-color: currentColor; }
.badge.failed { color: var(--bad); border-color: currentColor; }

/* --- small screens -----------------------------------------------------
   The body is one column at any width already. What breaks on a phone is the
   header, where a title, four nav links and Sign out share one wrapping flex
   row and land wherever they happen to fall. */
@media (max-width: 700px) {
  header { gap: .6rem .75rem; padding: .75rem .9rem; }
  header h1 { flex: 1; }
  /* A row of its own, under the title and Sign out. Moved with "order" rather
     than in the markup, because on a wide screen the nav genuinely does belong
     between those two, and the source order is the reading order. */
  nav { order: 1; flex-basis: 100%; gap: .3rem; }
  /* Stretched to fill the line: four links of unequal length wrapping across
     two rows read as debris otherwise. Smaller and tighter so that on most
     phones they fit on one row at all. */
  nav a { flex: 1 1 auto; text-align: center; padding: .55rem .55rem; font-size: .85rem; }
  main { padding: 1.25rem .9rem 1.5rem; }
  footer { padding: 1rem .9rem 2.5rem; }
  .panel, .card, .entry { padding: .8rem .85rem; }
  /* 16px is the threshold under which iOS Safari zooms the page in on focus —
     and it does not zoom back out, so one tap on a field leaves you scrolled
     sideways across a form you were only trying to type in. */
  input, select, textarea, .token input, #mcp-config { font-size: 16px; }
}
`;

/**
 * Two behaviours, both of which genuinely need a client: copying a secret to
 * the clipboard, and refreshing the log table without losing scroll position.
 * Everything else is a form post and a server render.
 */
export const JS = `
// Say what actually happened. The clipboard write fails on every plain http
// origin, and reporting "Copied" for a fallback that only selected the text is
// how someone pastes the wrong thing and blames the field.
const flash = (btn, text) => {
  if (btn.dataset.label === undefined) btn.dataset.label = btn.textContent.trim();
  btn.textContent = text;
  setTimeout(() => { btn.textContent = btn.dataset.label; }, 1600);
};

const selectIn = (el) => {
  el.hidden = false;
  el.removeAttribute('readonly');
  el.select();
  el.setAttribute('readonly', '');
};

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.copy);
  if (!input) return;
  try {
    await navigator.clipboard.writeText(input.value);
    flash(btn, 'Copied');
  } catch {
    // Clipboard API needs a secure context, and this is deliberately served
    // over http on a LAN — so fall back to selecting the text for the user.
    selectIn(input);
    flash(btn, 'Selected — copy it');
  }
});

// Assembled in the browser, never rendered by the server. The token is masked
// three lines above on the page, so putting it into the HTML as readable JSON
// would undo that and make a screenshot carry a working credential.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy-config]');
  if (!btn) return;
  const box = document.getElementById(btn.dataset.copyConfig);
  const url = document.getElementById('mcp-url');
  const token = document.getElementById('bearer');
  if (!box || !url || !token) return;

  const config = JSON.stringify({
    mcpServers: {
      'arr-mcp': {
        type: 'http',
        url: url.value,
        headers: { Authorization: 'Bearer ' + token.value }
      }
    }
  }, null, 2);

  try {
    await navigator.clipboard.writeText(config);
    flash(btn, 'Copied');
  } catch {
    // No clipboard on http, and nothing on screen to select — so fill the
    // textarea and reveal it. That puts the token on screen, acceptable only
    // because it took a click on a button that says it copies credentials.
    box.value = config;
    selectIn(box);
    flash(btn, 'Selected — copy it');
  }
});

// Reveal a secret only on request, so a screenshot or a shoulder does not
// capture every API key on the page by default.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-reveal]');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.reveal);
  if (!input) return;
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  btn.textContent = hidden ? 'Hide' : 'Show';
});

// The add form: a dialog opened by a button, with fields that follow the
// picker. Both are enhancements — with scripting off, a <noscript> rule styles
// the dialog back into the page and every field shows.
const addService = document.getElementById('add-service');
if (addService) {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open]');
    if (!btn) return;
    const dialog = document.getElementById(btn.dataset.open);
    if (dialog && !dialog.open) dialog.showModal();
  });

  // A refused add re-renders the page with the dialog open, which to a browser
  // with no script means "inline". Reopen it as the modal it was when posted,
  // so the error at the top and the form it is about are on screen together.
  if (addService.open) {
    addService.close();
    addService.showModal();
  }

  const picker = document.getElementById('add.type');
  if (picker) {
    const follow = () => {
      for (const el of addService.querySelectorAll('[data-only]')) {
        el.hidden = !el.dataset.only.split(' ').includes(picker.value);
      }
    };
    picker.addEventListener('change', follow);
    follow();
  }

  // Test, without leaving the dialog.
  //
  // The unscripted fallback posts this form and gets the page back with the
  // dialog reopened and the fields blank — survivable for a refused Add, which
  // you do once, but not for a test you repeat while fixing a URL. So the
  // scripted path posts the same form to the same route and fills the result in
  // place, which is also what keeps the typed API key off the wire twice and
  // out of the rendered HTML entirely.
  //
  // textContent, never innerHTML: detail and remedy quote whatever the service
  // said back, and this is the one path where that string is put on the page by
  // the browser rather than through the server's escaping template.
  const form = addService.querySelector('form');
  const result = document.getElementById('add-test-result');
  const testBtn = addService.querySelector('button[formaction="/ui/config/test"]');

  if (form && result && testBtn) {
    const say = (kind, text) => {
      const box = document.createElement('div');
      box.className = 'msg ' + kind;
      box.style.margin = '.75rem 0 0';
      box.textContent = text;
      result.replaceChildren(box);
    };

    testBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      testBtn.disabled = true;
      say('ok', 'Testing…');

      try {
        const res = await fetch('/ui/config/test', {
          method: 'POST',
          headers: { accept: 'application/json' },
          body: new FormData(form),
        });
        const d = await res.json();

        if (d.ok) {
          say('ok', 'Reachable in ' + d.latency_ms + ' ms' +
            (d.version ? ' — version ' + d.version : '') +
            '. Not added yet: this tested the fields as they are on screen.');
        } else {
          const err = d.error || d;
          say('err', (err.detail || 'Unreachable.') + (err.remedy ? '\\n' + err.remedy : ''));
        }
      } catch {
        say('err', 'Could not reach this server to run the test. Check that the page is still connected.');
      } finally {
        testBtn.disabled = false;
      }
    });
  }
}

// The log stream polls JSON and builds rows with textContent — never
// innerHTML.
//
// Every other part of this page is server-rendered through an escaping
// template, and that is sound. This one is different in kind: log lines carry
// release names straight from public indexers, which are the most
// attacker-controllable strings in the whole system. Setting
// innerHTML here would make one escaping mistake, anywhere in the server-side
// rendering path, an XSS. Building nodes and assigning textContent makes that
// impossible rather than merely unlikely.
const stream = document.getElementById('log-stream');
if (stream) {
  const follow = document.getElementById('follow');

  const cell = (text, className) => {
    const td = document.createElement('td');
    td.textContent = text == null ? '' : String(text);
    if (className) td.className = className;
    return td;
  };

  const render = (rows) => {
    const table = document.createElement('table');
    const head = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const label of ['Time', 'Level', 'Service', 'Message']) {
      const th = document.createElement('th');
      th.textContent = label;
      hr.appendChild(th);
    }
    head.appendChild(hr);
    table.appendChild(head);

    const body = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.className = 'lvl-' + row.level;
      tr.appendChild(cell(row.at, 'mono'));
      tr.appendChild(cell(row.levelName));
      tr.appendChild(cell(row.service || '—'));
      tr.appendChild(cell(row.msg));
      body.appendChild(tr);
    }
    table.appendChild(body);

    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'note';
      empty.textContent = 'Nothing logged yet for this filter.';
      stream.replaceChildren(empty);
      return;
    }
    stream.replaceChildren(table);
  };

  const tick = async () => {
    if (follow && !follow.checked) return;
    try {
      const res = await fetch(stream.dataset.url, { headers: { accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      // Scroll position is restored because the container scrolls, not the
      // body — otherwise every poll would jump to the top while reading.
      const top = stream.scrollTop;
      render(Array.isArray(data.rows) ? data.rows : []);
      stream.scrollTop = top;
    } catch { /* a poll that fails is retried on the next tick */ }
  };

  const timer = setInterval(tick, 4000);
  window.addEventListener('beforeunload', () => clearInterval(timer));
}
`;
