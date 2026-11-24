'use strict';

/* =========================================================================
   Delayed tooltips: any element with a data-tip="…" attribute shows that
   text after the mouse rests on it (or keyboard focus reaches it) for 1 s.
   Touch screens never show them, since there is no hovering there.
   ========================================================================= */

(() => {
  const DELAY_MS = 1000;
  const MARGIN = 8; // gap from the element and from the window edges

  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.id = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);

  let timer = null;
  let target = null;

  function show(el) {
    const text = el.dataset.tip;
    if (!text || !el.isConnected) return;
    tip.textContent = text;

    // measure, then place below the element (above if it doesn't fit), inside the window
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - t.width - MARGIN));
    let top = r.bottom + MARGIN;
    if (top + t.height > window.innerHeight - MARGIN) top = r.top - t.height - MARGIN;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;

    tip.classList.add('visible');
    el.setAttribute('aria-describedby', 'tooltip');
  }

  function hide() {
    clearTimeout(timer);
    timer = null;
    tip.classList.remove('visible');
    if (target) target.removeAttribute('aria-describedby');
    target = null;
  }

  function schedule(el) {
    hide();
    target = el;
    timer = setTimeout(() => { if (target === el) show(el); }, DELAY_MS);
  }

  // mouse
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest('[data-tip]');
    if (el === target) return;
    if (el) schedule(el); else hide();
  });
  document.addEventListener('pointerout', (e) => {
    if (target && !target.contains(e.relatedTarget)) hide();
  });

  // keyboard (Tab key)
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el && el.matches(':focus-visible')) schedule(el);
  });
  document.addEventListener('focusout', hide);

  // anything else the user does hides it right away
  for (const type of ['pointerdown', 'keydown', 'scroll', 'wheel']) {
    document.addEventListener(type, hide, { capture: true, passive: true });
  }
  window.addEventListener('blur', hide);
})();
