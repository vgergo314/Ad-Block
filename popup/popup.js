import { ALLOW_WINDOW_MS, getEnabled, getSites, hostOf, matchSite, normalizeHost } from '../lib/sites.js';

const $ = (id) => document.getElementById(id);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const tabHost = tab ? hostOf(tab.url) : null;

let sites = await getSites();

async function saveSites(next) {
  sites = [...new Set(next)].sort();
  await chrome.runtime.sendMessage({ type: 'setSites', sites });
  render();
}

// --- master on/off switch ----------------------------------------------------
// Applies live: open frames switch to pass-through (or back) without a reload.

function renderEnabled(enabled) {
  $('enabled').checked = enabled;
  $('paused').hidden = enabled;
  $('settings').inert = !enabled;
}

$('enabled').addEventListener('change', async (e) => {
  renderEnabled(e.target.checked);
  await chrome.storage.sync.set({ enabled: e.target.checked });
});

renderEnabled(await getEnabled());

// --- current site card -----------------------------------------------------

function renderCurrent() {
  const toggle = $('toggle');
  if (!tabHost) {
    $('host').textContent = 'Not a web page';
    toggle.disabled = true;
    $('status').textContent = 'Open a website to protect it.';
    return;
  }

  const entry = matchSite(tabHost, sites);
  $('host').textContent = tabHost.replace(/^www\./, '');
  toggle.checked = !!entry;
  $('status').textContent = entry ? `Protected${entry !== tabHost.replace(/^www\./, '') ? ` (via ${entry})` : ''}` : 'Not protected';
  $('status').classList.toggle('on', !!entry);
  $('stat').hidden = !entry;
  $('allow').hidden = !entry;
}

$('toggle').addEventListener('change', async (e) => {
  const entry = matchSite(tabHost, sites);
  if (e.target.checked && !entry) await saveSites([...sites, normalizeHost(tabHost)]);
  if (!e.target.checked && entry) await saveSites(sites.filter((s) => s !== entry));
  // Open frames switch live, but a tab loaded before the extension was
  // installed or reloaded has no guard in it yet, so reload when turning on.
  if (e.target.checked) chrome.tabs.reload(tab.id);
});

async function renderCount() {
  const { counts = {} } = await chrome.storage.session.get('counts');
  $('count').textContent = counts[tab?.id] ?? 0;
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.counts) renderCount();
});

// --- "let the next popup through" ----------------------------------------------

let countdown;

function showAllowState(until) {
  const btn = $('allow');
  clearInterval(countdown);
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(countdown);
      btn.disabled = false;
      btn.textContent = 'Let the next popup through';
      return;
    }
    btn.disabled = true;
    btn.textContent = `Next popup allowed… ${left}s`;
  };
  tick();
  countdown = setInterval(tick, 250);
}

$('allow').addEventListener('click', async () => {
  const until = Date.now() + ALLOW_WINDOW_MS;
  const { allow = {} } = await chrome.storage.session.get('allow');
  allow[tab.id] = until;
  await chrome.storage.session.set({ allow });
  chrome.tabs.sendMessage(tab.id, { type: 'allow', until }).catch(() => {});
  showAllowState(until);
});

// Layer 1 deletes the entry when it lets a popup through — reset the button then.
chrome.storage.session.onChanged.addListener((changes) => {
  if (!changes.allow) return;
  const until = changes.allow.newValue?.[tab?.id] ?? 0;
  showAllowState(until);
});

// --- site list --------------------------------------------------------------

function renderSites() {
  const list = $('sites');
  list.replaceChildren();
  $('site-count').textContent = sites.length ? `(${sites.length})` : '';

  if (!sites.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No sites yet. Use the switch above or add one below.';
    list.append(li);
    return;
  }

  for (const site of sites) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = site;
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.title = `Stop protecting ${site}`;
    remove.textContent = '×';
    remove.addEventListener('click', () => saveSites(sites.filter((s) => s !== site)));
    li.append(name, remove);
    list.append(li);
  }
}

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const host = normalizeHost($('add-input').value);
  if (!host) return;
  $('add-input').value = '';
  await saveSites([...sites, host]);
});

// --- init -------------------------------------------------------------------

function render() {
  renderCurrent();
  renderSites();
}

render();
renderCount();
if (tab) {
  const { allow = {} } = await chrome.storage.session.get('allow');
  if ((allow[tab.id] ?? 0) > Date.now()) showAllowState(allow[tab.id]);
}
