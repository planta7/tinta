import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishRelease,
  dependencyOrder,
  promotionReview,
} from "../../scripts/publication.mjs";
import {
  fileJournal,
  githubJournal,
  encode,
  hash,
} from "../../scripts/publication-journal.mjs";

function fixture() {
  let storage = null;
  let locked = false;
  let saves = 0;
  const remote = new Map();
  const writes = [];
  const tags = { "@fixture/a": null, "@fixture/b": null };
  const control = {
    fail: null,
    before: false,
    loseJournalAt: 0,
    hidden: false,
  };
  const plan = {
    candidate: "a".repeat(64),
    publisherSha: "b".repeat(40),
    releaseId: "fixture-release",
    expiresAt: "2026-11-01T00:00:00Z",
    targets: [
      {
        name: "@fixture/b",
        kind: "npm",
        version: "1.0.0",
        channel: "latest",
        dependencies: [{ name: "@fixture/a", version: "1.0.0" }],
      },
      {
        name: "@fixture/a",
        kind: "npm",
        version: "1.0.0",
        channel: "latest",
        dependencies: [],
      },
      { name: "fixture.extension", kind: "vsix", version: "0.2.0" },
    ],
  };
  const intent = {
    candidate: plan.candidate,
    publisherSha: plan.publisherSha,
    releaseId: plan.releaseId,
    expiresAt: "2026-10-31T00:00:00Z",
    reconciliation: null,
  };
  const mutate = async (key, action) => {
    writes.push(key);
    if (control.fail === key && control.before)
      throw new Error("Simulated failure before write");
    action();
    if (control.fail === key)
      throw new Error("Simulated lost response after write");
  };
  const operation = (key, retryAbsent = true) => ({
    retryAbsent,
    read: async () => (control.hidden ? null : (remote.get(key) ?? null)),
    write: () => mutate(key, () => remote.set(key, "expected")),
    verify: async (value) => {
      if (value !== "expected") throw new Error("Immutable content collision");
      return { identity: key, sha256: plan.candidate };
    },
  });
  const journal = {
    async acquire() {
      if (locked) throw new Error("Concurrent release");
      locked = true;
    },
    async release() {
      locked = false;
    },
    async read() {
      return structuredClone(storage);
    },
    async save(value) {
      saves += 1;
      if (saves === control.loseJournalAt)
        throw new Error("Journal unavailable");
      storage = structuredClone(value);
    },
  };
  const adapters = {
    npm: {
      preflight: async () => {},
      upload: (target) => operation(target.name),
      verifyInstall: async () => {
        if (
          !["@fixture/a", "@fixture/b"].every(
            (name) => remote.get(name) === "expected",
          )
        )
          throw new Error("Incomplete dependency installation");
      },
      channel: async (target) => tags[target.name],
      promote: (target, old) => ({
        retryAbsent: true,
        read: async () =>
          tags[target.name] === target.version ? target.version : null,
        write: () =>
          mutate(`tag:${target.name}`, () => {
            tags[target.name] = target.version;
          }),
        verify: async () => ({ old, new: tags[target.name] }),
      }),
    },
    marketplace: {
      preflight: async () => {},
      upload: () => operation("vsix", false),
      visibility: () => operation("visibility"),
    },
    github: {
      preflight: async () => {},
      async *operations() {
        for (const key of ["tag", "draft", "asset", "publish"])
          yield { key, ...operation(`github:${key}`) };
      },
    },
  };
  const run = (extra = {}) =>
    publishRelease({
      gate: async () => plan,
      journal,
      adapters,
      intent,
      now: () => Date.parse("2026-10-11T00:00:00Z"),
      ...extra,
    });
  return {
    run,
    plan,
    intent,
    adapters,
    journal,
    remote,
    writes,
    tags,
    control,
    get storage() {
      return storage;
    },
    lose() {
      storage = null;
    },
  };
}

describe("resumable coordinated publication", () => {
  it("submits the dependency batch before waiting for npm scanning", async () => {
    const f = fixture();
    const original = f.adapters.npm.upload;
    const verifications = [];
    f.adapters.npm.upload = (target) => {
      const operation = original(target);
      return {
        ...operation,
        read: async () => {
          if (!f.remote.has(target.name)) return null;
          expect(f.writes.slice(0, 2)).toEqual(["@fixture/a", "@fixture/b"]);
          expect(
            f.storage[f.plan.candidate].items[`npm:${target.name}`].status,
          ).toBe("submitted");
          return operation.read();
        },
        verify: async (value) => {
          verifications.push(target.name);
          return operation.verify(value);
        },
      };
    };
    expect((await f.run()).status).toBe("promoted");
    expect(verifications).toEqual(["@fixture/a", "@fixture/b"]);
  });

  it("preserves unavailable npm submissions and blocks downstream destinations on resume", async () => {
    const f = fixture();
    const original = f.adapters.npm.upload;
    let visible = false;
    f.adapters.npm.upload = (target) => ({
      ...original(target),
      retryAbsent: false,
      read: async () => (visible ? (f.remote.get(target.name) ?? null) : null),
    });
    await expect(f.run()).rejects.toThrow("indexing");
    expect(f.writes).toEqual(["@fixture/a", "@fixture/b"]);
    expect(f.storage[f.plan.candidate].items["npm:@fixture/a"].error).toBe(
      "availability-pending",
    );
    await expect(f.run()).rejects.toThrow("reconcile");
    expect(f.writes).toEqual(["@fixture/a", "@fixture/b"]);
    visible = true;
    expect((await f.run()).status).toBe("promoted");
    expect(f.writes.filter((key) => key === "@fixture/a")).toHaveLength(1);
    expect(f.writes.filter((key) => key === "@fixture/b")).toHaveLength(1);
  });

  it("automatically resumes a recorded partial promotion without repeating uploads", async () => {
    const f = fixture();
    f.control.fail = "tag:@fixture/b";
    f.control.before = true;
    await expect(f.run({ reconcileRecordedPromotion: true })).rejects.toThrow();
    f.control.fail = null;
    expect((await f.run({ reconcileRecordedPromotion: true })).status).toBe(
      "promoted",
    );
    expect(f.intent.reconciliation).toBeNull();
    expect(f.writes.filter((key) => key === "@fixture/a")).toHaveLength(1);
    expect(f.writes.filter((key) => key === "tag:@fixture/a")).toHaveLength(1);
  });

  it("refuses automatic reconciliation of an externally changed partial promotion", async () => {
    const f = fixture();
    f.control.fail = "tag:@fixture/b";
    f.control.before = true;
    await expect(f.run()).rejects.toThrow();
    f.control.fail = null;
    f.tags["@fixture/b"] = "0.9.0";
    await expect(f.run({ reconcileRecordedPromotion: true })).rejects.toThrow(
      "reconciliation",
    );
  });

  it("uses dependency order and does not repeat verified writes", async () => {
    const f = fixture();
    expect((await f.run()).status).toBe("promoted");
    expect(f.writes).toEqual([
      "@fixture/a",
      "@fixture/b",
      "vsix",
      "visibility",
      "tag:@fixture/a",
      "tag:@fixture/b",
      "github:tag",
      "github:draft",
      "github:asset",
      "github:publish",
    ]);
    await f.run();
    expect(f.writes).toHaveLength(10);
  });
  for (const key of [
    "@fixture/a",
    "@fixture/b",
    "vsix",
    "visibility",
    "tag:@fixture/a",
    "tag:@fixture/b",
    "github:tag",
    "github:draft",
    "github:asset",
    "github:publish",
  ]) {
    it(`reconciles success followed by timeout for ${key}`, async () => {
      const f = fixture();
      f.control.fail = key;
      expect((await f.run()).status).toBe("promoted");
      expect(f.writes.filter((value) => value === key)).toHaveLength(1);
    });
    it(`retains partial state after failure before ${key}`, async () => {
      const f = fixture();
      f.control.fail = key;
      f.control.before = true;
      await expect(f.run()).rejects.toThrow();
      expect(f.storage[f.plan.candidate].status).not.toBe("promoted");
      f.control.fail = null;
      if (key === "vsix") {
        await expect(f.run()).rejects.toThrow("reconcile");
        f.remote.set("vsix", "expected");
      }
      if (key === "tag:@fixture/b") {
        await expect(f.run()).rejects.toThrow("reviewed reconciliation");
        f.intent.reconciliation = hash(encode(f.tags));
      }
      expect((await f.run()).status).toBe("promoted");
    });
  }
  for (const save of [5, 8, 11, 15, 18, 21, 24, 27, 30]) {
    it(`recovers when journal persistence fails at transition ${save}`, async () => {
      const f = fixture();
      f.control.loseJournalAt = save;
      await expect(f.run()).rejects.toThrow("Journal unavailable");
      f.control.loseJournalAt = 0;
      if (
        Object.values(f.tags).some(Boolean) &&
        !Object.values(f.tags).every(Boolean)
      ) {
        f.intent.reconciliation = hash(encode(f.tags));
      }
      expect((await f.run()).status).toBe("promoted");
      expect(new Set(f.writes).size).toBe(f.writes.length);
    });
  }
  it("reconstructs lost journal from destinations", async () => {
    const f = fixture();
    await f.run();
    f.lose();
    await f.run();
    expect(f.writes).toHaveLength(10);
  });
  it("rejects content collisions without overwrite", async () => {
    const f = fixture();
    f.remote.set("@fixture/a", "different");
    await expect(f.run()).rejects.toThrow("collision");
    expect(f.writes).toEqual([]);
  });
  it("keeps indexing delays unknown and never repeats an extension upload", async () => {
    const f = fixture();
    const original = f.adapters.marketplace.upload;
    let visible = false;
    f.adapters.marketplace.upload = () => ({
      ...original(),
      read: async () => (visible ? "expected" : null),
    });
    await expect(f.run()).rejects.toThrow("indexing");
    await expect(f.run()).rejects.toThrow("reconcile");
    visible = true;
    await f.run();
    expect(f.writes.filter((key) => key === "vsix")).toHaveLength(1);
  });
  it("serializes concurrent releases before any submission", async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.run(), f.run()]);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(f.writes).toHaveLength(10);
  });
  it("requires every preflight before the first package upload", async () => {
    const f = fixture();
    f.adapters.marketplace.preflight = async () => {
      throw new Error("credential expired");
    };
    await expect(f.run()).rejects.toThrow("credential expired");
    expect(f.writes).toEqual([]);
  });
  it("rejects old approvals, another candidate and unreviewed publisher", async () => {
    for (const [key, value] of [
      ["expiresAt", "2026-01-01"],
      ["candidate", "c".repeat(64)],
      ["publisherSha", "d".repeat(40)],
    ]) {
      const f = fixture();
      f.intent[key] = value;
      await expect(f.run()).rejects.toThrow();
      expect(f.storage).toBeNull();
      expect(f.writes).toEqual([]);
    }
  });
  it("does not let a newer release be overtaken by a retry", async () => {
    const f = fixture();
    f.tags["@fixture/a"] = "2.0.0";
    await expect(f.run()).rejects.toThrow("backward");
    expect(f.writes.some((key) => key.startsWith("tag:"))).toBe(false);
  });
  it("rejects a changed candidate under the same immutable release identity", async () => {
    const f = fixture();
    await f.run();
    f.plan.candidate = "c".repeat(64);
    f.intent.candidate = f.plan.candidate;
    await expect(f.run()).rejects.toThrow("identity collision");
  });
  it("bounds retry attempts", async () => {
    const f = fixture();
    f.control.fail = "@fixture/a";
    f.control.before = true;
    for (let i = 0; i < 3; i += 1) await expect(f.run()).rejects.toThrow();
    await expect(f.run()).rejects.toThrow("exhausted");
    expect(f.writes).toHaveLength(3);
  });
  it("separates destination steps and checks previous destinations", async () => {
    const f = fixture();
    await expect(f.run({ phase: "marketplace" })).rejects.toThrow("incomplete");
    for (const phase of ["npm", "marketplace", "promote", "github"])
      await f.run({ phase });
    expect(f.writes).toHaveLength(10);
  });
  it("rejects missing dependency closure and cycles", () => {
    expect(() =>
      dependencyOrder([{ name: "a", dependencies: [{ name: "b" }] }]),
    ).toThrow("closure");
    expect(() =>
      dependencyOrder([
        {
          name: "a",
          version: "1",
          dependencies: [{ name: "a", version: "1" }],
        },
      ]),
    ).toThrow("cycle");
    expect(() =>
      promotionReview({ a: "invalid" }, [{ name: "a", version: "1.0.0" }]),
    ).toThrow();
  });
});

it("persists local journal atomically and rejects another owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "publication-journal-test-"));
  try {
    const first = fileJournal(directory);
    const second = fileJournal(directory);
    await first.acquire();
    await expect(second.acquire()).rejects.toThrow();
    await first.save({ candidate: "a".repeat(64), items: { npm: "unknown" } });
    await first.release();
    await second.acquire();
    expect(await second.read()).toEqual(
      JSON.parse(readFileSync(join(directory, "journal.json"))),
    );
    await second.release();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function gitService() {
  let head = null;
  let serial = 0;
  const objects = new Map();
  const calls = [];
  let timeout = false;
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.includes("/actions/runs/")) return { status: "completed" };
    if (method === "GET" && path.includes("/git/ref/"))
      return head ? { object: { sha: head } } : null;
    if (method === "GET") return objects.get(path.split("/").at(-1));
    if (path.endsWith("/git/blobs")) {
      const sha = String(++serial);
      objects.set(sha, {
        encoding: "base64",
        content: Buffer.from(body.content).toString("base64"),
      });
      return { sha };
    }
    if (path.endsWith("/git/trees")) {
      const sha = String(++serial);
      objects.set(sha, { truncated: false, tree: body.tree });
      return { sha };
    }
    if (path.endsWith("/git/commits")) {
      const sha = String(++serial);
      objects.set(sha, { ...body, tree: { sha: body.tree } });
      return { sha };
    }
    if (path.includes("/git/refs")) {
      if (head && objects.get(body.sha).parents[0] !== head)
        throw new Error("Non-fast-forward");
      head = body.sha;
      if (timeout) {
        timeout = false;
        throw new Error("Response lost");
      }
      return {};
    }
    throw new Error("Unexpected fixture request");
  };
  return {
    api,
    calls,
    loseResponse() {
      timeout = true;
    },
  };
}

it("keeps durable Git receipts across instances and reconciles lost ref responses", async () => {
  const service = gitService();
  const first = githubJournal(service.api, "fixture/repo", "1/1");
  service.loseResponse();
  await first.acquire();
  await first.save({ candidate: { items: { npm: "verified" } } });
  await first.release();
  const next = githubJournal(service.api, "fixture/repo", "2/1");
  await next.acquire();
  expect(await next.read()).toEqual({
    candidate: { items: { npm: "verified" } },
  });
  await next.release();
  expect(
    service.calls
      .filter((call) => call.method === "PATCH")
      .every((call) => call.body.force === false),
  ).toBe(true);
});

it("prevents concurrent Git journal acquisition by non-fast-forward CAS", async () => {
  const service = gitService();
  const results = await Promise.allSettled([
    githubJournal(service.api, "fixture/repo", "1/1").acquire(),
    githubJournal(service.api, "fixture/repo", "2/1").acquire(),
  ]);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
});

it("proves write access only after acquiring the same repository journal", async () => {
  const service = gitService();
  const journal = githubJournal(service.api, "fixture/repo", "1/1");
  expect(() => journal.assertWriteAccess("fixture/repo")).toThrow("unverified");
  await journal.acquire();
  expect(() => journal.assertWriteAccess("fixture/repo")).not.toThrow();
  expect(() => journal.assertWriteAccess("another/repo")).toThrow();
  await journal.release();
  expect(() => journal.assertWriteAccess("fixture/repo")).toThrow("unverified");

  const denied = githubJournal(
    async (method, path, body) => {
      if (method !== "GET") throw new Error("Permission denied");
      return service.api(method, path, body);
    },
    "fixture/repo",
    "2/1",
  );
  await expect(denied.acquire()).rejects.toThrow("Permission denied");
  expect(() => denied.assertWriteAccess("fixture/repo")).toThrow("unverified");
});

it("does not steal a durable lease from a running workflow attempt", async () => {
  const service = gitService();
  const api = (method, path, body) =>
    path.includes("/actions/runs/")
      ? Promise.resolve({ status: "in_progress" })
      : service.api(method, path, body);
  const first = githubJournal(api, "fixture/repo", "1/1");
  await first.acquire();
  const next = githubJournal(api, "fixture/repo", "2/1");
  await expect(next.acquire()).rejects.toThrow("Concurrent publisher");
  await first.release();
});

it("rechecks expiration between writes and never treats a failed retry as complete", async () => {
  const f = fixture();
  await f.run();
  f.remote.set("vsix", "changed");
  await expect(f.run()).rejects.toThrow("collision");
  expect(f.storage[f.plan.candidate].status).not.toBe("promoted");
  const other = fixture();
  await expect(
    other.run({
      now: () =>
        Date.parse(other.writes.length === 0 ? "2026-10-11" : "2026-12-01"),
    }),
  ).rejects.toThrow("expired");
  expect(other.writes).toEqual(["@fixture/a"]);
});

it("rejects a candidate that expires while waiting for npm visibility", async () => {
  const f = fixture();
  let expired = false;
  const original = f.adapters.npm.upload;
  f.adapters.npm.upload = (target) => {
    const operation = original(target);
    return {
      ...operation,
      read: async () => {
        if (f.remote.has(target.name)) expired = true;
        return operation.read();
      },
    };
  };
  await expect(
    f.run({
      now: () => Date.parse(expired ? "2026-12-01" : "2026-10-11"),
    }),
  ).rejects.toThrow("expired");
  expect(f.writes).toEqual(["@fixture/a", "@fixture/b"]);
  expect(f.storage[f.plan.candidate].status).not.toBe("promoted");
});

it("requires a reviewed absent-state digest to retry an unknown Marketplace submission", async () => {
  const f = fixture();
  f.control.fail = "vsix";
  f.control.before = true;
  await expect(f.run()).rejects.toThrow("unknown");
  f.control.fail = null;
  await expect(f.run()).rejects.toThrow("reconcile");
  f.intent.reconciliation = f.storage[f.plan.candidate].reconciliation.digest;
  expect((await f.run()).status).toBe("promoted");
  expect(f.writes.filter((key) => key === "vsix")).toHaveLength(2);
});
