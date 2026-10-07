// Isolated-world bridge: tells hook.js whether this site is being mapped, and forwards
// its observations (method, URL, status, shapes — never values) to the background worker.
(async () => {
  const s = await chrome.storage.local.get(["domains", "recording"]);
  const domains = s.domains || [];
  const host = location.hostname;
  const listed = domains.some((d) => host === d || host.endsWith("." + d));
  const on = listed && (s.recording ?? true);
  window.postMessage({ __endpointMapperMode: on }, location.origin);
  if (!on) return;

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__endpointMapper !== 1) return;
    const d = e.data;
    try {
      chrome.runtime.sendMessage({
        type: "pageReq", method: d.method, url: d.url, status: d.status, kind: d.kind,
        req: d.req, res: d.res, contentType: d.contentType, page: location.pathname,
      }).catch(() => {});
    } catch {}
  });
})();
