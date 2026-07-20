import type { RefObject } from "react";

import type { WhiteBalanceValues } from "../types";
import { WHITE_BALANCE_MAX, WHITE_BALANCE_MIN } from "../lib/white-balance";

export type WhiteBalanceAxis = keyof WhiteBalanceValues;

/** Keeps the two white-balance axes behaviorally identical. */
export function WhiteBalanceAxisControl({
  axis,
  label,
  value,
  disabled,
  rangeRef,
  valueRef,
  onInput,
  onCommit,
  onSet,
}: {
  axis: WhiteBalanceAxis;
  label: string;
  value: number;
  disabled: boolean;
  rangeRef: RefObject<HTMLInputElement | null>;
  valueRef: RefObject<HTMLInputElement | null>;
  onInput: (axis: WhiteBalanceAxis, input: HTMLInputElement) => void;
  onCommit: () => void;
  onSet: (axis: WhiteBalanceAxis, value: number) => void;
}) {
  return (
    <div className="white-balance__row">
      <label htmlFor={axis}>{label}</label>
      <input
        ref={rangeRef}
        id={axis}
        className={`chromatic-range chromatic-range--${axis}`}
        type="range"
        aria-label={`White balance ${axis}`}
        min={WHITE_BALANCE_MIN}
        max={WHITE_BALANCE_MAX}
        step="1"
        defaultValue={value}
        aria-valuetext={`${value}`}
        disabled={disabled}
        onInput={(event) => onInput(axis, event.currentTarget)}
        onPointerUp={onCommit}
        onPointerCancel={onCommit}
        onBlur={onCommit}
      />
      <input
        ref={valueRef}
        className="white-balance__value"
        aria-label={`White balance ${axis} value`}
        type="number"
        min={WHITE_BALANCE_MIN}
        max={WHITE_BALANCE_MAX}
        step="1"
        defaultValue={value}
        disabled={disabled}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber;
          if (Number.isFinite(next)) {
            onSet(
              axis,
              Math.max(WHITE_BALANCE_MIN, Math.min(WHITE_BALANCE_MAX, next)),
            );
          }
        }}
        onBlur={(event) => {
          event.currentTarget.value = String(value);
        }}
      />
    </div>
  );
}
