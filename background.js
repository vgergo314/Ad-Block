import { getEnabled, getSites, hostOf, isSameSite, matchSite } from './lib/sites.js';
import { addBlock, getStats, KINDS } from './lib/stats.js';

// Layer 2 (content/main.js + content/bridge.js) is declared in manifest.json and
// loads in every frame of every site; it only blocks inside protected tabs.

chrome.runtime.onInstalled.addListener(async () => {
  // Builds before 1.1 registered Layer 2 per site and stored learned player
  // domains. Both are superseded by the manifest content scripts.
  chrome.storage.sync.remove('playerHosts');
  const old = await chrome.scripting.getRegisteredContentScripts({ ids: ['pg-main', 'pg-bridge'] });
  if (old.length) await chrome.scripting.unregisterContentScripts({ ids: old.map((s) => s.id) });
  showPausedBadge(await getEnabled());
});

/** Is this tab's address-bar page on a protected site (and the extension not paused)? */
async function isProtectedTab(tab) {
  const host = hostOf(tab?.url || tab?.pendingUrl);
  return !!host && (await getEnabled()) && !!matchSite(host, await getSites());
}

// ---------------------------------------------------------------------------
// Master switch. Pausing doesn't unload anything: bridge.js flips every frame
// to pass-through live, and Layer 1 below stops closing tabs.
// ---------------------------------------------------------------------------

/** The toolbar icon's only badge: OFF while paused. Block counts live in the popup. */
function showPausedBadge(enabled) {
  chrome.action.setBadgeBackgroundColor({ color: '#8e8e93' });
  chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
}

chrome.runtime.onStartup.addListener(async () => showPausedBadge(await getEnabled()));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.enabled) showPausedBadge(changes.enabled.newValue ?? true);
});

// ---------------------------------------------------------------------------
// Per-tab state in session storage (survives the worker going to sleep).
// ---------------------------------------------------------------------------

let countChain = Promise.resolve();

/**
 * Counts one stopped popup: the per-tab count shown in the popup (session) and
 * the all-time stats (local). `host` is the tab's address-bar host; stats file it under the
 * protected-site entry that covers it. Chained so concurrent blocks don't race.
 */
function recordBlock(tabId, host, kind) {
  countChain = countChain.then(async () => {
    const { counts = {} } = await chrome.storage.session.get('counts');
    counts[tabId] = (counts[tabId] ?? 0) + 1;
    await chrome.storage.session.set({ counts });

    const site = host ? matchSite(host, await getSites()) : null;
    const stats = addBlock(await getStats(), site, kind in KINDS ? kind : 'window.open');
    await chrome.storage.local.set({ stats });
  }).catch((err) => console.error('[Popup Guard] count failed', err));
  return countChain;
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
  if (!sourceHost || !(await getEnabled()) || !matchSite(sourceHost, await getSites())) return;

  // about:blank / empty targets count as foreign: pop-unders often open blank and redirect.
  const targetHost = hostOf(url);
  if (targetHost && isSameSite(sourceHost, targetHost)) {
    await watchChild(tabId, sourceTabId, sourceHost);
    return;
  }

  if (await consumeAllow(sourceTabId)) return;
  await closePopup(tabId, sourceTabId, source.windowId, sourceHost);
});

async function closePopup(tabId, sourceTabId, windowId, sourceHost) {
  await chrome.tabs.remove(tabId).catch(() => {});
  chrome.tabs.update(sourceTabId, { active: true }).catch(() => {});
  if (windowId !== undefined) chrome.windows.update(windowId, { focused: true }).catch(() => {});
  recordBlock(sourceTabId, sourceHost, 'closed');
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
  if (!child || !(await getEnabled())) return;

  const expired = child.until < Date.now();
  const targetHost = hostOf(url);
  if (!expired && targetHost && isSameSite(child.sourceHost, targetHost)) return; // still on-site: keep watching

  delete children[tabId];
  await chrome.storage.session.set({ children });
  if (expired || (await consumeAllow(child.sourceTabId))) return;

  const source = await chrome.tabs.get(child.sourceTabId).catch(() => null);
  await closePopup(tabId, child.sourceTabId, source?.windowId, child.sourceHost);
});

// ---------------------------------------------------------------------------
// Messages from content/bridge.js and the popup.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'blocked':
      if (sender.tab) recordBlock(sender.tab.id, hostOf(sender.tab.url), msg.kind);
      return false;
    case 'isProtectedTab':
      // bridge.js asks when a frame can't see its tab's address itself.
      isProtectedTab(sender.tab).then(sendResponse);
      return true;
    case 'getAllow':
      if (!sender.tab) return false;
      getAllowUntil(sender.tab.id).then(sendResponse);
      return true;
    case 'setSites':
      // Open frames pick the change up live via storage.onChanged in bridge.js.
      chrome.storage.sync.set({ sites: msg.sites }).then(() => sendResponse(true));
      return true;
    default:
      return false;
  }
});
