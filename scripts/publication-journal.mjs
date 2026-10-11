import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const encode = (value) => JSON.stringify(value, null, 2) + "\n";

/** Local durable storage. An abandoned lock needs explicit operator recovery. */
export function fileJournal(directory) {
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, "lock");
  const path = join(directory, "journal.json");
  return {
    async acquire() {
      mkdirSync(lock);
    },
    async release() {
      rmSync(lock, { recursive: true });
    },
    async read() {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async save(value) {
      const temporary = join(directory, "journal.pending");
      const fd = openSync(temporary, "w", 0o600);
      try {
        writeFileSync(fd, encode(value));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
      const parent = openSync(directory, "r");
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    },
  };
}

/** Append-only Git history; non-force ref updates provide compare-and-swap. */
export function githubJournal(api, repository, owner) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(owner, /^[1-9][0-9]*\/[1-9][0-9]*$/);
  const base = `/repos/${repository}`;
  const branch = "publication-journal";
  let head;
  let state;
  async function read() {
    const ref = await api("GET", `${base}/git/ref/heads/${branch}`);
    head = ref?.object.sha ?? null;
    if (!head)
      return { format: "tinta-publication-store-1", owner: null, releases: {} };
    const commit = await api("GET", `${base}/git/commits/${head}`);
    const tree = await api("GET", `${base}/git/trees/${commit.tree.sha}`);
    assert.equal(tree.truncated, false);
    assert.equal(tree.tree.length, 1);
    assert.equal(tree.tree[0].path, "journal.json");
    const blob = await api("GET", `${base}/git/blobs/${tree.tree[0].sha}`);
    assert.equal(blob.encoding, "base64");
    const value = JSON.parse(
      Buffer.from(blob.content, "base64").toString("utf8"),
    );
    assert.equal(value.format, "tinta-publication-store-1");
    return value;
  }
  async function save(next) {
    const blob = await api("POST", `${base}/git/blobs`, {
      content: encode(next),
      encoding: "utf-8",
    });
    const tree = await api("POST", `${base}/git/trees`, {
      tree: [
        { path: "journal.json", mode: "100644", type: "blob", sha: blob.sha },
      ],
    });
    const commit = await api("POST", `${base}/git/commits`, {
      message: "Record publication progress",
      tree: tree.sha,
      parents: head ? [head] : [],
    });
    try {
      if (head) {
        await api("PATCH", `${base}/git/refs/heads/${branch}`, {
          sha: commit.sha,
          force: false,
        });
      } else {
        await api("POST", `${base}/git/refs`, {
          ref: `refs/heads/${branch}`,
          sha: commit.sha,
        });
      }
    } catch {
      // A lost response may follow a successful ref update. Never repeat blindly.
      const ref = await api("GET", `${base}/git/ref/heads/${branch}`);
      assert.equal(
        ref?.object.sha,
        commit.sha,
        "Journal conflict or unknown write",
      );
    }
    head = commit.sha;
    state = structuredClone(next);
  }
  return {
    async acquire() {
      state = await read();
      if (state.owner && state.owner !== owner) {
        assert.match(state.owner, /^[1-9][0-9]*\/[1-9][0-9]*$/);
        const [run, attempt] = state.owner.split("/");
        const previous = await api(
          "GET",
          `${base}/actions/runs/${run}/attempts/${attempt}`,
        );
        assert.equal(
          previous.status,
          "completed",
          "Concurrent publisher owns journal",
        );
      }
      await save({ ...state, owner });
    },
    async release() {
      assert.equal(state.owner, owner);
      await save({ ...state, owner: null });
    },
    async read() {
      return structuredClone(state.releases);
    },
    async save(releases) {
      assert.equal(state.owner, owner);
      await save({ ...state, releases });
    },
  };
}
