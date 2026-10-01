import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { create } from "zustand";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import {
  createWheelStepper,
  isInHorizontalScrollArea,
  resolveSteppedThreadKey,
  THREAD_STEP_COMMIT_DELAY_MS,
  type ThreadStepDirection,
} from "./threadStep.logic";

interface ThreadStepCursorState {
  // Thread the stepping cursor sits on, highlighted until it opens.
  readonly cursorKey: string | null;
  setCursorKey: (cursorKey: string | null) => void;
}

export const useThreadStepCursorStore = create<ThreadStepCursorState>((set) => ({
  cursorKey: null,
  setCursorKey: (cursorKey) => set({ cursorKey }),
}));

function scrollRowIntoView(threadKey: string) {
  requestAnimationFrame(() => {
    document
      .querySelector(`[data-thread-step-key="${CSS.escape(threadKey)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });
}

/**
 * Steps a cursor through `threadKeys` (the visible sidebar order) from
 * horizontal wheel input and the thread.stepNext/thread.stepPrevious
 * commands, then opens the cursor's thread once stepping pauses.
 */
export function useThreadStepNavigation(input: {
  readonly enabled: boolean;
  readonly threadKeys: readonly string[];
  readonly currentKey: string | null;
  readonly openThread: (threadKey: string) => void;
}): (direction: ThreadStepDirection) => boolean {
  const { enabled, threadKeys } = input;
  const latestRef = useRef(input);
  useLayoutEffect(() => {
    latestRef.current = input;
  });
  const commitTimerRef = useRef<number | null>(null);

  const clearCommitTimer = useCallback(() => {
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
  }, []);

  const step = useCallback(
    (direction: ThreadStepDirection): boolean => {
      const { threadKeys, currentKey } = latestRef.current;
      const { cursorKey, setCursorKey } = useThreadStepCursorStore.getState();
      const target = resolveSteppedThreadKey({ threadKeys, cursorKey, currentKey, direction });
      if (target === null || (target === currentKey && cursorKey === null)) return false;
      setCursorKey(target);
      scrollRowIntoView(target);
      clearCommitTimer();
      commitTimerRef.current = window.setTimeout(() => {
        commitTimerRef.current = null;
        const pending = useThreadStepCursorStore.getState().cursorKey;
        useThreadStepCursorStore.getState().setCursorKey(null);
        if (pending !== null && pending !== latestRef.current.currentKey) {
          latestRef.current.openThread(pending);
        }
      }, THREAD_STEP_COMMIT_DELAY_MS);
      return true;
    },
    [clearCommitTimer],
  );

  useEffect(() => {
    if (!enabled) return;
    const stepper = createWheelStepper();
    const onWheel = (event: WheelEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
      const sample = {
        deltaX: event.deltaMode === 1 ? event.deltaX * 16 : event.deltaX,
        deltaY: event.deltaY,
        shiftKey: event.shiftKey,
        timeStamp: event.timeStamp,
      };
      if (!stepper.isHorizontal(sample)) return;
      if (isCommandPaletteOpen() || isModelPickerOpen()) return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        isInHorizontalScrollArea(
          target,
          (element) => getComputedStyle(element as Element).overflowX,
        )
      ) {
        return;
      }
      // Horizontal input outside scrollable areas belongs to stepping, so keep
      // it from turning into a history swipe.
      event.preventDefault();
      const direction = stepper.push(sample);
      if (direction !== null) step(direction);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [enabled, step]);

  // A cursor left on a thread that scrolled out of the list is dropped.
  useEffect(() => {
    const { cursorKey, setCursorKey } = useThreadStepCursorStore.getState();
    if (cursorKey !== null && !threadKeys.includes(cursorKey)) setCursorKey(null);
  }, [threadKeys]);

  useEffect(
    () => () => {
      clearCommitTimer();
      useThreadStepCursorStore.getState().setCursorKey(null);
    },
    [clearCommitTimer],
  );

  return step;
}
