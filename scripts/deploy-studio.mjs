import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { requireCommandSync } from "./commands.mjs";
import { digest, readZip, inspectEntries } from "./distribution-archive.mjs";
import {
  readCandidateJson,
  fileRecord,
  validateProducerIdentity,
  candidateWorkflow,
} from "./release-candidate.mjs";
import { verifyAttestation } from "./verify-release-candidate.mjs";
import { loadReleaseConfig, releaseIdentity } from "./release-contract.mjs";

export function stableStudioRelease(release) {
  assert.equal(release.draft, false, "Draft release");
  assert.equal(release.prerelease, false, "Prerelease");
  assert.ok(
    Number.isFinite(Date.parse(release.published_at)),
    "Unpublished release",
  );
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0);
  const match = /^tinta-v(\d+\.\d+\.\d+)-vscode-(\d+\.\d+\.\d+)-stable$/.exec(
    release.tag_name,
  );
  assert.ok(
    match && semver.valid(match[1]) && semver.valid(match[2]),
    "Stable tinta tag required",
  );
  assert.equal(
    semver.minor(match[2]) % 2,
    0,
    "Stable extension version required",
  );
  return { implementation: match[1], extension: match[2] };
}

export async function currentStudioRelease(release, repository, api) {
  const selected = stableStudioRelease(release);
  for (let page = 1; page <= 10; page++) {
    const releases = await api(
      `/repos/${repository}/releases?per_page=100&page=${page}`,
    );
    for (const other of releases) {
      let version;
      try {
        version = stableStudioRelease(other);
      } catch {
        continue;
      }
      if (
        semver.gt(version.implementation, selected.implementation) ||
        (version.implementation === selected.implementation &&
          semver.gt(version.extension, selected.extension))
      )
        return false;
    }
    if (releases.length < 100) return true;
  }
  throw new Error("Release pagination limit");
}

export function verifyStudioSignature(
  path,
  producer,
  bundle,
  execute = requireCommandSync,
) {
  verifyAttestation(path, producer, (command) =>
    execute(
      command[1] === "attestation" ? [...command, "--bundle", bundle] : command,
    ),
  );
}

export async function prepareStudioRelease({
  release,
  repository,
  repositoryId,
  directory,
  api,
  download,
  attest = verifyStudioSignature,
}) {
  const versions = stableStudioRelease(release);
  const repo = await api(`/repos/${repository}`);
  assert.equal(repo.full_name, repository);
  assert.equal(String(repo.id), repositoryId);
  if (!(await currentStudioRelease(release, repository, api))) return null;
  const assets = await api(
    `/repos/${repository}/releases/${release.id}/assets?per_page=100`,
  );
  assert.ok(assets.length < 100, "Asset pagination limit");
  mkdirSync(directory, { recursive: true });
  async function asset(name) {
    const matches = assets.filter((item) => item.name === name);
    assert.equal(
      matches.length,
      1,
      `Missing or duplicate release asset: ${name}`,
    );
    const record = matches[0];
    assert.ok(Number.isSafeInteger(record.id) && record.id > 0);
    assert.equal(record.state, "uploaded");
    assert.ok(record.size > 0 && record.size <= 128 * 1024 * 1024);
    const bytes = await download(record.id);
    assert.equal(bytes.length, record.size);
    assert.equal(
      record.digest,
      `sha256:${digest(bytes)}`,
      "Release asset digest mismatch",
    );
    return bytes;
  }
  const indexBytes = await asset("candidate-index.json");
  const index = readCandidateJson(indexBytes);
  assert.equal(index.format, "tinta-candidate-1");
  validateProducerIdentity(index.producer);
  const producer = index.producer;
  assert.equal(producer.repository, repository);
  assert.equal(producer.repositoryId, repositoryId);
  assert.equal(producer.workflow, candidateWorkflow);
  assert.equal(producer.ref, `refs/heads/${repo.default_branch}`);
  const tag = await api(
    `/repos/${repository}/git/ref/tags/${encodeURIComponent(release.tag_name)}`,
  );
  assert.equal(tag.object.type, "commit");
  assert.equal(
    tag.object.sha,
    producer.sourceSha,
    "Release tag source mismatch",
  );
  const run = await api(
    `/repos/${repository}/actions/runs/${producer.runId}/attempts/${producer.attempt}`,
  );
  assert.equal(String(run.id), producer.runId);
  assert.equal(run.run_attempt, producer.attempt);
  assert.equal(run.head_sha, producer.sourceSha);
  assert.equal(run.path, candidateWorkflow);
  assert.equal(String(run.repository.id), repositoryId);
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  const indexPath = join(directory, "candidate-index.json");
  const bundlePath = join(directory, "attestation.sigstore.json");
  writeFileSync(indexPath, indexBytes);
  writeFileSync(bundlePath, await asset("attestation.sigstore.json"));
  await attest(indexPath, producer, bundlePath);
  async function bound(record, name) {
    assert.equal(record.path, name);
    const bytes = await asset(name);
    assert.deepEqual(
      fileRecord(name, bytes),
      record,
      "Signed metadata mismatch",
    );
    return readCandidateJson(bytes);
  }
  const manifest = await bound(index.manifest, "release-manifest.json");
  const inventory = await bound(index.inventory, "inventory.json");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.tag, release.tag_name);
  assert.equal(manifest.source.commit, producer.sourceSha);
  assert.equal(manifest.versions.implementation, versions.implementation);
  assert.equal(manifest.versions.extension, versions.extension);
  assert.equal(manifest.versions.npmChannel, "latest");
  assert.equal(manifest.versions.extensionChannel, "stable");
  assert.deepEqual(inventory.versions, manifest.versions);
  assert.equal(inventory.source.commit, producer.sourceSha);
  assert.equal(inventory.source.dirty, false);
  const targets = manifest.targets.filter(
    (target) => target.id === "studio-directory",
  );
  const packed = inventory.targets.filter(
    (target) => target.id === "studio-directory",
  );
  assert.equal(targets.length, 1);
  assert.equal(packed.length, 1);
  const target = targets[0];
  assert.equal(target.kind, "zip");
  assert.equal(target.version, versions.implementation);
  assert.equal(target.channel, "latest");
  const archive = target.archive;
  assert.equal(archive.path, `studio-directory-${versions.implementation}.zip`);
  assert.equal(packed[0].archive, archive.path);
  const bytes = await asset(archive.path);
  assert.deepEqual(
    fileRecord(archive.path, bytes),
    archive,
    "Signed Studio archive mismatch",
  );
  assert.equal(packed[0].sha256, archive.sha256);
  const entries = readZip(bytes);
  const files = inspectEntries(
    entries,
    packed[0].files.map((file) => file.path),
  );
  assert.deepEqual(files, packed[0].files, "Studio member digest mismatch");
  assert.ok(entries["index.html"]?.length > 0);
  assert.ok(entries.LICENSE?.length > 100);
  assert.ok(entries["THIRD_PARTY_NOTICES.txt"]?.length > 100);
  assert.ok(files.some((file) => file.path.startsWith("assets/")));
  for (const file of files)
    assert.ok(
      ["index.html", "LICENSE", "THIRD_PARTY_NOTICES.txt"].includes(
        file.path,
      ) || /^assets\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(file.path),
      "Unexpected Studio file",
    );
  const output = join(directory, "studio");
  // Write bytes as regular files; ZIP attributes never create links or executables.
  for (const [name, value] of Object.entries(entries)) {
    const path = join(output, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value, { flag: "wx" });
  }
  return {
    releaseId: release.id,
    tag: release.tag_name,
    sourceSha: producer.sourceSha,
    archiveSha256: archive.sha256,
    output,
  };
}

async function main(mode) {
  const policy = readCandidateJson(readFileSync("toolchain/publication.json"));
  assert.equal(process.env.GITHUB_REPOSITORY, policy.repository);
  assert.equal(process.env.GITHUB_REPOSITORY_ID, policy.repositoryId);
  const api = async (path) =>
    readCandidateJson(
      Buffer.from(requireCommandSync(["gh", "api", path]).stdout),
    );
  if (mode === "locate") {
    const release = await api(
      `/repos/${policy.repository}/releases/tags/${releaseIdentity(loadReleaseConfig()).tag}`,
    );
    stableStudioRelease(release);
    appendFileSync(process.env.GITHUB_OUTPUT, `release_id=${release.id}\n`);
    return;
  }
  assert.ok(["prepare", "current"].includes(mode), "Unknown demo operation");
  assert.match(process.env.TINTA_STUDIO_RELEASE_ID ?? "", /^[1-9][0-9]*$/);
  const release = await api(
    `/repos/${policy.repository}/releases/${process.env.TINTA_STUDIO_RELEASE_ID}`,
  );
  let receipt;
  if (mode === "prepare")
    receipt = await prepareStudioRelease({
      release,
      repository: policy.repository,
      repositoryId: policy.repositoryId,
      directory: "build/demo-release",
      api,
      download: async (id) =>
        Buffer.from(
          requireCommandSync(
            [
              "gh",
              "api",
              `/repos/${policy.repository}/releases/assets/${id}`,
              "-H",
              "Accept: application/octet-stream",
            ],
            { encoding: null, maxBuffer: 128 * 1024 * 1024 },
          ).stdout,
        ),
    });
  else receipt = await currentStudioRelease(release, policy.repository, api);
  appendFileSync(process.env.GITHUB_OUTPUT, `publish=${Boolean(receipt)}\n`);
  if (receipt && mode === "prepare")
    writeFileSync(
      "build/demo-release/receipt.json",
      JSON.stringify(receipt, null, 2) + "\n",
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main(process.argv[2]);
