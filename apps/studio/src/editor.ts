import {
  sourceOffset,
  editorOffset,
  normalizedSource,
} from "./source-buffer.js";
import {
  EditorState,
  StateEffect,
  StateField,
  Compartment,
  Transaction,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  Decoration,
  type DecorationSet,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  insertNewlineAndIndent,
  invertedEffects,
} from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, snippetCompletion } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import type { AssetStore, SourceProfile, TextEdit } from "@tinta/types";
import { snippets } from "./studio-runtime.js";

export const assetEffect = StateEffect.define<AssetStore>();
const assetField = StateField.define<AssetStore>({
  create: () => new Map(),
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(assetEffect)) value = effect.value;
    return value;
  },
});
const assetHistory = invertedEffects.of((transaction) =>
  transaction.effects.some((effect) => effect.is(assetEffect))
    ? [assetEffect.of(transaction.startState.field(assetField))]
    : [],
);

export const tokenEffect = StateEffect.define<
  readonly {
    from: number;
    to: number;
  }[]
>();
const tokens = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects)
      if (effect.is(tokenEffect))
        value = Decoration.set(
          effect.value
            .filter(
              (range) =>
                range.to > range.from && range.to <= transaction.newDoc.length,
            )
            .map((range) =>
              Decoration.mark({ class: "tinta-token" }).range(
                range.from,
                range.to,
              ),
            ),
          true,
        );
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export class SourceEditor {
  readonly view: EditorView;
  private profile = new Compartment();
  private source = "";

  constructor(
    parent: HTMLElement,
    source: string,
    profile: SourceProfile,
    change: (source: string, assets: AssetStore) => void,
    assets: AssetStore,
  ) {
    const lineEnding = dominantEnding(source);
    this.source = source;
    const rawEffect = StateEffect.define<string>();
    const rawField = StateField.define<string>({
      create: () => source,
      update(value, transaction) {
        for (const effect of transaction.effects)
          if (effect.is(rawEffect)) value = effect.value;
        return value;
      },
    });
    const rawHistory = invertedEffects.of((transaction) =>
      transaction.docChanged
        ? [rawEffect.of(transaction.startState.field(rawField))]
        : [],
    );
    const rawChanges = EditorState.transactionExtender.of((transaction) => {
      if (
        !transaction.docChanged ||
        transaction.effects.some((effect) => effect.is(rawEffect))
      )
        return null;

      const original = transaction.startState.field(rawField);
      let rebuilt = "";
      let last = 0;
      transaction.changes.iterChanges(
        (from, to, _newFrom, _newTo, inserted) => {
          const start = sourceOffset(original, from);
          const end = sourceOffset(original, to);
          rebuilt +=
            original.slice(last, start) +
            inserted.toString().replace(/\n/g, lineEnding);
          last = end;
        },
      );

      return { effects: rawEffect.of(rebuilt + original.slice(last)) };
    });
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: normalizedSource(source),
        extensions: [
          lineNumbers(),
          history(),
          markdown(),
          bracketMatching(),
          EditorView.lineWrapping,
          highlightSelectionMatches(),
          tokens,
          assetField.init(() => assets),
          assetHistory,
          rawField,
          rawHistory,
          rawChanges,
          this.profile.of(this.completion(profile)),
          keymap.of([
            {
              key: "Tab",
              run: (view) => {
                view.dispatch(view.state.replaceSelection("  "));
                return true;
              },
            },
            { key: "Enter", run: insertNewlineAndIndent },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          EditorView.contentAttributes.of({
            "aria-label": "Document source",
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            this.source = update.state.field(rawField);
            if (
              update.docChanged ||
              update.transactions.some((t) =>
                t.effects.some((e) => e.is(assetEffect)),
              )
            )
              change(this.source, update.state.field(assetField));
          }),
        ],
      }),
    });
    this.view.scrollDOM.tabIndex = 0;
    this.view.scrollDOM.setAttribute(
      "aria-label",
      "Scrollable document source",
    );
  }

  private completion(profile: SourceProfile) {
    return profile === "tinta"
      ? autocompletion({
          override: [
            (context) => {
              const word = context.matchBefore(/@?[A-Za-z_]*/);
              if (!word || (!context.explicit && word.from === word.to))
                return null;
              return {
                from: word.from,
                options: Object.entries(snippets).map(([label, content]) =>
                  snippetCompletion(content, { label, type: "keyword" }),
                ),
              };
            },
          ],
        })
      : [];
  }

  setProfile(profile: SourceProfile): void {
    this.view.dispatch({
      effects: this.profile.reconfigure(this.completion(profile)),
    });
  }

  insert(text: string, assets?: AssetStore): void {
    this.view.dispatch({
      ...this.view.state.replaceSelection(text),
      ...(assets ? { effects: assetEffect.of(assets) } : {}),
      annotations: Transaction.userEvent.of("input.import"),
    });
    this.view.focus();
  }

  applyEdits(edits: readonly TextEdit[]): void {
    this.view.dispatch({
      changes: edits.map((edit) => ({
        from: editorOffset(this.source, edit.start),
        to: editorOffset(this.source, edit.end),
        insert: normalizedSource(edit.replacement),
      })),
      annotations: Transaction.userEvent.of("input.import"),
    });
  }

  setAssets(assets: AssetStore): void {
    this.view.dispatch({
      effects: assetEffect.of(assets),
      annotations: Transaction.userEvent.of("input.import"),
    });
  }

  select(start: number, end: number): void {
    const max = this.view.state.doc.length;
    this.view.dispatch({
      selection: {
        anchor: Math.min(editorOffset(this.source, start), max),
        head: Math.min(editorOffset(this.source, end), max),
      },
      scrollIntoView: true,
    });
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }
}

export function dominantEnding(source: string): string {
  const endings = source.match(/\r\n|\r|\n/g) ?? [];
  const counts = new Map<string, number>();
  for (const ending of endings)
    counts.set(ending, (counts.get(ending) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "\n";
}
