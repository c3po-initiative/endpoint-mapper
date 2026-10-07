const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

async function addDomain(raw) {
  let d = raw.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  if (!d || !d.includes(".")) { $("msg").textContent = "Enter a domain like mychart.example.org"; return; }
  await send({ type: "addDomain", domain: d });
  $("msg").textContent = "Added. Reload the site's tab so capture starts on it.";
  render();
}

async function render() {
  const s = await chrome.storage.local.get(["domains", "recording", "endpoints", "pages", "mark", "diag"]);
  const dg = s.diag || { net: 0, page: 0 };
  $("diag").textContent = `Signals received: ${dg.page} from page, ${dg.net} from network`;
  const eps = Object.values(s.endpoints || {});
  const mark = s.mark || 0;
  $("sEndpoints").textContent = eps.length;
  $("sNew").textContent = mark ? eps.filter((e) => e.firstSeen > mark).length : "–";
  $("sPages").textContent = Object.keys(s.pages || {}).length;

  const rec = s.recording ?? true;
  $("dot").classList.toggle("on", rec);
  $("recLabel").textContent = rec ? "Recording" : "Paused";
  $("recBtn").textContent = rec ? "Pause" : "Resume";
  $("recBtn").onclick = async () => { await send({ type: "setRecording", value: !rec }); render(); };

  const ul = $("domains");
  ul.innerHTML = "";
  const domains = s.domains || [];
  if (!domains.length) ul.innerHTML = '<li class="muted">No sites yet</li>';
  for (const d of domains) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "mono";
    name.textContent = d;
    li.appendChild(name);
    const btns = document.createElement("span");
    const x = document.createElement("button");
    x.textContent = "✕";
    x.title = "Stop mapping this site";
    x.onclick = async () => {
      await send({ type: "removeDomain", domain: d });
      render();
    };
    btns.appendChild(x);
    li.appendChild(btns);
    ul.appendChild(li);
  }
}

$("addBtn").onclick = () => addDomain($("domainInput").value);
$("domainInput").onkeydown = (e) => { if (e.key === "Enter") addDomain(e.target.value); };
$("addCurrent").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.startsWith("https://")) { $("msg").textContent = "Open the site in this tab first."; return; }
  addDomain(new URL(tab.url).hostname);
};
$("markBtn").onclick = async () => { await send({ type: "mark" }); $("msg").textContent = "Marked. New endpoints from here on are highlighted."; render(); };
$("openBtn").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });

chrome.storage.onChanged.addListener(render);
render();
