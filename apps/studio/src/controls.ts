import { createElement as h, type ReactNode } from "react";

const iconPaths: Record<string, string> = {
  new: "M 12 5 v14 M 5 12 h14",
  open: "M 3 7 h6 l2 2 h10 l-3 10 H 3 Z M 3 7 V 5 h6 l2 2 h8 v2",
  save: "M 5 3 h12 l4 4 v14 H 3 V 3 Z M 7 3 v6 h10 V 3 M 7 21 v-8 h10 v8",
  export: "M 12 3 v12 M 7 10 l5 5 5-5 M 4 15 v6 h16 v-6",
  read: "M 3 4 h7 l2 2 2-2 h7 v15 h-7 l-2 2-2-2 H 3 Z M 12 6 v15",
  edit: "M 15 4 l5 5 M 4 20 l5-1 L 21 7 17 3 5 15 Z",
  arrow: "M 5 12 h14 M 13 6 l6 6-6 6",
  chevron: "M 8 10 l4 4 4-4",
};

export function icon(name: string) {
  return h(
    "svg",
    {
      width: 18,
      height: 18,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.6,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      focusable: false,
    },
    h("path", { d: iconPaths[name] }),
  );
}

export function brand() {
  return h(
    "div",
    { className: "brand", "aria-label": "Tinta Studio" },
    h("span", { className: "brand-mark", "aria-hidden": true }, "t"),
    h(
      "span",
      null,
      "tinta",
      h("span", { className: "brand-studio" }, " / studio"),
    ),
    h("span", { className: "draft-label" }, "Draft"),
  );
}

export function menu(label: string, items: ReactNode[]) {
  return h(
    "details",
    { className: "action-menu", key: label },
    h("summary", null, label, icon("chevron")),
    h(
      "div",
      { className: "menu-items", "aria-label": label + " actions" },
      ...items,
    ),
  );
}

export function button(
  label: string,
  action: () => void,
  disabled = false,
  options: { icon?: string; className?: string; pressed?: boolean } = {},
) {
  return h(
    "button",
    {
      key: label,
      type: "button",
      disabled,
      className: options.className,
      "aria-pressed": options.pressed,
      onClick: (event: { currentTarget: HTMLButtonElement }) => {
        const opened = event.currentTarget.closest("details");
        if (opened) {
          opened.open = false;
          opened.querySelector("summary")?.focus();
        } else event.currentTarget.focus();
        action();
      },
    },
    options.icon ? icon(options.icon) : null,
    label,
  );
}
