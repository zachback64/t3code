import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import {
  buildThreadAttentionQueue,
  popAttentionTrail,
  resolveNextAttentionThreadKey,
  resolveThreadAttentionTier,
} from "./threadAttention.logic";

const environmentId = EnvironmentId.make("environment-local");
const NOW = "2026-03-09T12:00:00.000Z";

function makeShell(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make("project-1"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-03-09T09:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function completedTurn(completedAt: string): EnvironmentThreadShell["latestTurn"] {
  return {
    turnId: TurnId.make(`turn-${completedAt}`),
    state: "completed",
    requestedAt: "2026-03-09T09:00:00.000Z",
    startedAt: "2026-03-09T09:00:01.000Z",
    completedAt,
    assistantMessageId: null,
  };
}

const keyOf = (id: string) => scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
// Visited once before the completions below, so they read as unseen.
const visitedBeforeCompletion = "2026-03-09T08:00:00.000Z";

describe("resolveThreadAttentionTier", () => {
  it("puts approvals, questions, and actionable plans in the input tier", () => {
    expect(
      resolveThreadAttentionTier(makeShell("a", { hasPendingApprovals: true }), undefined),
    ).toBe("input");
    expect(
      resolveThreadAttentionTier(makeShell("b", { hasPendingUserInput: true }), undefined),
    ).toBe("input");
    expect(
      resolveThreadAttentionTier(
        makeShell("c", {
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          latestTurn: completedTurn("2026-03-09T10:00:00.000Z"),
        }),
        undefined,
      ),
    ).toBe("input");
  });

  it("marks a completion newer than the last visit as unread", () => {
    const thread = makeShell("a", { latestTurn: completedTurn("2026-03-09T10:00:00.000Z") });
    expect(resolveThreadAttentionTier(thread, visitedBeforeCompletion)).toBe("unread");
    expect(resolveThreadAttentionTier(thread, "2026-03-09T10:00:00.000Z")).toBeNull();
  });

  it("ignores working threads even with an unread completion", () => {
    const thread = makeShell("a", {
      latestTurn: completedTurn("2026-03-09T10:00:00.000Z"),
      backgroundLiveness: "working",
    });
    expect(resolveThreadAttentionTier(thread, visitedBeforeCompletion)).toBeNull();
  });
});

describe("buildThreadAttentionQueue", () => {
  it("orders input before unread, oldest wait first within each tier", () => {
    const threads = [
      makeShell("unread-new", { latestTurn: completedTurn("2026-03-09T11:00:00.000Z") }),
      makeShell("input-new", { hasPendingUserInput: true, updatedAt: "2026-03-09T11:30:00.000Z" }),
      makeShell("idle"),
      makeShell("unread-old", { latestTurn: completedTurn("2026-03-09T10:00:00.000Z") }),
      makeShell("input-old", { hasPendingApprovals: true, updatedAt: "2026-03-09T09:30:00.000Z" }),
    ];
    const lastVisitedAtByKey = {
      [keyOf("unread-new")]: visitedBeforeCompletion,
      [keyOf("unread-old")]: visitedBeforeCompletion,
    };
    expect(buildThreadAttentionQueue({ threads, lastVisitedAtByKey, now: NOW })).toEqual([
      keyOf("input-old"),
      keyOf("input-new"),
      keyOf("unread-old"),
      keyOf("unread-new"),
    ]);
  });

  it("leaves out archived, settled, and snoozed threads", () => {
    const threads = [
      makeShell("archived", { hasPendingUserInput: true, archivedAt: NOW }),
      makeShell("settled", {
        latestTurn: completedTurn("2026-03-09T10:00:00.000Z"),
        settledOverride: "settled",
      }),
      makeShell("snoozed", {
        latestTurn: completedTurn("2026-03-09T10:00:00.000Z"),
        snoozedAt: "2026-03-09T10:30:00.000Z",
        snoozedUntil: "2026-03-10T09:00:00.000Z",
      }),
    ];
    const lastVisitedAtByKey = Object.fromEntries(
      ["archived", "settled", "snoozed"].map((id) => [keyOf(id), visitedBeforeCompletion]),
    );
    expect(buildThreadAttentionQueue({ threads, lastVisitedAtByKey, now: NOW })).toEqual([]);
  });

  it("keeps a snoozed thread that raised its hand", () => {
    const threads = [
      makeShell("snoozed", {
        hasPendingApprovals: true,
        snoozedAt: "2026-03-09T10:30:00.000Z",
        snoozedUntil: "2026-03-10T09:00:00.000Z",
      }),
    ];
    expect(buildThreadAttentionQueue({ threads, lastVisitedAtByKey: {}, now: NOW })).toEqual([
      keyOf("snoozed"),
    ]);
  });
});

describe("resolveNextAttentionThreadKey", () => {
  const queue = ["a", "b", "c"];

  it("starts at the head from outside the queue", () => {
    expect(resolveNextAttentionThreadKey({ queue, currentThreadKey: null })).toBe("a");
    expect(resolveNextAttentionThreadKey({ queue, currentThreadKey: "read" })).toBe("a");
  });

  it("steps past the current thread and wraps around", () => {
    expect(resolveNextAttentionThreadKey({ queue, currentThreadKey: "a" })).toBe("b");
    expect(resolveNextAttentionThreadKey({ queue, currentThreadKey: "c" })).toBe("a");
  });

  it("is null when nothing else is waiting", () => {
    expect(resolveNextAttentionThreadKey({ queue: [], currentThreadKey: "a" })).toBeNull();
    expect(resolveNextAttentionThreadKey({ queue: ["a"], currentThreadKey: "a" })).toBeNull();
  });
});

describe("popAttentionTrail", () => {
  it("returns the most recent thread that still exists and is not current", () => {
    expect(
      popAttentionTrail({
        trail: ["a", "gone", "b", "current"],
        currentThreadKey: "current",
        exists: (key) => key !== "gone",
      }),
    ).toEqual({ target: "b", trail: ["a", "gone"] });
  });

  it("reports a spent trail", () => {
    expect(
      popAttentionTrail({ trail: ["gone"], currentThreadKey: null, exists: () => false }),
    ).toEqual({ target: null, trail: [] });
  });
});
