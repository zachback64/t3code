import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useReducer, useState } from "react";

import { retryEnvironmentThread } from "../state/threads";
import { createThreadSyncRecovery, type ThreadSyncPhase } from "../threadSync";

function retryThreadByKey(key: string): void {
  const ref = parseScopedThreadKey(key);
  if (ref !== null) retryEnvironmentThread(ref);
}

/**
 * Returns the thread sync phase to show. A failed sync restarts on its own a
 * few times before it reads as failed, where the composer offers Retry.
 */
export function useThreadSyncRecovery(
  ref: ScopedThreadRef | null,
  phase: ThreadSyncPhase | null,
): ThreadSyncPhase | null {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const [recovery] = useState(() =>
    createThreadSyncRecovery({ retry: retryThreadByKey, onRetried: rerender }),
  );
  useEffect(() => () => recovery.dispose(), [recovery]);
  return recovery.update(ref === null ? "" : scopedThreadKey(ref), phase);
}
