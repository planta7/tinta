import { decodeProgram } from "@tinta/engine";
import { encodeUtf8, limits } from "@tinta/artifacts";
import type { Diagnostic, Program, SourceProfile } from "@tinta/types";
import {
  base,
  baseKeys,
  exact,
  identity,
  record,
  token,
  type Base,
} from "./protocol.js";

export interface Compilation {
  revision: number;
  program?: Program;
  diagnostics: readonly Diagnostic[];
}

export class CompilerHost {
  private worker: Worker | undefined;
  private timer?: ReturnType<typeof setTimeout>;
  private header: Base = {
    protocol: "tinta-host-1",
    documentId: token(),
    capability: token(),
    requestId: 0,
    sourceRevision: 0,
  };
  staleResponses = 0;

  constructor(
    private code: string,
    private receive: (result: Compilation) => void,
  ) {}

  compile(source: string, profile: SourceProfile, revision: number): void {
    this.stop();
    this.header = {
      ...this.header,
      requestId: this.header.requestId + 1,
      sourceRevision: revision,
    };
    try {
      if (encodeUtf8(source).length > limits.sourceBytes)
        return this.fail(
          "E_LIMIT",
          "Source exceeds the byte limit. Save source remains available.",
        );
    } catch {
      return this.fail("E_ENCODING", "Source contains invalid Unicode.");
    }

    const url = URL.createObjectURL(
      new Blob([this.code], { type: "text/javascript" }),
    );
    let worker: Worker;
    try {
      worker = new Worker(url);
    } catch {
      return this.fail(
        "E_INTERNAL",
        "The compiler could not start. Your source is still available.",
      );
    } finally {
      URL.revokeObjectURL(url);
    }
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (!base(data) || !identity(data, this.header))
        return this.fail("E_PROTOCOL", "Invalid compiler message.");
      if (
        data.sourceRevision !== this.header.sourceRevision ||
        data.requestId !== this.header.requestId
      ) {
        this.staleResponses++;
        return;
      }
      if (
        !exact(data, [...baseKeys, "program", "diagnostics"]) ||
        !["compiled", "rejected"].includes(String(data.kind)) ||
        !diagnostics(data.diagnostics)
      ) {
        return this.fail("E_PROTOCOL", "Invalid compiler response.");
      }
      if (data.kind === "compiled") {
        const decoded = decodeProgram(data.program);
        if (
          !decoded.ok ||
          decoded.value.source !== source ||
          decoded.value.profile !== profile
        )
          return this.fail("E_PROTOCOL", "Compiler program validation failed.");
        this.stop();
        this.receive({
          revision,
          program: decoded.value,
          diagnostics: data.diagnostics,
        });
      } else {
        this.stop();
        this.receive({ revision, diagnostics: data.diagnostics });
      }
    };
    worker.onerror = () =>
      this.fail(
        "E_INTERNAL",
        "Compiler stopped. Your source is still available.",
      );
    this.timer = setTimeout(
      () =>
        this.fail(
          "E_WORKER_TIMEOUT",
          "Checking timed out. Your source is still available.",
        ),
      3000,
    );
    worker.postMessage({
      ...this.header,
      kind: "compile",
      source,
      profile,
      uri: "tinta:/document." + (profile === "markdown" ? "md" : "tinta"),
    });
  }

  private fail(code: string, message: string): void {
    this.stop();
    const position = { offset: 0, line: 1, column: 1 };
    this.receive({
      revision: this.header.sourceRevision,
      diagnostics: [
        {
          code,
          message,
          severity: "error",
          phase: "host",
          span: {
            uri: "tinta:/document.tinta",
            start: position,
            end: position,
          },
        },
      ],
    });
  }

  stop(): void {
    clearTimeout(this.timer);
    this.worker?.terminate();
    this.worker = undefined;
  }
}

export function diagnostics(value: unknown): value is Diagnostic[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(
      (item) =>
        record(item) &&
        typeof item.code === "string" &&
        item.code.length < 100 &&
        typeof item.message === "string" &&
        item.message.length <= 4096 &&
        ["error", "warning"].includes(String(item.severity)) &&
        record(item.span) &&
        record(item.span.start) &&
        record(item.span.end) &&
        [item.span.start, item.span.end].every(
          (p) =>
            Number.isSafeInteger(p.offset) &&
            Number.isSafeInteger(p.line) &&
            Number.isSafeInteger(p.column),
        ),
    )
  );
}
