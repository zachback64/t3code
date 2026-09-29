/**
 * Folder rows for the legacy (project-tree) sidebar. Folders group project
 * rows; their state lives in the UI state store (see `sidebarFolders.ts`).
 *
 * A collapsed folder shows the highest-priority status of every thread filed
 * anywhere inside it, the same way a collapsed project summarizes its threads.
 */
import { useDroppable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  SIDEBAR_FOLDER_ROOT_DROP_ID,
  sidebarFolderRowKey,
  type SidebarFolder,
} from "../../sidebarFolders";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { resolveProjectStatusIndicator, resolveThreadStatusPill } from "../Sidebar.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Horizontal indent per folder level, matching the thread list's inset. */
export function sidebarFolderIndentStyle(depth: number): React.CSSProperties | undefined {
  return depth > 0 ? { paddingLeft: `${depth * 0.75}rem` } : undefined;
}

const EMPTY_THREADS: readonly SidebarThreadSummary[] = [];

function useFolderStatus(threads: readonly SidebarThreadSummary[]) {
  const lastVisitedAts = useUiStateStore(
    useShallow((state) =>
      threads.map(
        (thread) =>
          state.threadLastVisitedAtById[
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
          ] ?? null,
      ),
    ),
  );
  return useMemo(
    () =>
      resolveProjectStatusIndicator(
        threads.map((thread, index) => {
          const lastVisitedAt = lastVisitedAts[index];
          return resolveThreadStatusPill({
            thread: { ...thread, ...(lastVisitedAt ? { lastVisitedAt } : {}) },
          });
        }),
      ),
    [lastVisitedAts, threads],
  );
}

export interface SidebarFolderRowProps {
  folder: SidebarFolder;
  depth: number;
  projectCount: number;
  // Unarchived threads of every project below the folder. Only read while
  // collapsed, so an open folder does not subscribe to their visit times.
  threads: readonly SidebarThreadSummary[];
  isManualProjectSorting: boolean;
  onContextMenu: (folder: SidebarFolder, position: { x: number; y: number }) => void;
  dragInProgressRef: React.RefObject<boolean>;
  suppressProjectClickAfterDragRef: React.RefObject<boolean>;
}

export const SidebarFolderRow = memo(function SidebarFolderRow(props: SidebarFolderRowProps) {
  const {
    folder,
    depth,
    projectCount,
    threads,
    isManualProjectSorting,
    onContextMenu,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
  } = props;
  const setFolderExpanded = useUiStateStore((state) => state.setSidebarFolderExpanded);
  const status = useFolderStatus(folder.expanded ? EMPTY_THREADS : threads);
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({
    id: sidebarFolderRowKey(folder.id),
    disabled: !isManualProjectSorting,
  });

  const toggle = useCallback(() => {
    setFolderExpanded(folder.id, !folder.expanded);
  }, [folder.expanded, folder.id, setFolderExpanded]);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (dragInProgressRef.current) {
        event.preventDefault();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        return;
      }
      toggle();
    },
    [dragInProgressRef, suppressProjectClickAfterDragRef, toggle],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowRight" && !folder.expanded) {
        event.preventDefault();
        setFolderExpanded(folder.id, true);
        return;
      }
      if (event.key === "ArrowLeft" && folder.expanded) {
        event.preventDefault();
        setFolderExpanded(folder.id, false);
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    },
    [folder.expanded, folder.id, setFolderExpanded, toggle],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      onContextMenu(folder, { x: event.clientX, y: event.clientY });
    },
    [folder, onContextMenu],
  );

  const FolderGlyph = folder.expanded ? FolderOpenIcon : FolderIcon;

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: transition,
        ...sidebarFolderIndentStyle(depth),
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
      data-testid="sidebar-folder-row"
    >
      <div className="group/folder-header relative">
        <SidebarMenuButton
          ref={isManualProjectSorting ? setActivatorNodeRef : undefined}
          className={isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : undefined}
          {...(isManualProjectSorting ? attributes : {})}
          {...(isManualProjectSorting ? listeners : {})}
          aria-expanded={folder.expanded}
          aria-label={`${folder.name} folder`}
          onPointerDownCapture={() => {
            // A drag that just ended leaves this set so its trailing click is
            // ignored; a fresh press is a real click.
            suppressProjectClickAfterDragRef.current = false;
          }}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onContextMenu={handleContextMenu}
        >
          {!folder.expanded && status ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    aria-label={status.label}
                    className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
                  />
                }
              >
                <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/folder-header:opacity-0">
                  <span
                    className={`size-[9px] rounded-full ${status.dotClass} ${
                      status.pulse ? "animate-status-pulse" : ""
                    }`}
                  />
                </span>
                <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-icon-muted opacity-0 transition-opacity duration-150 group-hover/folder-header:opacity-100" />
              </TooltipTrigger>
              <TooltipPopup side="top">{status.label}</TooltipPopup>
            </Tooltip>
          ) : (
            <ChevronRightIcon
              className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                folder.expanded ? "rotate-90" : ""
              }`}
            />
          )}
          <FolderGlyph className="size-3.5 shrink-0 text-icon-muted" />
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-sm font-medium text-sidebar-foreground/90">
              {folder.name}
            </span>
            {!folder.expanded && projectCount > 0 ? (
              <span className="shrink-0 text-secondary-label text-3xs">
                {projectCount === 1 ? "1 project" : `${projectCount} projects`}
              </span>
            ) : null}
          </span>
        </SidebarMenuButton>
      </div>
    </li>
  );
});

/** Makes the "Projects" section header a drop target for "move to top level". */
export function SidebarFolderRootDropZone(props: {
  enabled: boolean;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: SIDEBAR_FOLDER_ROOT_DROP_ID,
    disabled: !props.enabled,
  });
  return (
    <div
      ref={setNodeRef}
      onContextMenu={props.onContextMenu}
      className={`mb-1 flex items-center justify-between rounded-md pl-2 pr-1.5 ${
        isOver ? "ring-1 ring-primary/40" : ""
      }`}
    >
      {props.children}
    </div>
  );
}

export type SidebarFolderDialogRequest =
  | {
      readonly mode: "create";
      readonly parentId: string | null;
      // Preference keys of projects to file into the new folder.
      readonly projects?: readonly (readonly string[])[];
    }
  | { readonly mode: "rename"; readonly folderId: string; readonly currentName: string };

export function SidebarFolderNameDialog(props: {
  request: SidebarFolderDialogRequest | null;
  parentPath: string | null;
  onClose: () => void;
  onSubmit: (request: SidebarFolderDialogRequest, name: string) => void;
}) {
  const { request, parentPath, onClose, onSubmit } = props;
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {request ? (
        <SidebarFolderNameDialogBody
          // Remount per request so the field starts from the right name.
          key={request.mode === "rename" ? `rename:${request.folderId}` : "create"}
          request={request}
          parentPath={parentPath}
          onClose={onClose}
          onSubmit={onSubmit}
        />
      ) : null}
    </Dialog>
  );
}

function SidebarFolderNameDialogBody(props: {
  request: SidebarFolderDialogRequest;
  parentPath: string | null;
  onClose: () => void;
  onSubmit: (request: SidebarFolderDialogRequest, name: string) => void;
}) {
  const { request, parentPath, onClose, onSubmit } = props;
  const [name, setName] = useState(request.mode === "rename" ? request.currentName : "");
  const canSubmit = name.trim().length > 0;
  const submit = () => {
    if (!canSubmit) return;
    onSubmit(request, name);
  };
  return (
    <DialogPopup className="max-w-sm">
      <DialogHeader>
        <DialogTitle>{request.mode === "rename" ? "Rename folder" : "New folder"}</DialogTitle>
        <DialogDescription>
          {request.mode === "rename"
            ? "Folders only organize the sidebar. Projects are not moved on disk."
            : parentPath
              ? `Create a folder inside ${parentPath}.`
              : "Group projects in the sidebar. Projects are not moved on disk."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Folder name</span>
          <Input
            aria-label="Folder name"
            autoFocus
            placeholder="Personal"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!canSubmit} onClick={submit}>
          {request.mode === "rename" ? "Save" : "Create"}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
