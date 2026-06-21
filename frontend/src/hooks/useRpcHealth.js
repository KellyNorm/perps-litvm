import { useEffect, useState } from "react";
import { subscribeRpcHealth, getRpcDegraded } from "../lib/rpcHealth.js";

// Subscribe to the global RPC-health signal. Returns true while the last read exhausted
// its retries on a transient transport error (drives the "reconnecting…" indicator);
// flips back to false as soon as any wrapped read succeeds again.
export function useRpcHealth() {
  const [degraded, setDegraded] = useState(getRpcDegraded());
  useEffect(() => subscribeRpcHealth(setDegraded), []);
  return degraded;
}
