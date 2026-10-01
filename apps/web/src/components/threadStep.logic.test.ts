import { describe, expect, it } from "vite-plus/test";

import {
  createWheelStepper,
  isInHorizontalScrollArea,
  resolveSteppedThreadKey,
  type WheelStepSample,
} from "./threadStep.logic";

const keys = ["a", "b", "c"];

describe("resolveSteppedThreadKey", () => {
  it("steps from the cursor before the open thread", () => {
    expect(
      resolveSteppedThreadKey({
        threadKeys: keys,
        cursorKey: "b",
        currentKey: "a",
        direction: "next",
      }),
    ).toBe("c");
  });

  it("steps from the open thread when there is no cursor", () => {
    expect(
      resolveSteppedThreadKey({
        threadKeys: keys,
        cursorKey: null,
        currentKey: "b",
        direction: "previous",
      }),
    ).toBe("a");
  });

  it("starts at an end when nothing on the list is open", () => {
    const base = { threadKeys: keys, cursorKey: null, currentKey: "gone" };
    expect(resolveSteppedThreadKey({ ...base, direction: "next" })).toBe("a");
    expect(resolveSteppedThreadKey({ ...base, direction: "previous" })).toBe("c");
  });

  it("stops at the ends instead of wrapping", () => {
    expect(
      resolveSteppedThreadKey({
        threadKeys: keys,
        cursorKey: "c",
        currentKey: null,
        direction: "next",
      }),
    ).toBe("c");
    expect(
      resolveSteppedThreadKey({
        threadKeys: [],
        cursorKey: null,
        currentKey: null,
        direction: "next",
      }),
    ).toBeNull();
  });
});

function sample(deltaX: number, timeStamp: number, extra: Partial<WheelStepSample> = {}) {
  return { deltaX, deltaY: 0, shiftKey: false, timeStamp, ...extra };
}

describe("createWheelStepper", () => {
  it("turns one detent's smooth-scroll burst into a single step", () => {
    const stepper = createWheelStepper();
    const steps = [2, 4, 8, 12, 10, 6, 3, 1].map((delta, index) =>
      stepper.push(sample(delta, index * 16)),
    );
    expect(steps.filter(Boolean)).toEqual(["next"]);
  });

  it("steps again after the cooldown and maps negative travel to previous", () => {
    const stepper = createWheelStepper();
    expect(stepper.push(sample(-30, 0))).toBe("previous");
    expect(stepper.push(sample(-30, 50))).toBeNull();
    expect(stepper.push(sample(-30, 400))).toBe("previous");
  });

  it("forgets partial travel after a pause", () => {
    const stepper = createWheelStepper();
    expect(stepper.push(sample(8, 0))).toBeNull();
    expect(stepper.push(sample(8, 1000))).toBeNull();
    expect(stepper.push(sample(8, 1010))).toBe("next");
  });

  it("ignores vertical, diagonal, and Shift+wheel input", () => {
    const stepper = createWheelStepper();
    expect(stepper.push(sample(0, 0, { deltaY: 40 }))).toBeNull();
    expect(stepper.push(sample(30, 10, { deltaY: 20 }))).toBeNull();
    expect(stepper.push(sample(60, 20, { shiftKey: true }))).toBeNull();
  });
});

interface FakeElement {
  scrollWidth: number;
  clientWidth: number;
  parentElement: FakeElement | null;
  tag: string;
  overflowX: string;
  matches(selector: string): boolean;
}

function element(tag: string, parent: FakeElement | null, overrides: Partial<FakeElement> = {}) {
  const node: FakeElement = {
    scrollWidth: 100,
    clientWidth: 100,
    parentElement: parent,
    tag,
    overflowX: "visible",
    matches: (selector) => selector.split(",").includes(tag),
    ...overrides,
  };
  return node;
}

describe("isInHorizontalScrollArea", () => {
  const overflow = (node: object) => (node as FakeElement).overflowX;

  it("keeps normal scrolling inside code blocks and terminals", () => {
    const body = element("body", null);
    expect(isInHorizontalScrollArea(element("span", element("pre", body)), overflow)).toBe(true);
    expect(isInHorizontalScrollArea(element("div", element(".xterm", body)), overflow)).toBe(true);
  });

  it("detects a horizontally overflowing scroll container", () => {
    const body = element("body", null);
    const scroller = element("div", body, { scrollWidth: 400, overflowX: "auto" });
    expect(isInHorizontalScrollArea(element("span", scroller), overflow)).toBe(true);
  });

  it("allows stepping over plain content", () => {
    const body = element("body", null);
    const clipped = element("div", body, { scrollWidth: 400, overflowX: "hidden" });
    expect(isInHorizontalScrollArea(element("p", clipped), overflow)).toBe(false);
  });
});
