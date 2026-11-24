'use strict';

/* =========================================================================
   Help panel: how to enable Web Bluetooth per browser.
   Detects the current browser and opens its section first.
   ========================================================================= */

(() => {
  const dialog = $('helpDialog');

  function detectBrowser() {
    const ua = navigator.userAgent;
    // iPads report themselves as Macs, but have touch screens
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
    if (navigator.brave) return 'brave';
    if (/Firefox\//.test(ua)) return 'firefox';
    if (/Safari\//.test(ua) && !/Chrome\/|Chromium\//.test(ua)) return 'safari';
    if (/Chrome\//.test(ua)) return 'chrome';
    return null;
  }

  const mine = detectBrowser();
  for (const item of dialog.querySelectorAll('details[data-browser]')) {
    const isMine = item.dataset.browser === mine;
    item.classList.toggle('mine', isMine);
    item.open = isMine;
  }

  function openHelp(e) {
    if (e) e.preventDefault();
    dialog.showModal();
  }

  $('helpBtn').addEventListener('click', openHelp);
  $('unsupportedHelp').addEventListener('click', openHelp);
  $('helpClose').addEventListener('click', () => dialog.close());

  dialog.addEventListener('click', async (e) => {
    // a click on the dark area around the panel lands on the dialog itself
    if (e.target === dialog) { dialog.close(); return; }

    // "Copy" buttons next to settings addresses
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Copy failed';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
})();
