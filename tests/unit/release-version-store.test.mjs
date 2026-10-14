import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, devNull } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  planRelease,
  commitsSince,
  reserveRelease,
} from "../../scripts/release-version-store.mjs";
import { automaticVersions } from "../../scripts/automatic-release.mjs";

let directory;
let baseline;
const git = (...args) =>
  execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
const journal = () => ({ format: "tinta-publication-store-1", releases: {} });
function commit(message) {
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    message,
  );
  return git("rev-parse", "HEAD");
}
function allocate(store = null, published = journal()) {
  return planRelease({
    baseline,
    store,
    journal: published,
    sourceSha: git("rev-parse", "HEAD"),
    repository: "fixture/repo",
    execute: git,
  });
}
function markPublished(published, plan) {
  published.releases[plan.sourceSha] = {
    status: "promoted",
    items: { "github:tag": { receipt: { sourceSha: plan.sourceSha } } },
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "release-versions-"));
  git("init", "--initial-branch=main");
  baseline = {
    schemaVersion: 1,
    baseCommit: commit("chore: baseline"),
    implementation: "0.1.21",
    extension: "0.2.21",
  };
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("release allocation with real Git history", () => {
  it("groups fixes and a feature into exactly one minor release", () => {
    commit("fix(parser): recover input");
    commit("fix(cli): print a useful diagnostic");
    commit("feat(engine): add an operation");
    const { plan } = allocate();
    expect(plan.implementation).toBe("0.2.0");
    expect(plan.extension).toBe("0.4.0");
    expect(plan.notes).toContain("recover input");
    expect(plan.notes).toContain("add an operation");
  });

  it("does not publish documentation or CI-only pushes", () => {
    commit("docs: explain usage");
    commit("ci: adjust verification");
    const { plan, next } = allocate();
    expect(plan.publish).toBe(false);
    expect(plan.implementation).toBe("0.1.21");
    expect(next.latest.sourceSha).toBe(baseline.baseCommit);
  });

  it("keeps failed or pending changes in the next plan without reusing a reservation", () => {
    const published = journal();
    commit("feat(cli): add a command");
    const first = allocate();
    commit("docs: describe that command");
    const second = allocate(first.next, published);
    expect(second.plan.publish).toBe(true);
    expect(second.plan.implementation).toBe("0.2.1");
    expect(second.plan.extension).toBe("0.4.1");
    expect(second.plan.notes).toContain("add a command");
    expect(second.plan.notes).toContain("describe that command");
    expect(first.next.plans[first.plan.sourceSha]).toEqual(first.plan);
    markPublished(published, second.plan);
    commit("docs: correct spelling");
    const third = allocate(second.next, published);
    expect(third.plan.publish).toBe(false);
    expect(third.plan.implementation).toBe("0.2.1");
  });

  it("bases notes and impact on the last complete release, excluding published features", () => {
    const published = journal();
    commit("feat(parser): add syntax");
    const first = allocate();
    markPublished(published, first.plan);
    commit("fix(parser): improve recovery");
    const second = allocate(first.next, published);
    expect(second.plan.implementation).toBe("0.2.1");
    expect(second.plan.impact).toBe("patch");
    expect(second.plan.before).toBe(first.plan.sourceSha);
    expect(second.plan.notes).not.toContain("add syntax");
  });

  it("does not allocate a new version or rewrite a plan on retry after publication", () => {
    commit("fix: repair input");
    const first = allocate();
    const published = journal();
    markPublished(published, first.plan);
    const retry = allocate(first.next, published);
    expect(retry).toEqual({ plan: first.plan, next: null });
    commit("feat: add a capability");
    const second = allocate(first.next, published);
    git("checkout", "--detach", first.plan.sourceSha);
    expect(allocate(second.next, published)).toEqual({
      plan: first.plan,
      next: null,
    });
  });

  it("inspects merge contents and breaking footers beyond the first line", () => {
    git("switch", "-c", "feature/example");
    const feature = commit(
      "refactor(engine): change shape\n\nBREAKING CHANGE: remove the old return type",
    );
    git("switch", "main");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "merge",
      "--no-ff",
      "feature/example",
      "-m",
      "Merge pull request #1 from fixture/feature/example",
    );
    expect(
      commitsSince(baseline.baseCommit, git("rev-parse", "HEAD"), git).some(
        (c) => c.sha === feature && c.message.includes("BREAKING CHANGE"),
      ),
    ).toBe(true);
    const { plan } = allocate();
    expect(plan.impact).toBe("breaking");
    expect(plan.implementation).toBe("0.2.0");
    expect(plan.extension).toBe("0.4.0");
  });

  it("allocates unique versions for queued source revisions before any publication completes", () => {
    commit("feat: add a capability");
    const first = allocate();
    commit("fix: repair the capability");
    const second = allocate(first.next);
    commit("fix: repair another edge case");
    const third = allocate(second.next);
    expect(
      [first, second, third].map(({ plan }) => plan.implementation),
    ).toEqual(["0.2.0", "0.2.1", "0.2.2"]);
    expect(
      new Set([first, second, third].map(({ plan }) => plan.extension)).size,
    ).toBe(3);
    expect(third.plan.notes).toContain("add a capability");
    expect(third.plan.notes).toContain("repair another edge case");
  });

  it("keeps a no-release decision unchanged when a later feature is reserved", () => {
    commit("ci: adjust a runner");
    const first = allocate();
    commit("feat: add a capability");
    const second = allocate(first.next);
    git("checkout", "--detach", first.plan.sourceSha);
    expect(allocate(second.next)).toEqual({ plan: first.plan, next: null });
    expect(first.plan.publish).toBe(false);
  });

  it("rejects rewritten or unreserved backwards histories and policy changes", () => {
    const initial = baseline.baseCommit;
    commit("fix: repair input");
    const first = allocate();
    commit("fix: repair another input");
    const second = allocate(first.next);
    git("checkout", "--detach", initial);
    expect(() => allocate(second.next)).toThrow("backwards");
    git("checkout", "main");
    baseline = { ...baseline, implementation: "1.0.0" };
    expect(() => allocate(second.next)).toThrow("migration");
  });

  it("lets independent read-only consumers recover the identical frozen versions", () => {
    commit("feat: add a capability");
    const { plan, next } = allocate();
    git("switch", "--orphan", "ledger");
    writeFileSync(join(directory, "versions.json"), JSON.stringify(next));
    git("add", "versions.json");
    const ledger = commit("Record immutable release versions");
    git("update-ref", "refs/remotes/origin/release-versions", ledger);
    git("checkout", "main");
    expect(
      automaticVersions(plan.sourceSha, { execute: git, readPlan: () => null }),
    ).toEqual({
      implementation: "0.2.0",
      extension: "0.4.0",
      npmChannel: "latest",
      extensionChannel: "stable",
    });
  });
});

it("checks working-branch commits without a token or version allocation", () => {
  git("update-ref", "refs/remotes/origin/main", baseline.baseCommit);
  commit("feat(cli): add a command");
  const script = fileURLToPath(
    new URL("../../scripts/release-version-store.mjs", import.meta.url),
  );
  const run = () =>
    execFileSync(process.execPath, [script, "check"], {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
    });
  expect(run()).toContain("release impact: minor");
  expect(git("status", "--porcelain")).toBe("");
  expect(git("branch", "--list", "release-versions")).toBe("");
  commit("An unstructured message");
  expect(run).toThrow("Conventional Commits");
});

function apiFixture() {
  let head = null;
  let store = null;
  let nextStore;
  const writes = [];
  const control = {
    loseResponse: false,
    conflict: false,
    journalUnavailable: false,
  };
  const api = async (method, path, body) => {
    if (method === "GET" && path.endsWith("/git/ref/heads/release-versions"))
      return head === null ? null : { object: { sha: head } };
    if (method === "GET" && path.includes("/contents/versions.json?ref="))
      return {
        encoding: "base64",
        content: Buffer.from(JSON.stringify(store)).toString("base64"),
      };
    if (method === "GET") {
      if (path.endsWith("/git/ref/heads/release-versions"))
        return head === null ? null : { object: { sha: head } };
      if (
        path.endsWith("/git/ref/heads/publication-journal") &&
        control.journalUnavailable
      )
        throw new Error("Publication history unavailable");
      if (path.endsWith("/git/ref/heads/publication-journal"))
        return { object: { sha: "d".repeat(40) } };
      if (path.includes("/git/commits/"))
        return {
          tree: {
            sha: path.endsWith("d".repeat(40))
              ? "e".repeat(40)
              : "f".repeat(40),
          },
        };
      if (path.includes("/git/trees/"))
        return {
          truncated: false,
          tree: [
            {
              path: path.endsWith("e".repeat(40))
                ? "journal.json"
                : "versions.json",
              type: "blob",
              sha: path.endsWith("e".repeat(40))
                ? "1".repeat(40)
                : "2".repeat(40),
            },
          ],
        };
      if (path.includes("/git/blobs/"))
        return {
          encoding: "base64",
          content: Buffer.from(
            JSON.stringify(path.endsWith("1".repeat(40)) ? journal() : store),
          ).toString("base64"),
        };
      throw new Error(`Unexpected read: ${path}`);
    }
    writes.push({ method, path, body });
    if (path.endsWith("/git/blobs")) {
      nextStore = JSON.parse(body.content);
      return { sha: "b".repeat(40) };
    }
    if (path.endsWith("/git/trees")) return { sha: "c".repeat(40) };
    if (path.endsWith("/git/commits")) {
      expect(body.parents).toEqual(head ? [head] : []);
      return { sha: String(writes.length).padStart(40, "0") };
    }
    expect(body.force).not.toBe(true);
    if (control.conflict) throw new Error("Concurrent update");
    head = body.sha;
    store = nextStore;
    if (control.loseResponse) throw new Error("Lost response");
    return {};
  };
  return { api, writes, control };
}

it("persists reservations once and reconciles a lost ref response without replay", async () => {
  commit("fix: repair input");
  const f = apiFixture();
  f.control.loseResponse = true;
  const options = {
    api: f.api,
    repository: "fixture/repo",
    baseline,
    sourceSha: git("rev-parse", "HEAD"),
    execute: git,
  };
  const first = await reserveRelease(options);
  expect(f.writes).toHaveLength(4);
  f.control.journalUnavailable = true;
  expect(await reserveRelease(options)).toEqual(first);
  f.control.journalUnavailable = false;
  expect(f.writes).toHaveLength(4);
  commit("fix: repair another input");
  const next = await reserveRelease({
    ...options,
    sourceSha: git("rev-parse", "HEAD"),
  });
  expect(next.implementation).toBe("0.1.23");
  expect(f.writes.filter((w) => w.method === "PATCH")).toHaveLength(1);
});

it("stops on a conflicting ref update and never forces a reservation", async () => {
  commit("fix: repair input");
  const f = apiFixture();
  f.control.conflict = true;
  await expect(
    reserveRelease({
      api: f.api,
      repository: "fixture/repo",
      baseline,
      sourceSha: git("rev-parse", "HEAD"),
      execute: git,
    }),
  ).rejects.toThrow("conflict or unknown");
  expect(f.writes).toHaveLength(4);
});

it("keeps branch verification read-only and skips only release work for a no-release plan", () => {
  const verify = parse(readFileSync(".github/workflows/verify.yml", "utf8"));
  const publish = parse(
    readFileSync(".github/workflows/publish-release.yml", "utf8"),
  );
  expect(verify.on.push.branches).toContain("!release-versions");
  expect(verify.jobs["release-plan"].if).toBe(
    "github.ref == 'refs/heads/main'",
  );
  expect(verify.jobs.verify.permissions).toEqual({ contents: "read" });
  expect(
    verify.jobs.verify.steps.some(
      (s) => s.run === "pnpm verify --suite editing",
    ),
  ).toBe(true);
  expect(verify.jobs["cli-portability"].if).toBe(
    "!cancelled() && needs.verify.result == 'success'",
  );
  expect(verify.jobs.verify.if).toContain(
    "needs.release-plan.result == 'skipped'",
  );
  const transferredPlan = verify.jobs.verify.steps.find(
    (step) =>
      step.with?.["artifact-ids"] ===
      "${{ needs.release-plan.outputs.plan_id }}",
  );
  expect(transferredPlan.with.path).toBe("reports/release");
  expect(verify.jobs.build.if).toContain(
    "needs.release-plan.outputs.publish == 'true'",
  );
  expect(verify.jobs["provenance-capability"].if).toContain(
    "needs.release-plan.outputs.publish == 'true'",
  );
  const gate = publish.jobs["candidate-gate"];
  const decision = gate.steps.find((step) => step.id === "versions");
  expect(decision.if).toBe(
    "hashFiles('scripts/release-version-store.mjs') != ''",
  );
  expect(gate.outputs.publish).toBe(
    "${{ steps.versions.outputs.publish || 'true' }}",
  );
  for (const step of gate.steps.filter((step) =>
    ["prepare", "runtime"].includes(step.id),
  )) {
    expect(step.if).toBe("steps.versions.outputs.publish != 'false'");
  }
  expect(publish.jobs.publish.if).toContain(
    "needs.candidate-gate.outputs.publish == 'true'",
  );
  expect(
    publish.jobs.publish.steps.find(
      (s) => s.name === "Publish and verify the complete release",
    ).run,
  ).toBe("node scripts/publish-release.mjs all");
});
