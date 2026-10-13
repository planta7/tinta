import type {
  ControlDefinition,
  Diagnostic,
  DocNode,
  MountOptions,
  ReaderHandle,
  ReaderHost,
  ResolvedNode,
  Result,
  Revision,
  Scalar,
  Session,
  Span,
} from "@tinta-lang/types";
import { createChartView, type ChartView } from "./chart-view.js";
import { validateNodes } from "./policy.js";

import { normalizeAssetPath, validateAssets } from "@tinta-lang/types/assets";
import { base64, identifyInternalDiagnostic } from "@tinta-lang/types/common";

const mounts = new WeakSet<HTMLElement>();
const reservedHeadings = new WeakMap<Document, Set<string>>();
let nextInstance = 0;

function incidentId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

type Field = HTMLInputElement | HTMLSelectElement;

interface ControlView {
  readonly root: HTMLDivElement;
  readonly field: Field;
  readonly output: HTMLOutputElement | undefined;
  readonly error: HTMLSpanElement;
  readonly definition: ControlDefinition;
}

/** Mount a validated session projection. Compilation and asset decoding stay outside the reader. */
export function mountReader(
  session: Session,
  host: ReaderHost,
  options: MountOptions,
): Result<ReaderHandle> {
  const fallback: Span = {
    uri: "tinta:reader",
    start: { offset: 0, line: 1, column: 1 },
    end: { offset: 0, line: 1, column: 1 },
  };
  const diagnostic = (
    code: string,
    message: string,
    span = fallback,
  ): Diagnostic =>
    identifyInternalDiagnostic(
      {
        code,
        message,
        severity: code.startsWith("W_") ? "warning" : "error",
        phase: "host",
        span,
      },
      incidentId,
      message,
    );
  let native: HTMLElement;
  try {
    if (
      typeof document === "undefined" ||
      typeof HTMLElement === "undefined" ||
      !(host?.nativeElement instanceof HTMLElement) ||
      host.nativeElement.ownerDocument !== document ||
      mounts.has(host.nativeElement)
    ) {
      throw new Error(
        "A reader requires an unused HTMLElement in the caller's document.",
      );
    }
    native = host.nativeElement;
  } catch {
    return {
      ok: false,
      diagnostics: [
        diagnostic("E_PROTOCOL", "Invalid or already mounted reader host."),
      ],
    };
  }

  let assets: ReturnType<typeof validateAssets>;
  try {
    assets = validateAssets(options.assets);
  } catch {
    return {
      ok: false,
      diagnostics: [
        diagnostic("E_ASSET_TYPE", "Invalid reader asset capability."),
      ],
    };
  }

  const doc = native.ownerDocument;
  const prefix = `tinta-reader-${++nextInstance}-`;
  const article = doc.createElement("article");
  article.className = "tinta-reader";
  article.tabIndex = -1;
  const toolbar = doc.createElement("div");
  toolbar.className = "tinta-reader-actions";
  const reset = doc.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset reading";
  toolbar.append(reset);
  const content = doc.createElement("div");
  const status = doc.createElement("div");
  status.className = "tinta-reader-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  article.append(toolbar, content, status);

  const charts = new Map<string, ChartView>();
  let candidateState: Revision["state"];
  const controls = new Map<string, ControlView>();
  const fieldNames = new WeakMap<EventTarget, string>();
  const spans = new Map<string, Span>();
  const alignments = new Map<string, readonly string[]>();
  const tightItems = new Set<string>();
  const headings = new Map<string, string>();
  const reserved = reservedHeadings.get(doc) ?? new Set<string>();
  reservedHeadings.set(doc, reserved);
  const warnings = new Map<string, Diagnostic>();
  const detailStates = new Set<string>();
  const listeners: Array<() => void> = [];
  let unsubscribe = (): void => {};
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision: Revision;
  let lastNumber = -1;
  let activeControl: string | undefined;
  let structuralChange = false;

  function report(items: readonly Diagnostic[]): void {
    for (const item of items) {
      try {
        options.onDiagnostic?.(item);
      } catch {
        const failure = diagnostic(
          "E_INTERNAL",
          "A diagnostic subscriber failed.",
        );
        status.textContent = `${failure.code}: ${failure.message}`;
      }
    }
  }
  function announce(message: string): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!destroyed) status.textContent = message;
    }, 150);
  }
  function listen(
    target: EventTarget,
    name: string,
    listener: EventListener,
  ): void {
    target.addEventListener(name, listener);
    listeners.push(() => target.removeEventListener(name, listener));
  }
  function remember(nodes: readonly DocNode[]): void {
    for (const node of nodes) {
      spans.set(node.id, node.span);
      if (node.kind === "heading") {
        let id = node.anchor;
        while (doc.getElementById(id) || reserved.has(id)) id = prefix + id;
        headings.set(node.anchor, id);
        reserved.add(id);
      }
      if ("children" in node) remember(node.children);
      if (node.kind === "list") {
        for (const item of node.items) {
          if (node.tight) tightItems.add(item.id);
          remember(item.children);
        }
      }
      if (node.kind === "markdown-table") {
        alignments.set(node.id, node.align);
        for (const row of [node.header, ...node.rows]) {
          for (const cell of row) remember(cell);
        }
      }
    }
  }
  function warn(node: ResolvedNode, code: string, message: string): void {
    if (warnings.has(node.id)) return;
    warnings.set(node.id, diagnostic(code, message, spans.get(node.id)));
  }
  function updateField(view: ControlView, value: Scalar): void {
    if (view.definition.kind === "toggle") {
      (view.field as HTMLInputElement).checked = value === true;
    } else view.field.value = String(value);
    if (view.output) view.output.value = String(value);
    view.error.textContent = "";
    view.field.removeAttribute("aria-invalid");
  }
  function control(
    node: Extract<ResolvedNode, { kind: "control" }>,
  ): HTMLElement {
    const d = node.definition;
    let view = controls.get(d.name);
    if (!view) {
      const root = doc.createElement("div");
      root.className = "tinta-control";
      if (d.kind === "toggle") root.classList.add("tinta-control-toggle");
      root.dataset.tintaControl = d.name;
      const label = doc.createElement("label");
      label.textContent = d.label;
      const field =
        d.kind === "choice"
          ? doc.createElement("select")
          : doc.createElement("input");
      field.id = prefix + d.id;
      field.tabIndex = 0;
      label.htmlFor = field.id;
      if (field instanceof HTMLInputElement) {
        field.type = d.kind === "toggle" ? "checkbox" : "range";
        if (d.kind === "slider") {
          field.min = String(d.min);
          field.max = String(d.max);
          field.step = String(d.step);
        }
      } else if (d.kind === "choice") {
        for (const value of d.options) {
          const option = doc.createElement("option");
          option.value = value;
          option.textContent = value;
          field.append(option);
        }
      }

      const fieldRow = doc.createElement("div");
      fieldRow.className = "tinta-control-field";
      if (d.kind === "toggle") fieldRow.append(field, label);
      else fieldRow.append(field);
      let output: HTMLOutputElement | undefined;
      if (d.kind === "slider") {
        output = doc.createElement("output");
        output.htmlFor.value = field.id;
        output.setAttribute("aria-live", "off");
        output.setAttribute("aria-hidden", "true");
        fieldRow.append(output);
      }
      const error = doc.createElement("span");
      error.id = field.id + "-error";
      error.className = "tinta-control-error";
      field.setAttribute("aria-describedby", error.id);
      if (d.kind === "toggle") root.append(fieldRow, error);
      else root.append(label, fieldRow, error);
      view = {
        root,
        field,
        output,
        error,
        definition: d,
      };
      controls.set(d.name, view);
      fieldNames.set(field, d.name);
    }
    updateField(view, node.value);

    return view.root.cloneNode(true) as HTMLElement;
  }
  function render(node: ResolvedNode, open: ReadonlySet<string>): Node {
    if (node.kind === "text") return doc.createTextNode(node.value);
    if (node.kind === "control") return control(node);
    if (node.kind === "image") {
      let key: string | undefined;
      try {
        key = normalizeAssetPath(node.destination);
      } catch {
        /* The placeholder remains inert. */
      }

      const asset = key === undefined ? undefined : assets.get(key);
      if (asset) {
        const image = doc.createElement("img");
        image.alt = node.alt;
        if (node.title !== undefined) image.title = node.title;
        image.src = `data:${asset.mime};base64,${base64(asset.bytes)}`;
        return image;
      }

      const placeholder = doc.createElement("span");
      placeholder.className = "tinta-image-placeholder";
      placeholder.textContent =
        `Image unavailable: ${node.alt || "Decorative image"}. ` +
        `Add local images or open a source bundle.`;
      warn(
        node,
        "W_ASSET_UNAVAILABLE",
        "A document image is unavailable. Exports require all images they include.",
      );

      return placeholder;
    }
    if (node.kind === "chart") {
      let view = charts.get(node.id);
      if (!view) {
        view = createChartView(
          doc,
          prefix + node.id,
          node.chart,
          (name, value) => {
            const result = session.setControl(name, value);
            showResult(result, name);
            return result.ok;
          },
        );
        charts.set(node.id, view);
      }
      view.update(node.chart, candidateState);
      const placeholder = doc.createElement("figure");
      placeholder.dataset.tintaChart = node.id;
      return placeholder;
    }

    const element = doc.createElement(node.tag);
    element.dataset.tintaNode = `${node.id}:${node.tag}`;
    if (node.tag === "li" && tightItems.has(node.id))
      element.className = "tinta-tight-item";
    for (const [name, value] of Object.entries(node.attributes)) {
      if (name === "id")
        element.id = headings.get(String(value)) ?? String(value);
      else if (name === "href" && String(value).startsWith("#")) {
        let anchor = String(value).slice(1);
        try {
          anchor = decodeURIComponent(anchor);
        } catch {
          /* An invalid fragment remains inert. */
        }
        const resolved =
          headings.get(`tinta-${anchor}`) ?? headings.get(anchor);
        element.setAttribute("href", `#${resolved ?? anchor}`);
      } else if (typeof value === "boolean") {
        if (value) element.setAttribute(name, "");
      } else element.setAttribute(name, String(value));
    }
    if (node.tag === "a" && !String(node.attributes.href).startsWith("#")) {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    }
    if (node.tag === "input")
      element.setAttribute(
        "aria-label",
        node.attributes.checked ? "Completed task" : "Incomplete task",
      );
    if (/^h[1-6]$/.test(node.tag)) element.tabIndex = -1;
    if (node.tag === "details") {
      element.dataset.tintaDetails = node.id;
      (element as HTMLDetailsElement).open = open.has(node.id);
    }
    for (const child of node.children) element.append(render(child, open));
    if (
      node.tag === "li" &&
      element.firstElementChild?.matches('input[type="checkbox"]')
    ) {
      element.classList.add("tinta-task-item");
    }
    if (node.tag === "table" || node.tag === "pre") {
      const wrapper = doc.createElement("div");
      wrapper.className = "tinta-scroll";
      wrapper.dataset.tintaNode = `${node.id}:scroll`;
      wrapper.tabIndex = 0;
      wrapper.setAttribute("role", "region");
      wrapper.setAttribute(
        "aria-label",
        node.tag === "pre"
          ? "Code block"
          : element.querySelector("caption")?.textContent || "Document table",
      );
      if (node.tag === "table" && !element.querySelector("caption")) {
        const caption = doc.createElement("caption");
        const rows = element.querySelectorAll("tbody tr").length;
        caption.textContent = `Document table — ${rows} ${rows === 1 ? "row" : "rows"}`;
        element.prepend(caption);
      }
      if (node.tag === "table") {
        const alignment = alignments.get(node.id);
        for (const row of element.querySelectorAll("tr")) {
          Array.from(row.children).forEach((cell, index) => {
            if (alignment?.[index] && alignment[index] !== "none")
              cell.className = `tinta-align-${alignment[index]}`;
          });
        }
      }
      wrapper.append(element);

      return wrapper;
    }

    return element;
  }
  function key(node: Node): string {
    if (!(node instanceof HTMLElement)) return "text";
    if (node.dataset.tintaChart) return `chart:${node.dataset.tintaChart}`;
    return node.dataset.tintaControl
      ? `control:${node.dataset.tintaControl}`
      : (node.dataset.tintaNode ?? node.tagName);
  }
  function reconcile(parent: Node, candidate: Node): void {
    const available = new Map<string, Node[]>();

    for (const child of Array.from(parent.childNodes)) {
      const name = key(child);
      const bucket = available.get(name) ?? [];
      bucket.push(child);
      available.set(name, bucket);
    }

    let cursor = parent.firstChild;

    for (const desired of Array.from(candidate.childNodes)) {
      let current = available.get(key(desired))?.shift();
      if (desired instanceof HTMLElement && desired.dataset.tintaChart) {
        current = charts.get(desired.dataset.tintaChart)!.root;
      } else if (
        desired instanceof HTMLElement &&
        desired.dataset.tintaControl
      ) {
        current = controls.get(desired.dataset.tintaControl)!.root;
      } else if (
        current instanceof HTMLElement &&
        desired instanceof HTMLElement
      ) {
        for (const attribute of Array.from(current.attributes)) {
          if (!desired.hasAttribute(attribute.name))
            current.removeAttribute(attribute.name);
        }
        for (const attribute of Array.from(desired.attributes)) {
          if (current.getAttribute(attribute.name) !== attribute.value)
            current.setAttribute(attribute.name, attribute.value);
        }
        reconcile(current, desired);
      } else if (
        current?.nodeType === Node.TEXT_NODE &&
        desired.nodeType === Node.TEXT_NODE
      ) {
        if (current.nodeValue !== desired.nodeValue)
          current.nodeValue = desired.nodeValue;
      } else if (desired instanceof HTMLElement) {
        current = desired.cloneNode(false);
        reconcile(current, desired);
      } else current = desired;
      if (current !== cursor) parent.insertBefore(current, cursor);
      cursor = current.nextSibling;
    }
    while (cursor) {
      const next = cursor.nextSibling;
      parent.removeChild(cursor);
      cursor = next;
    }
  }
  function project(next: Revision): void {
    if (destroyed || next.number === lastNumber) return;
    validateNodes(next.nodes);
    candidateState = next.state;
    const focused = content.contains(doc.activeElement)
      ? doc.activeElement
      : null;
    const focusedName = focused ? fieldNames.get(focused) : undefined;
    const focusedChart = focused?.closest("[data-tinta-chart]");
    const preceding: string[] = [];

    for (const element of content.querySelectorAll("input, select, button")) {
      if (element === focused) break;
      const name = fieldNames.get(element);
      if (name) preceding.push(name);
    }
    for (const details of content.querySelectorAll<HTMLDetailsElement>(
      "details",
    )) {
      const id = details.dataset.tintaDetails!;
      if (details.open) detailStates.add(id);
      else detailStates.delete(id);
    }

    const open = detailStates;
    const focusedDetails = focused
      ?.closest("details")
      ?.getAttribute("data-tinta-details");
    const wasSummary = focused?.tagName === "SUMMARY";
    const previousWarnings = new Set(warnings.keys());
    const fragment = doc.createDocumentFragment();

    for (const node of next.nodes) fragment.append(render(node, open));
    reconcile(content, fragment);
    revision = next;
    lastNumber = next.number;
    structuralChange = false;
    if (focusedName || focusedChart) {
      const field = focusedName
        ? controls.get(focusedName)!.field
        : (focused as HTMLElement);
      if (content.contains(field)) field.focus({ preventScroll: true });
      else {
        structuralChange = true;
        const previous = preceding
          .reverse()
          .map((name) => controls.get(name)!.field)
          .find(
            (field) =>
              content.contains(field) && field.getClientRects().length > 0,
          );
        (
          previous ??
          content.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6") ??
          article
        ).focus({ preventScroll: true });
      }
    } else if (wasSummary && focusedDetails) {
      for (const details of content.querySelectorAll<HTMLElement>("details")) {
        if (details.dataset.tintaDetails === focusedDetails)
          details.querySelector("summary")?.focus({ preventScroll: true });
      }
    }
    if (next.number > 0)
      announce(
        structuralChange
          ? "Reading updated. A focused control was hidden; focus moved to visible content."
          : "Reading updated.",
      );
    report(next.diagnostics);
    if (next.number > 0)
      report(
        [...warnings]
          .filter(([id]) => !previousWarnings.has(id))
          .map(([, item]) => item),
      );
  }
  function showResult(result: Result<Revision>, name?: string): void {
    if (destroyed) return;
    const view = name ? controls.get(name) : undefined;
    result = {
      ...result,
      diagnostics: result.diagnostics.map((item) =>
        item.details?.incidentId
          ? item
          : identifyInternalDiagnostic(item, incidentId),
      ),
    };
    if (!result.ok) {
      if (view) {
        updateField(view, revision.state[name!]!);
        view.field.setAttribute("aria-invalid", "true");
        view.error.textContent = result.diagnostics
          .map((d) => `${d.code}: ${d.message}`)
          .join(" ");
      }
      announce(
        `Change rejected. ${result.diagnostics.map((d) => `${d.code}: ${d.message}`).join(" ")}`,
      );
    } else {
      project(result.value);
      if (result.diagnostics.length)
        announce(
          result.diagnostics.map((d) => `${d.code}: ${d.message}`).join(" "),
        );
    }
    report(result.diagnostics);
  }
  function onInput(event: Event): void {
    if (destroyed || !event.target) return;
    const name = fieldNames.get(event.target);
    if (!name) return;
    const view = controls.get(name)!;
    if ((view.definition.kind === "slider") !== (event.type === "input"))
      return;

    const value =
      view.definition.kind === "toggle"
        ? (view.field as HTMLInputElement).checked
        : view.definition.kind === "slider"
          ? Number(view.field.value)
          : view.field.value;
    activeControl = name;
    try {
      showResult(session.setControl(name, value), name);
    } catch {
      showResult(
        {
          ok: false,
          diagnostics: [
            diagnostic(
              "E_INTERNAL",
              "Reader action failed.",
              view.definition.span,
            ),
          ],
        },
        name,
      );
    } finally {
      activeControl = undefined;
    }
  }
  function resetPresentation(): void {
    if (destroyed) return;
    detailStates.clear();
    for (const view of charts.values()) view.reset();
    for (const details of content.querySelectorAll<HTMLDetailsElement>(
      "details",
    ))
      details.open = false;
    for (const [name, view] of controls)
      updateField(view, revision.state[name]!);
    announce("Reading presentation reset.");
  }
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    if (timer !== undefined) clearTimeout(timer);
    for (const remove of listeners) remove();
    try {
      unsubscribe();
    } catch {
      report([diagnostic("E_INTERNAL", "Reader subscription cleanup failed.")]);
    }
    for (const id of headings.values()) reserved.delete(id);
    controls.clear();
    for (const view of charts.values()) view.destroy();
    charts.clear();
    article.remove();
    mounts.delete(native);
  }
  try {
    remember(session.program.flow);
    article.lang = session.program.metadata.locale;
    article.setAttribute(
      "aria-label",
      session.program.metadata.title || "Document reader",
    );
    revision = session.getRevision();
    project(revision);
    listen(content, "input", onInput);
    listen(content, "change", onInput);
    listen(content, "click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest("a");
      if (!link || !link.getAttribute("href")?.startsWith("#")) return;
      event.preventDefault();
      const id = link.getAttribute("href")!.slice(1);
      const heading = Array.from(
        content.querySelectorAll<HTMLElement>("[id]"),
      ).find((element) => element.id === id);
      if (heading) {
        heading.focus();
        heading.scrollIntoView();
      }
    });
    listen(reset, "click", () => {
      let result: Result<Revision>;
      try {
        result = session.reset();
      } catch {
        result = {
          ok: false,
          diagnostics: [diagnostic("E_INTERNAL", "Reader reset failed.")],
        };
      }
      showResult(result);
      if (result.ok) {
        resetPresentation();
        announce("Reading reset.");
      }
    });
    unsubscribe = session.subscribe((next) => {
      try {
        project(next);
      } catch {
        const item = diagnostic(
          "E_INTERNAL",
          "Reader could not display the committed revision.",
        );
        if (activeControl)
          controls
            .get(activeControl)
            ?.field.setAttribute("aria-invalid", "true");
        status.textContent = `${item.code}: ${item.message}`;
        for (const view of controls.values()) view.field.disabled = true;
        report([item]);
      }
    });
    native.append(article);
    mounts.add(native);
    report([...warnings.values()]);

    return {
      ok: true,
      value: { resetPresentation, destroy },
      diagnostics: [...warnings.values()],
    };
  } catch {
    destroy();
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "E_PROTOCOL",
          "Reader initialization rejected invalid session data.",
        ),
      ],
    };
  }
}
