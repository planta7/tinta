import { createElement as h } from "react";
import { brand, button, icon } from "./controls.js";
export interface WelcomeActions {
  newDocument: () => void;
  openFile: () => void;
  exploreExamples: () => void;
  openExample: (name: string) => void;
  recovery: () => void;
}

export function Welcome(actions: WelcomeActions) {
  return h(
    "div",
    null,
    h(
      "header",
      { className: "welcome-header" },
      brand(),
      h(
        "span",
        { className: "quiet" },
        "A language for interactive documents.",
      ),
    ),
    h(
      "main",
      { className: "welcome" },
      h(
        "section",
        { className: "welcome-start", "aria-labelledby": "welcome-title" },
        h("div", { className: "eyebrow" }, "WRITE. QUESTION. EXPLORE."),
        h(
          "h1",
          { id: "welcome-title" },
          "A document.",
          h("br"),
          h("em", null, "With more to say."),
        ),
        h(
          "p",
          { className: "welcome-intro" },
          "Create articles, reports and guides that invite exploration. Bring writing, data and interaction together with tinta.",
        ),
        h(
          "div",
          { className: "welcome-actions" },
          button("New document", actions.newDocument, false, {
            icon: "new",
            className: "primary",
          }),
          button("Open file", actions.openFile, false, {
            icon: "open",
          }),
        ),
        h(
          "p",
          { className: "file-hint" },
          "Open or drop a .md, .tinta, or .tinta.zip file. Everything stays on your device.",
        ),
      ),
      h(
        "section",
        {
          className: "welcome-examples",
          "aria-labelledby": "examples-heading",
        },
        h(
          "div",
          { className: "section-heading" },
          h("h2", { id: "examples-heading" }, "The starting collection"),
          button("Explore examples", actions.exploreExamples, false, {
            className: "text-button",
          }),
        ),
        ...[
          [
            "guide",
            "01",
            "A handout that adapts",
            "Open the right instructions for each participant.",
          ],
          [
            "article",
            "02",
            "An article you can explore",
            "Test a newsletter readership assumption.",
          ],
          [
            "report",
            "03",
            "A neighborhood reading report",
            "Filter days, compare figures, and inspect the rows.",
          ],
          [
            "chart-atlas",
            "04",
            "Everything in one document",
            "Explore every control and all seven chart types.",
          ],
        ].map(([name, number, title, description]) =>
          h(
            "button",
            {
              key: name,
              type: "button",
              className: "example-row",
              onClick: () => actions.openExample(name!),
            },
            h(
              "span",
              {
                className: `example-specimen specimen-${name}`,
              },
              h(
                "span",
                { className: "specimen-glyph", "aria-hidden": true },
                name === "guide"
                  ? "Aa"
                  : name === "article"
                    ? "ƒ"
                    : name === "report"
                      ? "▂ ▅ ▇"
                      : "▂ ▅ ▃ ▇",
              ),
              h("span", { className: "example-number" }, number),
            ),
            h(
              "span",
              { className: "example-copy" },
              h("strong", null, title),
              h("span", null, description),
            ),
            icon("arrow"),
          ),
        ),
      ),
      h(
        "div",
        { className: "welcome-bottom" },
        button("Local recovery copies", actions.recovery, false, {
          className: "text-button",
        }),
        h(
          "span",
          null,
          "Automatic local drafts · Up to 10 copies / 30 MiB; oldest copies are replaced.",
        ),
      ),
    ),
  );
}
