import { describe, expect, it } from "vitest";
import {
  boundedJson,
  extensionMessage,
  webviewMessage,
  sameDocument,
  sameRevision,
  sourceIdentity,
} from "../../packages/types/dist/webview.js";

const source = {
  uri: "untitled:Document",
  documentInstance: "a".repeat(32),
  editorVersion: 1,
  sourceRevision: 0,
  profile: "tinta",
  sourceSha256: "b".repeat(64),
};
const header = {
  protocol: "tinta-vscode-1",
  panelId: "c".repeat(32),
  capability: "d".repeat(32),
  requestId: 1,
  source,
};
const load = {
  ...header,
  kind: "load",
  program: {},
  assets: [],
  assetPaths: {},
  baseline: {},
  assetRevision: 0,
};
const state = {
  ...header,
  kind: "state",
  controls: { amount: 2, visible: true, option: "First" },
  sessionRevision: 1,
  assetRevision: 0,
};
const diagnostic = {
  code: "E_PROTOCOL",
  severity: "error",
  phase: "host",
  message: "Invalid preview message.",
  span: {
    uri: "tinta:/preview",
    start: { offset: 0, line: 1, column: 1 },
    end: { offset: 0, line: 1, column: 1 },
  },
};

describe("outer webview JSON envelopes", () => {
  it("accepts only the transport's distinct directions and discriminants", () => {
    expect(extensionMessage(load)).toBe(true);
    expect(webviewMessage(load)).toBe(false);
    expect(webviewMessage(state)).toBe(true);
    expect(extensionMessage(state)).toBe(false);
    for (const kind of ["reset", "get-state", "destroy"])
      expect(extensionMessage({ ...header, kind })).toBe(true);
    expect(
      extensionMessage({ ...header, kind: "set-enabled", enabled: false }),
    ).toBe(true);
    expect(webviewMessage({ ...header, requestId: 0, kind: "ready" })).toBe(
      true,
    );
    expect(webviewMessage({ ...header, kind: "ready" })).toBe(false);
    expect(webviewMessage({ ...header, kind: "destroyed" })).toBe(true);
    for (const kind of [
      "fetch",
      "command",
      "save",
      "read",
      "clipboard",
      "load-url",
    ]) {
      expect(extensionMessage({ ...header, kind })).toBe(false);
      expect(webviewMessage({ ...header, kind })).toBe(false);
    }
  });

  it("rejects missing fields, unknown keys and malformed identities", () => {
    for (const key of Object.keys(header)) {
      const incomplete = { ...state };
      delete incomplete[key];
      expect(webviewMessage(incomplete), key).toBe(false);
    }
    for (const replacement of [
      { protocol: "tinta-host-1" },
      { panelId: "C".repeat(32) },
      { capability: "d".repeat(31) },
      { capability: "d".repeat(129) },
      { requestId: -1 },
      { requestId: Number.MAX_SAFE_INTEGER + 1 },
      { requestId: 0.5 },
      { source: { ...source, editorVersion: 0 } },
      { source: { ...source, sourceRevision: -1 } },
      { source: { ...source, uri: "a".repeat(4097) } },
      { source: { ...source, profile: "html" } },
      { source: { ...source, sourceSha256: "f".repeat(63) } },
      { source: { ...source, documentInstance: "bad" } },
      { source: { ...source, extra: true } },
      { extra: true },
    ]) {
      expect(webviewMessage({ ...state, ...replacement })).toBe(false);
      expect(extensionMessage({ ...load, ...replacement })).toBe(false);
    }
    expect(sourceIdentity(null)).toBe(false);
    expect(sourceIdentity(source)).toBe(true);
  });

  it("keeps document identity distinct from revision identity", () => {
    expect(sameRevision(source, { ...source })).toBe(true);
    for (const replacement of [
      { editorVersion: 2 },
      { sourceRevision: 1 },
      { sourceSha256: "c".repeat(64) },
    ]) {
      expect(sameDocument(source, { ...source, ...replacement })).toBe(true);
      expect(sameRevision(source, { ...source, ...replacement })).toBe(false);
    }
    for (const replacement of [
      { uri: "untitled:Other" },
      { documentInstance: "e".repeat(32) },
      { profile: "markdown" },
    ]) {
      expect(sameDocument(source, { ...source, ...replacement })).toBe(false);
      expect(sameRevision(source, { ...source, ...replacement })).toBe(false);
    }
  });

  it("bounds controls without interpreting names as object properties", () => {
    for (const controls of [
      [],
      null,
      { amount: Infinity },
      { amount: {} },
      { "bad-name": 1 },
      { constructor: 1 },
      JSON.parse('{"__proto__":1}'),
      Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`a${i}`, i])),
      { option: "a".repeat(2097153) },
    ]) {
      expect(webviewMessage({ ...state, controls })).toBe(false);
      expect(extensionMessage({ ...load, baseline: controls })).toBe(false);
    }
    expect(webviewMessage({ ...state, sessionRevision: -1 })).toBe(false);
    expect(webviewMessage({ ...state, assetRevision: 0.1 })).toBe(false);
  });

  it("validates asset envelopes without treating shape as raster authority", () => {
    const asset = {
      path: `assets/${"a".repeat(64)}.png`,
      mime: "image/png",
      sha256: "a".repeat(64),
      bytesBase64: "AA==",
    };
    expect(extensionMessage({ ...load, assets: [asset] })).toBe(true);
    for (const bytesBase64 of ["", "AAAA", "AAA=", "AA==", "/w==", "//8="])
      expect(
        extensionMessage({ ...load, assets: [{ ...asset, bytesBase64 }] }),
      ).toBe(true);
    for (const replacement of [
      { mime: "image/svg+xml" },
      { bytesBase64: "A A==" },
      { bytesBase64: "AA" },
      { bytesBase64: "AA-_" },
      { bytesBase64: "AB==" },
      { bytesBase64: "AAB=" },
      { bytesBase64: "a".repeat(13981017) },
      { path: "a".repeat(4097) },
      { sha256: "wrong" },
      { extra: true },
    ])
      expect(
        extensionMessage({ ...load, assets: [{ ...asset, ...replacement }] }),
      ).toBe(false);
    expect(
      extensionMessage({
        ...load,
        assets: Array.from({ length: 101 }, () => ({ ...asset })),
      }),
    ).toBe(false);
    expect(extensionMessage({ ...load, assetPaths: { image: 5 } })).toBe(false);
    expect(extensionMessage({ ...load, enabled: true })).toBe(false);
    expect(
      extensionMessage({ ...header, kind: "set-enabled", enabled: 1 }),
    ).toBe(false);
  });

  it("validates bounded diagnostic locations and related messages", () => {
    const message = {
      ...header,
      kind: "diagnostics",
      diagnostics: [diagnostic],
    };
    expect(webviewMessage(message)).toBe(true);
    expect(
      webviewMessage({
        ...message,
        diagnostics: [
          {
            ...diagnostic,
            related: [
              {
                message: "Related",
                span: {
                  ...diagnostic.span,
                  start: { ...diagnostic.span.start },
                  end: { ...diagnostic.span.end },
                },
              },
            ],
            details: {
              incidentId: "opaque",
              count: 1,
              retained: false,
              names: ["amount"],
            },
          },
        ],
      }),
    ).toBe(true);
    for (const replacement of [
      { code: "arbitrary" },
      { severity: "fatal" },
      { phase: "remote" },
      {
        span: { ...diagnostic.span, start: { offset: -1, line: 1, column: 1 } },
      },
      { related: [{ message: "Missing span" }] },
      { details: [] },
      { details: { nested: {} } },
      { details: { values: [1] } },
      { extra: true },
    ])
      expect(
        webviewMessage({
          ...message,
          diagnostics: [{ ...diagnostic, ...replacement }],
        }),
      ).toBe(false);
    expect(
      webviewMessage({
        ...message,
        diagnostics: Array.from({ length: 101 }, () =>
          structuredClone(diagnostic),
        ),
      }),
    ).toBe(false);
  });

  it("rejects non-JSON and resource attacks before dispatch or getters", () => {
    const cycle = {};
    cycle.self = cycle;
    const deep = Array.from({ length: 129 }).reduce((inner) => [inner], null);
    let invoked = false;
    const accessor = {
      get text() {
        invoked = true;
        return "secret";
      },
    };
    for (const value of [
      cycle,
      deep,
      accessor,
      new Date(),
      new Uint8Array(1),
      undefined,
      NaN,
      Infinity,
      1n,
      () => {},
      new Array(3),
      { [Symbol("hidden")]: 1 },
      Object.create({ inherited: true }),
      Object.defineProperty({}, "hidden", { value: 1 }),
      Array.from({ length: 100001 }, () => ({})),
      "a".repeat(64 * 1024 * 1024 + 1),
    ])
      expect(boundedJson(value)).toBe(false);
    expect(invoked).toBe(false);
    expect(
      boundedJson({
        text: "😀\n",
        number: 1,
        yes: true,
        no: false,
        absent: null,
        list: [1, 2],
      }),
    ).toBe(true);
    expect(
      boundedJson(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("Untrusted");
            },
          },
        ),
      ),
    ).toBe(false);
  });
});
