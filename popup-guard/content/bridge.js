// Isolated-world helper: relays between content/main.js (page world, no chrome.* APIs)
// and the background worker.

// Background may also inject this into an already-open player frame; run once.
if (!globalThis.__popupGuardBridge) {
  globalThis.__popupGuardBridge = true;

  const setAllowUntil = (until) => {
    if (document.documentElement) document.documentElement.dataset.pgAllowUntil = String(until);
  };

  window.addEventListener('popupguard:blocked', () => {
    chrome.runtime.sendMessage({ type: 'blocked' }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'allow') setAllowUntil(msg.until);
  });

  // Pick up an "allow next popup" that was granted before this page/frame loaded.
  chrome.runtime.sendMessage({ type: 'getAllow' }).then((until) => until && setAllowUntil(until)).catch(() => {});
}
