import { getAlwaysAllow, getEnabled, getSites, hostOf, matchSite, normalizeHost } from '../lib/sites.js';
import { getStats } from '../lib/stats.js';
import { renderStatsView } from './stats-view.js';
import { getSuggestState, suggestionFor } from '../lib/suggest.js';

const $ = (id) => document.getElementById(id);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const tabHost = tab ? hostOf(tab.url) : null;

const setSwitch = (el, on) => el.setAttribute('aria-checked', String(on));
const isOn = (el) => el.getAttribute('aria-checked') === 'true';

// The two rule lists. One "Sites" list shows both: Block = protected site,
// Allow = "always allow popups to". Storage keeps them apart.
let sites = await getSites();
let alwaysAllow = await getAlwaysAllow();

async function saveSites(next) {
  sites = [...new Set(next)].sort();
  await chrome.runtime.sendMessage({ type: 'setSites', sites });
}

async function saveAlwaysAllow(next) {
  alwaysAllow = [...new Set(next)].sort();
  // Open frames pick changes up live via storage.onChanged in bridge.js.
  await chrome.storage.sync.set({ alwaysAllow });
}

/** Puts `site` in one list (or neither, for mode null) and takes it out of the other. */
async function setRule(site, mode) {
  if (sites.includes(site) || mode === 'block') {
    await saveSites(mode === 'block' ? [...sites, site] : sites.filter((s) => s !== site));
  }
  if (alwaysAllow.includes(site) || mode === 'allow') {
    await saveAlwaysAllow(mode === 'allow' ? [...alwaysAllow, site] : alwaysAllow.filter((s) => s !== site));
  }
  render();
}

// --- master on/off switch ----------------------------------------------------
// Applies live: open frames switch to pass-through (or back) without a reload.

let enabled = await getEnabled();

$('enabled').addEventListener('click', async () => {
  enabled = !enabled;
  if (!enabled) clearAllow();
  render();
  await chrome.storage.sync.set({ enabled });
});

// --- tabs: Protection / Statistics --------------------------------------------------

const fmt = (n) => n.toLocaleString();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const plural = (n, word) => `${word}${n === 1 ? '' : 's'}`;

const tabs = [$('tab-protect'), $('tab-stats')];

function selectTab(tabEl, { focus = false } = {}) {
  for (const t of tabs) {
    const selected = t === tabEl;
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !selected;
  }
  if (tabEl === $('tab-stats')) renderStatsView();
  if (focus) tabEl.focus();
  try {
    localStorage.setItem('tab', tabEl.id);
  } catch {}
}

for (const t of tabs) {
  t.addEventListener('click', () => selectTab(t));
  // Arrow keys move between tabs (the usual tablist keyboard pattern).
  t.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    selectTab(tabs[(tabs.indexOf(t) + 1) % tabs.length], { focus: true });
  });
}

// The header count is a shortcut to the Statistics tab.
$('stats-toggle').addEventListener('click', () => selectTab($('tab-stats'), { focus: true }));

try {
  if (localStorage.getItem('tab') === 'tab-stats') selectTab($('tab-stats'));
} catch {}

async function renderChip() {
  const { total } = await getStats();
  // The header chip has little room (max ~4 characters).
  $('total-chip').textContent = total < 1_000 ? fmt(total) : compact.format(total);
  $('stats-toggle').setAttribute('aria-label', `${fmt(total)} ${plural(total, 'popup')} blocked in total, show statistics`);
}

chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.stats) renderChip();
});

function span(text, className) {
  const el = document.createElement('span');
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

// --- this site ---------------------------------------------------------------------

function renderCurrent() {
  const toggle = $('toggle');
  if (!tabHost) {
    $('host').textContent = 'Not a web page';
    toggle.disabled = true;
    $('status').textContent = 'Open a website to protect it.';
    for (const id of ['stat', 'allow', 'reload-hint']) $(id).hidden = true;
    return;
  }

  const entry = matchSite(tabHost, sites);
  const active = !!entry && enabled;
  const host = tabHost.replace(/^www\./, '');
  $('host').textContent = host;
  $('host').title = host;
  setSwitch(toggle, !!entry);
  toggle.disabled = !enabled;
  toggle.classList.toggle('dim', !enabled);
  $('current').classList.toggle('paused', !enabled);

  $('status').textContent = !enabled
    ? 'Paused — Popup Guard is off'
    : entry ? `Protected${entry !== host ? ` (via ${entry})` : ''}` : 'Not protected';
  $('status').classList.toggle('on', active);
  $('stat').hidden = !active;
  $('allow').hidden = !active;
  $('reload-hint').hidden = !(active && guarded === false);
}

/**
 * Is Layer 2 running in this tab? main.js answers a cancelable ping. A tab loaded
 * before the extension was installed has no main.js, so nothing cancels it. Only
 * asked when the popup opens on a protected tab with Popup Guard on; null otherwise.
 */
async function checkGuard() {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => !window.dispatchEvent(new CustomEvent('popupguard:ping', { cancelable: true })),
    });
    return result;
  } catch {
    return null; // a page extensions can't run on (chrome://, the Web Store)
  }
}

/**
 * Are the content scripts in this tab at all (on or off)? Reads bridge.js's flag
 * in the extension's isolated world, which the page can't set (main.js's marker
 * lives on the page's own window, so a page could fake it). null if we can't look.
 */
async function hasGuard() {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => !!globalThis.__popupGuardBridge,
    });
    return result;
  } catch {
    return null;
  }
}

/**
 * Starts guarding this tab after it was just protected. main.js is already in
 * every page loaded since install, waiting in pass-through, and switches on live,
 * so this popup stays open. Only a tab loaded before the extension was installed
 * or reloaded lacks it; that one is reloaded, which closes the popup, because
 * main.js must run before the page's scripts save window.open.
 */
async function guardTab() {
  if ((await hasGuard()) === false) {
    chrome.tabs.reload(tab.id);
    return;
  }
  // bridge.js picks up the new site list asynchronously; give it a moment.
  for (let i = 0; i < 5; i++) {
    guarded = await checkGuard();
    if (guarded !== false) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  renderCurrent();
}

let guarded = tabHost && enabled && matchSite(tabHost, sites) ? await checkGuard() : null;

$('reload-tab').addEventListener('click', () => {
  chrome.tabs.reload(tab.id);
  guarded = null;
  renderCurrent();
});

$('toggle').addEventListener('click', async () => {
  const entry = matchSite(tabHost, sites);
  guarded = null;
  if (entry) {
    await setRule(entry, null);
  } else {
    await setRule(normalizeHost(tabHost), 'block');
    await guardTab();
  }
});

async function renderCount() {
  const { counts = {} } = await chrome.storage.session.get('counts');
  const n = counts[tab?.id] ?? 0;
  $('count').textContent = fmt(n);
  $('count-word').textContent = plural(n, 'popup');
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.counts) renderCount();
});

// --- "let the next popup through" ----------------------------------------------
// Click once to allow the next popup (for ALLOW_WINDOW_MS); click again to undo.

let allowUntil = 0;
let allowTimer;

function showAllowState(until) {
  allowUntil = until;
  clearTimeout(allowTimer);
  const armed = until > Date.now();
  $('allow').textContent = armed ? 'Next popup will open — undo' : 'Let the next popup through';
  if (armed) allowTimer = setTimeout(() => showAllowState(0), until - Date.now());
}

function clearAllow() {
  if (allowUntil > Date.now()) chrome.runtime.sendMessage({ type: 'cancelAllow', tabId: tab.id });
  showAllowState(0);
}

// Shared with the right-click menu: the background does the actual work.
$('allow').addEventListener('click', async () => {
  if (allowUntil > Date.now()) clearAllow();
  else showAllowState(await chrome.runtime.sendMessage({ type: 'allowNext', tabId: tab.id }));
});

// Layer 1 deletes the entry when it lets a popup through — reset the link then.
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.allow) showAllowState(changes.allow.newValue?.[tab?.id] ?? 0);
});

// --- sites list ---------------------------------------------------------------------

function renderSites() {
  const rules = [
    ...sites.map((site) => ({ site, mode: 'block' })),
    ...alwaysAllow.map((site) => ({ site, mode: 'allow' })),
  ].sort((a, b) => a.site.localeCompare(b.site));

  if (!rules.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No sites yet. Use the switch above or add one below.';
    $('sites').replaceChildren(empty);
    return;
  }

  $('sites').replaceChildren(
    ...rules.map(({ site, mode }) => {
      const item = document.createElement('li');
      item.title = mode === 'block' ? `Popups are blocked on ${site}` : `Protected sites may always open ${site}`;

      const flip = document.createElement('button');
      flip.type = 'button';
      flip.className = `mode ${mode}`;
      flip.textContent = mode === 'block' ? 'Block' : 'Allow';
      flip.setAttribute('aria-label', mode === 'block'
        ? `${site}: popups blocked, click to always allow`
        : `${site}: popups always allowed, click to block`);
      flip.addEventListener('click', () => setRule(site, mode === 'block' ? 'allow' : 'block'));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.setAttribute('aria-label', `Remove ${site}`);
      remove.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';
      remove.addEventListener('click', () => setRule(site, null));

      item.append(span(site, 'name'), flip, remove);
      return item;
    }),
  );
}

function showError(message) {
  $('add-error').textContent = message;
  $('add-error').hidden = !message;
}

$('add-input').addEventListener('input', () => showError(''));

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const host = normalizeHost($('add-input').value);
  if (!host || !host.includes('.')) return showError('Enter a domain like example.com');
  const mode = $('add-mode').value;
  if ((mode === 'block' ? sites : alwaysAllow).includes(host)) return showError(`${host} is already in the list`);
  $('add-input').value = '';
  showError('');
  await setRule(host, mode);
});

// --- count on the toolbar icon ------------------------------------------------------

const { badgeCount = false } = await chrome.storage.sync.get('badgeCount');
setSwitch($('badge-count'), badgeCount);
$('badge-count').addEventListener('click', (e) => {
  const on = !isOn(e.currentTarget);
  setSwitch(e.currentTarget, on);
  chrome.storage.sync.set({ badgeCount: on });
});

// --- "Protect this site?" suggestion --------------------------------------------

async function renderSuggestion() {
  const site = tabHost ? normalizeHost(tabHost) : null;
  const count = site && enabled && !matchSite(tabHost, sites) ? suggestionFor(site, await getSuggestState()) : 0;
  $('suggest').hidden = !count;
  if (count) $('suggest-text').textContent = `This site tried to open ${count} popups. Protect it?`;
}

$('suggest-protect').addEventListener('click', async () => {
  await setRule(normalizeHost(tabHost), 'block');
  await guardTab(); // same as the switch
});

$('suggest-dismiss').addEventListener('click', async () => {
  const { dismissed } = await getSuggestState();
  await chrome.storage.local.set({ dismissed: [...new Set([...dismissed, normalizeHost(tabHost)])] });
  renderSuggestion();
});

// --- init -------------------------------------------------------------------

function render() {
  setSwitch($('enabled'), enabled);
  renderCurrent();
  renderSites();
  renderSuggestion();
}

render();
renderChip();
renderCount();
if (tab) {
  const { allow = {} } = await chrome.storage.session.get('allow');
  showAllowState(allow[tab.id] ?? 0);
}
