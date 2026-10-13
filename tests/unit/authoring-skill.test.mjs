import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { parse } from "yaml";
import { compile, createSession } from "../../packages/engine/dist/index.js";
import { run } from "../../packages/cli/dist/index.js";

const skill = resolve("docs/skills/tinta-authoring");
const examples = ["platform-guide", "time-estimate", "review-report"];
let directory;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "tinta-authoring-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function source(name) {
  return readFile(join(skill, "assets", `${name}.tinta`), "utf8");
}

function session(text) {
  const compiled = compile({ text, profile: "tinta", uri: "tinta:authoring" });
  expect(compiled.ok, JSON.stringify(compiled.diagnostics)).toBe(true);
  const created = createSession(compiled.value);
  expect(created.ok, JSON.stringify(created.diagnostics)).toBe(true);
  return created.value;
}

function textContent(nodes) {
  return nodes
    .map((node) => {
      if (node.kind === "text") return node.value;
      if (node.kind === "element") return textContent(node.children);
      return "";
    })
    .join("");
}

async function cli(args) {
  const result = await run([...args, "--json"]);
  expect(result.stderr).toBe("");
  return { ...result, json: JSON.parse(result.stdout) };
}

describe("portable authoring resources", () => {
  test.each([".agents", ".claude"])(
    "a copy under %s resolves its resources without the checkout",
    async (host) => {
      const installed = join(directory, host, "skills", "tinta-authoring");
      await cp(skill, installed, { recursive: true });
      const entry = await readFile(join(installed, "SKILL.md"), "utf8");
      const metadata = parse(entry.split("---")[1]);
      expect(Object.keys(metadata).sort()).toEqual(["description", "name"]);
      expect(metadata.name).toBe("tinta-authoring");
      expect(metadata.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(metadata.name.length).toBeLessThanOrEqual(64);
      expect(typeof metadata.description).toBe("string");
      expect(metadata.description.length).toBeGreaterThan(0);
      expect(metadata.description.length).toBeLessThanOrEqual(1024);
      expect(metadata.description).not.toMatch(/[<>]|\[TODO:/);

      // Follow local resource links recursively from the installed entrypoint.
      const queue = [join(installed, "SKILL.md")];
      const visited = new Set();
      while (queue.length > 0) {
        const file = queue.pop();
        if (visited.has(file)) continue;
        visited.add(file);
        const body = await readFile(file, "utf8");
        for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
          const target = resolve(dirname(file), match[1]);
          expect(target.startsWith(`${installed}${sep}`)).toBe(true);
          queue.push(target);
        }
        if (file.endsWith(".tinta")) {
          const result = await cli(["check", file, "--with-assets"]);
          expect(result.exitCode, result.stdout).toBe(0);
          expect(result.json.ok).toBe(true);
          expect(result.json.details.assetsChecked).toBe(true);
        }
      }
      expect(visited.size).toBe(6);
    },
  );

  test.each(examples)("exports %s in both HTML formats", async (name) => {
    const input = join(skill, "assets", `${name}.tinta`);
    for (const format of ["interactive", "static"]) {
      const output = join(directory, `${name}.${format}.html`);
      const result = await cli([
        "build",
        input,
        "--format",
        format,
        "--output",
        output,
      ]);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(result.json.ok).toBe(true);
      expect(result.json.artifacts).toHaveLength(1);
      const html = await readFile(output, "utf8");
      expect(html.toLowerCase()).toContain("<!doctype html>");
      if (format === "static") expect(html).not.toContain("<script");
      if (name === "platform-guide") {
        expect(html).toContain("In Finder");
        if (format === "static") expect(html).not.toContain("In File Explorer");
        else expect(html).toContain("In File Explorer");
      }
    }
  });
});

describe("authoring example scenarios", () => {
  test("guide choices show only the relevant instructions", async () => {
    const document = session(await source("platform-guide"));
    try {
      const instructions = {
        macOS: "In Finder",
        Windows: "In File Explorer",
        Linux: "In your file manager",
      };
      for (const [platform, visible] of Object.entries(instructions)) {
        const changed = document.setControl("platform", platform);
        expect(changed.ok).toBe(true);
        const text = textContent(changed.value.nodes);
        expect(text).toContain(visible);
        expect(text).toContain("Keep an editable copy");
        for (const hidden of Object.values(instructions)) {
          if (hidden !== visible) expect(text).not.toContain(hidden);
        }
      }
    } finally {
      document.destroy();
    }
  });

  test("time estimate handles every page count and discussion choice", async () => {
    const document = session(await source("time-estimate"));
    try {
      expect(document.getRevision().values.minutes).toBe(30);
      for (let pages = 0; pages <= 40; pages += 1) {
        for (const discussion of [false, true]) {
          const changed = document.setControls({ pages, discussion });
          expect(changed.ok).toBe(true);
          const expected = pages * 3 + (discussion ? 15 : 0);
          expect(changed.value.values.minutes).toBe(expected);
          const text = textContent(changed.value.nodes);
          expect(text.includes("Split this review")).toBe(expected > 60);
          expect(text.includes("No reading or discussion")).toBe(
            expected === 0,
          );
        }
      }
      const before = document.getRevision();
      expect(document.setControl("pages", 41).ok).toBe(false);
      expect(document.getRevision()).toBe(before);
    } finally {
      document.destroy();
    }
  });

  test("report filters agree on totals, chart rows, and empty results", async () => {
    const document = session(await source("review-report"));
    try {
      for (const includeDrafts of [false, true]) {
        for (let minimum = 0; minimum <= 40; minimum += 5) {
          const changed = document.setControls({
            include_drafts: includeDrafts,
            minimum,
          });
          expect(changed.ok).toBe(true);
          const expected = (includeDrafts ? [10, 20, 30, 40] : [10, 20]).filter(
            (minutes) => minutes >= minimum,
          );
          const total = expected.reduce((sum, minutes) => sum + minutes, 0);
          const revision = changed.value;
          expect(revision.tables.visible.rows).toHaveLength(expected.length);
          expect(revision.values.total).toBe(total);
          expect(revision.values.average).toBe(
            expected.length > 0 ? total / expected.length : 0,
          );
          const chart = revision.nodes.find((node) => node.kind === "chart");
          expect(chart.chart.table.rows).toEqual(revision.tables.visible.rows);
          expect(chart.chart.empty).toBe(expected.length === 0);
          const text = textContent(revision.nodes);
          expect(text.includes("No chapters match")).toBe(
            expected.length === 0,
          );
          expect(text.includes("Average review time")).toBe(
            expected.length > 0,
          );
        }
      }
    } finally {
      document.destroy();
    }
  });

  test("a broken calculation reports a source span and can be repaired", async () => {
    const original = await source("time-estimate");
    const broken = original.replace(
      "pages * minutes_per_page",
      "page_count * minutes_per_page",
    );
    const input = join(directory, "estimate.tinta");
    await writeFile(input, broken);
    const failed = await cli(["check", input]);
    expect(failed.exitCode).toBe(1);
    expect(failed.json.ok).toBe(false);
    const diagnostic = failed.json.diagnostics.find(
      (item) => item.code === "E_NAME_UNKNOWN",
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic.span.start.offset).toBeGreaterThanOrEqual(0);
    expect(diagnostic.span.end.offset).toBeGreaterThan(
      diagnostic.span.start.offset,
    );
    expect(
      broken.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
    ).toBe("page_count");
    await writeFile(input, original);
    const repaired = await cli(["check", input]);
    expect(repaired.exitCode, repaired.stdout).toBe(0);
    expect(repaired.json.ok).toBe(true);
  });

  test("enrichment preserves source bytes and literal syntax", async () => {
    const original = [
      "# Existing notes",
      "{{ customer }}",
      "@when pending",
      "```tinta",
      "@slider example = 5",
      "```",
      "<!-- Upload local files elsewhere. -->",
      "",
    ].join("\n");
    const input = join(directory, "notes.md");
    const output = join(directory, "notes.tinta");
    await writeFile(input, original);
    const result = await cli(["enrich", input, "--output", output]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(await readFile(input, "utf8")).toBe(original);
    const document = session(await readFile(output, "utf8"));
    try {
      const revision = document.getRevision();
      expect(revision.state).toEqual({});
      const text = textContent(revision.nodes);
      expect(text).toContain("{{ customer }}");
      expect(text).toContain("@when pending");
      expect(text).toContain("@slider example = 5");
      expect(text).not.toContain("Upload local files elsewhere");
    } finally {
      document.destroy();
    }
  });
});
