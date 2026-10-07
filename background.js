// Endpoint Mapper — background service worker.
// Records method, host, templated path, query-parameter NAMES, status, and the SHAPE of
// JSON request/response bodies (keys and value types). Never stores values, headers, cookies or tokens.

const STATIC_TYPES = new Set(["image", "imageset", "stylesheet", "font", "media"]);
const STATIC_EXT = /\.(png|jpe?g|gif|svg|ico|webp|bmp|css|woff2?|ttf|eot|otf|map|mp4|mp3|webm|wav)$/i;

let state = null;
let loading = null;
let saveTimer = null;
let badgeTimer = null;
const tabPages = new Map();
let lastPage = "(unknown)";

function load() {
  if (state) return Promise.resolve(state);
  if (!loading) {
    loading = chrome.storage.local
      .get(["domains", "recording", "endpoints", "jsUrls", "jsPaths", "pages", "mark", "diag"])
      .then((s) => {
        state = {
          domains: s.domains || [],
          recording: s.recording ?? true,
          endpoints: s.endpoints || {},
          jsUrls: s.jsUrls || [],
          jsPaths: s.jsPaths || {},
          pages: s.pages || {},
          mark: s.mark || 0,
          diag: s.diag || { net: 0, page: 0 },
        };
        updateBadge(false);
        return state;
      });
  }
  return loading;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set(state), 300);
}

function matchDomain(host, domains) {
  return domains.some((d) => host === d || host.endsWith("." + d));
}

// Replace IDs, UUIDs, hashes and long tokens in path segments with placeholders.
function templ(path) {
  return path
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      let d;
      try { d = decodeURIComponent(seg); } catch { d = seg; }
      if (/^\d+$/.test(d)) return "{num}";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d)) return "{uuid}";
      if (/^[0-9a-f]{16,}$/i.test(d)) return "{hex}";
      if (d.length >= 20 && /\d/.test(d) && /[A-Za-z]/.test(d) && /^[\w\-+=%.~]+$/.test(d)) return "{token}";
      return seg;
    })
    .join("/");
}

// Count a page visit only when the tab's page actually changes.
function enterPage(st, tabId, p) {
  lastPage = p;
  if (tabPages.get(tabId) === p) return;
  tabPages.set(tabId, p);
  touchPage(st, p);
}

async function pageFor(d) {
  if (d.type === "main_frame") return templ(new URL(d.url).pathname);
  if (tabPages.has(d.tabId)) return tabPages.get(d.tabId);
  if (d.tabId >= 0) {
    const t = await chrome.tabs.get(d.tabId).catch(() => null);
    if (t && t.url) {
      try {
        const p = templ(new URL(t.url).pathname);
        tabPages.set(d.tabId, p);
        return p;
      } catch {}
    }
  }
  return lastPage; // service-worker requests: attribute to the page last navigated to
}

// Single-page-app navigations don't produce a main_frame request.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  try {
    const p = templ(new URL(info.url).pathname);
    load().then((st) => {
      if (!st.recording || !matchDomain(new URL(info.url).hostname, st.domains)) {
        tabPages.set(tabId, p);
        return;
      }
      enterPage(st, tabId, p);
      save();
    });
  } catch {}
});
chrome.tabs.onRemoved.addListener((tabId) => tabPages.delete(tabId));

function touchPage(st, p) {
  const pg = st.pages[p] || (st.pages[p] = { visits: 0, newEndpoints: 0, firstSeen: Date.now() });
  pg.visits++;
  return pg;
}

// Merge two shapes (as produced by hook.js) into one.
function mergeShape(a, b) {
  if (a === undefined || a === null) return b ?? a;
  if (b === undefined || b === null) return a;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (!a.length) return b;
    if (!b.length) return a;
    return [mergeShape(a[0], b[0])];
  }
  const ao = typeof a === "object" && !Array.isArray(a);
  const bo = typeof b === "object" && !Array.isArray(b);
  if (ao && bo) {
    const o = { ...a };
    for (const k of Object.keys(b)) o[k] = mergeShape(o[k], b[k]);
    return o;
  }
  if (a === b) return a;
  if (a === "null") return b;
  if (b === "null") return a;
  if (typeof a === "string" && typeof b === "string") {
    return [...new Set([...a.split("|"), ...b.split("|")])].sort().join("|");
  }
  return ao ? a : b;
}

// Common recording path for both sources:
//  "net"  = chrome.webRequest (sees every request, no bodies)
//  "page" = hook.js inside the page (sees fetch/XHR plus request/response shapes)
async function record(src, r) {
  const st = await load();
  if (!st.recording) return;
  let u;
  try { u = new URL(r.url); } catch { return; }
  if (!/^https?:$/.test(u.protocol)) return;
  if (!matchDomain(u.hostname, st.domains)) return;
  st.diag = st.diag || { net: 0, page: 0 };
  st.diag[src]++;

  if (r.type === "script" || /\.m?js$/i.test(u.pathname)) {
    const clean = r.url.split("#")[0];
    if (!st.jsUrls.includes(clean)) { st.jsUrls.push(clean); save(); }
    return;
  }
  if (STATIC_TYPES.has(r.type) || STATIC_EXT.test(u.pathname)) return;

  const page = r.page;
  const path = templ(u.pathname);
  const key = `${r.method} ${u.host}${path}`;
  const now = Date.now();
  let e = st.endpoints[key];
  const isNew = !e;
  if (isNew) {
    e = st.endpoints[key] = {
      method: r.method, host: u.host, path,
      params: [], types: [], statuses: [], pages: [],
      count: 0, counts: { net: 0, page: 0 }, firstSeen: now, lastSeen: now, firstPage: page,
    };
    const pg = st.pages[page] || (st.pages[page] = { visits: 0, newEndpoints: 0, firstSeen: now });
    pg.newEndpoints++;
  }
  e.counts = e.counts || { net: 0, page: 0 };
  e.counts[src]++;
  e.count = Math.max(e.counts.net, e.counts.page);
  e.lastSeen = now;
  for (const k of u.searchParams.keys()) if (!e.params.includes(k)) e.params.push(k);
  if (r.type && !e.types.includes(r.type)) e.types.push(r.type);
  const s = String(r.status);
  if (!e.statuses.includes(s)) e.statuses.push(s);
  if (!e.pages.includes(page) && e.pages.length < 10) e.pages.push(page);
  if (r.req !== undefined && r.req !== null) e.req = mergeShape(e.req, r.req);
  if (r.res !== undefined && r.res !== null) e.res = mergeShape(e.res, r.res);
  if (r.contentType) e.contentType = r.contentType.split(";")[0];

  save();
  if (isNew) updateBadge(true);
}

async function handleNet(d, status) {
  // Skip the extension's own requests (JS scanning). Requests from the site's own
  // service worker have tabId -1 but are kept.
  if (d.initiator && d.initiator.startsWith("chrome-extension://")) return;
  const st = await load();
  let page = "(unknown)";
  try {
    page = await pageFor(d);
    if (d.type === "main_frame" && st.recording && matchDomain(new URL(d.url).hostname, st.domains)) enterPage(st, d.tabId, page);
  } catch {}
  record("net", { url: d.url, method: d.method, status, type: d.type, page });
}

function updateBadge(flash) {
  if (!state) return;
  const n = Object.keys(state.endpoints).length;
  chrome.action.setBadgeText({ text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ color: flash ? "#1f9d55" : "#5b6472" });
  if (flash) {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => chrome.action.setBadgeBackgroundColor({ color: "#5b6472" }), 1500);
  }
}

const FILTER = { urls: ["<all_urls>"] };
chrome.webRequest.onCompleted.addListener((d) => { handleNet(d, d.statusCode); }, FILTER);
chrome.webRequest.onErrorOccurred.addListener((d) => {
  if (d.error === "net::ERR_ABORTED") return;
  handleNet(d, "ERR");
}, FILTER);

// ---- JavaScript scanning: find endpoint-looking string literals in the site's scripts ----

function extractPaths(txt) {
  const out = new Set();
  const re = /["'`]((?:\/|api\/)[A-Za-z][\w\-]*(?:\/[\w\-{}$.]*)+)["'`]/g;
  let m;
  while ((m = re.exec(txt))) {
    let p = m[1];
    if (p.includes("//")) continue;
    if (STATIC_EXT.test(p) || /\.(js|mjs|html?|json|txt|xml)$/i.test(p)) continue;
    if (p.length < 6 || p.length > 200) continue;
    if (!p.startsWith("/")) p = "/" + p;
    p = templ(p.replace(/\$\{[^}]*\}/g, "{var}"));
    out.add(p);
  }
  return out;
}

async function scanJs() {
  const st = await load();
  let scanned = 0, failed = 0;
  for (const url of st.jsUrls) {
    try {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) { failed++; continue; }
      const txt = await r.text();
      scanned++;
      const file = url.split("?")[0].split("/").pop() || url;
      for (const p of extractPaths(txt)) {
        const e = st.jsPaths[p] || (st.jsPaths[p] = { sources: [] });
        if (!e.sources.includes(file) && e.sources.length < 5) e.sources.push(file);
      }
    } catch { failed++; }
  }
  save();
  return { scanned, failed, total: Object.keys(st.jsPaths).length };
}

// ---- Messages from popup and dashboard ----

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    const st = await load();
    switch (msg.type) {
      case "addDomain": {
        const d = msg.domain.trim().toLowerCase();
        if (d && !st.domains.includes(d)) st.domains.push(d);
        break;
      }
      case "removeDomain":
        st.domains = st.domains.filter((d) => d !== msg.domain);
        break;
      case "setRecording":
        st.recording = !!msg.value;
        break;
      case "mark":
        st.mark = Date.now();
        break;
      case "clear":
        st.endpoints = {}; st.jsUrls = []; st.jsPaths = {}; st.pages = {}; st.mark = 0; st.diag = { net: 0, page: 0 };
        updateBadge(false);
        break;
      case "pageReq":
        record("page", {
          url: msg.url, method: msg.method, status: msg.status,
          type: msg.kind === "xhr" ? "xmlhttprequest" : "fetch",
          page: templ(msg.page || "/"), req: msg.req, res: msg.res, contentType: msg.contentType,
        });
        reply({ ok: true });
        return;
      case "scanJs":
        reply(await scanJs());
        return;
    }
    await chrome.storage.local.set(state);
    reply({ ok: true });
  })();
  return true;
});

load();
