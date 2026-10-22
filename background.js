import { ALLOW_WINDOW_MS, getAlwaysAllow, getEnabled, getSites, hostOf, isSameSite, matchSite, normalizeHost } from './lib/sites.js';
import { addBlock, getStats, KINDS } from './lib/stats.js';
import { addSuspect, getSuggestState, suggestionFor } from './lib/suggest.js';

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

/** Global badge: OFF while paused. (Per tab, a suggestion dot or the block count may show; see refreshBadge.) */
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
    chrome.tabs.get(tabId).then(refreshBadge, () => {});

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

/** "Let the next popup through" for ALLOW_WINDOW_MS, from the popup or the menu. Returns the deadline. */
async function allowNextPopup(tabId) {
  const until = Date.now() + ALLOW_WINDOW_MS;
  const { allow = {} } = await chrome.storage.session.get('allow');
  allow[tabId] = until;
  await chrome.storage.session.set({ allow });
  chrome.tabs.sendMessage(tabId, { type: 'allow', until }).catch(() => {}); // every frame's bridge.js
  return until;
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
  const { counts = {}, allow = {} } = await chrome.storage.session.get(['counts', 'allow']);
  delete counts[tabId];
  delete allow[tabId];
  await chrome.storage.session.set({ counts, allow });
  for (const key of ['children', 'activity', 'userNav', 'tabUnder', 'tops']) {
    updateSession(key, (m) => void delete m[tabId]);
  }
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
  if (targetHost && matchSite(targetHost, await getAlwaysAllow())) return; // "Always allow popups to"
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
  markActivity(sourceTabId);
}

// The aniwaves ad opens a *same-site* copy of the page (?step1=…&step2=…), which
// then redirects itself to the ad. Watch such child tabs briefly and close them
// if they leave for another domain.
const CHILD_WATCH_MS = 15_000;

async function watchChild(tabId, sourceTabId, sourceHost) {
  markActivity(sourceTabId);
  // Opened just after a blocked tab-under? It's the ad script's copy of the page.
  const { tabUnder = {} } = await chrome.storage.session.get('tabUnder');
  if (Date.now() - (tabUnder[sourceTabId] ?? 0) < TAB_UNDER_WINDOW_MS) {
    chrome.tabs.remove(tabId).catch(() => {});
    return;
  }
  await updateSession('children', (children) => {
    children[tabId] = { sourceTabId, sourceHost, opened: Date.now(), until: Date.now() + CHILD_WATCH_MS };
  });
}

// ---------------------------------------------------------------------------
// Layer 3: tab-under. The ad opens a copy of the page in a new tab and sends
// THIS tab to an ad. content/main.js cancels script-started jumps before they
// happen; this is the fallback for one that slips through (e.g. started from a
// cross-site player frame): go back, and close the copy.
// ---------------------------------------------------------------------------

const TAB_UNDER_WINDOW_MS = 3_000; // popup activity and the redirect come together
const USER_NAV_GRACE_MS = 5_000;

// Small read-modify-write helper for the session maps below, chained so
// concurrent events can't overwrite each other.
let sessionChain = Promise.resolve();
function updateSession(key, change) {
  const run = sessionChain.then(async () => {
    const { [key]: map = {} } = await chrome.storage.session.get(key);
    const result = change(map);
    await chrome.storage.session.set({ [key]: map });
    return result;
  });
  sessionChain = run.catch(() => {});
  return run;
}

/** A protected tab just tried a popup trick; a redirect right after is a tab-under. */
function markActivity(tabId) {
  updateSession('activity', (m) => void (m[tabId] = Date.now()));
}

/** Close the same-site copies this tab opened in the last few seconds. */
async function closeRecentCopies(sourceTabId) {
  const closed = await updateSession('children', (children) => {
    const ids = Object.entries(children)
      .filter(([, c]) => c.sourceTabId === sourceTabId && Date.now() - (c.opened ?? 0) < TAB_UNDER_WINDOW_MS)
      .map(([id]) => Number(id));
    for (const id of ids) delete children[id];
    return ids;
  });
  for (const id of closed) chrome.tabs.remove(id).catch(() => {});
}

/** main.js blocked a tab-under in this tab (or the fallback caught one). */
async function onTabUnder(tabId) {
  await updateSession('tabUnder', (m) => void (m[tabId] = Date.now()));
  await closeRecentCopies(tabId);
}

chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId, url, transitionType, transitionQualifiers }) => {
  if (frameId !== 0) return;
  const host = hostOf(url);
  const prev = await updateSession('tops', (tops) => {
    const before = tops[tabId];
    tops[tabId] = host;
    return before;
  });
  // A real link click (reported by main.js) covers exactly one page load: this one.
  const userNavUntil = await updateSession('userNav', (m) => {
    const until = m[tabId];
    delete m[tabId];
    return until ?? 0;
  });
  if (!prev || !host || isSameSite(prev, host)) return;
  if (matchSite(host, await getAlwaysAllow())) return;
  if (!(await getEnabled()) || !matchSite(prev, await getSites())) return;

  // Things you did yourself: typing, bookmarks, reload, back/forward.
  if (['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated', 'reload', 'start_page'].includes(transitionType)) return;
  if (transitionQualifiers.includes('forward_back') || transitionQualifiers.includes('from_address_bar')) return;

  if (userNavUntil > Date.now()) return; // the user's own link click
  const { activity = {} } = await chrome.storage.session.get('activity');
  if (Date.now() - (activity[tabId] ?? 0) > TAB_UNDER_WINDOW_MS) return; // no popup trick just now
  if (await consumeAllow(tabId)) return;

  chrome.tabs.goBack(tabId).catch(() => {});
  recordBlock(tabId, prev, 'tab-under');
  onTabUnder(tabId);
});

chrome.webNavigation.onBeforeNavigate.addListener(async ({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  const { children = {} } = await chrome.storage.session.get('children');
  const child = children[tabId];
  if (!child || !(await getEnabled())) return;

  const expired = child.until < Date.now();
  const targetHost = hostOf(url);
  if (!expired && targetHost && isSameSite(child.sourceHost, targetHost)) return; // still on-site: keep watching

  await updateSession('children', (m) => void delete m[tabId]);
  if (expired || (targetHost && matchSite(targetHost, await getAlwaysAllow()))) return;
  if (await consumeAllow(child.sourceTabId)) return;

  const source = await chrome.tabs.get(child.sourceTabId).catch(() => null);
  await closePopup(tabId, child.sourceTabId, source?.windowId, child.sourceHost);
});

// ---------------------------------------------------------------------------
// Right-click menu: a "Popup Guard" submenu on pages, and the same items
// directly in the toolbar icon's menu. Labels follow the active tab.
// ---------------------------------------------------------------------------

const PAGE_CONTEXTS = ['page', 'frame', 'link', 'image', 'video', 'audio', 'selection', 'editable'];
const MENU_ITEMS = [
  ['toggle', 'Protect this site'],
  ['allow', 'Let the next popup through'],
  ['pause', 'Pause Popup Guard'],
];
const ignoreError = () => void chrome.runtime.lastError;

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'page', title: 'Popup Guard', contexts: PAGE_CONTEXTS }, ignoreError);
    for (const [id, title] of MENU_ITEMS) {
      chrome.contextMenus.create({ id: `page:${id}`, parentId: 'page', title, contexts: PAGE_CONTEXTS }, ignoreError);
      chrome.contextMenus.create({ id: `action:${id}`, title, contexts: ['action'] }, ignoreError);
    }
    refreshMenus();
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function refreshMenus(tab) {
  tab ??= await activeTab();
  const host = hostOf(tab?.url);
  const entry = host ? matchSite(host, await getSites()) : null;
  const enabled = await getEnabled();
  const update = (id, props) => {
    for (const where of ['page', 'action']) chrome.contextMenus.update(`${where}:${id}`, props, ignoreError);
  };
  update('toggle', { title: entry ? 'Stop protecting this site' : 'Protect this site', enabled: !!host });
  update('allow', { visible: !!entry && enabled });
  update('pause', { title: enabled ? 'Pause Popup Guard' : 'Resume Popup Guard' });
}

chrome.runtime.onInstalled.addListener(createMenus);
chrome.tabs.onActivated.addListener(() => refreshMenus());
chrome.tabs.onUpdated.addListener((_, info, tab) => {
  if (info.url && tab.active) refreshMenus(tab);
});
chrome.windows.onFocusChanged.addListener(() => refreshMenus());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.sites || changes.enabled)) refreshMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const action = String(info.menuItemId).split(':')[1];
  if (action === 'toggle') {
    const host = hostOf(tab?.url);
    if (!host) return;
    const sites = await getSites();
    const entry = matchSite(host, sites);
    if (entry) {
      await chrome.storage.sync.set({ sites: sites.filter((s) => s !== entry) });
    } else {
      await chrome.storage.sync.set({ sites: [...new Set([...sites, normalizeHost(host)])].sort() });
      chrome.tabs.reload(tab.id); // same as the popup: a tab loaded before install has no guard yet
    }
  } else if (action === 'allow' && tab) {
    await allowNextPopup(tab.id);
  } else if (action === 'pause') {
    await chrome.storage.sync.set({ enabled: !(await getEnabled()) });
  }
});

// ---------------------------------------------------------------------------
// Per-tab badge. On unprotected sites: "Protect this site?" suggestions tally
// popup tricks and put a small amber dot (no number) on the icon while you're
// on one that crossed the threshold; the popup shows the actual question. On
// protected sites: the tab's block count, if turned on in the popup.
// ---------------------------------------------------------------------------

const DOT_COLOR = '#f9ab00';
const COUNT_COLOR = '#d93025';
let suspectChain = Promise.resolve();

async function noteSuspect(tab) {
  const host = hostOf(tab?.url);
  if (!host || !(await getEnabled()) || matchSite(host, await getSites())) return;
  const site = normalizeHost(host);
  suspectChain = suspectChain.then(async () => {
    const { suspects } = await getSuggestState();
    await chrome.storage.local.set({ suspects: addSuspect(suspects, site) });
  }).catch(() => {});
  await suspectChain;
  refreshBadge(tab);
}

/** The tab's block count as badge text, if that's turned on and there is one; else null. */
async function countText(tabId) {
  const { badgeCount = false } = await chrome.storage.sync.get('badgeCount');
  if (!badgeCount) return null;
  const { counts = {} } = await chrome.storage.session.get('counts');
  const n = counts[tabId] ?? 0;
  return n ? (n > 999 ? '999+' : String(n)) : null;
}

async function refreshBadge(tab) {
  if (!tab?.id) return;
  const host = hostOf(tab.url);
  let text = null; // null clears this tab's text, falling back to the global badge (OFF or nothing)
  let color = '#8e8e93';
  if (host && (await getEnabled())) {
    if (matchSite(host, await getSites())) {
      text = await countText(tab.id);
      color = COUNT_COLOR;
    } else if (suggestionFor(normalizeHost(host), await getSuggestState()) > 0) {
      text = ' ';
      color = DOT_COLOR;
    }
  }
  chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color }).catch(() => {});
  chrome.action.setBadgeText({ tabId: tab.id, text }).catch(() => {});
}

async function refreshAllBadges() {
  for (const tab of await chrome.tabs.query({})) refreshBadge(tab);
}

chrome.tabs.onUpdated.addListener((_, info, tab) => {
  if (info.status === 'complete') refreshBadge(tab);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (
    (area === 'sync' && (changes.sites || changes.enabled || changes.badgeCount)) ||
    (area === 'local' && changes.dismissed)
  ) {
    refreshAllBadges();
  }
});

// ---------------------------------------------------------------------------
// Messages from content/bridge.js and the popup.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'blocked':
      if (!sender.tab) return false;
      recordBlock(sender.tab.id, hostOf(sender.tab.url), msg.kind);
      markActivity(sender.tab.id);
      if (msg.kind === 'tab-under') onTabUnder(sender.tab.id);
      return false;
    case 'suspect':
      noteSuspect(sender.tab);
      return false;
    case 'userNav':
      if (sender.tab) updateSession('userNav', (m) => void (m[sender.tab.id] = Date.now() + USER_NAV_GRACE_MS));
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
    case 'allowNext':
      allowNextPopup(msg.tabId).then(sendResponse);
      return true;
    default:
      return false;
  }
});
