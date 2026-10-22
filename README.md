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
| 3 | `content/main.js` + `background.js` | **Tab-under:** cancels a script's attempt to send the protected tab itself to another site (real link clicks still work). If a cross-site frame manages it anyway, the background sends the tab back and closes the copy of the page the ad opened. |
| — | `content/bridge.js` | Decides whether the frame's **tab** (its address bar) is on a protected site and switches the guard on or off live. Relays block counts, the "allow" switch and suggestion tallies. |

**Why every frame:** players like voe.sx redirect their iframe to a new random domain on every load and fire the ads from inside it. Chrome can only target scripts by a frame's own address, so Layer 2 is present everywhere and decides at click time by the tab's address. On unprotected sites it passes every call straight through to the real browser function.

Same-site new tabs (e.g. "open episode in new tab") are never blocked.

**Let the next popup through** gives you 10 seconds in which one popup (or one redirect) is allowed — use it when a protected site has a real link you want to open, or a login button that redirects you elsewhere.

## Also included

- **Notification prompts:** on protected sites, "Allow notifications?" requests are silently answered "denied" (including behind fake "click Allow to prove you're not a robot" boxes). Nothing can ever grant permission, and Chrome's site settings aren't changed.
- **Right-click menu:** on pages and on the toolbar icon — Protect / Stop protecting this site, Let the next popup through, Pause / Resume.
- **Suggestions:** if an unprotected site uses popup tricks 3 times (hidden links or forms, invisible overlays, popups from clicking something that isn't a link or button), the icon shows a small amber dot on that tab and the popup offers to protect it. Real links and buttons don't count. Tallies are site name + count, kept 30 days on this computer.
- **Stats:** click the number next to the title for all-time / today / 7-day counts, per site, and how popups were stopped. Stored only on this computer.
- **Master switch:** pauses everything live; the icon shows OFF.

## Testing

`test/` contains a fake page with each popup trick. Serve this folder and open it:

```
python3 -m http.server 8765
```

Then visit `http://localhost:8765/test/index.html`, protect `localhost`, and click the numbered buttons. Only #5 (same-site link) should open a tab, and only #14 (real link) should leave the page. The player buttons need `*.test` hostnames that point to 127.0.0.1 (e.g. Chrome's `--host-resolver-rules="MAP *.test 127.0.0.1"`).
