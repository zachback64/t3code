/**
 * Routes a thread out of the auto-routing project: classifies the
 * conversation against candidate projects, registers or creates the target
 * project, moves the thread, and records the move in its timeline.
 *
 * The provider command reactor calls this before a routed turn reaches the
 * provider, so the agent starts in the target project's root.
 *
 * @module ProjectRoutingFlow
 */
import {
  type AutoProjectRoutingSettings,
  CommandId,
  EventId,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  ProjectId,
  THREAD_PROJECT_MOVED_ACTIVITY_KIND,
  type ThreadId,
  ThreadProjectMovedActivityPayload,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { makeProjectRouter } from "./ProjectRouter.ts";
import {
  buildRoutingConversation,
  interpretProjectRoute,
  type ProjectRoutingStage,
  projectRoutingStageForTurn,
  sanitizeProjectName,
} from "./ProjectRouting.ts";

/** Command ids of moves made by the router; any other move is the user's. */
const ROUTER_COMMAND_PREFIX = "server:project-route:";
const CLASSIFY_TIMEOUT = "60 seconds";

const decodeMovedPayload = Schema.decodeUnknownOption(ThreadProjectMovedActivityPayload);

export interface ProjectRoutingContext {
  readonly stage: ProjectRoutingStage;
  readonly settings: AutoProjectRoutingSettings;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly autoProject: OrchestrationProjectShell;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
}

export const isRouterCommandId = (commandId: string | null) =>
  commandId?.startsWith(ROUTER_COMMAND_PREFIX) === true;

export const makeProjectRoutingFlow = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverSettingsService = yield* ServerSettingsService;
  const textGeneration = yield* TextGeneration;
  const router = yield* makeProjectRouter;

  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`${ROUTER_COMMAND_PREFIX}${tag}:${uuid}`)),
    );
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /**
   * The routing a turn start triggers, or null. Only threads in the
   * auto-routing project (and not in a worktree) are routed, on their opening
   * message and once more at the reclassify threshold, unless the user has
   * moved the thread by hand.
   */
  const contextForTurn = Effect.fn("ProjectRoutingFlow.contextForTurn")(function* (
    threadId: ThreadId,
  ) {
    const { autoProjectRouting: settings } = yield* serverSettingsService.getSettings;
    if (!settings.enabled || settings.projectRoot.length === 0) return null;
    const thread = Option.getOrUndefined(
      yield* projectionSnapshotQuery.getThreadShellById(threadId),
    );
    if (!thread || thread.worktreePath !== null) return null;
    const project = Option.getOrUndefined(
      yield* projectionSnapshotQuery.getProjectShellById(thread.projectId),
    );
    if (!project) return null;
    const autoRoot = yield* router.realPath(router.expand(settings.projectRoot));
    if ((yield* router.realPath(project.workspaceRoot)) !== autoRoot) return null;

    const detail = Option.getOrUndefined(
      yield* projectionSnapshotQuery.getThreadDetailById(threadId, {
        activityKinds: [THREAD_PROJECT_MOVED_ACTIVITY_KIND],
      }),
    );
    if (!detail) return null;
    const stage = projectRoutingStageForTurn({
      userMessageCount: detail.messages.filter((message) => message.role === "user").length,
      reclassifyAfter: settings.reclassifyAfterUserMessages,
      movedByUser: detail.activities.some((activity) => {
        const payload = decodeMovedPayload(activity.payload);
        return Option.isSome(payload) && payload.value.reason === "manual";
      }),
    });
    if (stage === null) return null;
    return {
      stage,
      settings,
      threadId,
      threadTitle: thread.title,
      autoProject: project,
      messages: detail.messages,
    } satisfies ProjectRoutingContext;
  });

  /** The project at `workspaceRoot`, registering it first when needed. */
  const ensureProject = Effect.fn("ProjectRoutingFlow.ensureProject")(function* (input: {
    readonly workspaceRoot: string;
    readonly title: string;
  }) {
    const existing = yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(
      input.workspaceRoot,
    );
    if (Option.isSome(existing)) {
      return { id: existing.value.id, title: existing.value.title };
    }
    const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
    yield* orchestrationEngine.dispatch({
      type: "project.create",
      commandId: yield* commandId("register"),
      projectId,
      title: input.title,
      workspaceRoot: input.workspaceRoot,
      createdAt: yield* nowIso,
    });
    return { id: projectId, title: input.title };
  });

  const appendMovedActivity = Effect.fn("ProjectRoutingFlow.appendMovedActivity")(function* (
    threadId: ThreadId,
    payload: ThreadProjectMovedActivityPayload,
  ) {
    const createdAt = yield* nowIso;
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* commandId("notice"),
      threadId,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: "info",
        kind: THREAD_PROJECT_MOVED_ACTIVITY_KIND,
        summary:
          payload.reason === "created"
            ? `Created ${payload.toProjectTitle} and moved this thread there`
            : `Moved to ${payload.toProjectTitle}`,
        payload,
        turnId: null,
        createdAt,
      },
      createdAt,
    });
  });

  const moveThread = Effect.fn("ProjectRoutingFlow.moveThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly fromProjectId: ProjectId;
    readonly to: { readonly id: ProjectId; readonly title: string };
    readonly reason: "matched" | "created";
    readonly warning: string | null;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: yield* commandId("move"),
      threadId: input.threadId,
      projectId: input.to.id,
    });
    yield* appendMovedActivity(input.threadId, {
      fromProjectId: input.fromProjectId,
      toProjectId: input.to.id,
      toProjectTitle: input.to.title,
      reason: input.reason,
      ...(input.warning ? { warning: input.warning } : {}),
    });
  });

  /**
   * Record a move the user made (for example undo) so the router leaves the
   * thread alone from then on.
   */
  const recordManualMove = Effect.fn("ProjectRoutingFlow.recordManualMove")(function* (input: {
    readonly threadId: ThreadId;
    readonly toProjectId: ProjectId;
  }) {
    const project = Option.getOrUndefined(
      yield* projectionSnapshotQuery.getProjectShellById(input.toProjectId),
    );
    yield* appendMovedActivity(input.threadId, {
      toProjectId: input.toProjectId,
      toProjectTitle: project?.title ?? "another project",
      reason: "manual",
    });
  });

  const appendRoutingFailure = Effect.fn("ProjectRoutingFlow.appendRoutingFailure")(function* (
    threadId: ThreadId,
    detail: string,
  ) {
    const createdAt = yield* nowIso;
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* commandId("failure"),
      threadId,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: "error",
        kind: "project.route.failed",
        summary: "Could not create a project for this thread",
        payload: { detail },
        turnId: null,
        createdAt,
      },
      createdAt,
    });
  });

  /**
   * Classify the thread and move it. On the opening message only an existing
   * project can match; at the reclassify threshold a thread that still fits
   * nothing gets a new project when the settings allow it. Returns whether
   * the thread moved.
   */
  const route = Effect.fn("ProjectRoutingFlow.route")(function* (context: ProjectRoutingContext) {
    const projects = yield* projectionSnapshotQuery.getProjectShells();
    const candidates = yield* router.listCandidates({
      projects,
      autoProjectRoot: context.autoProject.workspaceRoot,
      settings: context.settings,
    });
    const settings = yield* serverSettingsService.getSettings;
    const { textGenerationModelSelection: modelSelection } = resolveProjectSettings(
      settings,
      context.autoProject.id,
    ).settings;

    const conversation = buildRoutingConversation(context.messages);
    const answer = yield* textGeneration
      .generateProjectRoute({
        cwd: router.expand(context.settings.newProjectDirectory),
        conversation,
        candidates: candidates.map(({ name, path, description }) => ({ name, path, description })),
        modelSelection,
      })
      .pipe(
        Effect.timeoutOption(CLASSIFY_TIMEOUT),
        Effect.catchCause((cause) =>
          Effect.logWarning("project routing classification failed", {
            threadId: context.threadId,
            cause,
          }).pipe(Effect.as(Option.none())),
        ),
      );
    const decision = Option.isSome(answer)
      ? interpretProjectRoute({ ...answer.value, candidates })
      : ({ kind: "none", newProjectName: null, purpose: null } as const);
    yield* Effect.logInfo("project routing decision", {
      threadId: context.threadId,
      stage: context.stage,
      candidates: candidates.length,
      decision: decision.kind === "match" ? decision.candidate.path : "none",
    });

    if (decision.kind === "match") {
      const target =
        decision.candidate.projectId !== null
          ? { id: decision.candidate.projectId, title: decision.candidate.name }
          : yield* ensureProject({
              workspaceRoot: decision.candidate.path,
              title: decision.candidate.name,
            });
      yield* moveThread({
        threadId: context.threadId,
        fromProjectId: context.autoProject.id,
        to: target,
        reason: "matched",
        warning: null,
      });
      return true;
    }

    // A failed classification is not evidence that nothing fits.
    if (
      context.stage !== "reclassify" ||
      !context.settings.createProjects ||
      Option.isNone(answer)
    ) {
      return false;
    }
    const created = yield* router
      .createProject({
        name: decision.newProjectName ?? sanitizeProjectName(context.threadTitle),
        purpose: decision.purpose,
        settings: context.settings,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendRoutingFailure(context.threadId, Cause.pretty(cause)).pipe(Effect.as(null)),
        ),
      );
    if (created === null) return false;
    const target = yield* ensureProject({ workspaceRoot: created.path, title: created.name });
    yield* moveThread({
      threadId: context.threadId,
      fromProjectId: context.autoProject.id,
      to: target,
      reason: "created",
      warning: created.warning,
    });
    return true;
  });

  return { contextForTurn, route, recordManualMove } as const;
});
