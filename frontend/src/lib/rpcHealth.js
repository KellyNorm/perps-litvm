// Tiny global RPC-connection-health signal. `withRetry` reports here automatically: a
// read that succeeds (possibly after a retry) marks the connection healthy; a read that
// EXHAUSTS its retries on a transient transport error marks it degraded. The UI
// subscribes via useRpcHealth() to show a small "reconnecting…" indicator — we keep the
// last good data on screen and never blank the page on a transient drop.

let degraded = false;
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn(degraded);
}

export function reportHealthy() {
  if (degraded) {
    degraded = false;
    emit();
  }
}

export function reportDegraded() {
  if (!degraded) {
    degraded = true;
    emit();
  }
}

export function getRpcDegraded() {
  return degraded;
}

export function subscribeRpcHealth(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
