import { describe, expect, it } from "vitest";
import {
  automaticVersions,
  nextVersions,
  releaseNotes,
} from "../../scripts/automatic-release.mjs";
import { dispatchInputs } from "../../scripts/publication-gate.mjs";

const baseline = {
  schemaVersion: 1,
  baseCommit: "a".repeat(40),
  implementation: "0.1.0",
  extension: "0.2.0",
};

describe("automatic release identity", () => {
  it("increments both stable patch versions without changing protocol versions", () => {
    expect(nextVersions(baseline, 3)).toEqual({
      implementation: "0.1.3",
      extension: "0.2.3",
      npmChannel: "latest",
      extensionChannel: "stable",
    });
    expect(nextVersions(baseline, 3)).toEqual(nextVersions(baseline, 3));
    for (const distance of [0, -1, 0.5, NaN, Infinity]) {
      expect(() => nextVersions(baseline, distance)).toThrow();
    }
    expect(() =>
      nextVersions({ ...baseline, extension: "0.3.0" }, 1),
    ).toThrow();
  });

  it("counts first-parent history, rejects rewritten ancestry and wrong checkout", () => {
    const source = "c".repeat(40);
    const execute = (...args) =>
      args[0] === "rev-parse"
        ? source
        : [source, "b".repeat(40), baseline.baseCommit].join("\n");
    expect(
      automaticVersions(source, { baseline, execute }).implementation,
    ).toBe("0.1.2");
    expect(() =>
      automaticVersions("d".repeat(40), { baseline, execute }),
    ).toThrow("checkout");
    expect(() =>
      automaticVersions(source, {
        baseline: { ...baseline, baseCommit: "e".repeat(40) },
        execute,
      }),
    ).toThrow("baseline");
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
