import { token } from "./protocol.js";

export function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

export function dialog(
  title: string,
  build: (body: HTMLDialogElement, close: () => void) => void,
  cancelled?: () => void,
): void {
  const trigger =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
  const previous = Array.from(
    document.querySelectorAll<HTMLDialogElement>("dialog[open]"),
  ).at(-1);
  if (previous) {
    previous.inert = true;
    previous.setAttribute("aria-hidden", "true");
  }

  const element = node("dialog");
  const heading = node("h2", title);
  heading.id = "dialog-" + token();
  element.setAttribute("aria-labelledby", heading.id);
  element.append(heading);
  const close = () => {
    element.close();
    dispose();
  };
  build(element, close);
  const cancel = node("button", "×");
  cancel.setAttribute("aria-label", "Close dialog");
  cancel.title = "Close dialog";
  const dismiss = () => {
    close();
    cancelled?.();
  };
  cancel.onclick = dismiss;
  cancel.className = "dialog-close";
  const footer = dialogActions(element);
  element.insertBefore(cancel, heading);
  element.append(footer);
  const initialFocus =
    footer.querySelector<HTMLButtonElement>("button.primary:not(:disabled)") ??
    footer.querySelector<HTMLButtonElement>("button:not(:disabled)") ??
    cancel;
  initialFocus.autofocus = true;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    element.dispatchEvent(new Event("dispose"));
    element.remove();
    if (previous) {
      previous.inert = false;
      previous.removeAttribute("aria-hidden");
    }
    trigger?.focus();
  };
  element.onclose = dispose;
  element.oncancel = (event) => {
    event.preventDefault();
    dismiss();
  };
  document.body.append(element);
  element.showModal();
  initialFocus.focus();
}

function dialogActions(parent: HTMLDialogElement): HTMLElement {
  let footer = parent.querySelector<HTMLElement>(":scope > .dialog-actions");
  if (!footer) {
    footer = node("div");
    footer.className = "dialog-actions";
    parent.append(footer);
  }
  return footer;
}

export function action(
  parent: HTMLElement,
  label: string,
  run: () => void,
): HTMLButtonElement {
  const element = node("button", label);
  if (
    [
      "Save",
      "Rename",
      "Export file",
      "Insert data",
      "Insert image",
      "Create tinta source",
    ].includes(label)
  )
    element.classList.add("primary");
  element.onclick = () => {
    element.focus();
    run();
  };
  if (parent instanceof HTMLDialogElement)
    dialogActions(parent).append(element);
  else parent.append(element);
  return element;
}

export function field(
  parent: HTMLElement,
  label: string,
  value = "",
): HTMLInputElement {
  const wrapper = node("label", label + " ");
  const input = node("input");
  input.value = value;
  wrapper.append(input);
  parent.append(wrapper);
  return input;
}

export function select(
  parent: HTMLElement,
  label: string,
  options: string[],
): HTMLSelectElement {
  const wrapper = node("label", label + " ");
  const input = node("select");
  input.setAttribute("aria-label", label);
  for (const value of options) {
    const option = node("option", value);
    option.value = value;
    input.append(option);
  }
  wrapper.append(input);
  parent.append(wrapper);
  return input;
}
