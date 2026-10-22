import { ALLOW_WINDOW_MS, getPlayerHosts, getSites, hostOf, matchSite, normalizeHost } from '../lib/sites.js';

const $ = (id) => document.getElementById(id);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const tabHost = tab ? hostOf(tab.url) : null;

let sites = await getSites();
let playerHosts = await getPlayerHosts();

async function saveSites(next) {
  sites = [...new Set(next)].sort();
  await chrome.runtime.sendMessage({ type: 'setLists', sites });
  render();
}

async function savePlayerHosts(next) {
  playerHosts = next;
  await chrome.runtime.sendMessage({ type: 'setLists', playerHosts });
  render();
}

// The background learns new player hosts while the popup may be open.
chrome.storage.sync.onChanged.addListener((changes) => {
  if (!changes.playerHosts) return;
  playerHosts = changes.playerHosts.newValue ?? [];
  renderSites();
});

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
  // The page script only injects at page load, so reload to apply.
  chrome.tabs.reload(tab.id);
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

function siteRow(host, onRemove, tagText) {
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.textContent = host;
  if (tagText) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = tagText;
    tag.title = 'Video player embedded in a protected site. Added automatically after it opened an ad.';
    name.append(' ', tag);
  }
  const remove = document.createElement('button');
  remove.className = 'remove';
  remove.title = `Stop protecting ${host}`;
  remove.textContent = '×';
  remove.addEventListener('click', onRemove);
  li.append(name, remove);
  return li;
}

function renderSites() {
  const list = $('sites');
  list.replaceChildren();
  const total = sites.length + playerHosts.length;
  $('site-count').textContent = total ? `(${total})` : '';

  if (!total) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No sites yet. Use the switch above or add one below.';
    list.append(li);
    return;
  }

  for (const site of sites) {
    list.append(siteRow(site, () => saveSites(sites.filter((s) => s !== site))));
  }
  for (const host of playerHosts) {
    list.append(siteRow(host, () => savePlayerHosts(playerHosts.filter((h) => h !== host)), 'player'));
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
