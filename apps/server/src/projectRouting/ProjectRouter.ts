/**
 * Filesystem and CLI side of auto project routing: finding candidate
 * projects on disk and creating a new project (folder, git repository, and
 * optionally a private GitHub repository).
 *
 * @module ProjectRouter
 */
import type { AutoProjectRoutingSettings, OrchestrationProjectShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePathWith } from "../pathExpansion.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  describeProjectFromFiles,
  type ProjectCandidate,
  projectNameCandidates,
  sanitizeProjectName,
} from "./ProjectRouting.ts";

const MAX_CANDIDATES = 200;
const DESCRIPTION_FILE_BYTES = 4_000;

export class ProjectNameUnavailableError extends Schema.TaggedError<ProjectNameUnavailableError>()(
  "ProjectNameUnavailableError",
  { base: Schema.String },
) {
  override get message(): string {
    return `Every project name based on '${this.base}' is already taken.`;
  }
}

export interface CreatedProject {
  readonly name: string;
  readonly path: string;
  /** A step that failed without stopping creation, such as the GitHub repository. */
  readonly warning: string | null;
}

export const makeProjectRouter = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.make();

  const expand = (value: string) => path.resolve(expandHomePathWith(value, path));
  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
  const realPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));

  const readHead = (target: string) =>
    fileSystem.readFileString(target).pipe(
      Effect.map((text) => text.slice(0, DESCRIPTION_FILE_BYTES)),
      Effect.orElseSucceed(() => undefined),
    );

  const describeFolder = Effect.fn("ProjectRouter.describeFolder")(function* (root: string) {
    const [readme, claudeNotes, agentNotes, packageJson] = yield* Effect.all(
      [
        readHead(path.join(root, "README.md")),
        readHead(path.join(root, "CLAUDE.md")),
        readHead(path.join(root, "AGENTS.md")),
        readHead(path.join(root, "package.json")),
      ],
      { concurrency: "unbounded" },
    );
    return describeProjectFromFiles({
      readme,
      agentNotes: claudeNotes ?? agentNotes,
      packageJson,
    });
  });

  /** Git repositories at each search root, or directly inside it. */
  const discoverRepositories = Effect.fn("ProjectRouter.discoverRepositories")(function* (
    searchRoots: ReadonlyArray<string>,
  ) {
    const found: Array<string> = [];
    for (const rawRoot of searchRoots) {
      if (rawRoot.trim().length === 0) continue;
      const root = expand(rawRoot);
      if (!(yield* exists(root))) continue;
      if (yield* exists(path.join(root, ".git"))) {
        found.push(root);
        continue;
      }
      const entries = yield* fileSystem.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
      for (const entry of entries.toSorted()) {
        if (entry.startsWith(".")) continue;
        const child = path.join(root, entry);
        if (yield* exists(path.join(child, ".git"))) found.push(child);
      }
    }
    return found;
  });

  /**
   * Registered projects (except the auto-routing one) plus unregistered git
   * repositories from the search roots, each with a short description.
   */
  const listCandidates = Effect.fn("ProjectRouter.listCandidates")(function* (input: {
    readonly projects: ReadonlyArray<OrchestrationProjectShell>;
    readonly autoProjectRoot: string;
    readonly settings: AutoProjectRoutingSettings;
  }) {
    const autoRoot = yield* realPath(input.autoProjectRoot);
    const byPath = new Map<string, Omit<ProjectCandidate, "description">>();
    for (const project of input.projects) {
      const root = yield* realPath(project.workspaceRoot);
      if (root === autoRoot || byPath.has(root)) continue;
      byPath.set(root, { name: project.title, path: root, projectId: project.id });
    }
    for (const repository of yield* discoverRepositories(input.settings.searchRoots)) {
      const root = yield* realPath(repository);
      if (root === autoRoot || byPath.has(root)) continue;
      byPath.set(root, { name: path.basename(root), path: root, projectId: null });
    }
    const entries = [...byPath.values()].slice(0, MAX_CANDIDATES);
    return yield* Effect.forEach(
      entries,
      (entry) =>
        describeFolder(entry.path).pipe(
          Effect.map((description): ProjectCandidate => ({ ...entry, description })),
        ),
      { concurrency: 8 },
    );
  });

  const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
    processRunner.run({ command, args, cwd, timeout: "90 seconds" }).pipe(
      Effect.map((output) => ({
        ok: output.code === 0 && !output.timedOut,
        detail: (output.stderr.trim() || output.stdout.trim()).slice(0, 500),
      })),
      Effect.catch((error) => Effect.succeed({ ok: false, detail: error.message })),
    );

  /** Whether the signed-in GitHub account already has a repository by this name. */
  const gitHubRepositoryExists = (name: string, cwd: string) =>
    run("gh", ["repo", "view", name, "--json", "name"], cwd).pipe(
      Effect.map((result) => result.ok),
    );

  /**
   * Create `<newProjectDirectory>/<name>` with a README and CLAUDE.md, commit
   * it, and (if enabled) push it to a new private GitHub repository. Existing
   * folders and repositories are never reused: a taken name gets a numeric
   * suffix. A GitHub failure leaves the local project in place and is
   * reported as a warning.
   */
  const createProject = Effect.fn("ProjectRouter.createProject")(function* (input: {
    readonly name: string;
    readonly purpose: string | null;
    readonly settings: AutoProjectRoutingSettings;
  }) {
    const parent = expand(input.settings.newProjectDirectory);
    yield* fileSystem.makeDirectory(parent, { recursive: true });
    const base = sanitizeProjectName(input.name);
    let chosen: string | null = null;
    for (const candidate of projectNameCandidates(base)) {
      if (yield* exists(path.join(parent, candidate))) continue;
      if (
        input.settings.createGitHubRepository &&
        (yield* gitHubRepositoryExists(candidate, parent))
      ) {
        continue;
      }
      chosen = candidate;
      break;
    }
    if (chosen === null) {
      return yield* new ProjectNameUnavailableError({ base });
    }
    const root = path.join(parent, chosen);
    // Non-recursive: fails instead of adopting a folder created in the meantime.
    yield* fileSystem.makeDirectory(root);
    const purpose = input.purpose ?? "Started from a T3 Code thread.";
    yield* fileSystem.writeFileString(path.join(root, "README.md"), `# ${chosen}\n\n${purpose}\n`);
    yield* fileSystem.writeFileString(
      path.join(root, "CLAUDE.md"),
      `# ${chosen}\n\nPurpose: ${purpose}\n`,
    );

    for (const args of [
      ["init", "--initial-branch=main"],
      ["add", "README.md", "CLAUDE.md"],
      ["commit", "-m", "Initial commit"],
    ]) {
      const result = yield* run("git", args, root);
      if (!result.ok) {
        return {
          name: chosen,
          path: root,
          warning: `git ${args[0]} failed: ${result.detail}`,
        } satisfies CreatedProject;
      }
    }

    if (!input.settings.createGitHubRepository) {
      return { name: chosen, path: root, warning: null } satisfies CreatedProject;
    }
    const pushed = yield* run(
      "gh",
      ["repo", "create", chosen, "--private", "--source", ".", "--remote", "origin", "--push"],
      root,
    );
    return {
      name: chosen,
      path: root,
      warning: pushed.ok ? null : `GitHub repository was not created: ${pushed.detail}`,
    } satisfies CreatedProject;
  });

  return { expand, realPath, listCandidates, createProject } as const;
});

export type ProjectRouter = Effect.Success<typeof makeProjectRouter>;
