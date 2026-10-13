import type { AuthoringQuery, AuthoringResult } from "./authoring.js";
import { authoring } from "./authoring.js";
import { randomBytes } from "node:crypto";
import {
  diagnostic,
  identifyInternalDiagnostic,
  limits,
} from "@tinta-lang/types/common";
import type { AnalysisSnapshot } from "@tinta-lang/types/editor";
import type {
  AnalysisRequest,
  AnalysisReply,
  AnalysisWorker,
  Presentation,
} from "./protocol.js";

export interface SupervisorOptions {
  readonly debounceMs: number;
  readonly watchdogMs: number;
  readonly createWorker: () => AnalysisWorker;
  readonly publish: (request: AnalysisRequest, result: Presentation) => void;
  readonly capacity: (uri: string) => void;
}

interface DocumentState {
  request: AnalysisRequest;
  bytes: number;
  blocked: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class Supervisor {
  private readonly documents = new Map<string, DocumentState>();
  private readonly pending = new Map<string, AnalysisRequest>();
  private readonly cache = new Map<string, AnalysisSnapshot>();
  private readonly queries = new Map<
    string,
    (result: AuthoringResult) => void
  >();
  private readonly symbolQueries = new Map<
    string,
    {
      promise: Promise<AuthoringResult>;
      resolve: (result: AuthoringResult) => void;
    }
  >();
  private nextQuery = 0;
  private sourceBytes = 0;
  private analysisBytes = 0;
  private readonly cacheSizes = new Map<string, number>();
  private worker: AnalysisWorker | undefined;
  private active: AnalysisRequest | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private terminating: Promise<unknown> | undefined;

  constructor(private readonly options: SupervisorOptions) {}

  update(uri: string, version: number, text: string): boolean {
    if (
      this.disposed ||
      !/^(file|untitled):/.test(uri) ||
      uri.length > 4096 ||
      !Number.isSafeInteger(version) ||
      version < 1
    )
      return false;
    const previous = this.documents.get(uri);
    if (previous && version <= previous.request.version) return false;
    const bytes = Buffer.byteLength(text, "utf8");
    if (
      (!previous && this.documents.size >= 32) ||
      this.sourceBytes - (previous?.bytes ?? 0) + bytes > 32 * 1024 * 1024
    ) {
      this.close(uri);
      this.options.capacity(uri);
      return false;
    }
    this.finishQuery(uri, null);
    if (previous?.timer) clearTimeout(previous.timer);
    this.pending.delete(uri);
    this.dropSnapshot(uri);
    const request: AnalysisRequest = {
      uri,
      instance: previous?.request.instance ?? randomBytes(16).toString("hex"),
      version,
      text: bytes > limits.sourceBytes ? "" : text,
    };
    this.sourceBytes +=
      (bytes > limits.sourceBytes ? 0 : bytes) - (previous?.bytes ?? 0);
    const state: DocumentState = {
      request,
      bytes: bytes > limits.sourceBytes ? 0 : bytes,
      blocked: bytes > limits.sourceBytes,
    };
    this.documents.set(uri, state);
    if (this.active?.uri === uri) this.stopWorker();
    if (bytes > limits.sourceBytes) {
      this.fail(request, "E_LIMIT", "Source byte limit exceeded.");
      this.pump();
      return false;
    }
    state.timer = setTimeout(() => {
      delete state.timer;
      this.pending.set(uri, request);
      this.pump();
    }, this.options.debounceMs);
    this.pump();
    return true;
  }

  check(uri: string): void {
    const state = this.documents.get(uri);
    if (!state || state.blocked || this.disposed) return;
    if (state.timer) clearTimeout(state.timer);
    delete state.timer;
    if (this.active === state.request) return;
    this.pending.set(uri, state.request);
    this.pump();
  }

  query(uri: string, params: AuthoringQuery): Promise<AuthoringResult> {
    const state = this.documents.get(uri);
    if (!state || state.blocked || this.disposed) return Promise.resolve(null);
    const shared =
      params.kind === "symbols" ? this.symbolQueries.get(uri) : undefined;
    if (shared) return shared.promise;
    this.queries.get(uri)?.(null);
    this.queries.delete(uri);
    if (state.timer) clearTimeout(state.timer);
    delete state.timer;
    state.request = {
      ...state.request,
      query: { id: ++this.nextQuery, params },
    };
    if (this.active?.uri === uri) this.stopWorker();
    let complete!: (result: AuthoringResult) => void;
    const result = new Promise<AuthoringResult>((resolve) => {
      complete = resolve;
    });
    if (params.kind === "symbols") {
      this.symbolQueries.set(uri, { promise: result, resolve: complete });
    } else {
      this.queries.set(uri, complete);
    }
    this.pending.set(uri, state.request);
    this.pump();
    return result;
  }

  private finishQuery(
    uri: string,
    result: AuthoringResult,
    symbols: AuthoringResult = null,
  ): void {
    this.queries.get(uri)?.(result);
    this.queries.delete(uri);
    this.symbolQueries.get(uri)?.resolve(symbols);
    this.symbolQueries.delete(uri);
  }

  has(uri: string): boolean {
    return this.documents.has(uri);
  }

  snapshot(uri: string): AnalysisSnapshot | undefined {
    return this.cache.get(uri);
  }

  close(uri: string): void {
    this.finishQuery(uri, null);
    const state = this.documents.get(uri);
    if (state?.timer) clearTimeout(state.timer);
    this.sourceBytes -= state?.bytes ?? 0;
    this.documents.delete(uri);
    this.pending.delete(uri);
    this.dropSnapshot(uri);
    if (this.active?.uri === uri) this.stopWorker();
    else if (state && this.worker) {
      try {
        this.worker.postMessage({
          release: { uri, instance: state.request.instance },
        });
      } catch {
        const active = this.active;
        this.stopWorker();
        if (active)
          this.fail(active, "E_INTERNAL", "Unexpected internal failure.");
      }
    }
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    for (const uri of this.documents.keys()) this.close(uri);
    this.stopWorker();
  }

  private stopWorker(): void {
    const worker = this.worker;
    this.worker = undefined;
    this.active = undefined;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = undefined;
    if (worker) {
      this.terminating = worker
        .terminate()
        .catch(() => {})
        .finally(() => {
          this.terminating = undefined;
          this.pump();
        });
    }
  }

  private fail(request: AnalysisRequest, code: string, message: string): void {
    this.finishQuery(request.uri, null);
    const item = diagnostic(code, message);
    this.options.publish(request, {
      diagnostics: [
        identifyInternalDiagnostic(
          {
            ...item,
            phase: "host",
            span: { ...item.span, uri: request.uri },
          },
          () => randomBytes(16).toString("hex"),
        ),
      ],
    });
  }

  private pump(): void {
    if (this.disposed || this.active || this.terminating) return;
    const request = this.pending.values().next().value as
      AnalysisRequest | undefined;
    if (!request) return;
    this.pending.delete(request.uri);
    this.active = request;
    try {
      if (!this.worker) {
        const worker = this.options.createWorker();
        this.worker = worker;
        worker.on("message", (reply) => {
          if (this.worker === worker) this.receive(reply);
        });
        const failed = () => {
          if (this.worker !== worker) return;
          const active = this.active;
          this.stopWorker();
          if (active)
            this.fail(active, "E_INTERNAL", "Unexpected internal failure.");
          this.pump();
        };
        worker.on("error", failed);
        worker.on("exit", failed);
      }
      this.watchdog = setTimeout(() => {
        if (this.active !== request) return;
        this.stopWorker();
        this.fail(
          request,
          "E_WORKER_TIMEOUT",
          "Worker did not complete before the watchdog.",
        );
        this.pump();
      }, this.options.watchdogMs);
      this.worker.postMessage(request);
    } catch {
      this.stopWorker();
      this.fail(request, "E_INTERNAL", "Unexpected internal failure.");
      this.pump();
    }
  }

  private receive(reply: AnalysisReply): void {
    const request = this.active;
    if (
      !request ||
      reply?.request?.uri !== request.uri ||
      reply.request.instance !== request.instance ||
      reply.request.version !== request.version ||
      reply.request.query?.id !== request.query?.id
    )
      return;
    if (
      !reply.result ||
      typeof reply.result.ok !== "boolean" ||
      !Array.isArray(reply.result.diagnostics) ||
      reply.result.diagnostics.length > 100 ||
      (reply.result.ok &&
        (reply.result.value?.identity?.documentInstance !== request.instance ||
          reply.result.value.identity.editorVersion !== request.version ||
          reply.result.value.sourceText !== request.text))
    ) {
      this.stopWorker();
      this.fail(request, "E_PROTOCOL", "Malformed analysis worker reply.");
      this.pump();
      return;
    }
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = undefined;
    this.active = undefined;
    if (this.documents.get(request.uri)?.request === request) {
      const result = reply.result;
      if (result.ok) {
        const bytes = Buffer.byteLength(JSON.stringify(result.value), "utf8");
        if (bytes > 128 * 1024 * 1024) {
          this.finishQuery(request.uri, null);
          this.options.capacity(request.uri);
          this.pump();
          return;
        }
        while (
          this.cache.size >= 8 ||
          this.analysisBytes + bytes > 128 * 1024 * 1024
        ) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.dropSnapshot(oldest);
        }
        this.dropSnapshot(request.uri);
        this.cache.set(request.uri, {
          ...result.value,
          sourceText: request.text,
        });
        this.cacheSizes.set(request.uri, bytes);
        this.analysisBytes += bytes;
      }
      // Outline requests survive navigation on the same immutable version.
      const symbols = this.symbolQueries.has(request.uri)
        ? request.query?.params.kind === "symbols"
          ? (reply.authoring ?? null)
          : result.ok
            ? authoring(result.value, { kind: "symbols" })
            : null
        : null;
      this.finishQuery(request.uri, reply.authoring ?? null, symbols);
      this.options.publish(request, {
        diagnostics: result.diagnostics.map((item) =>
          identifyInternalDiagnostic(item, () =>
            randomBytes(16).toString("hex"),
          ),
        ),
        ...(result.ok ? { snapshot: result.value } : {}),
      });
    }
    this.pump();
  }

  private dropSnapshot(uri: string): void {
    this.analysisBytes -= this.cacheSizes.get(uri) ?? 0;
    this.cacheSizes.delete(uri);
    this.cache.delete(uri);
  }
}
