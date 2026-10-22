import { ALLOW_WINDOW_MS, getEnabled, getSites, hostOf, matchSite, normalizeHost } from '../lib/sites.js';
import { getStats, KINDS, lastDays } from '../lib/stats.js';

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

let enabled = true;
let statsOpen = false;

// Settings can't be used while paused, or while the stats panel covers them.
function updateSettingsInert() {
  $('settings').inert = !enabled || statsOpen;
  $('settings').classList.toggle('paused-look', !enabled);
}

function renderEnabled(value) {
  enabled = value;
  $('enabled').checked = enabled;
  $('paused').hidden = enabled;
  updateSettingsInert();
}

$('enabled').addEventListener('change', async (e) => {
  renderEnabled(e.target.checked);
  await chrome.storage.sync.set({ enabled: e.target.checked });
});

renderEnabled(await getEnabled());

// --- all-time stats (pull-down panel) ------------------------------------------

const fmt = (n) => n.toLocaleString();

function setStatsOpen(open) {
  statsOpen = open;
  const stage = document.querySelector('.stage');
  stage.classList.toggle('stats-open', open);
  // The panel is absolutely positioned; stretch the popup to fit it while open.
  stage.style.minHeight = open ? `${$('stats').scrollHeight}px` : '';
  $('stats').inert = !open;
  $('stats-toggle').setAttribute('aria-expanded', String(open));
  updateSettingsInert();
}

$('stats-toggle').addEventListener('click', () => setStatsOpen(!statsOpen));
$('st-close').addEventListener('click', () => setStatsOpen(false));
$('st-reset').addEventListener('click', async () => {
  if (confirm('Reset all popup statistics? This can’t be undone.')) await chrome.storage.local.remove('stats');
});

function li(...cells) {
  const item = document.createElement('li');
  for (const cell of cells) item.append(cell);
  return item;
}

function span(text, className) {
  const el = document.createElement('span');
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

async function renderStats() {
  const stats = await getStats();
  const week = lastDays(stats, 7);
  const today = week.at(-1).count;

  $('total-chip').textContent = fmt(stats.total);
  $('st-total').textContent = fmt(stats.total);
  $('st-today').textContent = fmt(today);
  $('st-week').textContent = fmt(week.reduce((sum, d) => sum + d.count, 0));
  $('st-empty').hidden = stats.total > 0;
  $('st-details').hidden = stats.total === 0;

  // 7-day chart
  const max = Math.max(1, ...week.map((d) => d.count));
  $('st-chart').replaceChildren(
    ...week.map(({ date, count }, i) => {
      const day = document.createElement('div');
      day.className = `day${i === week.length - 1 ? ' today' : ''}`;
      day.title = `${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${fmt(count)}`;
      const wrap = document.createElement('div');
      wrap.className = 'bar-wrap';
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.height = `${(count / max) * 100}%`;
      wrap.append(bar);
      const label = document.createElement('small');
      label.textContent = date.toLocaleDateString(undefined, { weekday: 'narrow' });
      day.append(wrap, label);
      return day;
    }),
  );

  // per site
  const siteRows = Object.entries(stats.sites).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const top = siteRows[0]?.[1] ?? 1;
  $('st-sites').replaceChildren(
    ...siteRows.map(([site, n]) => {
      const meter = span('', 'meter');
      const fill = document.createElement('span');
      fill.style.width = `${(n / top) * 100}%`;
      meter.append(fill);
      return li(span(site, 'name'), span(fmt(n), 'n'), meter);
    }),
  );

  // how they were stopped: Layer 2 (before opening) vs Layer 1 (closed after opening)
  const closed = stats.kinds.closed ?? 0;
  const before = stats.total - closed;
  const pct = (n) => `${Math.round((n / Math.max(1, stats.total)) * 100)}%`;
  $('st-split').querySelector('.before').style.width = pct(before);
  $('st-split').querySelector('.closed').style.width = pct(closed);
  $('st-before').textContent = pct(before);
  $('st-closed').textContent = pct(closed);
  $('st-kinds').replaceChildren(
    ...Object.entries(KINDS)
      .filter(([kind]) => stats.kinds[kind])
      .sort((a, b) => stats.kinds[b[0]] - stats.kinds[a[0]])
      .map(([kind, label]) => li(span(label), span(fmt(stats.kinds[kind])))),
  );

  if (statsOpen) setStatsOpen(true); // re-fit height after content changed
}

chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.stats) renderStats();
});
await renderStats();

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
