/**
 * Pure decisions for auto project routing: when a thread in the auto-routing
 * project is classified, how the classifier's answer is trusted, and how a
 * new project is named. IO lives in ProjectRouter.ts.
 *
 * @module ProjectRouting
 */
import type { OrchestrationMessage, ProjectId } from "@t3tools/contracts";

/** Answers below this confidence count as "no project". */
export const MIN_PROJECT_ROUTE_CONFIDENCE = 0.8;

const MAX_PROJECT_NAME_LENGTH = 40;
const FALLBACK_PROJECT_NAME = "new-project";
const CONVERSATION_BUDGET_CHARS = 12_000;
const MESSAGE_BUDGET_CHARS = 2_000;

export type ProjectRoutingStage = "first-message" | "reclassify";

export interface ProjectCandidate {
  readonly name: string;
  /** Absolute workspace root. */
  readonly path: string;
  readonly description: string;
  /** Set when the folder is already a T3 project. */
  readonly projectId: ProjectId | null;
}

export type ProjectRouteDecision =
  | { readonly kind: "match"; readonly candidate: ProjectCandidate; readonly confidence: number }
  | {
      readonly kind: "none";
      readonly newProjectName: string | null;
      readonly purpose: string | null;
    };

/**
 * Which classification, if any, a turn in the auto-routing project triggers.
 * The opening message is classified right away; a thread still unrouted when
 * it reaches `reclassifyAfter` user messages is classified once more, with the
 * conversation so far, and may get a new project.
 */
export function projectRoutingStageForTurn(input: {
  /** User messages in the thread, including the one starting this turn. */
  readonly userMessageCount: number;
  readonly reclassifyAfter: number;
  /** The user moved this thread by hand at some point (including undo). */
  readonly movedByUser: boolean;
}): ProjectRoutingStage | null {
  if (input.movedByUser) return null;
  if (input.userMessageCount === 1) return "first-message";
  if (input.userMessageCount === input.reclassifyAfter) return "reclassify";
  return null;
}

function normalizeCandidatePath(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, "") : trimmed;
}

/**
 * Turn the classifier's raw answer into a decision. The answer must name one
 * of the candidates (by path, or unambiguously by name) with enough
 * confidence; anything else is "none".
 */
export function interpretProjectRoute(input: {
  readonly projectPath: string;
  readonly confidence: number;
  readonly newProjectName: string;
  readonly purpose: string;
  readonly candidates: ReadonlyArray<ProjectCandidate>;
  readonly minConfidence?: number;
}): ProjectRouteDecision {
  const minConfidence = input.minConfidence ?? MIN_PROJECT_ROUTE_CONFIDENCE;
  const none: ProjectRouteDecision = {
    kind: "none",
    newProjectName: input.newProjectName.trim() ? sanitizeProjectName(input.newProjectName) : null,
    purpose: input.purpose.trim() ? input.purpose.trim().replace(/\s+/g, " ") : null,
  };
  const answer = normalizeCandidatePath(input.projectPath);
  if (answer.length === 0 || answer.toLowerCase() === "none") return none;
  if (!Number.isFinite(input.confidence) || input.confidence < minConfidence) return none;

  const byPath = input.candidates.find(
    (candidate) => normalizeCandidatePath(candidate.path) === answer,
  );
  if (byPath) return { kind: "match", candidate: byPath, confidence: input.confidence };

  const byName = input.candidates.filter(
    (candidate) => candidate.name.toLowerCase() === answer.toLowerCase(),
  );
  if (byName.length === 1) {
    return { kind: "match", candidate: byName[0]!, confidence: input.confidence };
  }
  return none;
}

/** A short kebab-case folder and repository name. */
export function sanitizeProjectName(raw: string): string {
  const kebab = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (kebab.length === 0) return FALLBACK_PROJECT_NAME;
  if (kebab.length <= MAX_PROJECT_NAME_LENGTH) return kebab;
  const clipped = kebab.slice(0, MAX_PROJECT_NAME_LENGTH);
  const lastBreak = clipped.lastIndexOf("-");
  return (lastBreak > 0 ? clipped.slice(0, lastBreak) : clipped).replace(/-+$/, "");
}

/** The base name, then `base-2`, `base-3`, … for resolving collisions. */
export function* projectNameCandidates(base: string, maxAttempts = 50): Generator<string> {
  yield base;
  for (let suffix = 2; suffix <= maxAttempts; suffix += 1) {
    yield `${base}-${suffix}`;
  }
}

/**
 * The first name whose folder and repository are both free. `isTaken` checks
 * one name; null means every attempt collided.
 */
export function pickAvailableProjectName(
  base: string,
  isTaken: (name: string) => boolean,
  maxAttempts?: number,
): string | null {
  for (const name of projectNameCandidates(base, maxAttempts)) {
    if (!isTaken(name)) return name;
  }
  return null;
}

/**
 * The text the classifier sees. The opening message alone at first; later the
 * conversation, keeping the opening request and the newest messages.
 */
export function buildRoutingConversation(
  messages: ReadonlyArray<Pick<OrchestrationMessage, "role" | "text">>,
): string {
  const lines = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const text = message.text.trim();
      const clipped =
        text.length > MESSAGE_BUDGET_CHARS ? `${text.slice(0, MESSAGE_BUDGET_CHARS)} […]` : text;
      return `${message.role === "user" ? "User" : "Assistant"}: ${clipped}`;
    })
    .filter((line) => !line.endsWith(": "));
  if (lines.length <= 1) return lines[0]?.replace(/^User: /, "") ?? "";

  const [first, ...rest] = lines;
  const kept: Array<string> = [];
  let used = first!.length;
  for (let index = rest.length - 1; index >= 0; index -= 1) {
    const line = rest[index]!;
    if (used + line.length > CONVERSATION_BUDGET_CHARS) break;
    kept.unshift(line);
    used += line.length;
  }
  const omitted = rest.length - kept.length;
  return [first!, ...(omitted > 0 ? [`[${omitted} earlier messages omitted]`] : []), ...kept].join(
    "\n\n",
  );
}

/** A one-line description from a README, agent notes, or package manifest. */
export function describeProjectFromFiles(files: {
  readonly readme?: string | undefined;
  readonly agentNotes?: string | undefined;
  readonly packageJson?: string | undefined;
}): string {
  const parts: Array<string> = [];
  if (files.packageJson) {
    try {
      const parsed = JSON.parse(files.packageJson) as { description?: unknown };
      if (typeof parsed.description === "string" && parsed.description.trim()) {
        parts.push(parsed.description.trim());
      }
    } catch {
      // Not JSON; the other sources still describe the project.
    }
  }
  for (const text of [files.readme, files.agentNotes]) {
    if (!text) continue;
    const prose = text
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .filter((line) => line.length > 0 && !line.startsWith("<") && !line.startsWith("!["))
      .slice(0, 4)
      .join(" ");
    if (prose) parts.push(prose);
  }
  const joined = parts.join(". ").replace(/\s+/g, " ").trim();
  return joined.length > 240 ? `${joined.slice(0, 237)}...` : joined;
}
