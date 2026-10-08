import { limits } from "@tinta/artifacts";

export interface Base {
  protocol: "tinta-host-1";
  documentId: string;
  capability: string;
  requestId: number;
  sourceRevision: number;
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export const baseKeys = [
  "protocol",
  "documentId",
  "capability",
  "requestId",
  "sourceRevision",
  "kind",
];

export function base(value: unknown): value is Base & Record<string, unknown> {
  return (
    record(value) &&
    value.protocol === "tinta-host-1" &&
    typeof value.documentId === "string" &&
    /^[a-f0-9]{32}$/.test(value.documentId) &&
    typeof value.capability === "string" &&
    /^[a-f0-9]{32,128}$/.test(value.capability) &&
    integer(value.requestId) &&
    integer(value.sourceRevision)
  );
}

export function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function token(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export function controls(value: unknown): boolean {
  return (
    record(value) &&
    Object.keys(value).length <= 128 &&
    Object.entries(value).every(
      ([key, v]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
        !["__proto__", "constructor", "prototype"].includes(key) &&
        (typeof v === "boolean" ||
          (typeof v === "string" && v.length <= limits.sourceBytes) ||
          (typeof v === "number" && Number.isFinite(v))),
    )
  );
}

export function identity(value: Base, expected: Base): boolean {
  return (
    value.documentId === expected.documentId &&
    value.capability === expected.capability
  );
}
