import assert from "node:assert/strict";
import { checkFile } from "./release-candidate.mjs";
import { digest } from "./distribution-archive.mjs";

export function releaseAdapter({ api, request, token, directory, journal }) {
  let repository;
  const root = () => `/repos/${repository}`;
  let releaseId;
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
    assert.equal(release.body, `Candidate SHA-256: ${plan.candidate}`);
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
      yield {
        key: "tag",
        retryAbsent: true,
        read: () => api("GET", tagPath),
        write: () =>
          api("POST", `${root()}/git/refs`, {
            ref: `refs/tags/${plan.tag}`,
            sha: plan.sourceSha,
          }),
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
      yield {
        key: "draft",
        retryAbsent: true,
        read: () => readRelease(plan),
        write: () =>
          api("POST", `${root()}/releases`, {
            tag_name: plan.tag,
            target_commitish: plan.sourceSha,
            name: plan.releaseId,
            body: `Candidate SHA-256: ${plan.candidate}`,
            draft: true,
            prerelease:
              plan.targets.find((t) => t.kind === "npm").channel !== "latest",
            make_latest: "false",
          }),
        verify: async (release) => checkRelease(release, plan),
      };
      const release = await readRelease(plan);
      checkRelease(release, plan);
      const assets = () =>
        api("GET", `${root()}/releases/${release.id}/assets?per_page=100`);
      const records = [...plan.targets.map((t) => t.archive), ...plan.metadata];
      assert.ok(records.length < 100);
      const find = async (record) => {
        const values = await assets();
        assert.ok(values.length < 100, "Ambiguous asset pagination");
        assert.ok(
          values.every((asset) => records.some((r) => r.path === asset.name)),
          "Unexpected release asset",
        );
        const matches = values.filter((asset) => asset.name === record.path);
        assert.ok(matches.length <= 1);
        return matches[0] ?? null;
      };
      for (const record of records) {
        yield {
          key: `asset:${record.path}`,
          retryAbsent: true,
          read: () => find(record),
          write: async () => {
            assert.equal(
              (await readRelease(plan)).draft,
              true,
              "Cannot add to a completed release",
            );
            await request(
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
          },
          verify: async (asset) => {
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
      yield {
        key: "publish",
        retryAbsent: true,
        read: async () => {
          const current = await readRelease(plan);
          checkRelease(current, plan);
          return current.draft ? null : current;
        },
        write: async () => {
          for (const record of records) {
            assert.equal(
              (await find(record))?.digest,
              `sha256:${record.sha256}`,
            );
            assert.equal(digest(checkFile(directory, record)), record.sha256);
          }
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
