import assert from "node:assert/strict";
import { checkFile } from "./release-candidate.mjs";
import { digest, readZip } from "./distribution-archive.mjs";
import { setTimeout } from "node:timers/promises";

export function candidateReleaseNotes(plan, directory) {
  const source = plan.targets.find((target) => target.id === "source");
  assert.ok(source, "Missing candidate source archive");
  const entries = readZip(checkFile(directory, source.archive));
  const releasePlanRecord = plan.metadata?.find(
    (record) => record.path === "release-plan.json",
  );
  if (releasePlanRecord) {
    const releasePlan = JSON.parse(checkFile(directory, releasePlanRecord));
    assert.equal(releasePlan.sourceSha, plan.sourceSha);
    assert.equal(typeof releasePlan.notes, "string");
    assert.ok(releasePlan.notes.trim());
    return (
      releasePlan.notes +
      `\n\n[Install and use](https://github.com/${plan.repository}/blob/${plan.sourceSha}/README.md#try-it-locally)`
    );
  }
  const changelog = entries["CHANGELOG.md"];
  assert.ok(changelog, "Missing candidate changelog");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(changelog);
  const implementation = plan.targets.find((target) => target.kind === "npm");
  const extension = plan.targets.find((target) => target.id === "vscode");
  assert.ok(implementation && extension, "Missing release versions");
  const heading = `## ${implementation.version} / VS Code ${extension.version}`;
  const lines = text.split(/\r?\n/);
  const matches = lines.flatMap((line, index) =>
    line === heading ? [index] : [],
  );
  assert.equal(matches.length, 1, "Missing or ambiguous release notes");
  const start = matches[0] + 1;
  const next = lines.findIndex(
    (line, index) => index >= start && line.startsWith("## "),
  );
  const notes = lines
    .slice(start, next < 0 ? undefined : next)
    .join("\n")
    .trim();
  assert.ok(notes, "Empty release notes");
  const reference = `https://github.com/${plan.repository}/blob/${plan.sourceSha}`;
  return [
    notes,
    "",
    "### Install and use",
    "",
    "Download the files attached to this release. See the " +
      `[setup instructions](${reference}/README.md#try-it-locally) and ` +
      `[VS Code quickstart](${reference}/docs/14_VSCODE_QUICKSTART.md).`,
    "",
    `Candidate SHA-256: ${plan.candidate}`,
  ].join("\n");
}

export function releaseAdapter({
  api,
  request,
  token,
  directory,
  journal,
  notes = (plan) => candidateReleaseNotes(plan, directory),
  wait = setTimeout,
}) {
  let body;
  let repository;
  const root = () => `/repos/${repository}`;
  let releaseId;
  const observe = async (read, ready, pending) => {
    for (let attempt = 0; ; attempt += 1) {
      const value = await read();
      if (ready(value) || !pending || attempt === 12) return value;
      await wait(5000);
    }
  };
  const readRelease = async (plan) => {
    if (releaseId !== undefined)
      return api("GET", `${root()}/releases/${releaseId}`);
    const published = await api(
      "GET",
      `${root()}/releases/tags/${encodeURIComponent(plan.tag)}`,
    );
    if (published) {
      releaseId = published.id;
      return published;
    }
    // The tag endpoint excludes drafts; authenticated listing includes them.
    for (let page = 1; page <= 10; page += 1) {
      const releases = await api(
        "GET",
        `${root()}/releases?per_page=100&page=${page}`,
      );
      const matches = releases.filter(
        (release) => release.tag_name === plan.tag,
      );
      assert.ok(matches.length <= 1, "Ambiguous release tag");
      if (matches.length === 1) {
        releaseId = matches[0].id;
        return matches[0];
      }
      if (releases.length < 100) return null;
    }
    throw new Error("Release lookup exceeded pagination bound");
  };
  const checkRelease = (release, plan) => {
    assert.equal(release.tag_name, plan.tag);
    assert.equal(release.target_commitish, plan.sourceSha);
    assert.equal(release.body, body, "Release description collision");
    assert.equal(
      release.prerelease,
      plan.targets.find((t) => t.kind === "npm").channel !== "latest",
    );
    return {
      id: release.id,
      tag: release.tag_name,
      candidate: plan.candidate,
      draft: release.draft,
    };
  };
  return {
    async preflight(plan) {
      repository = plan.repository;
      body = notes(plan);
      // The journal ref update proves Contents write using the same credential.
      journal.assertWriteAccess(repository);
      const repo = await api("GET", root());
      assert.equal(repo.full_name, repository);
      assert.equal(repo.private, false, "Public release repository required");
      const tag = await api(
        "GET",
        `${root()}/git/ref/tags/${encodeURIComponent(plan.tag)}`,
      );
      if (tag) {
        assert.equal(tag.object.type, "commit");
        assert.equal(tag.object.sha, plan.sourceSha, "Immutable tag collision");
      }
      const existing = await readRelease(plan);
      if (existing) checkRelease(existing, plan);
    },
    async *operations(plan) {
      const tagPath = `${root()}/git/ref/tags/${encodeURIComponent(plan.tag)}`;
      let tagSubmitted = false;
      yield {
        key: "tag",
        retryAbsent: true,
        read: ({ pending = false } = {}) =>
          observe(() => api("GET", tagPath), Boolean, tagSubmitted || pending),
        write: async () => {
          tagSubmitted = true;
          await api("POST", `${root()}/git/refs`, {
            ref: `refs/tags/${plan.tag}`,
            sha: plan.sourceSha,
          });
        },
        verify: async (tag) => {
          assert.equal(tag.object.type, "commit");
          assert.equal(
            tag.object.sha,
            plan.sourceSha,
            "Immutable tag collision",
          );
          return { tag: plan.tag, sourceSha: tag.object.sha };
        },
      };
      let draftSubmitted = false;
      yield {
        key: "draft",
        retryAbsent: true,
        read: ({ pending = false } = {}) =>
          observe(() => readRelease(plan), Boolean, draftSubmitted || pending),
        write: async () => {
          draftSubmitted = true;
          const created = await api("POST", `${root()}/releases`, {
            tag_name: plan.tag,
            target_commitish: plan.sourceSha,
            name: plan.releaseId,
            body,
            draft: true,
            prerelease:
              plan.targets.find((t) => t.kind === "npm").channel !== "latest",
            make_latest: "false",
          });
          assert.ok(Number.isSafeInteger(created?.id) && created.id > 0);
          releaseId = created.id;
        },
        verify: async (release) => checkRelease(release, plan),
      };
      const release = await readRelease(plan);
      checkRelease(release, plan);
      const assets = () =>
        api("GET", `${root()}/releases/${release.id}/assets?per_page=100`);
      const records = [...plan.targets.map((t) => t.archive), ...plan.metadata];
      assert.ok(records.length < 100);
      const list = async () => {
        const values = await assets();
        assert.ok(values.length < 100, "Ambiguous asset pagination");
        assert.ok(
          values.every((asset) => records.some((r) => r.path === asset.name)),
          "Unexpected release asset",
        );
        assert.equal(
          new Set(values.map((asset) => asset.name)).size,
          values.length,
        );
        return values;
      };
      const find = async (record) =>
        (await list()).find((asset) => asset.name === record.path) ?? null;
      for (const record of records) {
        let assetId;
        let assetSubmitted = false;
        yield {
          key: `asset:${record.path}`,
          retryAbsent: true,
          read: ({ pending = false } = {}) =>
            observe(
              () =>
                assetId === undefined
                  ? find(record)
                  : api("GET", `${root()}/releases/assets/${assetId}`),
              Boolean,
              assetSubmitted || pending,
            ),
          write: async () => {
            assert.equal(
              (await readRelease(plan)).draft,
              true,
              "Cannot add to a completed release",
            );
            assetSubmitted = true;
            const created = await request(
              `https://uploads.github.com${root()}/releases/${release.id}/assets?name=${encodeURIComponent(record.path)}`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/octet-stream",
                  "X-GitHub-Api-Version": "2022-11-28",
                },
                body: checkFile(directory, record),
              },
            );
            assert.ok(Number.isSafeInteger(created?.id) && created.id > 0);
            assetId = created.id;
          },
          verify: async (asset) => {
            assert.equal(asset.name, record.path);
            assert.equal(asset.size, record.bytes);
            assert.equal(asset.state, "uploaded");
            assert.equal(
              asset.digest,
              `sha256:${record.sha256}`,
              "Release asset collision",
            );
            // The server-computed digest binds the received bytes; never overwrite.
            return {
              id: asset.id,
              name: asset.name,
              sha256: record.sha256,
              bytes: asset.size,
            };
          },
        };
      }
      let publishSubmitted = false;
      yield {
        key: "publish",
        retryAbsent: true,
        read: async ({ pending = false } = {}) => {
          const current = await observe(
            () => readRelease(plan),
            (value) => value && !value.draft,
            publishSubmitted || pending,
          );
          if (!current) return null;
          checkRelease(current, plan);
          return current.draft ? null : current;
        },
        write: async () => {
          const values = await observe(
            list,
            (items) =>
              records.every((record) =>
                items.some((item) => item.name === record.path),
              ),
            true,
          );
          for (const record of records) {
            assert.equal(
              values.find((asset) => asset.name === record.path)?.digest,
              `sha256:${record.sha256}`,
            );
            assert.equal(digest(checkFile(directory, record)), record.sha256);
          }
          publishSubmitted = true;
          await api("PATCH", `${root()}/releases/${release.id}`, {
            draft: false,
            make_latest: "false",
          });
        },
        verify: async (current) => {
          assert.equal(current.draft, false);
          return checkRelease(current, plan);
        },
      };
    },
  };
}
