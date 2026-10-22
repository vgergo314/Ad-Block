# Popup Guard

Chrome extension (Manifest V3) that stops sites from opening ad tabs on every click — only on sites you choose.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this `popup-guard` folder.
3. Pin the extension, open the annoying site, click the icon and flip **This site** on. The tab reloads with protection active.

## How it works

| Layer | File | What it does |
|---|---|---|
| 1 | `background.js` | When a protected site opens a tab/window to a different domain (or `about:blank`), closes it immediately. Catches everything, including popups fired from inside the video-player iframe. |
| 2 | `content/main.js` | Injected into the page **before any site script** (`document_start`, `MAIN` world). Guards `window.open` (including copies borrowed from fresh iframes), script-clicked `<a target=_blank>` links, and invisible full-page click overlays — so the ad tab never even appears. |
| — | `content/bridge.js` | Relays block counts and the "allow" switch between the page and the extension. |

Same-site new tabs (e.g. "open episode in new tab") are never blocked.

**Let the next popup through** gives you 10 seconds in which one popup is allowed — use it when a protected site has a real link you want to open.

## Testing

`test/` contains a fake page with each popup trick. Serve the extension folder and open it:

```
python3 -m http.server 8765
```

Then visit `http://localhost:8765/test/index.html`, protect `localhost`, and click the numbered buttons. Only #5 (same-site link) should open a tab.
