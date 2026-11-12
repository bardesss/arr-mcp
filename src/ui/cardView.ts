import { IMAGE_HOSTS } from '../core/display.ts';

/**
 * The MCP Apps view behind `ui://arr-mcp/media-cards.html`: one self-contained
 * page, no framework and no bundle, that renders the `cards` a tool put in
 * `structuredContent`.
 *
 * It speaks the MCP Apps postMessage protocol directly (JSON-RPC 2.0 to
 * `window.parent`): `ui/initialize`, then `ui/notifications/initialized`, then
 * it waits for `ui/notifications/tool-result`. The official
 * `@modelcontextprotocol/ext-apps` client is half a megabyte bundled, for the
 * four messages this needs. `callTool` is wired but unused: v1 cards are
 * read-only, and a later version can ask the host to run a tool through it.
 *
 * Every string from a service is fenced in the payload and is unfenced here,
 * then written with `textContent`, never as markup. Image URLs are checked
 * against the same hosts the server allows and the CSP declares.
 *
 * Written with `String.raw` so the page's own regular expressions keep their
 * backslashes, which means no `${…}` anywhere in it except the one below.
 */
export const CARD_VIEW_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>arr-mcp media cards</title>
<style>
:root {
  --bg: var(--color-background-primary, #ffffff);
  --bg-2: var(--color-background-secondary, #f3f3f1);
  --fg: var(--color-text-primary, #1d1d1b);
  --fg-2: var(--color-text-secondary, #5f5e5a);
  --line: var(--color-border-tertiary, rgba(0, 0, 0, 0.1));
  --radius: var(--border-radius-lg, 12px);
  --radius-sm: var(--border-radius-sm, 6px);
  --font: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
  --ok: #2f9e44;
  --wait: #1c7ed6;
  --dl: #e8590c;
  --off: #868e96;
  --none: #adb5bd;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: var(--color-background-primary, #1f1e1d);
    --bg-2: var(--color-background-secondary, #2b2a28);
    --fg: var(--color-text-primary, #f3f2ee);
    --fg-2: var(--color-text-secondary, #b4b2a9);
    --line: var(--color-border-tertiary, rgba(255, 255, 255, 0.12));
  }
}
:root[data-theme="dark"] {
  --bg: var(--color-background-primary, #1f1e1d);
  --bg-2: var(--color-background-secondary, #2b2a28);
  --fg: var(--color-text-primary, #f3f2ee);
  --fg-2: var(--color-text-secondary, #b4b2a9);
  --line: var(--color-border-tertiary, rgba(255, 255, 255, 0.12));
}
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; color: var(--fg); font: 14px/1.45 var(--font); }
#root { padding: 2px; }
.empty { color: var(--fg-2); padding: 12px 4px; }

.detail { position: relative; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg); }
.detail .backdrop { position: absolute; inset: -24px; background-size: cover; background-position: center; filter: blur(22px) saturate(1.1); opacity: 0.32; }
.detail .scrim { position: absolute; inset: 0; background: linear-gradient(90deg, var(--bg) 0%, transparent 100%); opacity: 0.55; }
.detail .body { position: relative; display: flex; gap: 16px; padding: 16px; }
.detail .poster { flex: 0 0 140px; }
.detail .info { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 8px; }
.detail h1 { margin: 0; font-size: 20px; line-height: 1.25; font-weight: 600; }
.detail h1 .year { color: var(--fg-2); font-weight: 400; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line); background: var(--bg-2); white-space: nowrap; }
.badge.status { color: #fff; border-color: transparent; background: var(--status); }
.meta { color: var(--fg-2); font-size: 13px; }
.overview { margin: 0; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.progress { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--fg-2); }
.progress .bar { flex: 1; max-width: 220px; height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
.progress .fill { height: 100%; background: var(--status); }
.links { display: flex; gap: 12px; font-size: 13px; }
.links a { color: var(--fg); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }

.art { position: relative; aspect-ratio: 2 / 3; width: 100%; border-radius: var(--radius-sm); overflow: hidden; background: var(--bg-2); border: 1px solid var(--line); }
.art img { display: block; width: 100%; height: 100%; object-fit: cover; }
.art .fallback { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 10px; text-align: center; color: var(--fg-2); font-size: 13px; font-weight: 600; line-height: 1.3; background: linear-gradient(160deg, var(--bg-2), var(--bg)); }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 12px; }
.tile { min-width: 0; }
.tile .state { position: absolute; left: 6px; bottom: 6px; max-width: calc(100% - 12px); display: flex; align-items: center; gap: 5px; padding: 2px 8px 2px 6px; border-radius: 999px; background: rgba(0, 0, 0, 0.68); color: #fff; font-size: 11px; font-weight: 500; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
.tile .state::before { content: ""; flex: 0 0 7px; height: 7px; border-radius: 50%; background: var(--status); }
.tile .name { margin-top: 6px; font-size: 13px; font-weight: 600; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.tile .sub { font-size: 12px; color: var(--fg-2); }
.more { margin-top: 10px; font-size: 12px; color: var(--fg-2); }

@media (max-width: 420px) {
  .detail .body { flex-direction: column; }
  .detail .poster { flex-basis: auto; width: 120px; }
}
</style>
</head>
<body>
<div id="root"><div class="empty">Waiting for results…</div></div>
<script>
(function () {
  "use strict";

  var IMAGE_HOSTS = __IMAGE_HOSTS__;
  var STATUS = {
    downloaded: { label: "Available", color: "var(--ok)" },
    monitored: { label: "Monitored", color: "var(--wait)" },
    downloading: { label: "Downloading", color: "var(--dl)" },
    unmonitored: { label: "Unmonitored", color: "var(--off)" },
    absent: { label: "Not in library", color: "var(--none)" }
  };

  // --- MCP Apps bridge: JSON-RPC 2.0 over postMessage ---------------------
  var nextId = 1;
  var pending = {};
  function send(message) { window.parent.postMessage(message, "*"); }
  function request(method, params) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      send({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    });
  }
  function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params || {} }); }
  /** For a later version's actions (search, monitor): the host runs the tool. Unused in v1. */
  function callTool(name, args) { return request("tools/call", { name: name, arguments: args || {} }); }
  window.arrMcpCards = { callTool: callTool };

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined && msg.method === undefined) {
      var p = pending[msg.id];
      if (!p) return;
      delete pending[msg.id];
      if (msg.error) p.reject(msg.error); else p.resolve(msg.result);
      return;
    }
    if (msg.method === "ui/notifications/tool-result") { render(msg.params || {}); return; }
    if (msg.method === "ui/notifications/host-context-changed") { applyContext(msg.params || {}); return; }
    if (msg.id !== undefined) {
      // ui/resource-teardown and ping both want an empty answer; nothing else is served.
      if (msg.method === "ui/resource-teardown" || msg.method === "ping") send({ jsonrpc: "2.0", id: msg.id, result: {} });
      else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
    }
  });

  function applyContext(ctx) {
    var root = document.documentElement;
    if (ctx.theme === "light" || ctx.theme === "dark") root.setAttribute("data-theme", ctx.theme);
    var vars = ctx.styles && ctx.styles.variables;
    if (vars) for (var key in vars) if (/^--[a-z0-9-]+$/.test(key) && typeof vars[key] === "string") root.style.setProperty(key, vars[key]);
  }

  var lastHeight = 0;
  function reportSize() {
    var height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (height === lastHeight) return;
    lastHeight = height;
    notify("ui/notifications/size-changed", { height: height });
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(reportSize).observe(document.documentElement);

  // --- rendering -------------------------------------------------------------
  function unfence(value) {
    if (typeof value !== "string") return "";
    return value.replace(/<<untrusted:[^>]*>>([\s\S]*?)<<\/(?:untrusted)?>>/g, function (_m, inner) {
      return inner.replace(/\\u003c/g, "<").replace(/\\u003e/g, ">");
    });
  }
  function safeImage(value) {
    if (typeof value !== "string") return null;
    try {
      var url = new URL(value);
      return url.protocol === "https:" && IMAGE_HOSTS.indexOf(url.hostname) !== -1 ? url.href : null;
    } catch (e) { return null; }
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function artwork(card, title) {
    var box = el("div", "art");
    var fallback = el("div", "fallback", title);
    var src = safeImage(card.poster);
    if (!src) { box.appendChild(fallback); return box; }
    var img = el("img");
    img.alt = title;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = function () { img.remove(); box.appendChild(fallback); };
    img.src = src;
    box.appendChild(img);
    return box;
  }
  function runtime(minutes) {
    var h = Math.floor(minutes / 60), m = minutes % 60;
    return h === 0 ? m + " min" : m === 0 ? h + "h" : h + "h " + m + "m";
  }
  function statusOf(card) { return STATUS[card.status] || STATUS.absent; }
  function openLink(url) {
    request("ui/open-link", { url: url }).catch(function () { window.open(url, "_blank", "noopener"); });
  }

  function detail(card) {
    var title = unfence(card.title);
    var status = statusOf(card);
    var root = el("div", "detail");
    root.style.setProperty("--status", status.color);
    var backdrop = safeImage(card.backdrop) || safeImage(card.poster);
    if (backdrop) {
      var bg = el("div", "backdrop");
      bg.style.backgroundImage = 'url("' + backdrop + '")';
      root.appendChild(bg);
      root.appendChild(el("div", "scrim"));
    }
    var body = el("div", "body");
    var poster = el("div", "poster");
    poster.appendChild(artwork(card, title));
    body.appendChild(poster);

    var info = el("div", "info");
    var h1 = el("h1", null, title);
    if (card.year) { h1.appendChild(document.createTextNode(" ")); h1.appendChild(el("span", "year", "(" + card.year + ")")); }
    info.appendChild(h1);

    var badges = el("div", "badges");
    badges.appendChild(el("span", "badge", card.type === "series" ? "Series" : "Movie"));
    badges.appendChild(el("span", "badge status", status.label));
    if (card.qualityProfile) badges.appendChild(el("span", "badge", unfence(card.qualityProfile)));
    info.appendChild(badges);

    var meta = [];
    if (card.type === "movie" && card.runtimeMinutes) meta.push(runtime(card.runtimeMinutes));
    if (card.type === "series" && card.seasonCount) meta.push(card.seasonCount + (card.seasonCount === 1 ? " season" : " seasons"));
    if (card.genres && card.genres.length) meta.push(card.genres.map(unfence).join(", "));
    if (meta.length) info.appendChild(el("div", "meta", meta.join(" · ")));

    if (card.type === "series" && card.episodes && card.episodes.aired > 0) {
      var progress = el("div", "progress");
      var bar = el("div", "bar");
      var fill = el("div", "fill");
      var onDisk = Math.min(card.episodes.onDisk, card.episodes.aired);
      fill.style.width = Math.round((onDisk / card.episodes.aired) * 100) + "%";
      bar.appendChild(fill);
      progress.appendChild(bar);
      progress.appendChild(el("span", null, onDisk + " / " + card.episodes.aired + " episodes"));
      info.appendChild(progress);
    }

    if (card.overview) info.appendChild(el("p", "overview", unfence(card.overview)));

    var links = card.links || {};
    if (links.tmdb || links.imdb) {
      var row = el("div", "links");
      [["TMDB", links.tmdb], ["IMDb", links.imdb]].forEach(function (pair) {
        if (!pair[1]) return;
        var a = el("a", null, pair[0]);
        a.href = pair[1];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.addEventListener("click", function (e) { e.preventDefault(); openLink(pair[1]); });
        row.appendChild(a);
      });
      info.appendChild(row);
    }
    body.appendChild(info);
    root.appendChild(body);
    return root;
  }

  function tile(card) {
    var title = unfence(card.title);
    var status = statusOf(card);
    var node = el("div", "tile");
    node.style.setProperty("--status", status.color);
    node.title = title + (card.year ? " (" + card.year + ")" : "") + ": " + status.label;
    var art = artwork(card, title);
    art.appendChild(el("span", "state", status.label));
    node.appendChild(art);
    node.appendChild(el("div", "name", title));
    node.appendChild(el("div", "sub", [card.year, card.type === "series" ? "Series" : "Movie"].filter(Boolean).join(" · ")));
    return node;
  }

  function render(result) {
    var root = document.getElementById("root");
    root.textContent = "";
    // In the result's _meta, never structuredContent: some clients hand that to the model.
    var cards = result._meta && result._meta["arr-mcp/cards"];
    var items = cards && Array.isArray(cards.items) ? cards.items : [];
    if (result.isError || items.length === 0) {
      root.appendChild(el("div", "empty", result.isError ? "No card to show." : "No film or series in this answer."));
    } else if (cards.view === "detail") {
      root.appendChild(detail(items[0]));
    } else {
      var grid = el("div", "grid");
      items.forEach(function (card) { grid.appendChild(tile(card)); });
      root.appendChild(grid);
      if (cards.total > items.length) root.appendChild(el("div", "more", "Showing " + items.length + " of " + cards.total + "."));
    }
    requestAnimationFrame(reportSize);
  }
  window.arrMcpCards.render = render;

  request("ui/initialize", {
    appInfo: { name: "arr-mcp media cards", version: "1" },
    appCapabilities: {},
    protocolVersion: "2026-01-26"
  }).then(function (init) {
    applyContext((init && init.hostContext) || {});
    notify("ui/notifications/initialized", {});
  }).catch(function () { /* Not inside an MCP Apps host: nothing to talk to. */ });
})();
</script>
</body>
</html>
`.replace('__IMAGE_HOSTS__', JSON.stringify(IMAGE_HOSTS));
