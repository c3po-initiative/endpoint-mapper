# Endpoint Mapper

A Chrome extension (Manifest V3) that maps the API endpoints a website calls while you browse it. For every endpoint it records the method, the path, the query parameter names, the status codes, the page it was triggered from and the **shape** of the JSON request and response bodies: field names and value types, never the values themselves. The result can be exported as an OpenAPI 3.0 document, JSON or CSV.

It works on any HTTPS site, but it was built to answer one question for [dhroxy](https://github.com/c3po-initiative/Dhroxy): *which endpoints does sundhed.dk actually have, and what do they return?*

## Why it matters for dhroxy

dhroxy exposes a read-only FHIR R4 API over sundhed.dk. It works by calling a fixed set of sundhed.dk's internal endpoints (labsvar, e-journal, medicinkort, vaccination, billedbeskrivelser, aftaler and so on) and mapping each response into FHIR resources. Those endpoints are undocumented. Someone had to find each one, work out its parameters and learn the structure of its JSON before a mapper could be written.

Endpoint Mapper turns that manual DevTools work into a repeatable inventory:

- **Find endpoints dhroxy doesn't map yet.** Browse a part of the portal dhroxy doesn't cover. Every API call the page makes is listed with the page that triggered it, so a candidate for a new FHIR resource is one click away.
- **Write mappers against real structure.** Click an endpoint to see the merged shape of its responses across every call you made, including nullable fields and fields that only appear in some records. The OpenAPI export turns those shapes into JSON schemas you can read next to dhroxy's mapping code or generate types from.
- **Check coverage.** The *Pages* tab shows which parts of the portal still reveal new endpoints when you visit them, and the *In JS, not triggered* tab lists path-like strings in sundhed.dk's own scripts that no captured request has matched. Those point to features you haven't clicked yet.
- **Spot upstream changes.** When a dhroxy mapper starts failing, map the same pages again and compare the exported OpenAPI with an earlier one to see which fields or paths moved.
- **Share findings safely.** Exports contain structure, not health data, so an endpoint map can go into an issue or a pull request on dhroxy without leaking anyone's records. (See the caveats under [Privacy](#privacy) and check exports before sharing.)

In short: dhroxy is the *consumer* of sundhed.dk's endpoints; Endpoint Mapper is how you *discover and describe* them.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.

## Use

1. Open the site you want to map (for example `https://www.sundhed.dk`) and log in as usual.
2. Click the extension icon → **+ Add current site**, or type a domain. A domain also covers its subdomains, so `sundhed.dk` covers `www.sundhed.dk`.
3. **Reload the tab** so capture starts on it.
4. Click through the site normally. The badge counts unique endpoints and flashes green when a new one appears.
5. Optional: press **Mark now** before exploring a new area. Endpoints first seen after the mark are highlighted, and *Only new since mark* filters to them.
6. Open the **dashboard** to browse endpoints, pages and script findings, press **Scan JavaScript** to search the collected scripts, and export with **Export OpenAPI**, **Export JSON** or **Export CSV**.

Recording can be paused from the popup, and **Clear all** in the dashboard deletes everything recorded.

## How it works

Two sources feed the same endpoint list:

| Source | File | Sees |
|---|---|---|
| Network | `background.js` via `chrome.webRequest` | Every request from the site, including service-worker requests. Method, URL, status, request type. No bodies. |
| Page | `hook.js` in the page's own JavaScript world | `fetch` and `XMLHttpRequest` calls, including request and response bodies, which it reduces to shapes before they leave the page. |

`relay.js` runs in the extension's isolated world and connects the two: it tells `hook.js` whether the current site is on the list (the hook stays dormant until it hears back) and forwards the hook's shape-only observations to the background worker.

Paths are templated so that the same endpoint called with different IDs collapses into one entry. Numeric segments become `{num}`, UUIDs `{uuid}`, long hex strings `{hex}` and long mixed tokens `{token}`. JSON object keys that look like IDs are collapsed to `{id}`. String values are classified as `string`, `date-time` or `numeric-string`.

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: permissions, content scripts, popup |
| `background.js` | Service worker: recording, path templating, shape merging, JS scanning |
| `hook.js` | Wraps `fetch`/XHR inside the page and reduces bodies to shapes |
| `relay.js` | Bridge between the page and the service worker |
| `popup.html` / `popup.js` | Site list, recording toggle, quick stats |
| `dashboard.html` / `dashboard.js` | Endpoint, page and script views; OpenAPI/JSON/CSV export |
| `styles.css` | Shared styles (light and dark) |

## Privacy

Everything is stored locally in `chrome.storage.local` in your browser. Nothing is sent anywhere.

What is kept per endpoint: method, host, templated path, query parameter **names**, status codes, request types, up to ten pages it was seen on, call counts, timestamps, the content type and the shapes of JSON bodies. No values, headers, cookies or tokens are stored.

Caveats worth knowing:

- Path segments that don't match the ID patterns above are kept as they are. An identifier in an unusual format in a URL path (for example a CPR number with a dash) would not be replaced by a placeholder. Look over an export before you share it.
- The *Scan JavaScript* button downloads the site's script files again with your session (`credentials: "include"`) so it can read them. The full script URLs, query strings included, are stored.
- The extension has host access to all HTTPS sites so it can be pointed at any domain. On sites that aren't on your list, `hook.js` still wraps `fetch`/XHR but only buffers a little in page memory until `relay.js` tells it to switch off, and nothing is recorded.

## Licence

No licence file yet. dhroxy itself is Apache-2.0.
