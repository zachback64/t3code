// Stepping through sidebar threads with horizontal wheel input (an MX Master
// style thumb wheel) or the thread.stepNext / thread.stepPrevious commands.
//
// Each step moves a highlighted cursor one thread along the visible sidebar
// order; the cursor's thread opens once stepping pauses, so a quick spin
// through several threads does not load every thread on the way.

export type ThreadStepDirection = "previous" | "next";

/** Horizontal travel (px) that counts as one detent. */
export const WHEEL_STEP_THRESHOLD = 12;
/** After a step, input is ignored this long so one detent's burst moves one thread. */
export const WHEEL_STEP_COOLDOWN_MS = 160;
/** Partial travel older than this is forgotten. */
export const WHEEL_STEP_RESET_MS = 250;
/** The cursor's thread opens after this long without another step. */
export const THREAD_STEP_COMMIT_DELAY_MS = 320;

/**
 * Next cursor position. Starts from the cursor, else the open thread; with
 * neither on the list it starts at the first (next) or last (previous) row.
 * Stops at the ends rather than wrapping.
 */
export function resolveSteppedThreadKey(input: {
  readonly threadKeys: readonly string[];
  readonly cursorKey: string | null;
  readonly currentKey: string | null;
  readonly direction: ThreadStepDirection;
}): string | null {
  const { threadKeys, cursorKey, currentKey, direction } = input;
  if (threadKeys.length === 0) return null;
  const anchor = [cursorKey, currentKey].find(
    (key): key is string => key !== null && threadKeys.includes(key),
  );
  if (anchor === undefined) {
    return direction === "next" ? threadKeys[0]! : threadKeys.at(-1)!;
  }
  const index = threadKeys.indexOf(anchor);
  const nextIndex = direction === "next" ? index + 1 : index - 1;
  return threadKeys[Math.max(0, Math.min(threadKeys.length - 1, nextIndex))]!;
}

export interface WheelStepSample {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly shiftKey: boolean;
  readonly timeStamp: number;
}

/**
 * Turns a stream of wheel events into discrete steps. Only clearly horizontal
 * input counts; Shift+wheel (which macOS turns into horizontal scrolling) is
 * left alone. Positive deltaX (thumb wheel rolled forward) steps down the list.
 */
export function createWheelStepper(options?: {
  readonly threshold?: number;
  readonly cooldownMs?: number;
  readonly resetMs?: number;
}) {
  const threshold = options?.threshold ?? WHEEL_STEP_THRESHOLD;
  const cooldownMs = options?.cooldownMs ?? WHEEL_STEP_COOLDOWN_MS;
  const resetMs = options?.resetMs ?? WHEEL_STEP_RESET_MS;
  let accumulated = 0;
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let lastStepAt = Number.NEGATIVE_INFINITY;

  return {
    isHorizontal(sample: WheelStepSample): boolean {
      return (
        !sample.shiftKey &&
        sample.deltaX !== 0 &&
        Math.abs(sample.deltaX) > Math.abs(sample.deltaY) * 2
      );
    },
    push(sample: WheelStepSample): ThreadStepDirection | null {
      if (!this.isHorizontal(sample)) return null;
      const now = sample.timeStamp;
      if (now - lastStepAt < cooldownMs) {
        lastInputAt = now;
        return null;
      }
      if (now - lastInputAt > resetMs || Math.sign(sample.deltaX) !== Math.sign(accumulated)) {
        accumulated = 0;
      }
      lastInputAt = now;
      accumulated += sample.deltaX;
      if (Math.abs(accumulated) < threshold) return null;
      const direction: ThreadStepDirection = accumulated > 0 ? "next" : "previous";
      accumulated = 0;
      lastStepAt = now;
      return direction;
    },
  };
}

interface ScrollableElementLike {
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly parentElement: ScrollableElementLike | null;
  matches(selector: string): boolean;
}

// Places where horizontal scrolling is the point, scrollable right now or not.
const HORIZONTAL_SCROLL_SELECTOR = [
  "pre",
  "code",
  "table",
  "textarea",
  "input",
  "[contenteditable='true']",
  ".xterm",
  "[data-terminal]",
  "[data-diff]",
  "[data-diffs]",
  "[data-horizontal-scroll]",
].join(",");

/**
 * True when the wheel target, or anything above it, scrolls horizontally, so
 * thumb-wheel input there keeps its normal meaning.
 */
export function isInHorizontalScrollArea(
  target: ScrollableElementLike | null,
  getOverflowX: (element: ScrollableElementLike) => string,
): boolean {
  for (let element = target; element !== null; element = element.parentElement) {
    if (element.matches(HORIZONTAL_SCROLL_SELECTOR)) return true;
    if (element.scrollWidth > element.clientWidth + 1) {
      const overflowX = getOverflowX(element);
      if (overflowX === "auto" || overflowX === "scroll") return true;
    }
  }
  return false;
}
