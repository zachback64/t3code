// @effect-diagnostics globalTimers:off - Display timing for React hooks, outside an Effect runtime.
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";

export type ThreadSyncPhase = "loading" | "syncing" | "load-failed" | "sync-failed";

/** Whether the thread's messages have not arrived yet (loading, or failed to). */
export function isThreadDetailLoading(phase: ThreadSyncPhase | null): boolean {
  return phase === "loading" || phase === "load-failed";
}

export function isThreadSyncFailed(phase: ThreadSyncPhase | null): boolean {
  return phase === "load-failed" || phase === "sync-failed";
}

export function resolveThreadSyncPhase(input: {
  readonly detailExists: boolean;
  readonly shellExists: boolean;
  readonly status: EnvironmentThreadStatus;
  readonly hasError: boolean;
}): ThreadSyncPhase | null {
  if (!input.shellExists) {
    return null;
  }

  switch (input.status) {
    case "empty":
    case "cached":
    case "synchronizing":
      if (input.hasError) return input.detailExists ? "sync-failed" : "load-failed";
      return input.detailExists ? "syncing" : "loading";
    case "deleted":
    case "live":
      return null;
  }
}

export function threadSyncLabel(phase: ThreadSyncPhase): string {
  switch (phase) {
    case "loading":
      return "Loading messages...";
    case "syncing":
      return "Syncing messages...";
    case "load-failed":
      return "Couldn't load messages.";
    case "sync-failed":
      return "Couldn't sync messages.";
  }
}

/** How long a loading or syncing row stays up before it offers a manual retry. */
export const THREAD_SYNC_STALL_MS = 30_000;
/** Waits before each automatic retry of a failed thread sync. */
export const THREAD_SYNC_RETRY_DELAYS_MS: ReadonlyArray<number> = [1_000, 4_000, 15_000];

export interface ThreadSyncRecovery {
  /**
   * Reports the raw sync phase for `key` (a thread). Returns the phase to
   * show: a failure reads as the phase it interrupted while automatic retries
   * remain, and as failed once they run out.
   */
  readonly update: (key: string, phase: ThreadSyncPhase | null) => ThreadSyncPhase | null;
  /** Cancels a pending retry. */
  readonly dispose: () => void;
}

/**
 * Retries a failed thread sync a few times before surfacing the failure, so
 * a state machine that died (for example on a storage error) restarts on its
 * own instead of leaving the thread on "Loading messages..." forever.
 * `onRetried` fires after each automatic retry; call `update` again then, since
 * a retry that fails the same way may not change the raw phase.
 */
export function createThreadSyncRecovery(input: {
  readonly retry: (key: string) => void;
  readonly onRetried: () => void;
  readonly delaysMs?: ReadonlyArray<number>;
}): ThreadSyncRecovery {
  const delaysMs = input.delaysMs ?? THREAD_SYNC_RETRY_DELAYS_MS;
  let key = "";
  let attempts = 0;
  let exhausted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  return {
    update: (nextKey, phase) => {
      if (nextKey !== key) {
        key = nextKey;
        attempts = 0;
        exhausted = false;
        clearTimer();
      }
      if (phase === null) {
        // In sync again: the next failure gets a fresh set of retries.
        attempts = 0;
        exhausted = false;
        clearTimer();
        return null;
      }
      if (!isThreadSyncFailed(phase)) {
        // Recovered by itself (the subscription retries expected failures).
        exhausted = false;
        clearTimer();
        return phase;
      }
      if (exhausted) return phase;
      if (timer === undefined) {
        const delay = delaysMs[attempts];
        if (delay === undefined) {
          exhausted = true;
          return phase;
        }
        const retryKey = key;
        timer = setTimeout(() => {
          timer = undefined;
          attempts += 1;
          input.retry(retryKey);
          input.onRetried();
        }, delay);
      }
      return phase === "load-failed" ? "loading" : "syncing";
    },
    dispose: clearTimer,
  };
}
