import { getStats, KINDS, lastDays } from '../lib/stats.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString();
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;
const pct = (n, total) => `${Math.round((n / total) * 100)}%`;

/** Smallest of 1, 2, 5 × 10ⁿ that is ≥ v: a clean top for the axis. */
function niceMax(v) {
  if (v <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= v);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// --- tooltip -------------------------------------------------------------------------

const tooltip = $('tooltip');

/** Shows `value` (bold) over `label` next to the pointer. Text only, never HTML. */
function showTip(e, value, label) {
  tooltip.replaceChildren(el('b', null, value), document.createTextNode(label));
  tooltip.hidden = false;
  const { width, height } = tooltip.getBoundingClientRect();
  const x = Math.min(e.clientX + 12, innerWidth - width - 8);
  const y = e.clientY - height - 12 < 8 ? e.clientY + 16 : e.clientY - height - 12;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

const hideTip = () => { tooltip.hidden = true; };

// --- per-day chart -----------------------------------------------------------------------

let range = 30;
try {
  range = Number(localStorage.getItem('range')) || range;
} catch {}

for (const btn of document.querySelectorAll('.range button')) {
  btn.addEventListener('click', () => {
    range = Number(btn.dataset.days);
    try {
      localStorage.setItem('range', String(range));
    } catch {}
    render();
  });
}

const dayLong = (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const dayShort = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function renderDays(stats) {
  for (const btn of document.querySelectorAll('.range button')) {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.days) === range));
  }

  const days = lastDays(stats, range);
  const top = niceMax(Math.max(...days.map((d) => d.count)));

  // Gridlines at 0, half and the top, wherever those are whole numbers.
  $('grid').replaceChildren(
    ...[0, top / 2, top].filter(Number.isInteger).map((v) => {
      const tick = el('div', v === 0 ? 'tick zero' : 'tick');
      tick.style.bottom = `${(v / top) * 100}%`;
      tick.append(el('span', null, fmt(v)));
      return tick;
    }),
  );

  // Height is exactly count / top: no minimum, so a 0 day draws nothing.
  $('cols').replaceChildren(
    ...days.map(({ date, count }) => {
      const col = el('div', 'col');
      const bar = el('i');
      bar.style.height = `${(count / top) * 100}%`;
      col.append(bar);
      col.addEventListener('pointermove', (e) => showTip(e, plural(count, 'popup'), dayLong(date)));
      col.addEventListener('pointerleave', hideTip);
      return col;
    }),
  );
  $('cols').classList.toggle('dense', range > 30);
  const total = days.reduce((sum, d) => sum + d.count, 0);
  $('cols').setAttribute('aria-label', `Column chart: ${plural(total, 'popup')} blocked in the last ${range} days. The table below lists each day.`);

  // Labels under every column for a week, else every 7th / 15th day counting back from today.
  const step = range <= 7 ? 1 : range <= 30 ? 7 : 15;
  $('xlabels').replaceChildren(
    ...days.flatMap(({ date }, i) => {
      const back = days.length - 1 - i;
      if (back % step) return [];
      const label = el('span', null, back === 0 ? 'Today' : range <= 7 ? date.toLocaleDateString(undefined, { weekday: 'short' }) : dayShort(date));
      label.style.left = `${((i + 0.5) / days.length) * 100}%`;
      return [label];
    }),
  );

  $('day-table').replaceChildren(
    ...days.toReversed().map(({ date, count }) => {
      const row = el('tr');
      row.append(el('td', null, dayLong(date)), el('td', null, fmt(count)));
      return row;
    }),
  );
}

// --- horizontal bar lists ------------------------------------------------------------------

/** One row per [label, count], longest first; each bar is count / the largest count. */
function renderBars(list, entries, total) {
  const rows = entries.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const max = rows[0]?.[1] ?? 1;
  list.replaceChildren(
    ...rows.map(([label, n]) => {
      const row = el('li');
      const name = el('span', 'name', label);
      name.title = label;
      const track = el('span', 'track');
      const bar = el('i');
      bar.style.width = `${(n / max) * 100}%`;
      track.append(bar);
      const value = el('span', 'n', fmt(n));
      value.append(el('small', null, pct(n, total)));
      row.append(name, track, value);
      row.addEventListener('pointermove', (e) => showTip(e, `${plural(n, 'popup')} · ${pct(n, total)}`, label));
      row.addEventListener('pointerleave', hideTip);
      return row;
    }),
  );
}

// --- page --------------------------------------------------------------------------------

async function render() {
  const stats = await getStats();
  const month = lastDays(stats, 30);
  const sum = (days) => days.reduce((s, d) => s + d.count, 0);

  $('t-total').textContent = fmt(stats.total);
  $('t-today').textContent = fmt(month.at(-1).count);
  $('t-week').textContent = fmt(sum(month.slice(-7)));
  $('t-month').textContent = fmt(sum(month));

  $('empty').hidden = stats.total > 0;
  $('details').hidden = stats.total === 0;
  $('reset').hidden = stats.total === 0;
  if (!stats.total) return;

  renderDays(stats);
  renderBars($('sites'), Object.entries(stats.sites), stats.total);
  renderBars($('kinds'), Object.entries(stats.kinds).map(([kind, n]) => [KINDS[kind] ?? kind, n]), stats.total);
}

$('reset').addEventListener('click', async () => {
  if (confirm('Reset all popup statistics? This can’t be undone.')) await chrome.storage.local.remove('stats');
});

chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.stats) render();
});

render();
