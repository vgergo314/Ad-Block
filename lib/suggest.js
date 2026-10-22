// "Protect this site?" suggestions. Unprotected sites that use popup tricks
// get a tally in chrome.storage.local (site name + count, nothing else);
// entries untouched for KEEP_DAYS are dropped. "Not this site" is permanent.

export const SUGGEST_AFTER = 3;
const KEEP_DAYS = 30;

export async function getSuggestState() {
  const { suspects = {}, dismissed = [] } = await chrome.storage.local.get(['suspects', 'dismissed']);
  return { suspects, dismissed };
}

/** Adds one trick for `site` in place and drops stale entries. */
export function addSuspect(suspects, site, now = Date.now()) {
  suspects[site] = { count: (suspects[site]?.count ?? 0) + 1, last: now };
  for (const [key, entry] of Object.entries(suspects)) {
    if (now - entry.last > KEEP_DAYS * 86_400_000) delete suspects[key];
  }
  return suspects;
}

/** How many tricks `site` used, if it should be suggested now; otherwise 0. */
export function suggestionFor(site, { suspects, dismissed }) {
  const count = suspects[site]?.count ?? 0;
  return site && count >= SUGGEST_AFTER && !dismissed.includes(site) ? count : 0;
}
