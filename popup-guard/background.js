import { getSites, hostOf, isSameSite, matchSite, matchPatternsFor } from './lib/sites.js';

const SCRIPT_IDS = ['pg-main', 'pg-bridge'];

// ---------------------------------------------------------------------------
// Content-script registration: Layer 2 runs on the protected sites themselves
// (top page + same-site frames). Embedded players on other domains are
// handled by injectIntoFrame below.
// Calls are chained so overlapping syncs can't race into "duplicate script ID".
// ---------------------------------------------------------------------------

let syncChain = Promise.resolve();

function syncContentScripts() {
  syncChain = syncChain.then(async () => {
    const sites = await getSites();
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS });
    if (existing.length) {
      await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
    }
    if (!sites.length) return;

    const matches = sites.flatMap(matchPatternsFor);
    await chrome.scripting.registerContentScripts([
      // MAIN world + document_start: must patch window.open before the ad script caches it.
      { id: 'pg-main', matches, js: ['content/main.js'], runAt: 'document_start', world: 'MAIN', allFrames: true },
      { id: 'pg-bridge', matches, js: ['content/bridge.js'], runAt: 'document_start', allFrames: true },
    ]);
  }).catch((err) => console.error('[Popup Guard] script sync failed', err));
  return syncChain;
}

chrome.runtime.onInstalled.addListener(() => {
  // 1.0.x briefly stored learned player domains; they rotate (voe.sx), so drop them.
  chrome.storage.sync.remove('playerHosts');
  syncContentScripts();
});
chrome.runtime.onStartup.addListener(syncContentScripts);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.sites) syncContentScripts();
});

/** Host of the tab's top page if that page is on a protected site, else null. */
async function protectedTopHost(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const host = hostOf(tab?.url || tab?.pendingUrl);
  return host && matchSite(host, await getSites()) ? host : null;
}

// ---------------------------------------------------------------------------
// Layer 2 for embedded players. sorozatom.online embeds voe.sx, which
// redirects the frame to a new random domain on every load
// (derricknationtop.com, …), and the ads fire from inside that frame. A
// domain list can't keep up, so every cross-site frame that commits inside a
// protected tab gets Layer 2, injected as soon as the frame's document exists.
// ---------------------------------------------------------------------------

chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId, url }) => {
  if (frameId === 0) return;
  const frameHost = hostOf(url);
  if (!frameHost) return;

  const topHost = await protectedTopHost(tabId);
  // Same-site frames already get the registered content scripts.
  if (!topHost || isSameSite(frameHost, topHost)) return;

  const target = { tabId, frameIds: [frameId] };
  await Promise.all([
    chrome.scripting.executeScript({ target, files: ['content/main.js'], world: 'MAIN', injectImmediately: true }),
    chrome.scripting.executeScript({ target, files: ['content/bridge.js'], injectImmediately: true }),
  ]).catch(() => {}); // frame gone or not scriptable (e.g. chrome-error://)
});

// ---------------------------------------------------------------------------
// Per-tab state in session storage (survives the worker going to sleep).
// ---------------------------------------------------------------------------

let countChain = Promise.resolve();

function recordBlock(tabId) {
  countChain = countChain.then(async () => {
    const { counts = {} } = await chrome.storage.session.get('counts');
    counts[tabId] = (counts[tabId] ?? 0) + 1;
    await chrome.storage.session.set({ counts });
    await showBadge(tabId, counts[tabId]);
  });
  return countChain;
}

async function showBadge(tabId, count) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' });
  await chrome.action.setBadgeText({ tabId, text: count > 99 ? '99+' : String(count) });
}

async function getAllowUntil(tabId) {
  const { allow = {} } = await chrome.storage.session.get('allow');
  return allow[tabId] ?? 0;
}

/** If "allow next popup" is active for this tab, use it up and return true. */
async function consumeAllow(tabId) {
  const { allow = {} } = await chrome.storage.session.get('allow');
  if ((allow[tabId] ?? 0) <= Date.now()) return false;
  delete allow[tabId];
  await chrome.storage.session.set({ allow });
  return true;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { counts = {}, allow = {}, children = {} } = await chrome.storage.session.get(['counts', 'allow', 'children']);
  delete counts[tabId];
  delete allow[tabId];
  delete children[tabId];
  await chrome.storage.session.set({ counts, allow, children });
});

// Chrome can drop tab-specific badge text on navigation; put it back.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const { counts = {} } = await chrome.storage.session.get('counts');
  if (counts[tabId]) showBadge(tabId, counts[tabId]);
});

// ---------------------------------------------------------------------------
// Layer 1: close any tab/window a protected site opens to a foreign domain.
// Catches every mechanism (window.open, _blank links, popups from inside
// cross-origin player iframes) because it only looks at the result.
// ---------------------------------------------------------------------------

chrome.webNavigation.onCreatedNavigationTarget.addListener(async ({ sourceTabId, tabId, url }) => {
  let source;
  try {
    source = await chrome.tabs.get(sourceTabId);
  } catch {
    return; // opener already gone
  }

  const sourceHost = hostOf(source.url || source.pendingUrl);
  if (!sourceHost || !matchSite(sourceHost, await getSites())) return;

  // about:blank / empty targets count as foreign: pop-unders often open blank and redirect.
  const targetHost = hostOf(url);
  if (targetHost && isSameSite(sourceHost, targetHost)) {
    await watchChild(tabId, sourceTabId, sourceHost);
    return;
  }

  if (await consumeAllow(sourceTabId)) return;
  await closePopup(tabId, sourceTabId, source.windowId);
});

async function closePopup(tabId, sourceTabId, windowId) {
  await chrome.tabs.remove(tabId).catch(() => {});
  chrome.tabs.update(sourceTabId, { active: true }).catch(() => {});
  if (windowId !== undefined) chrome.windows.update(windowId, { focused: true }).catch(() => {});
  recordBlock(sourceTabId);
}

// The aniwaves ad opens a *same-site* copy of the page (?step1=…&step2=…), which
// then redirects itself to the ad. Watch such child tabs briefly and close them
// if they leave for another domain.
const CHILD_WATCH_MS = 15_000;

async function watchChild(tabId, sourceTabId, sourceHost) {
  const { children = {} } = await chrome.storage.session.get('children');
  children[tabId] = { sourceTabId, sourceHost, until: Date.now() + CHILD_WATCH_MS };
  await chrome.storage.session.set({ children });
}

chrome.webNavigation.onBeforeNavigate.addListener(async ({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  const { children = {} } = await chrome.storage.session.get('children');
  const child = children[tabId];
  if (!child) return;

  const expired = child.until < Date.now();
  const targetHost = hostOf(url);
  if (!expired && targetHost && isSameSite(child.sourceHost, targetHost)) return; // still on-site: keep watching

  delete children[tabId];
  await chrome.storage.session.set({ children });
  if (expired || (await consumeAllow(child.sourceTabId))) return;

  const source = await chrome.tabs.get(child.sourceTabId).catch(() => null);
  await closePopup(tabId, child.sourceTabId, source?.windowId);
});

// ---------------------------------------------------------------------------
// Messages from content/bridge.js and the popup.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'blocked':
      if (sender.tab) recordBlock(sender.tab.id);
      return false;
    case 'getAllow':
      if (!sender.tab) return false;
      getAllowUntil(sender.tab.id).then(sendResponse);
      return true;
    case 'setSites':
      // Popup waits for this so it can reload the tab once scripts are (un)registered.
      chrome.storage.sync.set({ sites: msg.sites })
        .then(syncContentScripts)
        .then(() => sendResponse(true));
      return true;
    default:
      return false;
  }
});
