import { randomUUID } from "./lib/utils";

// User-defined folders that group project rows in the legacy sidebar.
//
// Folders are a client-side organization preference, persisted with the rest
// of the sidebar layout (project order, expansion) in the UI state store. A
// folder may contain folders and projects; projects without a folder stay at
// the top level. Sibling folders keep their array order.

export interface SidebarFolder {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly expanded: boolean;
}

export interface SidebarFolderState {
  readonly sidebarFolders: readonly SidebarFolder[];
  // Project preference key -> folder id. Projects are written under their
  // logical sidebar key; lookups also accept a member's physical key so a
  // grouping-mode change does not silently unfile a project.
  readonly projectFolderById: Readonly<Record<string, string>>;
}

export const MAX_SIDEBAR_FOLDER_NAME_LENGTH = 80;

export function normalizeSidebarFolderName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, MAX_SIDEBAR_FOLDER_NAME_LENGTH);
}

export function makeSidebarFolderId(): string {
  return `folder-${randomUUID()}`;
}

/** Drops malformed entries, dangling parents and parent cycles from persisted folders. */
export function sanitizeSidebarFolders(value: unknown): SidebarFolder[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const folders: SidebarFolder[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const id = candidate.id;
    const name =
      typeof candidate.name === "string" ? normalizeSidebarFolderName(candidate.name) : "";
    if (typeof id !== "string" || id.length === 0 || seen.has(id) || name.length === 0) continue;
    seen.add(id);
    folders.push({
      id,
      name,
      parentId:
        typeof candidate.parentId === "string" && candidate.parentId.length > 0
          ? candidate.parentId
          : null,
      expanded: candidate.expanded !== false,
    });
  }
  const byId = new Map(folders.map((folder) => [folder.id, folder] as const));
  return folders.map((folder) => {
    if (folder.parentId === null) return folder;
    if (!byId.has(folder.parentId) || parentChainLoops(byId, folder.id)) {
      return { ...folder, parentId: null };
    }
    return folder;
  });
}

function parentChainLoops(byId: ReadonlyMap<string, SidebarFolder>, startId: string): boolean {
  const visited = new Set<string>([startId]);
  let current = byId.get(startId)?.parentId ?? null;
  while (current !== null) {
    if (visited.has(current)) return true;
    visited.add(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return false;
}

export function sanitizeProjectFolderById(
  value: unknown,
  folders: readonly SidebarFolder[],
): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const folderIds = new Set(folders.map((folder) => folder.id));
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        entry[0].length > 0 && typeof entry[1] === "string" && folderIds.has(entry[1]),
    ),
  );
}

/** True when `folderId` is `ancestorId` itself or sits anywhere below it. */
export function isSidebarFolderWithin(
  folders: readonly SidebarFolder[],
  folderId: string,
  ancestorId: string,
): boolean {
  const byId = new Map(folders.map((folder) => [folder.id, folder] as const));
  const visited = new Set<string>();
  let current: string | null = folderId;
  while (current !== null && !visited.has(current)) {
    if (current === ancestorId) return true;
    visited.add(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return false;
}

export function createSidebarFolder<S extends SidebarFolderState>(
  state: S,
  input: { id: string; name: string; parentId: string | null },
): S {
  const name = normalizeSidebarFolderName(input.name);
  if (name.length === 0 || state.sidebarFolders.some((folder) => folder.id === input.id)) {
    return state;
  }
  const parentId =
    input.parentId !== null && state.sidebarFolders.some((folder) => folder.id === input.parentId)
      ? input.parentId
      : null;
  // Creating inside a collapsed folder would hide the new folder immediately.
  const sidebarFolders = state.sidebarFolders.map((folder) =>
    parentId !== null && isSidebarFolderWithin(state.sidebarFolders, parentId, folder.id)
      ? folder.expanded
        ? folder
        : { ...folder, expanded: true }
      : folder,
  );
  return {
    ...state,
    sidebarFolders: [...sidebarFolders, { id: input.id, name, parentId, expanded: true }],
  };
}

export function renameSidebarFolder<S extends SidebarFolderState>(
  state: S,
  folderId: string,
  name: string,
): S {
  const nextName = normalizeSidebarFolderName(name);
  if (nextName.length === 0) return state;
  let changed = false;
  const sidebarFolders = state.sidebarFolders.map((folder) => {
    if (folder.id !== folderId || folder.name === nextName) return folder;
    changed = true;
    return { ...folder, name: nextName };
  });
  return changed ? { ...state, sidebarFolders } : state;
}

export function setSidebarFolderExpanded<S extends SidebarFolderState>(
  state: S,
  folderId: string,
  expanded: boolean,
): S {
  let changed = false;
  const sidebarFolders = state.sidebarFolders.map((folder) => {
    if (folder.id !== folderId || folder.expanded === expanded) return folder;
    changed = true;
    return { ...folder, expanded };
  });
  return changed ? { ...state, sidebarFolders } : state;
}

/**
 * Removes a folder. Its subfolders and projects move up to the folder's
 * parent (or the top level), keeping their relative order.
 */
export function deleteSidebarFolder<S extends SidebarFolderState>(state: S, folderId: string): S {
  const target = state.sidebarFolders.find((folder) => folder.id === folderId);
  if (!target) return state;
  const sidebarFolders = state.sidebarFolders.flatMap((folder) => {
    if (folder.id === folderId) return [];
    return folder.parentId === folderId ? [{ ...folder, parentId: target.parentId }] : [folder];
  });
  const projectFolderById: Record<string, string> = {};
  for (const [projectKey, projectFolderId] of Object.entries(state.projectFolderById)) {
    if (projectFolderId !== folderId) {
      projectFolderById[projectKey] = projectFolderId;
    } else if (target.parentId !== null) {
      projectFolderById[projectKey] = target.parentId;
    }
  }
  return { ...state, sidebarFolders, projectFolderById };
}

/**
 * Moves a folder under `parentId` (null for top level), appended after its new
 * siblings. Moving a folder into itself or one of its descendants is ignored.
 */
export function moveSidebarFolder<S extends SidebarFolderState>(
  state: S,
  folderId: string,
  parentId: string | null,
): S {
  const folder = state.sidebarFolders.find((entry) => entry.id === folderId);
  if (!folder || folder.parentId === parentId) return state;
  if (parentId !== null) {
    if (!state.sidebarFolders.some((entry) => entry.id === parentId)) return state;
    if (isSidebarFolderWithin(state.sidebarFolders, parentId, folderId)) return state;
  }
  const remaining = state.sidebarFolders.filter((entry) => entry.id !== folderId);
  return { ...state, sidebarFolders: [...remaining, { ...folder, parentId }] };
}

/** Swaps a folder with its previous (-1) or next (1) sibling. */
export function shiftSidebarFolder<S extends SidebarFolderState>(
  state: S,
  folderId: string,
  direction: -1 | 1,
): S {
  const folder = state.sidebarFolders.find((entry) => entry.id === folderId);
  if (!folder) return state;
  const siblingIndexes = state.sidebarFolders.flatMap((entry, index) =>
    entry.parentId === folder.parentId ? [index] : [],
  );
  const position = siblingIndexes.findIndex(
    (index) => state.sidebarFolders[index]!.id === folderId,
  );
  const swapWith = siblingIndexes[position + direction];
  if (swapWith === undefined) return state;
  const sidebarFolders = [...state.sidebarFolders];
  const currentIndex = siblingIndexes[position]!;
  [sidebarFolders[currentIndex], sidebarFolders[swapWith]] = [
    sidebarFolders[swapWith]!,
    sidebarFolders[currentIndex]!,
  ];
  return { ...state, sidebarFolders };
}

/**
 * Files projects into `folderId` (null for top level). Each project is given
 * as its preference keys, primary key first; stale entries under the other
 * keys are cleared so one project never resolves to two folders.
 */
export function moveProjectsToSidebarFolder<S extends SidebarFolderState>(
  state: S,
  projects: readonly (readonly string[])[],
  folderId: string | null,
): S {
  if (folderId !== null && !state.sidebarFolders.some((folder) => folder.id === folderId)) {
    return state;
  }
  const projectFolderById = { ...state.projectFolderById };
  let changed = false;
  for (const preferenceKeys of projects) {
    const [primaryKey, ...otherKeys] = preferenceKeys;
    if (!primaryKey) continue;
    for (const key of otherKeys) {
      if (key !== primaryKey && key in projectFolderById) {
        delete projectFolderById[key];
        changed = true;
      }
    }
    if (folderId === null) {
      if (primaryKey in projectFolderById) {
        delete projectFolderById[primaryKey];
        changed = true;
      }
    } else if (projectFolderById[primaryKey] !== folderId) {
      projectFolderById[primaryKey] = folderId;
      changed = true;
    }
  }
  return changed ? { ...state, projectFolderById } : state;
}

export function resolveProjectFolderId(
  state: SidebarFolderState,
  preferenceKeys: readonly string[],
  folderIds: ReadonlySet<string> = new Set(state.sidebarFolders.map((folder) => folder.id)),
): string | null {
  for (const key of preferenceKeys) {
    const folderId = state.projectFolderById[key];
    if (folderId !== undefined && folderIds.has(folderId)) {
      return folderId;
    }
  }
  return null;
}

export type SidebarFolderTreeRow<P> =
  | {
      readonly kind: "folder";
      readonly key: string;
      readonly folder: SidebarFolder;
      readonly depth: number;
      // Every project filed anywhere below this folder, in sidebar order.
      readonly descendantProjects: readonly P[];
    }
  | {
      readonly kind: "project";
      readonly key: string;
      readonly project: P;
      readonly depth: number;
      readonly folderId: string | null;
    };

export function sidebarFolderRowKey(folderId: string): string {
  return `sidebar-folder:${folderId}`;
}

/**
 * Flattens folders and projects into the rows the sidebar renders. Each level
 * lists its folders first (in folder order), then its projects (in the order
 * given). Children of collapsed folders are omitted.
 */
export function buildSidebarFolderTreeRows<P>(input: {
  state: SidebarFolderState;
  projects: readonly P[];
  getProjectKey: (project: P) => string;
  getPreferenceKeys: (project: P) => readonly string[];
}): SidebarFolderTreeRow<P>[] {
  const { state, projects, getProjectKey, getPreferenceKeys } = input;
  const folderIds = new Set(state.sidebarFolders.map((folder) => folder.id));
  const foldersByParent = new Map<string | null, SidebarFolder[]>();
  for (const folder of state.sidebarFolders) {
    const siblings = foldersByParent.get(folder.parentId);
    if (siblings) siblings.push(folder);
    else foldersByParent.set(folder.parentId, [folder]);
  }
  const projectsByFolder = new Map<string | null, P[]>();
  for (const project of projects) {
    const folderId = resolveProjectFolderId(state, getPreferenceKeys(project), folderIds);
    const siblings = projectsByFolder.get(folderId);
    if (siblings) siblings.push(project);
    else projectsByFolder.set(folderId, [project]);
  }

  const descendantProjectsById = new Map<string, P[]>();
  const collectDescendants = (folderId: string, visiting: Set<string>): P[] => {
    const cached = descendantProjectsById.get(folderId);
    if (cached) return cached;
    if (visiting.has(folderId)) return [];
    visiting.add(folderId);
    const collected = [
      ...(foldersByParent.get(folderId) ?? []).flatMap((child) =>
        collectDescendants(child.id, visiting),
      ),
      ...(projectsByFolder.get(folderId) ?? []),
    ];
    descendantProjectsById.set(folderId, collected);
    return collected;
  };

  const rows: SidebarFolderTreeRow<P>[] = [];
  const visit = (parentId: string | null, depth: number, visiting: Set<string>) => {
    for (const folder of foldersByParent.get(parentId) ?? []) {
      if (visiting.has(folder.id)) continue;
      rows.push({
        kind: "folder",
        key: sidebarFolderRowKey(folder.id),
        folder,
        depth,
        descendantProjects: collectDescendants(folder.id, new Set()),
      });
      if (folder.expanded) {
        visit(folder.id, depth + 1, new Set([...visiting, folder.id]));
      }
    }
    for (const project of projectsByFolder.get(parentId) ?? []) {
      rows.push({
        kind: "project",
        key: getProjectKey(project),
        project,
        depth,
        folderId: parentId,
      });
    }
  };
  visit(null, 0, new Set());
  return rows;
}

/** Folder paths ("Work / Clients") for "Move to folder" menus, in tree order. */
export function listSidebarFolderPaths(
  folders: readonly SidebarFolder[],
): { folder: SidebarFolder; path: string; depth: number }[] {
  const byParent = new Map<string | null, SidebarFolder[]>();
  for (const folder of folders) {
    const siblings = byParent.get(folder.parentId);
    if (siblings) siblings.push(folder);
    else byParent.set(folder.parentId, [folder]);
  }
  const result: { folder: SidebarFolder; path: string; depth: number }[] = [];
  const visit = (parentId: string | null, prefix: string, depth: number, seen: Set<string>) => {
    for (const folder of byParent.get(parentId) ?? []) {
      if (seen.has(folder.id)) continue;
      const path = prefix ? `${prefix} / ${folder.name}` : folder.name;
      result.push({ folder, path, depth });
      visit(folder.id, path, depth + 1, new Set([...seen, folder.id]));
    }
  };
  visit(null, "", 0, new Set());
  return result;
}

export const SIDEBAR_FOLDER_ROOT_DROP_ID = "sidebar-folder-root";

export function isSidebarFolderRowKey(key: string): boolean {
  return key.startsWith("sidebar-folder:");
}

export type SidebarFolderDropTarget =
  | { readonly kind: "root" }
  | { readonly kind: "folder"; readonly folderId: string }
  | { readonly kind: "project"; readonly folderId: string | null };

export type SidebarFolderDropAction =
  | { readonly kind: "move-project"; readonly folderId: string | null; readonly reorder: boolean }
  | { readonly kind: "move-folder"; readonly parentId: string | null };

/**
 * Decides what dropping a dragged sidebar row onto a target does. Dropping on
 * a folder files the row inside it; dropping on a project joins that project's
 * folder (and, for projects, takes its place in the manual order); dropping on
 * the section header moves the row to the top level.
 */
export function resolveSidebarFolderDrop(input: {
  folders: readonly SidebarFolder[];
  dragged: { readonly kind: "project" } | { readonly kind: "folder"; readonly folderId: string };
  target: SidebarFolderDropTarget;
}): SidebarFolderDropAction | null {
  const { folders, dragged, target } = input;
  const destination = target.kind === "root" ? null : target.folderId;
  if (dragged.kind === "project") {
    return { kind: "move-project", folderId: destination, reorder: target.kind === "project" };
  }
  if (destination !== null && isSidebarFolderWithin(folders, destination, dragged.folderId)) {
    return null;
  }
  const current = folders.find((folder) => folder.id === dragged.folderId);
  if (!current || current.parentId === destination) {
    return null;
  }
  return { kind: "move-folder", parentId: destination };
}

export function parseSidebarFolderRowKey(key: string): string | null {
  return isSidebarFolderRowKey(key) ? key.slice("sidebar-folder:".length) : null;
}
