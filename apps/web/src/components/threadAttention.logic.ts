import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";

import { firstValidTimestampMs, resolveThreadStatusPill } from "./Sidebar.logic";

// ── Attention navigation ────────────────────────────────────────────
// "Next attention" walks the threads that are waiting on the user, in the
// order a person would triage them: anything blocked on the user first
// (approval, question, actionable plan), then finished turns the user has
// not read. Working, monitoring, and read threads never join the queue, so
// the command never cycles through threads that need nothing.

export type ThreadAttentionTier = "input" | "unread";

const TIER_RANK: Record<ThreadAttentionTier, number> = { input: 0, unread: 1 };

/**
 * Derived from the sidebar's own status pill so the queue always matches what
 * the rows show: a thread is "input" exactly when its pill asks for a
 * decision, and "unread" exactly when it shows Completed.
 */
export function resolveThreadAttentionTier(
  thread: EnvironmentThreadShell,
  lastVisitedAt: string | undefined,
): ThreadAttentionTier | null {
  const pill = resolveThreadStatusPill({ thread: { ...thread, lastVisitedAt } });
  switch (pill?.label) {
    case "Pending Approval":
    case "Awaiting Input":
    case "Plan Ready":
      return "input";
    case "Completed":
      return "unread";
    default:
      return null;
  }
}

// Shells carry no "request raised at" stamp. A thread blocked on the user
// makes no further progress, so its last update is when it started waiting.
// An unread thread has waited since its turn completed.
function waitingSinceMs(thread: EnvironmentThreadShell, tier: ThreadAttentionTier): number {
  return tier === "unread"
    ? firstValidTimestampMs(thread.latestTurn?.completedAt, thread.updatedAt)
    : firstValidTimestampMs(thread.updatedAt, thread.latestTurn?.completedAt);
}

/**
 * Thread keys that need the user, highest tier first and oldest wait first
 * within a tier. Archived, settled, and currently snoozed threads are out of
 * the inbox and stay out of the queue.
 */
export function buildThreadAttentionQueue(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly lastVisitedAtByKey: Readonly<Record<string, string>>;
  readonly now: string;
}): string[] {
  const entries: { key: string; tier: ThreadAttentionTier; waitingSince: number }[] = [];
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    if (thread.settledOverride === "settled") continue;
    if (effectiveSnoozed(thread, { now: input.now })) continue;
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const tier = resolveThreadAttentionTier(thread, input.lastVisitedAtByKey[key]);
    if (tier === null) continue;
    entries.push({ key, tier, waitingSince: waitingSinceMs(thread, tier) });
  }
  entries.sort(
    (left, right) =>
      TIER_RANK[left.tier] - TIER_RANK[right.tier] ||
      left.waitingSince - right.waitingSince ||
      left.key.localeCompare(right.key),
  );
  return entries.map((entry) => entry.key);
}

/**
 * The thread after the current one in the queue, wrapping to the front. From
 * outside the queue (a read or working thread, or no thread) that is the head.
 * Null when nothing other than the current thread needs attention.
 */
export function resolveNextAttentionThreadKey(input: {
  readonly queue: ReadonlyArray<string>;
  readonly currentThreadKey: string | null;
}): string | null {
  const { queue, currentThreadKey } = input;
  const currentIndex = currentThreadKey === null ? -1 : queue.indexOf(currentThreadKey);
  if (currentIndex === -1) return queue[0] ?? null;
  const next = queue[(currentIndex + 1) % queue.length] ?? null;
  return next === currentThreadKey ? null : next;
}

/**
 * Pops the attention trail (the threads the user left via "next attention")
 * back to the most recent one that still exists and is not the current
 * thread. Returns the target and the remaining trail; a null target means the
 * trail is spent.
 */
export function popAttentionTrail(input: {
  readonly trail: ReadonlyArray<string>;
  readonly currentThreadKey: string | null;
  readonly exists: (threadKey: string) => boolean;
}): { readonly target: string | null; readonly trail: string[] } {
  const trail = [...input.trail];
  for (let candidate = trail.pop(); candidate !== undefined; candidate = trail.pop()) {
    if (candidate !== input.currentThreadKey && input.exists(candidate)) {
      return { target: candidate, trail };
    }
  }
  return { target: null, trail };
}
