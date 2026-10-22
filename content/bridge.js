// Isolated-world helper, loaded in every frame next to content/main.js.
// Works out whether this frame's TAB is on a protected site and tells main.js,
// and relays block reports to the background worker.

// An older build may have registered this file a second time; run once.
if (!globalThis.__popupGuardBridge) {
  globalThis.__popupGuardBridge = true;

  // Same as lib/sites.js matchSite (content scripts can't import modules).
  const covers = (host, sites) => {
    const h = host.replace(/^www\./, '');
    return sites.some((site) => h === site || h.endsWith(`.${site}`));
  };

  /**
   * The tab's address-bar host. For a frame (e.g. the voe.sx player) that's the
   * outermost ancestor, not the frame's own random domain. '' if unknown.
   */
  const topHost = () => {
    if (window === window.top) return location.hostname;
    const origins = location.ancestorOrigins;
    const top = origins?.length ? origins[origins.length - 1] : '';
    try {
      return new URL(top).hostname;
    } catch {
      return ''; // 'null' origin, e.g. masked by the embedding page
    }
  };

  // Shared secret with main.js so page scripts can't spoof the state (see main.js).
  // Sent at document_start, before any page script exists: now if main.js ran
  // first, or when main.js announces itself if this script ran first. main.js
  // keeps only the first key it hears and hides the event from the page.
  // getRandomValues, not randomUUID: the latter is missing on plain-http frames.
  const key = Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(36)).join('');
  const sayHello = () => window.dispatchEvent(new CustomEvent('popupguard:hello', { detail: key }));
  window.addEventListener('popupguard:main-ready', sayHello, { once: true });
  sayHello();

  let state = { active: false, allowUntil: 0 };
  const publish = (patch) => {
    state = { ...state, ...patch };
    window.dispatchEvent(new CustomEvent('popupguard:state', { detail: JSON.stringify({ ...state, key }) }));
  };

  const refresh = async () => {
    const host = topHost();
    const { sites = [], enabled = true } = await chrome.storage.sync.get(['sites', 'enabled']);
    let active;
    if (!enabled) {
      active = false; // paused with the popup's master switch
    } else if (host) {
      active = covers(host, sites);
    } else {
      // Can't see the top page from here; the background can (sender.tab.url).
      active = await chrome.runtime.sendMessage({ type: 'isProtectedTab' }).catch(() => false);
    }
    publish({ active: !!active });

    // Pick up an "allow next popup" that was granted before this frame loaded.
    if (active) {
      const until = await chrome.runtime.sendMessage({ type: 'getAllow' }).catch(() => 0);
      if (until) publish({ allowUntil: until });
    }
  };

  refresh();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes.sites || changes.enabled)) refresh();
  });

  // detail is the block kind from main.js ('window.open', 'link', 'form', 'overlay', 'notification').
  // A page could fake these, but that only inflates its own counter.
  window.addEventListener('popupguard:blocked', (e) => {
    if (!state.active) return;
    const kind = typeof e.detail === 'string' ? e.detail : undefined;
    chrome.runtime.sendMessage({ type: 'blocked', kind }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'allow') publish({ allowUntil: msg.until });
  });
}
