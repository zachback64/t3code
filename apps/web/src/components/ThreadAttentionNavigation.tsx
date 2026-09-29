import { useAtomValue } from "@effect/atom-react";
import { useParams, useRouter } from "@tanstack/react-router";
import {
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { useEffect, useEffectEvent, useRef } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isElectron } from "../env";
import { resolveShortcutCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "../state/server";
import { readThreadShells } from "../state/entities";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import {
  buildThreadAttentionQueue,
  popAttentionTrail,
  resolveNextAttentionThreadKey,
} from "./threadAttention.logic";
import { toastManager } from "./ui/toast";

type AttentionDirection = "previous" | "next";

// Mouse thumb buttons: `button === 3` is Back, `button === 4` is Forward.
const MOUSE_BUTTON_BACK = 3;
const MOUSE_BUTTON_FORWARD = 4;
// Desktop forwards macOS swipe gestures (what Logitech Options+ sends for its
// Back/Forward buttons) as these menu actions.
const SWIPE_BACK_ACTION = "swipe-back";
const SWIPE_FORWARD_ACTION = "swipe-forward";
const ATTENTION_TRAIL_LIMIT = 50;
const CAUGHT_UP_TOAST_ID = "thread-attention-caught-up";

function directionForMouseButton(button: number): AttentionDirection | null {
  if (button === MOUSE_BUTTON_BACK) return "previous";
  if (button === MOUSE_BUTTON_FORWARD) return "next";
  return null;
}

/**
 * Next/previous attention: `thread.nextAttention` opens the next thread
 * waiting on the user and `thread.previousAttention` retraces those jumps.
 * In the desktop app the mouse's back/forward buttons run the same commands
 * instead of Chromium's default history navigation; with no jumps to retrace,
 * back still falls through to history so the button keeps its usual meaning.
 */
export function ThreadAttentionNavigation() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const router = useRouter();
  const routeThreadKey = useParams({
    strict: false,
    select: (params) => {
      const ref = resolveThreadRouteRef(params);
      return ref === null ? null : scopedThreadKey(ref);
    },
  });
  const trailRef = useRef<string[]>([]);

  const navigate = useEffectEvent((direction: AttentionDirection) => {
    const currentThreadKey = routeThreadKey;
    // Read on demand: subscribing to every shell would re-render this on each
    // streamed update for a command pressed a few times a minute.
    const threads = readThreadShells();
    const openThread = (threadKey: string) => {
      const ref = parseScopedThreadKey(threadKey);
      if (ref === null) return;
      void router
        .navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) })
        .then(() => {
          requestAnimationFrame(() => {
            document
              .querySelector('[data-app-sidebar] [aria-current="page"]')
              ?.scrollIntoView({ block: "nearest" });
          });
        });
    };

    if (direction === "previous") {
      const knownKeys = new Set(
        threads.map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
      );
      const { target, trail } = popAttentionTrail({
        trail: trailRef.current,
        currentThreadKey,
        exists: (threadKey) => knownKeys.has(threadKey),
      });
      trailRef.current = trail;
      if (target === null) window.history.back();
      else openThread(target);
      return;
    }

    const target = resolveNextAttentionThreadKey({
      queue: buildThreadAttentionQueue({
        threads,
        lastVisitedAtByKey: useUiStateStore.getState().threadLastVisitedAtById,
        now: new Date().toISOString(),
      }),
      currentThreadKey,
    });
    if (target === null) {
      toastManager.add({ id: CAUGHT_UP_TOAST_ID, type: "info", title: "All caught up" });
      return;
    }
    if (currentThreadKey !== null) {
      trailRef.current = [...trailRef.current, currentThreadKey].slice(-ATTENTION_TRAIL_LIMIT);
    }
    openThread(target);
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen()) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          previewFocus: isPreviewFocused(),
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command !== "thread.nextAttention" && command !== "thread.previousAttention") return;
      event.preventDefault();
      event.stopPropagation();
      navigate(command === "thread.nextAttention" ? "next" : "previous");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  useEffect(() => {
    if (!isElectron) return;
    // Chromium navigates history on the thumb buttons unless every phase of
    // the click is cancelled; the command itself runs once, on mouseup.
    const suppress = (event: MouseEvent) => {
      if (!event.isTrusted || directionForMouseButton(event.button) === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onMouseUp = (event: MouseEvent) => {
      if (!event.isTrusted) return;
      const direction = directionForMouseButton(event.button);
      if (direction === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      navigate(direction);
    };
    window.addEventListener("mousedown", suppress, true);
    window.addEventListener("mouseup", onMouseUp, true);
    window.addEventListener("auxclick", suppress, true);
    const unsubscribeMenu = window.desktopBridge?.onMenuAction?.((action) => {
      if (action === SWIPE_BACK_ACTION) navigate("previous");
      else if (action === SWIPE_FORWARD_ACTION) navigate("next");
    });
    return () => {
      window.removeEventListener("mousedown", suppress, true);
      window.removeEventListener("mouseup", onMouseUp, true);
      window.removeEventListener("auxclick", suppress, true);
      unsubscribeMenu?.();
    };
  }, []);

  return null;
}
