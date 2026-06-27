/* ============================================================================
   BRACE — The Modern Shooting Log · interactions
   Restraint over flourish: a precision instrument, not a startup.
   ========================================================================== */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Sticky condensing header ---------------------------------- */
  var header = document.getElementById('header');
  var lastKnown = 0, ticking = false;
  function onScroll() {
    lastKnown = window.scrollY;
    if (!ticking) {
      window.requestAnimationFrame(function () {
        header.classList.toggle('is-condensed', lastKnown > 24);
        ticking = false;
      });
      ticking = true;
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- Mobile navigation sheet ----------------------------------- */
  var toggle = document.getElementById('navToggle');
  var closeBtn = document.getElementById('navClose');
  var sheet = document.getElementById('mobileNav');
  var mainEl = document.getElementById('main');
  function setNav(open) {
    sheet.classList.toggle('is-open', open);
    sheet.setAttribute('aria-hidden', String(!open));
    toggle.setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
    // Make the rest of the page unfocusable to AT/keyboard while the dialog is open
    if (mainEl) { try { mainEl.inert = open; } catch (e) {} }
    if (header) { try { header.inert = open; } catch (e) {} }
    if (open) { var first = sheet.querySelector('a'); if (first) first.focus(); }
  }
  // Focus trap fallback for browsers without inert support
  if (sheet) sheet.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab' || !sheet.classList.contains('is-open')) return;
    var f = sheet.querySelectorAll('a[href], button:not([disabled])');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  if (toggle) toggle.addEventListener('click', function () { setNav(true); });
  if (closeBtn) closeBtn.addEventListener('click', function () { setNav(false); toggle.focus(); });
  if (sheet) sheet.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () { setNav(false); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sheet.classList.contains('is-open')) { setNav(false); toggle.focus(); }
  });

  /* ---------- Scroll reveal --------------------------------------------- */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealEls.forEach(function (el) { el.classList.add('reveal', 'in'); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('reveal'); });
    var io = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
    revealEls.forEach(function (el) { io.observe(el); });
  }

  /* ---------- Count-up ledger figures ----------------------------------- */
  var counters = Array.prototype.slice.call(document.querySelectorAll('[data-count]'));
  function formatNum(n) { return n.toLocaleString('en-GB'); }
  function runCount(el) {
    var target = parseInt(el.getAttribute('data-count'), 10) || 0;
    if (reduceMotion) { el.textContent = formatNum(target); return; }
    var dur = 900, start = null;
    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      el.textContent = formatNum(Math.round(target * eased));
      if (p < 1) window.requestAnimationFrame(step);
      else el.textContent = formatNum(target);
    }
    window.requestAnimationFrame(step);
  }
  if (!('IntersectionObserver' in window)) {
    counters.forEach(runCount);
  } else {
    var cio = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { runCount(entry.target); obs.unobserve(entry.target); }
      });
    }, { threshold: 0.6 });
    counters.forEach(function (el) { cio.observe(el); });
  }

  /* ---------- FAQ accordion --------------------------------------------- */
  var faqList = document.getElementById('faqList');
  if (faqList) {
    // Wire ARIA: associate each toggle with its answer panel
    faqList.querySelectorAll('.faq-item').forEach(function (item, i) {
      var b = item.querySelector('.faq-q');
      var pnl = item.querySelector('.faq-a');
      var pid = 'faq-panel-' + (i + 1);
      pnl.id = pid; pnl.setAttribute('role', 'region'); pnl.setAttribute('aria-label', 'Answer');
      b.setAttribute('type', 'button'); b.setAttribute('aria-controls', pid);
    });
    faqList.querySelectorAll('.faq-q').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var item = btn.closest('.faq-item');
        var panel = item.querySelector('.faq-a');
        var isOpen = item.classList.contains('is-open');
        // close any other open item (one at a time)
        faqList.querySelectorAll('.faq-item.is-open').forEach(function (other) {
          if (other !== item) {
            other.classList.remove('is-open');
            other.querySelector('.faq-q').setAttribute('aria-expanded', 'false');
            other.querySelector('.faq-a').style.maxHeight = null;
          }
        });
        item.classList.toggle('is-open', !isOpen);
        btn.setAttribute('aria-expanded', String(!isOpen));
        panel.style.maxHeight = !isOpen ? panel.scrollHeight + 'px' : null;
      });
    });
    // keep open panel sized correctly on resize
    window.addEventListener('resize', function () {
      var open = faqList.querySelector('.faq-item.is-open .faq-a');
      if (open) open.style.maxHeight = open.scrollHeight + 'px';
    });
    // recalc after web fonts swap in (display=swap reflow)
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        var openA = faqList.querySelector('.faq-item.is-open .faq-a');
        if (openA) openA.style.maxHeight = openA.scrollHeight + 'px';
      });
    }
  }

  /* ---------- Founding-member form (mock pre-launch capture) ------------ */
  var form = document.getElementById('signupForm');
  var success = document.getElementById('formSuccess');
  if (form) {
    var emailInput = form.querySelector('#email');
    var errNode = document.getElementById('email-err');
    if (emailInput) emailInput.addEventListener('input', function () {
      emailInput.removeAttribute('aria-invalid');
      emailInput.style.borderColor = '';
      if (errNode) errNode.hidden = true;
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = form.querySelector('#email');
      if (!email.value || !/.+@.+\..+/.test(email.value)) {
        email.setAttribute('aria-invalid', 'true');
        if (errNode) errNode.hidden = false;
        email.style.borderColor = 'var(--c-brass-deep)';
        email.focus();
        return;
      }
      email.removeAttribute('aria-invalid');
      if (errNode) errNode.hidden = true;
      // Pre-launch: no backend yet. Acknowledge locally; a real endpoint drops in here.
      form.style.display = 'none';
      if (success) { success.classList.add('show'); success.focus(); }
      try { window.localStorage.setItem('brace_founding_email', email.value); } catch (err) {}
    });
  }

  /* ---------- Gilt-edge sweep on the game-book card --------------------- */
  var card = document.getElementById('gamebookCard');
  if (card && !reduceMotion && 'IntersectionObserver' in window) {
    var gio = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add('gilt'); obs.unobserve(entry.target); }
      });
    }, { threshold: 0.3 });
    gio.observe(card);
  }
})();
