/** Bounded JSON envelope validation; programs and raster bytes need decoding too. */
import { limits, utf8ByteLength } from "./common.js";
import type { ControlState, Diagnostic, ProgramIR } from "./index.js";
import type { SourceIdentity } from "./editor.js";

export interface WebviewIdentity {
  readonly protocol: "tinta-vscode-1";
  readonly panelId: string;
  readonly capability: string;
  readonly requestId: number;
  readonly source: SourceIdentity;
}

export interface WebviewAsset {
  readonly path: string;
  readonly mime: "image/png" | "image/jpeg" | "image/webp";
  readonly sha256: string;
  readonly bytesBase64: string;
}

export type ExtensionToWebview = WebviewIdentity &
  (
    | Readonly<{
        kind: "load";
        program: ProgramIR;
        assets: readonly WebviewAsset[];
        assetPaths: Readonly<Record<string, string>>;
        baseline: ControlState;
        assetRevision: number;
      }>
    | Readonly<{ kind: "set-enabled"; enabled: boolean }>
    | Readonly<{ kind: "reset" | "get-state" | "destroy" }>
  );

export type WebviewToExtension = WebviewIdentity &
  (
    | Readonly<{ kind: "ready" | "destroyed" }>
    | Readonly<{
        kind: "state";
        controls: ControlState;
        sessionRevision: number;
        assetRevision: number;
      }>
    | Readonly<{ kind: "diagnostics"; diagnostics: readonly Diagnostic[] }>
  );

const headerKeys = [
  "protocol",
  "panelId",
  "capability",
  "requestId",
  "source",
  "kind",
];
const identityKeys = [
  "uri",
  "documentInstance",
  "editorVersion",
  "sourceRevision",
  "profile",
  "sourceSha256",
];

export function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

export function unsigned(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hex(value: unknown, length: number): value is string {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[a-f0-9]+$/.test(value)
  );
}

export function sourceIdentity(value: unknown): value is SourceIdentity {
  return (
    record(value) &&
    exactKeys(value, identityKeys) &&
    typeof value.uri === "string" &&
    value.uri.length > 0 &&
    value.uri.length <= 4096 &&
    hex(value.documentInstance, 32) &&
    unsigned(value.editorVersion) &&
    value.editorVersion > 0 &&
    unsigned(value.sourceRevision) &&
    (value.profile === "tinta" || value.profile === "markdown") &&
    hex(value.sourceSha256, 64)
  );
}

export function controlState(value: unknown): value is ControlState {
  return (
    record(value) &&
    Object.keys(value).length <= 128 &&
    Object.entries(value).every(
      ([name, item]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        !["__proto__", "constructor", "prototype"].includes(name) &&
        (typeof item === "boolean" ||
          (typeof item === "number" && Number.isFinite(item)) ||
          (typeof item === "string" &&
            utf8ByteLength(item) <= limits.sourceBytes)),
    )
  );
}

/** Count before serialization; reject cycles, accessors and non-JSON values. */
export function boundedJson(value: unknown): boolean {
  const seen = new Set<object>();
  let objects = 0;
  let bytes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 128 || bytes > 64 * 1024 * 1024) return false;
    if (item === null || typeof item === "boolean") {
      bytes += item === null || item === true ? 4 : 5;
    } else if (typeof item === "number") {
      if (!Number.isFinite(item)) return false;
      bytes += String(item).length;
    } else if (typeof item === "string") {
      // Bound the string before JSON escaping can allocate a larger copy.
      if (item.length > 64 * 1024 * 1024) return false;
      bytes += utf8ByteLength(JSON.stringify(item));
    } else if (typeof item === "object") {
      if ((!Array.isArray(item) && !record(item)) || seen.has(item))
        return false;
      if (++objects > 100000) return false;
      seen.add(item);
      bytes += 2;
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const entries = Object.entries(descriptors).filter(
        ([key]) => !(Array.isArray(item) && key === "length"),
      );
      if (Object.getOwnPropertySymbols(item).length) return false;
      if (Array.isArray(item) && entries.length !== item.length) return false;
      for (let index = 0; index < entries.length; index++) {
        const [key, descriptor] = entries[index]!;
        if (!descriptor.enumerable || !("value" in descriptor)) return false;
        if (Array.isArray(item)) {
          if (key !== String(index)) return false;
        } else {
          bytes += utf8ByteLength(JSON.stringify(key)) + 1;
        }
        if (index) bytes++;
        if (!visit(descriptor.value, depth + 1)) return false;
      }
    } else return false;
    return bytes <= 64 * 1024 * 1024;
  };
  try {
    return visit(value, 0);
  } catch {
    return false;
  }
}

function header(
  value: unknown,
): value is WebviewIdentity & Record<string, unknown> {
  return (
    record(value) &&
    value.protocol === "tinta-vscode-1" &&
    hex(value.panelId, 32) &&
    typeof value.capability === "string" &&
    /^[a-f0-9]{32,128}$/.test(value.capability) &&
    unsigned(value.requestId) &&
    sourceIdentity(value.source)
  );
}

function canonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const end = value.length - padding;
  for (let index = 0; index < end; index++) {
    if (!alphabet.includes(value[index]!)) return false;
  }
  if (padding === 2) return alphabet.indexOf(value[end - 1]!) % 16 === 0;
  if (padding === 1) return alphabet.indexOf(value[end - 1]!) % 4 === 0;
  return true;
}

function assetEnvelope(value: unknown): value is WebviewAsset {
  return (
    record(value) &&
    exactKeys(value, ["path", "mime", "sha256", "bytesBase64"]) &&
    typeof value.path === "string" &&
    value.path.length <= 4096 &&
    ["image/png", "image/jpeg", "image/webp"].includes(String(value.mime)) &&
    hex(value.sha256, 64) &&
    typeof value.bytesBase64 === "string" &&
    value.bytesBase64.length <= 4 * Math.ceil(limits.assetBytes / 3) &&
    canonicalBase64(value.bytesBase64)
  );
}

/** Shape only: the receiver must decodeProgram and validateAssets before loading. */
export function extensionMessage(value: unknown): value is ExtensionToWebview {
  if (!boundedJson(value) || !header(value)) return false;
  if (["reset", "get-state", "destroy"].includes(String(value.kind)))
    return exactKeys(value, headerKeys);
  if (value.kind === "set-enabled")
    return (
      exactKeys(value, [...headerKeys, "enabled"]) &&
      typeof value.enabled === "boolean"
    );
  if (value.kind !== "load") return false;
  return (
    exactKeys(value, [
      ...headerKeys,
      "program",
      "assets",
      "assetPaths",
      "baseline",
      "assetRevision",
    ]) &&
    record(value.program) &&
    Array.isArray(value.assets) &&
    value.assets.length <= limits.assetCount &&
    value.assets.every(assetEnvelope) &&
    record(value.assetPaths) &&
    Object.keys(value.assetPaths).length <= 100000 &&
    Object.entries(value.assetPaths).every(
      ([path, target]) =>
        path.length <= 4096 &&
        typeof target === "string" &&
        target.length <= 4096,
    ) &&
    controlState(value.baseline) &&
    unsigned(value.assetRevision)
  );
}

function position(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, ["offset", "line", "column"]) &&
    unsigned(value.offset) &&
    unsigned(value.line) &&
    value.line > 0 &&
    unsigned(value.column) &&
    value.column > 0
  );
}

function span(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, ["uri", "start", "end"]) &&
    typeof value.uri === "string" &&
    value.uri.length <= 4096 &&
    position(value.start) &&
    position(value.end)
  );
}

function diagnosticDetails(value: unknown): boolean {
  return (
    record(value) &&
    Object.values(value).every(
      (item) =>
        typeof item === "string" ||
        typeof item === "boolean" ||
        (typeof item === "number" && Number.isFinite(item)) ||
        (Array.isArray(item) &&
          item.every((entry) => typeof entry === "string")),
    )
  );
}

function diagnostic(value: unknown): boolean {
  if (!record(value)) return false;
  const required = ["code", "severity", "phase", "message", "span"];
  const optional = ["related", "details"];
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => [...required, ...optional].includes(key))
  )
    return false;
  return (
    typeof value.code === "string" &&
    /^[EW]_[A-Z0-9_]+$/.test(value.code) &&
    ["error", "warning"].includes(String(value.severity)) &&
    [
      "decode",
      "parse",
      "bind",
      "type",
      "evaluate",
      "assets",
      "export",
      "host",
    ].includes(String(value.phase)) &&
    typeof value.message === "string" &&
    value.message.length <= limits.sourceBytes &&
    span(value.span) &&
    (value.details === undefined || diagnosticDetails(value.details)) &&
    (value.related === undefined ||
      (Array.isArray(value.related) &&
        value.related.length <= 100 &&
        value.related.every(
          (item) =>
            record(item) &&
            exactKeys(item, ["message", "span"]) &&
            typeof item.message === "string" &&
            span(item.span),
        )))
  );
}

export function webviewMessage(value: unknown): value is WebviewToExtension {
  if (!boundedJson(value) || !header(value)) return false;
  if (value.kind === "ready" || value.kind === "destroyed")
    return (
      exactKeys(value, headerKeys) &&
      (value.kind !== "ready" || value.requestId === 0)
    );
  if (value.kind === "state")
    return (
      exactKeys(value, [
        ...headerKeys,
        "controls",
        "sessionRevision",
        "assetRevision",
      ]) &&
      controlState(value.controls) &&
      unsigned(value.sessionRevision) &&
      unsigned(value.assetRevision)
    );
  if (value.kind === "diagnostics")
    return (
      exactKeys(value, [...headerKeys, "diagnostics"]) &&
      Array.isArray(value.diagnostics) &&
      value.diagnostics.length <= 100 &&
      value.diagnostics.every(diagnostic)
    );
  return false;
}

export function sameDocument(
  left: SourceIdentity,
  right: SourceIdentity,
): boolean {
  return (
    left.uri === right.uri &&
    left.documentInstance === right.documentInstance &&
    left.profile === right.profile
  );
}

export function sameRevision(
  left: SourceIdentity,
  right: SourceIdentity,
): boolean {
  return (
    sameDocument(left, right) &&
    left.editorVersion === right.editorVersion &&
    left.sourceRevision === right.sourceRevision &&
    left.sourceSha256 === right.sourceSha256
  );
}
