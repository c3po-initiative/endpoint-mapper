// Runs in the page's own JavaScript world. Wraps fetch and XMLHttpRequest to see each API call,
// and reduces request/response JSON to its SHAPE (keys and value types). Values never leave the page.
// It stays dormant until relay.js confirms this site is on the extension's list.
(() => {
  if (window.__endpointMapperHooked) return;
  window.__endpointMapperHooked = true;

  let mode = "pending"; // pending -> on | off
  const queue = [];
  let queuedBytes = 0;

  const looksLikeId = (k) => /^\d+$/.test(k) || (k.length >= 16 && /\d/.test(k) && !/\s/.test(k));

  function shape(v, d = 0) {
    if (v === null) return "null";
    if (Array.isArray(v)) {
      if (!v.length) return [];
      let acc;
      for (const x of v.slice(0, 20)) acc = merge(acc, shape(x, d + 1));
      return [acc];
    }
    if (typeof v === "object") {
      if (d > 12) return "object";
      const o = {};
      for (const k of Object.keys(v).slice(0, 300)) {
        const key = looksLikeId(k) ? "{id}" : k;
        o[key] = merge(o[key], shape(v[k], d + 1));
      }
      return o;
    }
    if (typeof v === "string") {
      if (/^\d{4}-\d\d-\d\d(T|$)/.test(v)) return "date-time";
      if (/^-?\d+(\.\d+)?$/.test(v)) return "numeric-string";
      return "string";
    }
    return typeof v; // number | boolean
  }

  function merge(a, b) {
    if (a === undefined) return b;
    if (b === undefined) return a;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (!a.length) return b;
      if (!b.length) return a;
      return [merge(a[0], b[0])];
    }
    const ao = a && typeof a === "object" && !Array.isArray(a);
    const bo = b && typeof b === "object" && !Array.isArray(b);
    if (ao && bo) {
      const o = { ...a };
      for (const k of Object.keys(b)) o[k] = merge(o[k], b[k]);
      return o;
    }
    if (a === b) return a;
    if (a === "null") return b;
    if (b === "null") return a;
    if (typeof a === "string" && typeof b === "string") {
      const set = new Set([...a.split("|"), ...b.split("|")]);
      return [...set].sort().join("|");
    }
    return ao ? a : b;
  }

  function parseBody(body) {
    if (body == null) return null;
    if (typeof body === "string") {
      try { return shape(JSON.parse(body)); } catch {}
      if (body.includes("=")) {
        try { const o = {}; for (const [k] of new URLSearchParams(body)) o[k] = "string"; return { "(form)": o }; } catch {}
      }
      return "text";
    }
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const o = {}; for (const [k] of body) o[k] = "string"; return { "(form)": o };
    }
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      const o = {}; for (const [k] of body) o[k] = "string"; return { "(form)": o };
    }
    return "binary";
  }

  function emit(item) {
    let req = null, res = null, contentType = item.contentType || "";
    try { req = parseBody(item.reqBody); } catch {}
    if (item.text != null) {
      try { res = shape(JSON.parse(item.text)); } catch { res = item.text.length ? "non-json" : null; }
    }
    window.postMessage({ __endpointMapper: 1, method: item.method, url: item.url, status: item.status,
      kind: item.kind, req, res, contentType }, location.origin);
  }

  function handle(item) {
    if (mode === "off") return;
    if (mode === "on") return emit(item);
    const size = (item.text ? item.text.length : 0) + (typeof item.reqBody === "string" ? item.reqBody.length : 0);
    if (queue.length < 50 && queuedBytes + size < 5e6) { queue.push(item); queuedBytes += size; }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__endpointMapperMode === undefined) return;
    mode = e.data.__endpointMapperMode ? "on" : "off";
    const q = queue.splice(0); queuedBytes = 0;
    if (mode === "on") q.forEach(emit);
  });

  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return String(u); } };
  const wantText = (ct) => !ct || /json|text|javascript/i.test(ct);

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const isReq = typeof Request !== "undefined" && input instanceof Request;
      const method = String((init && init.method) || (isReq ? input.method : "GET")).toUpperCase();
      const url = abs(isReq ? input.url : input);
      const reqBody = init && init.body !== undefined ? init.body : null;
      const p = origFetch.apply(this, arguments);
      if (mode !== "off") {
        p.then((r) => {
          const ct = r.headers.get("content-type") || "";
          if (!wantText(ct)) return handle({ method, url, status: r.status, kind: "fetch", reqBody, text: null, contentType: ct });
          r.clone().text().then((t) => handle({ method, url, status: r.status, kind: "fetch", reqBody, text: t.length < 2e7 ? t : null, contentType: ct }), () => {});
        }, () => handle({ method, url, status: "ERR", kind: "fetch", reqBody, text: null }));
      }
      return p;
    };
  }

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__em = { method: String(m).toUpperCase(), url: abs(u) };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const x = this;
    if (x.__em && mode !== "off") {
      x.addEventListener("loadend", () => {
        let text = null, ct = "";
        try { ct = x.getResponseHeader("content-type") || ""; } catch {}
        try {
          if (wantText(ct)) {
            if (x.responseType === "" || x.responseType === "text") text = x.responseText;
            else if (x.responseType === "json") text = JSON.stringify(x.response);
          }
        } catch {}
        handle({ method: x.__em.method, url: x.__em.url, status: x.status || "ERR", kind: "xhr", reqBody: body ?? null, text, contentType: ct });
      });
    }
    return XS.apply(this, arguments);
  };
})();
