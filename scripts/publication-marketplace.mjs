import assert from "node:assert/strict";
import { checkFile } from "./release-candidate.mjs";
import { digest, readZip } from "./distribution-archive.mjs";

export function verifyMarketplacePayload(submitted, downloaded) {
  const expected = readZip(submitted);
  const actual = readZip(downloaded);
  const signatures = new Set([".signature.p7s", "extension.signature.p7s"]);
  assert.deepEqual(
    Object.keys(actual)
      .filter((name) => !signatures.has(name))
      .sort(),
    Object.keys(expected).sort(),
    "Unexpected Marketplace payload entries",
  );
  for (const [path, bytes] of Object.entries(expected)) {
    assert.equal(
      digest(actual[path]),
      digest(bytes),
      "Marketplace payload content changed",
    );
  }
  return {
    submittedSha256: digest(submitted),
    downloadedSha256: digest(downloaded),
    byteIdentical: digest(submitted) === digest(downloaded),
    files: Object.entries(expected).map(([path, bytes]) => ({
      path,
      sha256: digest(bytes),
    })),
  };
}

/** Gallery REST with an Entra token; no Azure Pipelines credential assumptions. */
export function marketplaceAdapter({
  request,
  credential,
  directory,
  publisherId,
}) {
  const base = "https://marketplace.visualstudio.com";
  let headers;
  const call = (path, options = {}) =>
    request(base + path, { headers, ...options });
  const route = (target) => {
    assert.match(target.name, /^[A-Za-z0-9-]+\.[A-Za-z0-9-]+$/);
    const [publisher, extension] = target.name.split(".");
    return {
      publisher,
      extension,
      path: `/_apis/gallery/publishers/${publisher}/extensions/${extension}`,
    };
  };
  return {
    async preflight(plan) {
      const target = plan.targets.find((t) => t.kind === "vsix");
      assert.ok(target, "Extension is mandatory");
      const { publisher } = route(target);
      assert.notEqual(publisher, "tinta-local");
      headers = { Authorization: `Bearer ${await credential()}` };
      const identity = await call(
        `/_apis/gallery/publishers/${publisher}?api-version=7.2-preview.1`,
      );
      assert.equal(
        identity.publisherId,
        publisherId,
        "Publisher ownership binding changed",
      );
      assert.equal(identity.publisherName, publisher);
      checkFile(directory, target.archive);
    },
    upload(target) {
      const { publisher, extension, path } = route(target);
      const read = async () => {
        const result = await call(
          `${path}?flags=145&api-version=7.2-preview.2`,
          { missing: true },
        );
        if (!result) return null;
        assert.equal(result.publisher.publisherId, publisherId);
        assert.equal(result.publisher.publisherName, publisher);
        assert.equal(result.extensionName, extension);
        const versions = result.versions.filter(
          (v) =>
            v.version === target.version &&
            (v.targetPlatform ?? "universal") === "universal",
        );
        assert.ok(versions.length <= 1, "Ambiguous extension version");
        return versions.length
          ? { extensionId: result.extensionId, version: versions[0] }
          : null;
      };
      return {
        retryAbsent: false,
        read,
        write: async () => {
          assert.equal(await read(), null, "Extension version already exists");
          const existing = await call(`${path}?api-version=7.2-preview.2`, {
            missing: true,
          });
          await call(
            existing
              ? `${path}?api-version=7.2-preview.2`
              : "/_apis/gallery/extensions?api-version=7.2-preview.2",
            {
              method: existing ? "PUT" : "POST",
              headers: {
                ...headers,
                "Content-Type": "application/octet-stream",
              },
              body: checkFile(directory, target.archive),
            },
          );
        },
        verify: async (remote) => {
          const preRelease =
            remote.version.properties?.some(
              (p) =>
                p.key === "Microsoft.VisualStudio.Code.PreRelease" &&
                p.value === "true",
            ) ?? false;
          assert.equal(
            preRelease,
            target.channel === "pre-release",
            "Extension channel collision",
          );
          const downloaded = await call(
            `/_apis/gallery/publisher/${publisher}/extension/${extension}/${target.version}/assets/Microsoft.VisualStudio.Services.VSIXPackage?api-version=7.2-preview.1`,
            { binary: true },
          );
          return {
            publisher,
            publisherId,
            extensionId: remote.extensionId,
            version: target.version,
            channel: target.channel,
            targetPlatform: "universal",
            ...verifyMarketplacePayload(
              checkFile(directory, target.archive),
              downloaded,
            ),
          };
        },
      };
    },
  };
}
