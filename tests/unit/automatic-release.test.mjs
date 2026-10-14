import { describe, expect, it } from "vitest";
import {
  automaticVersions,
  commitImpact,
  releaseImpact,
  nextVersions,
  releaseNotes,
  releaseSource,
  validateReleasePlan,
} from "../../scripts/automatic-release.mjs";
import { dispatchInputs } from "../../scripts/publication-gate.mjs";

const baseline = {
  schemaVersion: 1,
  implementation: "0.1.21",
  extension: "0.2.21",
};
const source = "c".repeat(40);
const before = "a".repeat(40);
const commit = (message) => ({ message });
const plan = {
  schemaVersion: 1,
  sourceSha: source,
  before,
  publish: true,
  impact: "minor",
  ...nextVersions(baseline, "minor"),
  notes: "A release note",
};

describe("semantic release versions", () => {
  it.each([
    ["fix(parser): recover a malformed input", "patch"],
    ["perf(engine): avoid duplicate evaluation", "patch"],
    ["revert(cli): restore previous behavior", "patch"],
    ["feat(cli): add a command", "minor"],
    ["FEAT(cli): add a command", "minor"],
    ["feat(parser)!: change syntax", "breaking"],
    ["refactor!: remove an API", "breaking"],
    [
      "fix(cli): change arguments\n\nBREAKING CHANGE: old flag removed",
      "breaking",
    ],
    [
      "chore: change defaults\n\nBREAKING-CHANGE: old default removed",
      "breaking",
    ],
    ["docs: mention feat(parser): in prose", null],
    ["ci: change a runner", null],
    ["test(parser): cover an edge case", null],
    ["chore: update tooling", null],
    ["refactor: simplify a loop", null],
    ["style: format sources", null],
    ["Merge pull request #1 from fixture/branch", null],
    ["fix: repair a bug\n\nA feat: in the body is not a new feature", "patch"],
  ])("classifies %s as %s", (message, expected) => {
    expect(commitImpact(commit(message))).toBe(expected);
  });

  it("requires structured messages instead of guessing release impact", () => {
    for (const message of [
      "",
      "Add a feature",
      "feat:",
      "fix(scope) no colon",
    ]) {
      expect(() => commitImpact(commit(message))).toThrow(
        "Conventional Commits",
      );
    }
  });

  it("selects one highest impact for all commits", () => {
    const changes = [...Array(5)].map(() => commit("fix: repair a bug"));
    changes.push(commit("feat: add a capability"));
    expect(releaseImpact(changes)).toBe("minor");
    expect(nextVersions(baseline, releaseImpact(changes))).toEqual({
      implementation: "0.2.0",
      extension: "0.4.0",
      npmChannel: "latest",
      extensionChannel: "stable",
    });
    changes.push(commit("fix!: remove a deprecated API"));
    expect(releaseImpact(changes)).toBe("breaking");
    expect(releaseImpact([])).toBeNull();
  });

  it("increments patches and reserves even extension minors for stable releases", () => {
    expect(nextVersions(baseline, "patch").implementation).toBe("0.1.22");
    expect(nextVersions(baseline, "patch").extension).toBe("0.2.22");
    expect(nextVersions(baseline, "breaking").implementation).toBe("0.2.0");
    expect(nextVersions(baseline, "breaking").extension).toBe("0.4.0");
    expect(
      nextVersions(
        { ...baseline, implementation: "1.7.9", extension: "1.4.9" },
        "breaking",
      ),
    ).toEqual({
      implementation: "2.0.0",
      extension: "2.0.0",
      npmChannel: "latest",
      extensionChannel: "stable",
    });
    expect(nextVersions(baseline, null).implementation).toBe("0.1.21");
    expect(() =>
      nextVersions({ ...baseline, extension: "0.3.1" }, "patch"),
    ).toThrow();
    expect(() =>
      nextVersions({ ...baseline, implementation: "0.01.0" }, "patch"),
    ).toThrow();
    expect(() =>
      nextVersions(
        { ...baseline, implementation: "0.1.9007199254740991" },
        "patch",
      ),
    ).toThrow();
    expect(() => nextVersions(baseline, "unknown")).toThrow();
  });

  it("uses the frozen source plan after newer reservations arrive", () => {
    const store = {
      format: "tinta-release-versions-1",
      plans: { [source]: structuredClone(plan) },
    };
    const execute = (command) =>
      command === "rev-parse"
        ? source
        : command === "show"
          ? JSON.stringify(store)
          : [source, before].join("\n");
    const expected = automaticVersions(source, {
      execute,
      readPlan: () => null,
    });
    store.plans["d".repeat(40)] = { ...plan, implementation: "9.0.0" };
    expect(
      automaticVersions(source, { execute, readPlan: () => null }),
    ).toEqual(expected);
    expect(expected.implementation).toBe("0.2.0");
    expect(() =>
      automaticVersions("d".repeat(40), { execute, readPlan: () => null }),
    ).toThrow("checkout");
    store.plans[source].before = "e".repeat(40);
    expect(() =>
      automaticVersions(source, { execute, readPlan: () => null }),
    ).toThrow("first-parent");
  });

  it("uses an already transferred plan without relying on immediate Git ref visibility", () => {
    const execute = (command) => {
      if (command === "show") throw new Error("Ref is not visible yet");
      return command === "rev-parse" ? source : [source, before].join("\n");
    };
    expect(
      automaticVersions(source, { execute, readPlan: () => plan })
        .implementation,
    ).toBe("0.2.0");
    expect(() =>
      automaticVersions(source, {
        execute,
        readPlan: () => ({ ...plan, sourceSha: before }),
      }),
    ).toThrow("checkout mismatch");
  });

  it.each([
    ["sourceSha", "d".repeat(40)],
    ["publish", false],
    ["extension", "0.3.0"],
    ["implementation", "0.2.0-dev.0"],
    ["npmChannel", "next"],
    ["extensionChannel", "pre-release"],
    ["notes", ""],
  ])("rejects an inconsistent frozen plan field %s", (key, value) => {
    expect(() =>
      validateReleasePlan({ ...plan, [key]: value }, source),
    ).toThrow();
  });

  it("escapes release note text and preserves immutable commit links", () => {
    const sha = "a".repeat(40);
    const notes = releaseNotes(
      [{ sha, subject: "Fix <script> and [link](url)" }],
      "fixture/repo",
    );
    expect(notes).toContain("\\<script\\>");
    expect(notes).toContain("\\[link\\]\\(url\\)");
    expect(notes).toContain(`https://github.com/fixture/repo/commit/${sha}`);
    expect(() => releaseNotes([], "fixture/repo")).toThrow();
    expect(() =>
      releaseNotes([{ sha, subject: "Fix" }], "https://foreign.example"),
    ).toThrow();
  });

  it("requires an ordinary main push from the configured repository", () => {
    const env = {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: source,
      GITHUB_REPOSITORY: "fixture/repo",
    };
    const event = {
      after: source,
      before,
      forced: false,
      repository: { full_name: "fixture/repo", default_branch: "main" },
    };
    expect(releaseSource(env, event)).toBe(source);
    expect(() => releaseSource(env, { ...event, forced: true })).toThrow(
      "Force",
    );
    expect(() =>
      releaseSource({ ...env, GITHUB_REF: "refs/heads/feature/a" }, event),
    ).toThrow();
    expect(() =>
      releaseSource(env, {
        ...event,
        repository: { ...event.repository, full_name: "other/repo" },
      }),
    ).toThrow();
  });
});

describe("automatic CD event boundary", () => {
  const source = "a".repeat(40);
  const env = {
    GITHUB_EVENT_NAME: "workflow_run",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "b".repeat(40),
    GITHUB_REPOSITORY: "fixture/repo",
    GITHUB_REPOSITORY_ID: "42",
    TINTA_RELEASE_SOURCE_SHA: source,
    TINTA_CANDIDATE_RUN: "123",
    TINTA_CANDIDATE_ATTEMPT: "2",
  };
  const run = {
    id: 123,
    run_attempt: 2,
    path: ".github/workflows/verify.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: source,
    head_repository: { full_name: "fixture/repo", id: 42 },
  };
  it("uses the completed producer revision even if main has advanced", () => {
    expect(dispatchInputs(env, { workflow_run: run })).toEqual({
      run: "123",
      attempt: 2,
      publisherSha: source,
      digest: undefined,
    });
  });
  it.each([
    { event: "pull_request" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { status: "in_progress" },
    { head_branch: "feature/change" },
    { path: ".github/workflows/unrelated.yml" },
    { head_sha: "c".repeat(40) },
    { head_repository: { full_name: "foreign/repo", id: 42 } },
    { head_repository: { full_name: "fixture/repo", id: 43 } },
    { run_attempt: 1 },
    { id: 124 },
  ])("rejects unrelated or unsuccessful producer metadata %j", (patch) => {
    expect(() =>
      dispatchInputs(env, { workflow_run: { ...run, ...patch } }),
    ).toThrow();
  });
});
