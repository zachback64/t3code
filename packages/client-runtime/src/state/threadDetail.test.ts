import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { threadStateFromResult } from "./threadDetail.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "./threadState.ts";

describe("threadStateFromResult", () => {
  it("reads a running state machine's value unchanged", () => {
    const state = { ...EMPTY_ENVIRONMENT_THREAD_STATE, status: "synchronizing" as const };
    expect(threadStateFromResult(AsyncResult.success(state))).toBe(state);
  });

  it("reports a failed state machine as an error instead of an endless load", () => {
    const state = threadStateFromResult(
      AsyncResult.failure(Cause.die(new Error("storage closed")), {
        previousSuccess: Option.some(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)),
      }),
    );

    expect(state.status).toBe("empty");
    expect(Option.isSome(state.error)).toBe(true);
  });
});
