// @effect-diagnostics globalTimers:off - Display timing for a React component, outside an Effect runtime.
import { CircleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Spinner } from "~/components/ui/spinner";

import {
  isThreadSyncFailed,
  THREAD_SYNC_STALL_MS,
  threadSyncLabel,
  type ThreadSyncPhase,
} from "../../threadSync";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";

/** True once `phase` has stayed in progress for `THREAD_SYNC_STALL_MS`. */
function useSyncStalled(phase: ThreadSyncPhase): boolean {
  const [stalledPhase, setStalledPhase] = useState<ThreadSyncPhase | null>(null);
  useEffect(() => {
    if (isThreadSyncFailed(phase)) return;
    const timer = setTimeout(() => setStalledPhase(phase), THREAD_SYNC_STALL_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  return stalledPhase === phase;
}

export function ComposerActivityRow({
  phase,
  onRetry,
}: {
  readonly phase: ThreadSyncPhase;
  /** Restarts the thread's sync. Offered once the sync failed or stalled. */
  readonly onRetry?: (() => void) | undefined;
}) {
  const failed = isThreadSyncFailed(phase);
  const stalled = useSyncStalled(phase);
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Icon>{failed ? <CircleAlertIcon /> : <Spinner />}</ComposerBanner.Icon>
      <ComposerBanner.Content>
        <span
          className="shrink-0 whitespace-nowrap text-muted-foreground"
          data-composer-sync-status={phase}
          role="status"
        >
          {threadSyncLabel(phase)}
        </span>
      </ComposerBanner.Content>
      {onRetry && (failed || stalled) ? (
        <ComposerBanner.Actions>
          <Button size="xs" variant="ghost" onClick={onRetry}>
            Retry
          </Button>
        </ComposerBanner.Actions>
      ) : null}
    </ComposerBanner.Row>
  );
}
