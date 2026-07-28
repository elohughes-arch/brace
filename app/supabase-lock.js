// ── A lock that cannot wedge the browser ───────────────────────────────────
//
// auth-js coordinates token refreshes between tabs with the Web Locks API, and
// for getSession() it asks to wait for the lock indefinitely. That is fine
// until one tab stops without releasing it: every other tab in the browser then
// waits for ever inside getSession(), which surfaces as a portal that loads
// nothing, reports nothing, and cannot be signed out of — because signing out
// needs the same lock.
//
// Waiting a few seconds gets the benefit (two tabs do not refresh the same
// token at once) without the failure mode. Losing the race is not dangerous:
// the worst case is a duplicate refresh, which is what browsers without Web
// Locks do all the time — auth-js falls back to no lock at all there.

const ACQUIRE_MS = 1500;

// Once a wait has actually timed out, the holder is not coming back — it is a
// tab that stopped without releasing. Waiting again on every subsequent call
// would add that delay to each of the four auth calls a sign-in makes, so pay
// it once and then behave like a browser without Web Locks at all.
let contended = false;

export async function boundedLock(name, _acquireTimeout, fn) {
  const locks = globalThis.navigator?.locks;
  if (contended || !locks?.request) return fn();   // Safari < 15.4, or a worker

  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), ACQUIRE_MS);
  try {
    return await locks.request(name, { mode: 'exclusive', signal: giveUp.signal }, fn);
  } catch (err) {
    // Only an abort means we never got the lock. Anything else came from fn
    // itself, and running it twice would be worse than not having run it.
    if (err && err.name === 'AbortError') { contended = true; return fn(); }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
