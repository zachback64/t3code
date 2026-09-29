import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AutoProjectRoutingSettings, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { makeProjectRouter } from "./ProjectRouter.ts";

const decodeSettings = Schema.decodeSync(AutoProjectRoutingSettings);

const settingsFor = (root: string) =>
  decodeSettings({
    projectRoot: `${root}/inbox`,
    searchRoots: [root],
    newProjectDirectory: root,
    createGitHubRepository: false,
  });

it.layer(NodeServices.layer)("ProjectRouter", (it) => {
  it.effect("creates a committed project beside an existing one instead of reusing it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-route-" });
      yield* fileSystem.makeDirectory(path.join(root, "garden"));
      yield* fileSystem.writeFileString(path.join(root, "garden", "keep.txt"), "mine");

      const router = yield* makeProjectRouter;
      const created = yield* router.createProject({
        name: "Garden",
        purpose: "Plan the garden beds.",
        settings: settingsFor(root),
      });

      expect(created.name).toBe("garden-2");
      expect(created.warning).toBeNull();
      expect(yield* fileSystem.readFileString(path.join(root, "garden", "keep.txt"))).toBe("mine");
      expect(yield* fileSystem.readFileString(path.join(created.path, "README.md"))).toContain(
        "Plan the garden beds.",
      );
      expect(yield* fileSystem.exists(path.join(created.path, ".git"))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("lists registered projects and unregistered repositories once each", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-route-" }),
      );
      for (const name of ["inbox", "registered", "loose", "plain-folder"]) {
        yield* fileSystem.makeDirectory(path.join(root, name));
      }
      for (const name of ["registered", "loose"]) {
        yield* fileSystem.makeDirectory(path.join(root, name, ".git"));
      }
      yield* fileSystem.writeFileString(
        path.join(root, "loose", "README.md"),
        "# Loose\nA side project.",
      );

      const router = yield* makeProjectRouter;
      const candidates = yield* router.listCandidates({
        projects: [
          {
            id: ProjectId.make("inbox"),
            title: "inbox",
            workspaceRoot: path.join(root, "inbox"),
          },
          {
            id: ProjectId.make("registered"),
            title: "Registered",
            workspaceRoot: path.join(root, "registered"),
          },
        ] as never,
        autoProjectRoot: path.join(root, "inbox"),
        settings: settingsFor(root),
      });

      expect(candidates.map((candidate) => [candidate.name, candidate.projectId])).toEqual([
        ["Registered", "registered"],
        ["loose", null],
      ]);
      expect(candidates[1]?.description).toBe("Loose A side project.");
    }).pipe(Effect.scoped),
  );
});
