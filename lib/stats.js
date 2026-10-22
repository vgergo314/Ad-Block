// All-time block statistics, kept in chrome.storage.local (this computer only;
// sync storage limits how often it can be written). Only day totals are kept,
// for the last KEEP_DAYS days, plus running totals per site and per kind.

const KEEP_DAYS = 90;

/** How a popup was stopped. 'closed' is Layer 1 (opened, then closed); the rest are Layer 2. */
export const KINDS = {
  'window.open': 'Popup call',
  link: 'Hidden link',
  form: 'Hidden form',
  overlay: 'Invisible overlay',
  closed: 'Closed after opening',
};

/** Local-time "YYYY-MM-DD". */
export function dayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const emptyStats = () => ({ total: 0, days: {}, sites: {}, kinds: {} });

export async function getStats() {
  const { stats } = await chrome.storage.local.get('stats');
  return { ...emptyStats(), ...stats };
}

/** Adds one block to `stats` in place and drops days older than KEEP_DAYS. */
export function addBlock(stats, site, kind, now = new Date()) {
  const today = dayKey(now);
  stats.total += 1;
  stats.days[today] = (stats.days[today] ?? 0) + 1;
  if (site) stats.sites[site] = (stats.sites[site] ?? 0) + 1;
  stats.kinds[kind] = (stats.kinds[kind] ?? 0) + 1;

  const oldest = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - KEEP_DAYS));
  for (const day of Object.keys(stats.days)) if (day < oldest) delete stats.days[day];
  return stats;
}

/** The last `n` days, oldest first, including days with no blocks. */
export function lastDays(stats, n, now = new Date()) {
  return Array.from({ length: n }, (_, i) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1 - i));
    return { date, count: stats.days[dayKey(date)] ?? 0 };
  });
}
