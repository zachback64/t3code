import {
  CommandId,
  type OrchestrationProject,
  type OrchestrationReadModel,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const project = (id: string, deletedAt: string | null = null): OrchestrationProject => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot: `/tmp/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt,
});

function makeReadModel(input: {
  readonly worktreePath?: string | null;
  readonly branch?: string | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [project("inbox"), project("winghopper"), project("gone", NOW)],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("inbox"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: input.branch ?? null,
        worktreePath: input.worktreePath ?? null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const move = (projectId: string, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.meta.update",
      commandId: CommandId.make(`cmd-move-${projectId}`),
      threadId: ThreadId.make("thread-1"),
      projectId: ProjectId.make(projectId),
    },
    readModel,
  }).pipe(Effect.map((result) => (Array.isArray(result) ? result : [result])));

it.layer(NodeServices.layer)("thread project move decider", (it) => {
  it.effect("moves a thread and drops the branch of the old repository", () =>
    Effect.gen(function* () {
      const [event] = yield* move("winghopper", makeReadModel({ branch: "main" }));
      expect(event?.type).toBe("thread.meta-updated");
      if (event?.type === "thread.meta-updated") {
        expect(event.payload.projectId).toBe("winghopper");
        expect(event.payload.branch).toBeNull();
      }
    }),
  );

  it.effect("rejects moves to a deleted project or out of a worktree", () =>
    Effect.gen(function* () {
      const deleted = yield* Effect.flip(move("gone", makeReadModel({})));
      expect(deleted.message).toContain("deleted");
      const worktree = yield* Effect.flip(
        move("winghopper", makeReadModel({ worktreePath: "/tmp/inbox-wt" })),
      );
      expect(worktree.message).toContain("worktree");
    }),
  );

  it.effect("leaves the project alone when the target is the current project", () =>
    Effect.gen(function* () {
      const [event] = yield* move("inbox", makeReadModel({ branch: "main" }));
      if (event?.type === "thread.meta-updated") {
        expect(event.payload.projectId).toBeUndefined();
        expect(event.payload.branch).toBeUndefined();
      }
    }),
  );
});
