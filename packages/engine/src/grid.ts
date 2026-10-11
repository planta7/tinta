import type {
  ControlDefinition,
  SliderDefinition,
  Span,
} from "@tinta-lang/types";
import { fail } from "./common.js";

/** Decimal tokens become exact millionths before any binary64 grid arithmetic. */
export function units(raw: string): bigint | undefined {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) return undefined;
  const fraction = match[3] ?? "";
  if (/^0+$/.test(match[2]! + fraction)) return 0n;
  const exponent = Number(match[4] ?? 0) + 6 - fraction.length;
  if (Math.abs(exponent) > 400) return undefined;
  let value = BigInt(match[2]! + fraction);
  if (exponent >= 0) value *= 10n ** BigInt(exponent);
  else {
    const divisor = 10n ** BigInt(-exponent);
    if (value % divisor !== 0n) return undefined;
    value /= divisor;
  }
  return match[1] === "-" ? -value : value;
}

export function grid(
  min: string,
  max: string,
  step: string,
  span: Span,
): SliderDefinition["grid"] {
  const a = units(min),
    b = units(max),
    s = units(step);
  if (
    a === undefined ||
    b === undefined ||
    s === undefined ||
    a >= b ||
    s < 1n ||
    a < -1000000000000000n ||
    b > 1000000000000000n ||
    (b - a) % s !== 0n ||
    (b - a) / s > 100000n
  )
    fail("E_STATE_DOMAIN", span);

  return {
    scale: 1000000,
    minUnits: String(a),
    stepUnits: String(s),
    ticks: Number((b - a) / s),
  };
}

export function inDomain(control: ControlDefinition, value: unknown): boolean {
  if (control.kind === "toggle") return typeof value === "boolean";
  if (control.kind === "choice")
    return typeof value === "string" && control.options.includes(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const n = units(String(value));
  if (n === undefined) return false;
  const offset = n - BigInt(control.grid.minUnits),
    step = BigInt(control.grid.stepUnits);
  return (
    offset >= 0n &&
    offset <= step * BigInt(control.grid.ticks) &&
    offset % step === 0n
  );
}
