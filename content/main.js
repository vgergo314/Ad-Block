// Layer 2 — runs in the PAGE's JS world at document_start, before any site script,
// in EVERY frame of EVERY site. Ad scripts grab a reference to window.open on load,
// so the guards must be in place first, even in a voe.sx player frame whose
// domain changes every load.
//
// The guards start in pass-through mode and only block once content/bridge.js
// says this frame's TAB (its address bar) is on a protected site. On normal
// sites every call goes straight to the real browser function.
// No chrome.* APIs here; bridge.js talks to us with 'popupguard:state' events.
(() => {
  // An older build may have registered this file a second time; run once.
  const ONCE = Symbol.for('popup-guard');
  if (window[ONCE]) return;
  Object.defineProperty(window, ONCE, { value: true });

  let active = false; // is this frame's tab on a protected site?
  let allowUntil = 0; // "Let the next popup through" deadline

  // Page scripts must not be able to send a fake "not protected" state. bridge.js
  // sends a random key in 'popupguard:hello' before any page script runs; every
  // later state event must carry it. These listeners are the first ones on
  // window, so stopImmediatePropagation keeps page scripts from seeing the key.
  // Chrome doesn't guarantee which of the two scripts runs first in a frame, so
  // whichever runs second completes the handshake (see 'popupguard:main-ready').
  let key = null;
  window.addEventListener(
    'popupguard:hello',
    (e) => {
      e.stopImmediatePropagation();
      if (key === null && typeof e.detail === 'string') key = e.detail;
    },
    true,
  );
  window.addEventListener(
    'popupguard:state',
    (e) => {
      e.stopImmediatePropagation();
      try {
        const msg = JSON.parse(e.detail);
        if (key !== null && msg.key === key) ({ active, allowUntil } = msg);
      } catch {}
    },
    true,
  );
  // If bridge.js ran first, its hello went unheard; this asks it to resend.
  window.dispatchEvent(new CustomEvent('popupguard:main-ready'));

  const passThrough = () => !active || allowUntil > Date.now();

  const ownHost = location.hostname;

  // Same logic as lib/sites.js baseDomain (page scripts can't import extension modules).
  const baseDomain = (host) =>
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') ? host : host.split('.').slice(-2).join('.');

  /** Not http(s) (about:blank, blob:, data:) counts as foreign — pop-unders open blank then redirect. */
  const isForeign = (url) => {
    try {
      const u = new URL(url || 'about:blank', location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
      return baseDomain(u.hostname) !== baseDomain(ownHost);
    } catch {
      return true;
    }
  };

  const report = (kind) => window.dispatchEvent(new CustomEvent('popupguard:blocked', { detail: kind }));

  // Some scripts check the return value and fall back to another trick on null,
  // so hand back something that looks like a window that opened fine.
  const fakeWindow = () => ({
    closed: false,
    opener: null,
    location: { href: 'about:blank', replace() {}, assign() {} },
    document: { write() {}, writeln() {}, open() {}, close() {} },
    focus() {},
    blur() {},
    close() { this.closed = true; },
    postMessage() {},
  });

  /** target="_blank" or any named target other than this frame/its parents. */
  const opensNewTab = (target) => {
    const t = (target || '').toLowerCase();
    return t !== '' && t !== '_self' && t !== '_top' && t !== '_parent';
  };

  // tagName instead of instanceof: methods borrowed from an iframe's realm are
  // called on *our* elements, where a cross-realm instanceof would fail.
  const isPopupLink = (a) => a?.tagName === 'A' && !!a.href && opensNewTab(a.target) && isForeign(a.href);
  // Read attributes directly: an <input name="target"> inside the form shadows form.target.
  const attr = (el, name) => (el ? Element.prototype.getAttribute.call(el, name) : null);
  const isPopupForm = (f, submitter) =>
    f?.tagName === 'FORM' &&
    opensNewTab(attr(submitter, 'formtarget') ?? attr(f, 'target')) &&
    isForeign(attr(submitter, 'formaction') ?? attr(f, 'action') ?? location.href);

  // --- unprotected sites: notice popup tricks (for "Protect this site?") ----
  // Nothing is blocked here; bridge.js tallies these per site. Real links and
  // buttons (share, "log in with…") don't count: only hidden links/forms,
  // invisible overlays, and popups opened by clicking something that isn't a
  // link or button (like a video).
  let lastPress = { at: 0, interactive: false };
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isTrusted) return;
      const el = e.target instanceof Element ? e.target : null;
      lastPress = {
        at: Date.now(),
        interactive: !!el?.closest('a[href],button,input,select,textarea,label,summary,[role="button"],[role="link"]'),
      };
    },
    true,
  );

  let lastSuspect = 0;
  const suspect = (kind) => {
    if (active || Date.now() - lastSuspect < 800) return; // one click = one trick
    lastSuspect = Date.now();
    window.dispatchEvent(new CustomEvent('popupguard:suspect', { detail: kind }));
  };
  const looksSneaky = (kind) =>
    kind !== 'notification' &&
    (kind !== 'window.open' || !(lastPress.interactive && Date.now() - lastPress.at < 1000));

  // Proxies keep toString() returning "[native code]" — the aniwaves ad script
  // checks exactly that and switches tricks if a function looks patched.
  const guard = (realFn, shouldBlock, kind, blockedResult) =>
    new Proxy(realFn, {
      apply(fn, thisArg, args) {
        if (passThrough() || !shouldBlock(thisArg, args)) {
          if (!active && looksSneaky(kind) && shouldBlock(thisArg, args)) suspect(kind);
          return Reflect.apply(fn, thisArg, args);
        }
        report(kind);
        return blockedResult?.(args);
      },
    });

  const patchMethod = (proto, name, shouldBlock, kind, blockedResult) => {
    if (proto?.[name]) proto[name] = guard(proto[name], shouldBlock, kind, blockedResult);
  };

  // --- install every guard on a window (ours, and any same-origin iframe's) ----

  const patched = new WeakSet();
  const patchWindow = (win) => {
    try {
      if (!win || patched.has(win)) return;
      patched.add(win);

      // Left writable: some normal sites' libraries wrap window.open themselves.
      Object.defineProperty(win, 'open', {
        value: guard(win.open, (_, [url]) => isForeign(url), 'window.open', fakeWindow),
        writable: true,
        configurable: true,
      });

      // Trick: build a hidden <a target=_blank> and click it from script.
      patchMethod(win.HTMLAnchorElement?.prototype, 'click', (a) => isPopupLink(a), 'link');
      patchMethod(
        win.EventTarget?.prototype,
        'dispatchEvent',
        (el, [event]) => event?.type === 'click' && isPopupLink(el),
        'link',
        () => false,
      );

      // Trick: hidden <form target=_blank method=GET> + submit(). The aniwaves
      // script uses this when it thinks an ad blocker is hiding its bait element.
      patchMethod(win.HTMLFormElement?.prototype, 'submit', (f) => isPopupForm(f), 'form');
      patchMethod(win.HTMLFormElement?.prototype, 'requestSubmit', (f, [submitter]) => isPopupForm(f, submitter), 'form');

      // "Allow notifications?" prompts (often behind fake "click Allow to prove
      // you're not a robot" boxes). On protected tabs these answer "denied"
      // without Chrome showing anything. Nothing here can ever grant permission,
      // and nothing is saved to Chrome's site settings.
      patchMethod(win.Notification, 'requestPermission', () => true, 'notification', ([callback]) => {
        if (typeof callback === 'function') callback('denied'); // old callback form
        return Promise.resolve('denied');
      });
      patchMethod(win.PushManager?.prototype, 'subscribe', () => true, 'notification', () =>
        Promise.reject(new DOMException('Permission denied.', 'NotAllowedError')),
      );
    } catch {
      // cross-origin frame — Layer 1 still covers it
    }
  };
  patchWindow(window);

  // Trick: create a blank iframe and borrow its pristine window.open / prototypes.
  const cwDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    ...cwDesc,
    get() {
      const win = cwDesc.get.call(this);
      patchWindow(win);
      return win;
    },
  });
  const cdDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument');
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', {
    ...cdDesc,
    get() {
      const doc = cdDesc.get.call(this);
      patchWindow(doc?.defaultView);
      return doc;
    },
  });

  // --- real user clicks / submits ----------------------------------------------

  // Real clicks on foreign new-tab links (often a full-page invisible <a> over the player).
  const onRealClick = (e) => {
    if (passThrough()) return;
    const a = e.target instanceof Element ? e.target.closest('a') : null;
    if (isPopupLink(a)) {
      e.preventDefault();
      report('link');
    }
  };
  window.addEventListener('click', onRealClick, true);
  window.addEventListener('auxclick', onRealClick, true);

  window.addEventListener(
    'submit',
    (e) => {
      if (!passThrough() && isPopupForm(e.target, e.submitter)) {
        e.preventDefault();
        report('form');
      }
    },
    true,
  );

  // --- tab-under: script sends THIS tab to an ad ---------------------------
  // Chrome announces every navigation of the top page before it starts and
  // says whether the user started it (a real link click, a form they sent).
  // On protected tabs, a script-started jump to another site is cancelled.
  // Typed addresses, bookmarks and back/forward aren't cancelable, so they
  // never reach this check. Jumps started by a cross-site frame (the player
  // doing top.location = ad) can't be cancelled from here at all; the
  // background's tab-under fallback sends those back.
  if (window === window.top && window.navigation) {
    // Chrome also calls it "user started" when the click was inside a frame
    // (e.g. the player doing top.location = ad). Only trust it if the user
    // clicked or typed in THIS page just before.
    let lastOwnInput = 0;
    const noteInput = (e) => {
      if (e.isTrusted) lastOwnInput = Date.now();
    };
    for (const type of ['pointerdown', 'keydown', 'click']) window.addEventListener(type, noteInput, true);

    navigation.addEventListener('navigate', (e) => {
      if (passThrough() || !e.cancelable || e.navigationType === 'reload' || e.navigationType === 'traverse') return;
      if (!isForeign(e.destination.url)) return;
      if (e.userInitiated && Date.now() - lastOwnInput < 1000) {
        // Tell the background this one is the user's, so its fallback leaves it alone.
        window.dispatchEvent(new CustomEvent('popupguard:usernav'));
        return;
      }
      e.preventDefault();
      report('tab-under');
    });
  }

  // --- invisible overlays -------------------------------------------------

  const TRANSPARENT = new Set(['transparent', 'rgba(0, 0, 0, 0)']);

  /** A big, see-through, empty layer sitting on top of the page = click-jacking overlay. */
  const isOverlay = (el) => {
    if (!(el instanceof HTMLElement) || el === document.body || el === document.documentElement) return false;
    const s = getComputedStyle(el);
    if (s.position !== 'fixed' && s.position !== 'absolute') return false;

    const r = el.getBoundingClientRect();
    if (r.width * r.height < innerWidth * innerHeight * 0.3) return false;

    const invisible =
      Number(s.opacity) < 0.1 || (TRANSPARENT.has(s.backgroundColor) && s.backgroundImage === 'none');
    const empty = !el.textContent.trim() && !el.querySelector('img,video,iframe,svg,canvas,button,input,select,textarea');
    return invisible && empty;
  };

  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isTrusted) return;
      const layer = e.target instanceof Element ? e.target.closest('a,div,span,ins') : null;
      if (!isOverlay(layer)) return;
      if (!active) return suspect('overlay'); // unprotected: just notice it
      if (passThrough()) return;
      // Hide it now so the next click lands on the real player. Any popup this
      // click still triggers is caught by the window.open / link guards above.
      layer.style.setProperty('display', 'none', 'important');
      report('overlay');
    },
    true,
  );
})();
