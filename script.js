/* ============================================================================
   BRACE — landing page
   Two jobs: retire the clay splash once it has played (or immediately, on a
   click / key / reduced-motion), and capture founding members for real.
   ========================================================================== */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SPLASH_MS = 3600;   // flight + break + wordmark draw + dot + curtain

  /* ---------- Splash ---------------------------------------------------- */
  var splash = document.getElementById('splash');

  function endSplash() {
    if (document.body.classList.contains('splash-done')) return;
    document.body.classList.add('splash-done');
    window.removeEventListener('keydown', onKey);
    if (splash) splash.removeEventListener('click', endSplash);
  }
  function onKey(e) {
    if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') endSplash();
  }

  if (reduceMotion) {
    endSplash();
  } else {
    setTimeout(endSplash, SPLASH_MS);
    window.addEventListener('keydown', onKey);
    if (splash) splash.addEventListener('click', endSplash);
  }

  /* ---------- Founding-member capture ----------------------------------- */
  var form = document.getElementById('signupForm');
  var success = document.getElementById('formSuccess');
  var errNode = document.getElementById('email-err');

  if (form) {
    var emailInput = form.querySelector('#email');

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
        if (errNode) { errNode.textContent = 'Enter a valid email address.'; errNode.hidden = false; }
        email.style.borderColor = 'var(--red)';
        email.focus();
        return;
      }
      email.removeAttribute('aria-invalid');
      if (errNode) errNode.hidden = true;

      // Writes to the founding_members table (anon key + RLS: insert-only).
      // 409 = already on the list, which is a success from the visitor's side.
      var SB_URL = 'https://tvcbizxwadibtclamnyy.supabase.co';
      var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR2Y2Jpenh3YWRpYnRjbGFtbnl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1NTcwNzQsImV4cCI6MjA5ODEzMzA3NH0.lH9bdpbc6vdQMMj50fxY8Lin_K-x6x2C-kdyHRsODBA';
      var btn = form.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }

      fetch(SB_URL + '/rest/v1/founding_members', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: SB_KEY,
          authorization: 'Bearer ' + SB_KEY,
          prefer: 'return=minimal',
        },
        body: JSON.stringify({ email: email.value.trim(), source: 'landing' }),
      }).then(function (res) {
        if (!(res.ok || res.status === 409)) throw new Error('capture failed: ' + res.status);
        form.style.display = 'none';
        if (success) { success.classList.add('show'); success.focus(); }
        try { window.localStorage.setItem('brace_founding_email', email.value); } catch (err) {}
      }).catch(function () {
        if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
        if (errNode) {
          errNode.textContent = 'Couldn’t save that just now — try again, or email hello@braceshooting.com.';
          errNode.hidden = false;
        }
      });
    });
  }
})();
