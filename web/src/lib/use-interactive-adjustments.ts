import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { QueueItem } from "../types";

export type AdjustmentAxis = "ev" | "temperature" | "tint";
export type AdjustmentValues = Pick<QueueItem, AdjustmentAxis>;

const PREVIEW_INTERVAL_MS = 16;
const SETTLE_DELAY_MS = 80;

function equal(a: AdjustmentValues, b: AdjustmentValues): boolean {
  return a.ev === b.ev && a.temperature === b.temperature && a.tint === b.tint;
}

function valuesFrom(item: QueueItem | undefined): AdjustmentValues {
  return {
    ev: item?.ev ?? 0,
    temperature: item?.temperature ?? 0,
    tint: item?.tint ?? 0,
  };
}

/** Coalesces native slider input into one latest GPU recipe and one persisted edit. */
export function useInteractiveAdjustments({
  active,
  onInvalidate,
  onPersist,
}: {
  active: QueueItem | undefined;
  onInvalidate: () => void;
  onPersist: (patch: Partial<AdjustmentValues>) => void;
}) {
  const [interaction, setInteraction] = useState<{
    fileId: string;
    values: AdjustmentValues;
  }>();
  const [interacting, setInteracting] = useState(false);
  const commitTimer = useRef<number | undefined>(undefined);
  const settleTimer = useRef<number | undefined>(undefined);
  const pending = useRef(valuesFrom(active));
  const committed = useRef(valuesFrom(active));
  const pendingPatch = useRef<Partial<AdjustmentValues>>({});
  const hasPendingRecipe = useRef(false);
  const rendersInFlight = useRef(0);
  const lastCommitAt = useRef(0);
  const activeId = useRef(active?.id);
  activeId.current = active?.id;

  const scheduleRender = useCallback(() => {
    if (
      equal(pending.current, committed.current) ||
      rendersInFlight.current > 0 ||
      commitTimer.current !== undefined
    ) {
      return;
    }
    const elapsed = lastCommitAt.current
      ? performance.now() - lastCommitAt.current
      : 0;
    commitTimer.current = window.setTimeout(
      () => {
        commitTimer.current = undefined;
        if (rendersInFlight.current > 0) return;
        lastCommitAt.current = performance.now();
        const values = pending.current;
        committed.current = values;
        if (activeId.current) {
          setInteraction({ fileId: activeId.current, values });
        }
      },
      Math.max(0, PREVIEW_INTERVAL_MS - elapsed),
    );
  }, []);

  const persist = useCallback(() => {
    if (!activeId.current) return;
    if (commitTimer.current !== undefined) {
      window.clearTimeout(commitTimer.current);
      commitTimer.current = undefined;
    }
    committed.current = pending.current;
    setInteraction(undefined);
    const patch = pendingPatch.current;
    pendingPatch.current = {};
    if (Object.keys(patch).length > 0) onPersist(patch);
  }, [onPersist]);

  const finish = useCallback(() => {
    if (settleTimer.current !== undefined) {
      window.clearTimeout(settleTimer.current);
      settleTimer.current = undefined;
    }
    setInteracting(false);
    persist();
  }, [persist]);

  const schedule = useCallback(
    (axis: AdjustmentAxis, value: number, canRender: boolean) => {
      pending.current = { ...pending.current, [axis]: value };
      pendingPatch.current = { ...pendingPatch.current, [axis]: value };
      if (!hasPendingRecipe.current) {
        hasPendingRecipe.current = true;
        onInvalidate();
      }
      setInteracting(true);
      if (settleTimer.current !== undefined) {
        window.clearTimeout(settleTimer.current);
      }
      settleTimer.current = window.setTimeout(() => {
        settleTimer.current = undefined;
        setInteracting(false);
        persist();
      }, SETTLE_DELAY_MS);
      if (canRender) scheduleRender();
    },
    [onInvalidate, persist, scheduleRender],
  );

  const set = useCallback(
    (patch: Partial<AdjustmentValues>) => {
      if (settleTimer.current !== undefined) {
        window.clearTimeout(settleTimer.current);
        settleTimer.current = undefined;
      }
      if (commitTimer.current !== undefined) {
        window.clearTimeout(commitTimer.current);
        commitTimer.current = undefined;
      }
      const values = { ...pending.current, ...patch };
      pending.current = values;
      committed.current = values;
      pendingPatch.current = {};
      hasPendingRecipe.current = true;
      lastCommitAt.current = performance.now();
      setInteracting(false);
      setInteraction(undefined);
      onInvalidate();
      onPersist(patch);
    },
    [onInvalidate, onPersist],
  );

  useEffect(() => {
    if (commitTimer.current !== undefined) {
      window.clearTimeout(commitTimer.current);
      commitTimer.current = undefined;
    }
    if (settleTimer.current !== undefined) {
      window.clearTimeout(settleTimer.current);
      settleTimer.current = undefined;
    }
    const values = valuesFrom(active);
    setInteraction(undefined);
    setInteracting(false);
    pending.current = values;
    committed.current = values;
    pendingPatch.current = {};
    hasPendingRecipe.current = false;
  }, [active?.id]);

  useEffect(
    () => () => {
      if (commitTimer.current !== undefined)
        window.clearTimeout(commitTimer.current);
      if (settleTimer.current !== undefined)
        window.clearTimeout(settleTimer.current);
    },
    [],
  );

  const stored = useMemo(
    () => valuesFrom(active),
    [active?.ev, active?.temperature, active?.tint],
  );
  const values = useMemo(
    () =>
      active && interaction?.fileId === active.id ? interaction.values : stored,
    [active?.id, interaction, stored],
  );

  const isLatest = useCallback(
    (candidate: AdjustmentValues) => equal(pending.current, candidate),
    [],
  );
  const pendingValue = useCallback(
    (axis: AdjustmentAxis) => pending.current[axis],
    [],
  );
  const markSettled = useCallback((rendered: AdjustmentValues) => {
    if (equal(pending.current, rendered)) hasPendingRecipe.current = false;
  }, []);
  const runRender = useCallback(
    async <Result>(
      rendered: AdjustmentValues,
      task: () => Promise<Result>,
    ): Promise<Result> => {
      rendersInFlight.current += 1;
      try {
        return await task();
      } finally {
        rendersInFlight.current -= 1;
        if (
          rendersInFlight.current === 0 &&
          !equal(pending.current, rendered)
        ) {
          scheduleRender();
        }
      }
    },
    [scheduleRender],
  );

  return useMemo(
    () => ({
      values,
      interacting,
      isLatest,
      pendingValue,
      schedule,
      set,
      finish,
      runRender,
      markSettled,
    }),
    [
      finish,
      interacting,
      isLatest,
      markSettled,
      pendingValue,
      runRender,
      schedule,
      set,
      values,
    ],
  );
}
