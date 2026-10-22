// Mimics the aniwaves pop-under script (qh.outdobankmen.com), de-obfuscated.
(() => {
  // "Same-site tab that redirects" trick, second half: the copy of the page jumps to the ad.
  const step1 = new URLSearchParams(location.search).get('step1');
  if (step1) location.replace(step1);

  // Grab window.open on load; if it looks patched, borrow a pristine one from a fresh iframe.
  const isNative = (fn) => { try { return fn.toString().includes('[native code]'); } catch { return false; } };
  const cachedOpen = window.open;
  window.__adOpen = (url) => {
    if (isNative(cachedOpen)) return cachedOpen.call(window, url, '_blank');
    const f = document.createElement('iframe');
    document.body.append(f);
    setTimeout(() => f.remove(), 1000);
    return f.contentWindow.open.call(window, url, '_blank');
  };

  // Route used when the script's ad-bait element gets hidden by an ad blocker.
  window.__adForm = (url) => {
    const form = document.createElement('form');
    const u = new URL(url, location.href);
    form.setAttribute('action', u.origin + u.pathname);
    form.setAttribute('method', 'GET');
    form.setAttribute('target', '_blank');
    form.style.display = 'none';
    u.searchParams.forEach((value, name) => {
      const input = document.createElement('input');
      Object.assign(input, { type: 'hidden', name, value });
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
    document.body.removeChild(form);
  };
})();
