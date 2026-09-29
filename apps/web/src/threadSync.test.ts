import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createThreadSyncRecovery, resolveThreadSyncPhase } from "./threadSync";

describe("resolveThreadSyncPhase", () => {
  it("loads when only shell data is available", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "synchronizing",
        hasError: false,
      }),
    ).toBe("loading");
  });

  it("syncs when cached detail is already visible", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "cached",
        hasError: false,
      }),
    ).toBe("syncing");
  });

  it("reports a failed load instead of loading forever", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "empty",
        hasError: true,
      }),
    ).toBe("load-failed");
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "cached",
        hasError: true,
      }),
    ).toBe("sync-failed");
  });

  it("does not report a sync phase without a shell or after going live", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: false,
        status: "empty",
        hasError: false,
      }),
    ).toBeNull();
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "live",
        hasError: false,
      }),
    ).toBeNull();
  });
});

describe("createThreadSyncRecovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const retry = vi.fn<(key: string) => void>();
    const onRetried = vi.fn<() => void>();
    const recovery = createThreadSyncRecovery({ retry, onRetried, delaysMs: [100, 200] });
    return { recovery, retry, onRetried };
  }

  it("keeps showing progress while it retries a failure, then reports it", () => {
    const { recovery, retry, onRetried } = setup();

    expect(recovery.update("thread-a", "load-failed")).toBe("loading");
    vi.advanceTimersByTime(100);
    expect(retry).toHaveBeenCalledWith("thread-a");
    expect(onRetried).toHaveBeenCalledTimes(1);

    // The restarted machine failed the same way.
    expect(recovery.update("thread-a", "load-failed")).toBe("loading");
    vi.advanceTimersByTime(200);
    expect(retry).toHaveBeenCalledTimes(2);

    expect(recovery.update("thread-a", "load-failed")).toBe("load-failed");
    vi.advanceTimersByTime(10_000);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending retry when the sync recovers on its own", () => {
    const { recovery, retry } = setup();

    recovery.update("thread-a", "sync-failed");
    expect(recovery.update("thread-a", "syncing")).toBe("syncing");
    vi.advanceTimersByTime(1_000);

    expect(retry).not.toHaveBeenCalled();
  });

  it("gives a thread fresh retries once it is back in sync", () => {
    const { recovery, retry } = setup();

    recovery.update("thread-a", "load-failed");
    vi.advanceTimersByTime(100);
    recovery.update("thread-a", "load-failed");
    vi.advanceTimersByTime(200);
    expect(recovery.update("thread-a", "load-failed")).toBe("load-failed");

    expect(recovery.update("thread-a", null)).toBeNull();
    expect(recovery.update("thread-a", "sync-failed")).toBe("syncing");
    vi.advanceTimersByTime(100);
    expect(retry).toHaveBeenCalledTimes(3);
  });

  it("drops a pending retry when switching threads", () => {
    const { recovery, retry } = setup();

    recovery.update("thread-a", "load-failed");
    expect(recovery.update("thread-b", "loading")).toBe("loading");
    vi.advanceTimersByTime(1_000);

    expect(retry).not.toHaveBeenCalled();
  });
});
