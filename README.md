# Popup Guard

Chrome extension (Manifest V3) that stops sites from opening ad tabs on every click — only on sites you choose.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder (the one containing `manifest.json`).
3. Pin the extension, open the annoying site, click the icon and flip **This site** on. The tab reloads with protection active.

## How it works

| Layer | File | What it does |
|---|---|---|
| 1 | `background.js` | When a protected site opens a tab/window to a different domain (or `about:blank`), closes it immediately. Also closes a same-site tab it opened that redirects to another domain within 15 s. Catches everything, including popups fired from inside the video-player iframe. |
| 2 | `content/main.js` | Loads in **every frame of every site, before any site script** (`document_start`, `MAIN` world). Guards `window.open` (including copies borrowed from fresh iframes), script-clicked `<a target=_blank>` links, hidden `<form target=_blank>` submits, and invisible full-page click overlays — so the ad tab never even appears. |
| — | `content/bridge.js` | Decides whether the frame's **tab** (its address bar) is on a protected site and switches Layer 2 on or off live. Relays block counts and the "allow" switch. |

**Why every frame:** players like voe.sx redirect their iframe to a new random domain on every load and fire the ads from inside it. Chrome can only target scripts by a frame's own address, so Layer 2 is present everywhere and decides at click time by the tab's address. On unprotected sites it passes every call straight through to the real browser function.

Same-site new tabs (e.g. "open episode in new tab") are never blocked.

**Let the next popup through** gives you 10 seconds in which one popup is allowed — use it when a protected site has a real link you want to open.

## Testing

`test/` contains a fake page with each popup trick. Serve this folder and open it:

```
python3 -m http.server 8765
```

Then visit `http://localhost:8765/test/index.html`, protect `localhost`, and click the numbered buttons. Only #5 (same-site link) should open a tab.
