const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
let S = { endpoints: {}, pages: {}, jsPaths: {}, jsUrls: [], domains: [], mark: 0 };
let sortKey = "path", sortDir = 1;
const openRows = new Set();
const keyOf = (e) => `${e.method} ${e.host}${e.path}`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  return new Date(t).toLocaleTimeString();
};

function jsMatcher(p) {
  const trailing = p.endsWith("/");
  const body = p.replace(/\/$/, "").replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{[^}]*\\?\}/g, "[^/]+");
  return new RegExp(body + (trailing ? "(/|$)" : "$"), "i");
}

function jsOnly() {
  const paths = Object.values(S.endpoints).map((e) => e.path);
  return Object.entries(S.jsPaths)
    .filter(([p]) => { const re = jsMatcher(p); return !paths.some((x) => re.test(x)); })
    .map(([p, v]) => ({ path: p, sources: v.sources }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function render() {
  const eps = Object.values(S.endpoints);
  const mark = S.mark || 0;
  $("sub").textContent = S.domains.length ? "Mapping " + S.domains.join(", ") : "No sites added yet — add one from the toolbar popup";
  $("tEndpoints").textContent = eps.length;
  $("tRequests").textContent = eps.reduce((a, e) => a + e.count, 0);
  $("tNew").textContent = mark ? eps.filter((e) => e.firstSeen > mark).length : "–";
  $("tPages").textContent = Object.keys(S.pages).length;
  const jo = jsOnly();
  $("tJsOnly").textContent = Object.keys(S.jsPaths).length ? jo.length : "–";

  // Method filter options
  const sel = $("method"), cur = sel.value;
  const methods = [...new Set(eps.map((e) => e.method))].sort();
  sel.innerHTML = '<option value="">All methods</option>' + methods.map((m) => `<option${m === cur ? " selected" : ""}>${m}</option>`).join("");

  // Endpoints
  const q = $("q").value.toLowerCase();
  const onlyNew = $("onlyNew").checked;
  let rows = eps.filter((e) =>
    (!cur || e.method === cur) &&
    (!onlyNew || (mark && e.firstSeen > mark)) &&
    (!q || [e.host + e.path, e.params.join(" "), e.pages.join(" ")].join(" ").toLowerCase().includes(q)));
  rows.sort((a, b) => {
    let x = a[sortKey], y = b[sortKey];
    if (Array.isArray(x)) { x = x.join(","); y = y.join(","); }
    return (typeof x === "number" ? x - y : String(x).localeCompare(String(y))) * sortDir;
  });
  $("epBody").innerHTML = rows.length ? rows.map((e) => {
    const isNew = mark && e.firstSeen > mark;
    const st = e.statuses.map((s) => `<span class="pill${/^[45]|ERR/.test(s) ? " warn" : ""}">${esc(s)}</span>`).join(" ");
    const k = keyOf(e), open = openRows.has(k), hasShape = e.req != null || e.res != null;
    const detail = open ? `<tr class="detail"><td colspan="8"><div class="shapes">
        <div><div class="label">Request body shape</div><pre>${esc(e.req != null ? JSON.stringify(e.req, null, 2) : "—")}</pre></div>
        <div><div class="label">Response shape${e.contentType ? " · " + esc(e.contentType) : ""}</div><pre>${esc(e.res != null ? JSON.stringify(e.res, null, 2) : "— (not captured from inside the page yet)")}</pre></div>
      </div></td></tr>` : "";
    return `<tr class="${isNew ? "new" : ""} ep" data-key="${esc(k)}" title="Click to show data shape">
      <td><span class="pill">${esc(e.method)}</span>${hasShape ? ' <span class="pill new" title="Data shape captured">{ }</span>' : ""}</td>
      <td class="mono path"><span class="muted">${esc(e.host)}</span>${esc(e.path)}</td>
      <td class="mono">${esc(e.params.join(", "))}</td>
      <td class="num">${e.count}</td>
      <td>${st}</td>
      <td class="muted">${esc(e.types.join(", "))}</td>
      <td class="mono path muted">${esc(e.firstPage)}</td>
      <td class="muted" title="${new Date(e.firstSeen).toLocaleString()}">${ago(e.firstSeen)}</td>
    </tr>${detail}`;
  }).join("") : `<tr><td colspan="8" class="empty">${eps.length ? "No endpoints match the filter." : "Nothing recorded yet. Add your site in the popup, then browse it."}</td></tr>`;

  document.querySelectorAll("tr.ep").forEach((tr) => tr.onclick = () => {
    const k = tr.dataset.key;
    openRows.has(k) ? openRows.delete(k) : openRows.add(k);
    render();
  });

  // Pages
  const pages = Object.entries(S.pages).sort((a, b) => b[1].newEndpoints - a[1].newEndpoints);
  $("pgBody").innerHTML = pages.length ? pages.map(([p, v]) =>
    `<tr><td class="mono path">${esc(p)}</td><td class="num">${v.visits}</td><td class="num">${v.newEndpoints}</td></tr>`
  ).join("") : '<tr><td colspan="3" class="empty">No pages visited yet.</td></tr>';

  // JS only
  const jq = $("jq").value.toLowerCase();
  const jrows = jo.filter((r) => !jq || r.path.toLowerCase().includes(jq));
  $("jsBody").innerHTML = jrows.length ? jrows.map((r) =>
    `<tr><td class="mono path">${esc(r.path)}</td><td class="mono muted">${esc(r.sources.join(", "))}</td></tr>`
  ).join("") : `<tr><td colspan="2" class="empty">${Object.keys(S.jsPaths).length ? "Every path found in the scripts has been triggered." : `Not scanned yet. ${S.jsUrls.length} script file(s) collected so far — press Scan JavaScript.`}</td></tr>`;
}

async function loadState() {
  const s = await chrome.storage.local.get(["endpoints", "pages", "jsPaths", "jsUrls", "domains", "mark"]);
  S = { endpoints: s.endpoints || {}, pages: s.pages || {}, jsPaths: s.jsPaths || {}, jsUrls: s.jsUrls || [], domains: s.domains || [], mark: s.mark || 0 };
  render();
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

$("jsonBtn").onclick = () => {
  const out = {
    exportedAt: new Date().toISOString(),
    domains: S.domains,
    endpoints: Object.values(S.endpoints).sort((a, b) => (a.host + a.path).localeCompare(b.host + b.path)),
    pages: S.pages,
    inJsNotTriggered: jsOnly(),
  };
  download(`endpoints-${stamp()}.json`, JSON.stringify(out, null, 2), "application/json");
};
// ---- OpenAPI export: turns captured shapes into schemas ----
function toSchema(sh) {
  if (sh === undefined || sh === null) return {};
  if (Array.isArray(sh)) return { type: "array", items: sh.length ? toSchema(sh[0]) : {} };
  if (typeof sh === "object") {
    const keys = Object.keys(sh);
    if (keys.length === 1 && keys[0] === "{id}") return { type: "object", additionalProperties: toSchema(sh["{id}"]) };
    const props = {};
    for (const k of keys) props[k] = k === "{id}" ? undefined : toSchema(sh[k]);
    const o = { type: "object", properties: Object.fromEntries(Object.entries(props).filter(([, v]) => v)) };
    if (keys.includes("{id}")) o.additionalProperties = toSchema(sh["{id}"]);
    return o;
  }
  const types = String(sh).split("|");
  const nullable = types.includes("null");
  const one = (t) => ({
    string: { type: "string" }, "date-time": { type: "string", format: "date-time" },
    "numeric-string": { type: "string", pattern: "^-?\\d+(\\.\\d+)?$" }, number: { type: "number" },
    boolean: { type: "boolean" }, object: { type: "object" }, text: { type: "string" },
    "non-json": { type: "string" }, binary: { type: "string", format: "binary" }, null: {},
  }[t] || { type: "string" });
  const rest = types.filter((t) => t !== "null");
  const base = rest.length > 1 ? { oneOf: rest.map(one) } : one(rest[0] || "string");
  return nullable ? { ...base, nullable: true } : base;
}

function buildOpenApi() {
  const eps = Object.values(S.endpoints).filter((e) => !e.types.every((t) => t === "main_frame" || t === "sub_frame"));
  const hosts = [...new Set(eps.map((e) => e.host))];
  const paths = {};
  for (const e of eps.sort((a, b) => a.path.localeCompare(b.path))) {
    const p = (hosts.length > 1 ? "/" + e.host : "") + e.path.replace(/\{(num|uuid|hex|token)\}/g, (m, t) => `{${t}}`);
    const params = [];
    for (const m of p.matchAll(/\{(\w+)\}/g)) params.push({ name: m[1], in: "path", required: true, schema: { type: "string" } });
    for (const q of e.params) params.push({ name: q, in: "query", schema: { type: "string" } });
    const isJson = !e.contentType || /json/.test(e.contentType);
    const op = {
      operationId: (e.method.toLowerCase() + "_" + e.path.replace(/[^A-Za-z0-9]+/g, "_")).replace(/_+$/, ""),
      summary: `${e.method} ${e.path}`,
      description: `Seen ${e.count}× on: ${e.pages.join(", ")}`,
      tags: [e.path.split("/").filter(Boolean).slice(-2, -1)[0] || "root"],
      responses: {},
    };
    if (params.length) op.parameters = params;
    if (e.req != null && !["GET", "HEAD"].includes(e.method)) {
      const form = e.req && e.req["(form)"];
      op.requestBody = form
        ? { content: { "application/x-www-form-urlencoded": { schema: toSchema(form) } } }
        : { content: { "application/json": { schema: toSchema(e.req) } } };
    }
    for (const st of e.statuses.filter((x) => /^\d+$/.test(x))) {
      op.responses[st] = { description: "Observed" };
      if (e.res != null && /^2/.test(st)) op.responses[st].content = { [isJson ? "application/json" : (e.contentType || "text/plain")]: { schema: toSchema(e.res) } };
    }
    if (!Object.keys(op.responses).length) op.responses.default = { description: "Not observed" };
    (paths[p] = paths[p] || {})[e.method.toLowerCase()] = op;
  }
  return {
    openapi: "3.0.3",
    info: { title: `Observed API: ${hosts.join(", ") || "none"}`, version: new Date().toISOString().slice(0, 10),
      description: "Generated by Endpoint Mapper from observed traffic. Schemas describe structure only; no values were recorded." },
    servers: hosts.length === 1 ? [{ url: "https://" + hosts[0] }] : [],
    paths,
  };
}
$("oasBtn").onclick = () => download(`openapi-${stamp()}.json`, JSON.stringify(buildOpenApi(), null, 2), "application/json");

$("csvBtn").onclick = () => {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [["method", "host", "path", "query_params", "count", "statuses", "types", "first_seen_on", "pages", "first_seen"].join(",")];
  for (const e of Object.values(S.endpoints)) {
    lines.push([e.method, e.host, e.path, e.params.join(" "), e.count, e.statuses.join(" "), e.types.join(" "),
      e.firstPage, e.pages.join(" "), new Date(e.firstSeen).toISOString()].map(q).join(","));
  }
  download(`endpoints-${stamp()}.csv`, lines.join("\n"), "text/csv");
};
$("markBtn").onclick = async () => { await send({ type: "mark" }); $("onlyNew").checked = true; loadState(); };
$("clearBtn").onclick = async () => { if (confirm("Delete everything recorded so far?")) { await send({ type: "clear" }); loadState(); } };
$("scanBtn").onclick = async () => {
  const b = $("scanBtn");
  b.disabled = true; b.textContent = "Scanning…";
  const r = await send({ type: "scanJs" });
  b.disabled = false; b.textContent = "Scan JavaScript";
  await loadState();
  alert(`Scanned ${r.scanned} script file(s)${r.failed ? `, ${r.failed} failed` : ""}. Found ${r.total} path-like strings in total.`);
  document.querySelector('[data-tab="jsonly"]').click();
};

document.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll("section").forEach((s) => s.hidden = s.id !== b.dataset.tab);
});
document.querySelectorAll("th[data-k]").forEach((th) => th.onclick = () => {
  const k = th.dataset.k;
  sortDir = sortKey === k ? -sortDir : (k === "count" || k === "firstSeen" ? -1 : 1);
  sortKey = k;
  render();
});
["q", "jq"].forEach((id) => $(id).oninput = render);
["method", "onlyNew"].forEach((id) => $(id).onchange = render);

let t;
chrome.storage.onChanged.addListener(() => { clearTimeout(t); t = setTimeout(loadState, 250); });
setInterval(render, 15000);
loadState();
