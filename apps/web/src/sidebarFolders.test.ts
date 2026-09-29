import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarFolderTreeRows,
  createSidebarFolder,
  deleteSidebarFolder,
  isSidebarFolderWithin,
  listSidebarFolderPaths,
  moveProjectsToSidebarFolder,
  moveSidebarFolder,
  renameSidebarFolder,
  resolveProjectFolderId,
  resolveSidebarFolderDrop,
  sanitizeProjectFolderById,
  sanitizeSidebarFolders,
  setSidebarFolderExpanded,
  shiftSidebarFolder,
  type SidebarFolder,
  type SidebarFolderState,
} from "./sidebarFolders";

function folder(id: string, parentId: string | null = null, expanded = true): SidebarFolder {
  return { id, name: id, parentId, expanded };
}

function state(
  sidebarFolders: SidebarFolder[],
  projectFolderById: Record<string, string> = {},
): SidebarFolderState {
  return { sidebarFolders, projectFolderById };
}

interface TestProject {
  key: string;
  aliases?: string[];
}

function rows(folderState: SidebarFolderState, projects: TestProject[]) {
  return buildSidebarFolderTreeRows({
    state: folderState,
    projects,
    getProjectKey: (project) => project.key,
    getPreferenceKeys: (project) => [project.key, ...(project.aliases ?? [])],
  }).map((row) =>
    row.kind === "folder"
      ? `${"  ".repeat(row.depth)}[${row.folder.id}] ${row.descendantProjects.map((p) => p.key).join(",")}`
      : `${"  ".repeat(row.depth)}${row.project.key}`,
  );
}

describe("sidebar folder tree", () => {
  it("nests folders and lists folders before projects at each level", () => {
    const folders = state([folder("work"), folder("clients", "work"), folder("personal")], {
      a: "clients",
      b: "work",
      c: "personal",
    });

    expect(rows(folders, [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }])).toEqual([
      "[work] a,b",
      "  [clients] a",
      "    a",
      "  b",
      "[personal] c",
      "  c",
      "d",
    ]);
  });

  it("hides the contents of collapsed folders but keeps their aggregate projects", () => {
    const folders = state([folder("work", null, false), folder("clients", "work")], {
      a: "clients",
    });

    expect(rows(folders, [{ key: "a" }, { key: "b" }])).toEqual(["[work] a", "b"]);
  });

  it("resolves a project filed under one of its member keys", () => {
    const folders = state([folder("work")], { "physical-a": "work" });

    expect(rows(folders, [{ key: "logical-a", aliases: ["physical-a"] }])).toEqual([
      "[work] logical-a",
      "  logical-a",
    ]);
  });

  it("keeps projects at the top level when their folder is gone", () => {
    const folders = state([folder("work")], { a: "missing" });

    expect(resolveProjectFolderId(folders, ["a"])).toBeNull();
    expect(rows(folders, [{ key: "a" }])).toEqual(["[work] ", "a"]);
  });

  it("builds slash-separated paths for move menus", () => {
    const folders = [folder("work"), folder("clients", "work"), folder("personal")];

    expect(listSidebarFolderPaths(folders).map((entry) => entry.path)).toEqual([
      "work",
      "work / clients",
      "personal",
    ]);
  });
});

describe("sidebar folder edits", () => {
  it("creates nested folders and expands collapsed ancestors", () => {
    const initial = state([folder("work", null, false)]);

    const next = createSidebarFolder(initial, {
      id: "clients",
      name: "  Clients  ",
      parentId: "work",
    });

    expect(next.sidebarFolders).toEqual([
      folder("work", null, true),
      { id: "clients", name: "Clients", parentId: "work", expanded: true },
    ]);
  });

  it("ignores blank names and unknown parents", () => {
    const initial = state([]);

    expect(createSidebarFolder(initial, { id: "x", name: "   ", parentId: null })).toBe(initial);
    expect(
      createSidebarFolder(initial, { id: "x", name: "X", parentId: "missing" }).sidebarFolders,
    ).toEqual([{ id: "x", name: "X", parentId: null, expanded: true }]);
  });

  it("renames and toggles folders", () => {
    const initial = state([folder("work")]);

    const renamed = renameSidebarFolder(initial, "work", "Work stuff");
    expect(renamed.sidebarFolders[0]?.name).toBe("Work stuff");
    expect(renameSidebarFolder(initial, "work", "")).toBe(initial);
    expect(setSidebarFolderExpanded(initial, "work", false).sidebarFolders[0]?.expanded).toBe(
      false,
    );
    expect(setSidebarFolderExpanded(initial, "work", true)).toBe(initial);
  });

  it("moves a deleted folder's contents to its parent", () => {
    const initial = state([folder("work"), folder("clients", "work"), folder("acme", "clients")], {
      a: "clients",
      b: "work",
    });

    const next = deleteSidebarFolder(initial, "clients");

    expect(next.sidebarFolders).toEqual([folder("work"), folder("acme", "work")]);
    expect(next.projectFolderById).toEqual({ a: "work", b: "work" });
  });

  it("moves a deleted top-level folder's contents to the top level", () => {
    const initial = state([folder("work"), folder("clients", "work")], { a: "work" });

    const next = deleteSidebarFolder(initial, "work");

    expect(next.sidebarFolders).toEqual([folder("clients")]);
    expect(next.projectFolderById).toEqual({});
  });

  it("moves folders but refuses cycles", () => {
    const initial = state([folder("work"), folder("clients", "work"), folder("personal")]);

    expect(moveSidebarFolder(initial, "work", "clients")).toBe(initial);
    expect(moveSidebarFolder(initial, "work", "work")).toBe(initial);
    expect(moveSidebarFolder(initial, "work", "missing")).toBe(initial);
    expect(moveSidebarFolder(initial, "personal", "clients").sidebarFolders).toEqual([
      folder("work"),
      folder("clients", "work"),
      folder("personal", "clients"),
    ]);
    expect(moveSidebarFolder(initial, "clients", null).sidebarFolders).toEqual([
      folder("work"),
      folder("personal"),
      folder("clients"),
    ]);
  });

  it("detects descendants", () => {
    const folders = [folder("a"), folder("b", "a"), folder("c", "b")];

    expect(isSidebarFolderWithin(folders, "c", "a")).toBe(true);
    expect(isSidebarFolderWithin(folders, "a", "a")).toBe(true);
    expect(isSidebarFolderWithin(folders, "a", "c")).toBe(false);
  });

  it("reorders folders among siblings only", () => {
    const initial = state([folder("work"), folder("clients", "work"), folder("personal")]);

    expect(shiftSidebarFolder(initial, "personal", -1).sidebarFolders.map((f) => f.id)).toEqual([
      "personal",
      "clients",
      "work",
    ]);
    expect(shiftSidebarFolder(initial, "personal", 1)).toBe(initial);
    expect(shiftSidebarFolder(initial, "clients", -1)).toBe(initial);
  });

  it("files projects under their primary key and clears stale member keys", () => {
    const initial = state([folder("work"), folder("personal")], { "physical-a": "personal" });

    const filed = moveProjectsToSidebarFolder(initial, [["logical-a", "physical-a"]], "work");
    expect(filed.projectFolderById).toEqual({ "logical-a": "work" });

    const unfiled = moveProjectsToSidebarFolder(filed, [["logical-a", "physical-a"]], null);
    expect(unfiled.projectFolderById).toEqual({});
    expect(moveProjectsToSidebarFolder(unfiled, [["logical-a"]], null)).toBe(unfiled);
    expect(moveProjectsToSidebarFolder(initial, [["x"]], "missing")).toBe(initial);
  });
});

describe("sidebar folder persistence", () => {
  it("drops malformed folders and breaks parent cycles", () => {
    const folders = sanitizeSidebarFolders([
      { id: "a", name: "A", parentId: "b" },
      { id: "b", name: "B", parentId: "a", expanded: false },
      { id: "c", name: "C", parentId: "gone" },
      { id: "c", name: "duplicate" },
      { id: "", name: "no id" },
      { id: "d", name: "   " },
      "junk",
    ]);

    expect(folders).toEqual([
      { id: "a", name: "A", parentId: null, expanded: true },
      { id: "b", name: "B", parentId: null, expanded: false },
      { id: "c", name: "C", parentId: null, expanded: true },
    ]);
    expect(sanitizeSidebarFolders("junk")).toEqual([]);
  });

  it("drops project entries pointing at unknown folders", () => {
    expect(sanitizeProjectFolderById({ a: "work", b: "gone", c: 3 }, [folder("work")])).toEqual({
      a: "work",
    });
  });
});

describe("sidebar folder drops", () => {
  const folders = [folder("work"), folder("clients", "work"), folder("personal")];

  it("files projects into folders, beside projects, or at the top level", () => {
    expect(
      resolveSidebarFolderDrop({
        folders,
        dragged: { kind: "project" },
        target: { kind: "folder", folderId: "clients" },
      }),
    ).toEqual({ kind: "move-project", folderId: "clients", reorder: false });
    expect(
      resolveSidebarFolderDrop({
        folders,
        dragged: { kind: "project" },
        target: { kind: "project", folderId: "personal" },
      }),
    ).toEqual({ kind: "move-project", folderId: "personal", reorder: true });
    expect(
      resolveSidebarFolderDrop({ folders, dragged: { kind: "project" }, target: { kind: "root" } }),
    ).toEqual({ kind: "move-project", folderId: null, reorder: false });
  });

  it("nests folders but never into themselves or their descendants", () => {
    const work = { kind: "folder", folderId: "work" } as const;

    expect(
      resolveSidebarFolderDrop({
        folders,
        dragged: work,
        target: { kind: "folder", folderId: "personal" },
      }),
    ).toEqual({ kind: "move-folder", parentId: "personal" });
    expect(
      resolveSidebarFolderDrop({
        folders,
        dragged: work,
        target: { kind: "folder", folderId: "clients" },
      }),
    ).toBeNull();
    expect(
      resolveSidebarFolderDrop({ folders, dragged: work, target: { kind: "root" } }),
    ).toBeNull();
    expect(
      resolveSidebarFolderDrop({
        folders,
        dragged: { kind: "folder", folderId: "clients" },
        target: { kind: "project", folderId: null },
      }),
    ).toEqual({ kind: "move-folder", parentId: null });
  });
});
