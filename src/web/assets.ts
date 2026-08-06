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

export const CSS = `
:root {
  --bg: #12141a; --panel: #1a1d26; --panel-2: #21252f; --line: #2c313d;
  --text: #e6e8ee; --dim: #9aa2b1; --accent: #6ea8fe;
  --ok: #4ade80; --warn: #fbbf24; --bad: #f87171;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f6f7f9; --panel: #fff; --panel-2: #f0f2f5; --line: #d9dee7;
    --text: #1a1d26; --dim: #5b6472; --accent: #1a56db;
  }
}
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
main { max-width: 1100px; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
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
.dot { width: .6rem; height: .6rem; border-radius: 50%; display: inline-block; flex: none; }
.dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); } .dot.off { background: var(--dim); }
.remedy {
  margin-top: .6rem; padding: .5rem .6rem; border-left: 3px solid var(--warn);
  background: var(--panel-2); border-radius: 0 6px 6px 0; font-size: .85rem; color: var(--text);
}
table { width: 100%; border-collapse: collapse; font-size: .87rem; }
th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
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
.token { display: flex; gap: .5rem; align-items: center; }
.token input { flex: 1; font-family: var(--mono); font-size: .8rem; }
`;

/**
 * Two behaviours, both of which genuinely need a client: copying a secret to
 * the clipboard, and refreshing the log table without losing scroll position.
 * Everything else is a form post and a server render.
 */
export const JS = `
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.copy);
  if (!input) return;
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    // Clipboard API needs a secure context, and this is deliberately served
    // over http on a LAN — so fall back to selecting the text for the user.
    input.removeAttribute('readonly');
    input.select();
    input.setAttribute('readonly', '');
  }
  const original = btn.textContent;
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = original; }, 1200);
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

// The log stream polls JSON and builds rows with textContent — never
// innerHTML.
//
// Every other part of this page is server-rendered through an escaping
// template, and that is sound. This one is different in kind: log lines carry
// release names straight from public indexers, which are the most
// attacker-controllable strings in the whole system (design spec §11). Setting
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
