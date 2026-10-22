// Shared helpers for the background worker and the popup.
// (content/main.js runs in the page and can't import, so it keeps its own copy of baseDomain.)

export const ALLOW_WINDOW_MS = 10_000;

/** "https://www.Example.com/x" or "example.com" -> "example.com" (null if unparseable). */
export function normalizeHost(input) {
  if (!input) return null;
  try {
    const url = new URL(input.includes('://') ? input : `https://${input.trim()}`);
    return url.hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

export function hostOf(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? hostname : null;
  } catch {
    return null;
  }
}

/** Returns the protected-site entry that covers `hostname` (itself or a parent domain), or null. */
export function matchSite(hostname, sites) {
  const host = hostname.replace(/^www\./, '');
  return sites.find((site) => host === site || host.endsWith(`.${site}`)) ?? null;
}

const isIp = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');

/** Rough "registrable domain": last two labels. Good enough for .com/.ru/.to; treats co.uk-style TLDs too loosely. */
export function baseDomain(hostname) {
  if (isIp(hostname)) return hostname;
  return hostname.split('.').slice(-2).join('.');
}

export const isSameSite = (a, b) => baseDomain(a) === baseDomain(b);

export async function getSites() {
  const { sites = [] } = await chrome.storage.sync.get('sites');
  return sites;
}

/** Master on/off switch in the popup. On unless the user paused it. */
export async function getEnabled() {
  const { enabled = true } = await chrome.storage.sync.get('enabled');
  return enabled;
}
