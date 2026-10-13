import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { createReleasePr, githubTransport } from "../../scripts/release-pr.mjs";

const source = "a".repeat(40);
const options = () => ({
  repository: "fixture/tinta",
  base: "main",
  source,
  authorized: true,
  plan: {
    files: {
      "toolchain/release.json": "fixture config\n",
      "CHANGELOG.md": "fixture notes\n",
    },
    dependencies: [],
    decision: "fixture-decision",
  },
});

function fixture() {
  const calls = [];
  const state = { branch: null, prs: [], commit: null, tree: null, source };
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    const route = path.replace("/repos/fixture/tinta", "");
    if (method === "GET") {
      if (route === "") return { default_branch: "main" };
      if (route === "/git/ref/heads/main")
        return { object: { sha: state.source } };
      if (route.startsWith("/pulls?")) return state.prs;
      if (route === "/git/ref/heads/codex/prepare-release") return state.branch;
      if (route === `/git/commits/${source}`)
        return {
          tree: { sha: "b".repeat(40) },
          committer: { date: "2026-01-01T00:00:00Z" },
        };
      if (route.startsWith("/compare/"))
        return (
          state.comparison ?? {
            status: "ahead",
            total_commits: 1,
            commits: [{ commit: state.commit }],
            files: state.tree.tree.map((file) => ({
              filename: file.path,
              status: "modified",
              sha: createHash("sha1")
                .update(`blob ${Buffer.byteLength(file.content)}\0`)
                .update(file.content)
                .digest("hex"),
            })),
          }
        );
    }
    if (method === "POST") {
      if (route === "/git/trees") {
        state.tree = body;
        return { sha: "c".repeat(40) };
      }
      if (route === "/git/commits") {
        state.commit = body;
        return { sha: "d".repeat(40) };
      }
      if (route === "/git/refs") {
        state.branch = { object: { sha: body.sha } };
        return state.branch;
      }
      if (route === "/pulls") {
        const pr = {
          ...body,
          state: "open",
          html_url: "https://example.invalid/pr/1",
          base: { ref: body.base },
          head: { repo: { full_name: "fixture/tinta" } },
        };
        state.prs.push(pr);
        return pr;
      }
    }
    throw new Error(`Unexpected fixture request ${method} ${route}`);
  };
  return { calls, state, api };
}

describe("release PR integration without external mutations", () => {
  it("creates one PR and retries without a write or changed identity", async () => {
    const f = fixture();
    const first = await createReleasePr(f.api, options());
    const writes = f.calls.filter((call) => call.method === "POST").length;
    expect(writes).toBe(4);
    expect(await createReleasePr(f.api, options())).toEqual(first);
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(
      writes,
    );
    expect(f.state.commit.parents).toEqual([source]);
    expect(f.state.commit.author.date).toBe("2026-01-01T00:00:00Z");
    expect(
      f.calls.some((call) => ["PATCH", "DELETE", "PUT"].includes(call.method)),
    ).toBe(false);
  });

  it("retries a first-version changelog-only PR", async () => {
    const f = fixture();
    const input = options();
    delete input.plan.files["toolchain/release.json"];
    const first = await createReleasePr(f.api, input);
    expect(f.state.tree.tree).toHaveLength(1);
    expect(await createReleasePr(f.api, input)).toEqual(first);
  });

  it("reconciles a PR created successfully before a transport timeout", async () => {
    const f = fixture();
    await expect(
      createReleasePr(async (method, path, body) => {
        const result = await f.api(method, path, body);
        if (method === "POST" && path.endsWith("/pulls"))
          throw new Error("timeout after success");
        return result;
      }, options()),
    ).rejects.toThrow(/timeout/);
    await createReleasePr(f.api, options());
    expect(f.state.prs).toHaveLength(1);
  });

  it("resumes after branch creation succeeded but PR creation timed out", async () => {
    const f = fixture();
    await expect(
      createReleasePr(async (method, path, body) => {
        if (method === "POST" && path.endsWith("/pulls"))
          throw new Error("timeout");
        return f.api(method, path, body);
      }, options()),
    ).rejects.toThrow(/timeout/);
    expect(f.state.branch).not.toBeNull();
    await createReleasePr(f.api, options());
    expect(f.state.prs).toHaveLength(1);
    expect(
      f.calls.filter(
        (call) => call.path.endsWith("/git/refs") && call.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("rejects missing authority, stale base and unrelated branches without writes", async () => {
    const f = fixture();
    await expect(
      createReleasePr(f.api, { ...options(), authorized: false }),
    ).rejects.toThrow(/authorized/);
    expect(f.calls).toHaveLength(0);
    f.state.source = "e".repeat(40);
    await expect(createReleasePr(f.api, options())).rejects.toThrow(/moved/);
    f.state.source = source;
    f.state.branch = { object: { sha: "d".repeat(40) } };
    f.state.comparison = { status: "ahead", total_commits: 2 };
    await expect(createReleasePr(f.api, options())).rejects.toThrow(
      /unrelated/,
    );
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("refuses a changed request, edited PR, or additional branch commit", async () => {
    const f = fixture();
    await createReleasePr(f.api, options());
    const writes = f.calls.filter((call) => call.method === "POST").length;
    const changed = options();
    changed.plan.files["CHANGELOG.md"] += "different";
    await expect(createReleasePr(f.api, changed)).rejects.toThrow(/unrelated/);
    f.state.prs[0].body = "Manual edits";
    await expect(createReleasePr(f.api, options())).rejects.toThrow(
      /unrelated/,
    );
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(
      writes,
    );
  });

  it("fails closed on transport errors and never forwards credentials to redirects", async () => {
    const transport = githubTransport("fixture-token", async (url, init) => {
      expect(url).toBe("https://api.github.com/repos/fixture/tinta");
      expect(init.redirect).toBe("error");
      return { status: 403, ok: false };
    });
    await expect(transport("GET", "/repos/fixture/tinta")).rejects.toThrow(
      "403",
    );
    expect(() => githubTransport("")).toThrow(/token/);
  });
});

describe("workflow authority and validation topology", () => {
  it("pins actions, serializes explicit dispatch and scopes write permissions", () => {
    const workflow = parse(
      readFileSync(".github/workflows/prepare-release.yml", "utf8"),
    );
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch.inputs.authorize_remote.default).toBe(
      false,
    );
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(workflow.jobs["pull-request"].needs).toBe("validate");
    expect(workflow.jobs["pull-request"].if).toContain(
      "inputs.authorize_remote",
    );
    expect(workflow.jobs["pull-request"].permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
        if (step.run) expect(step.run).not.toContain("${{");
      }
    }
    const verify = parse(readFileSync(".github/workflows/verify.yml", "utf8"));
    expect(Object.keys(verify.jobs).sort()).toEqual([
      "cli-portability",
      "verify",
    ]);
    expect(
      Object.values(verify.jobs)
        .flatMap((job) => job.steps)
        .some((step) =>
          /validate-release-preparation|distribution-package|check-release-artifacts/.test(
            step.run ?? "",
          ),
        ),
    ).toBe(false);
    expect(
      workflow.jobs.validate.steps.some(
        (step) => step.run === "node scripts/validate-release-preparation.mjs",
      ),
    ).toBe(true);
    const validation = readFileSync(
      "scripts/validate-release-preparation.mjs",
      "utf8",
    );
    expect(validation).toContain('"scripts/release-contract.mjs"');
    expect(validation).toContain('"scripts/distribution-package.mjs"');
    expect(validation).toContain('"scripts/check-release-artifacts.mjs"');
    expect(validation).toContain('"scripts/distribution-vitest.config.js"');
  });
});
