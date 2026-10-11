import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readTarball } from "./distribution-archive.mjs";

export function loopbackRegistry(value) {
  const url = new URL(value);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.port && Number(url.port) > 0);
  assert.equal(url.username + url.password + url.search + url.hash, "");
  assert.equal(url.pathname, "/");
  return url.origin;
}

export function verifyIntegrity(bytes, integrity) {
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
  assert.equal(
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    integrity,
    "Tarball integrity mismatch",
  );
}

export function dependencyArchive(record) {
  return `${record.name.replaceAll("/", "-").replace(/^@/, "")}-${record.version}.tgz`;
}

export async function registryPackages(
  inventory,
  archives,
  dependencies,
  tools,
) {
  const packages = [];
  for (const target of inventory.targets.filter((item) =>
    item.archive.endsWith(".tgz"),
  )) {
    const bytes = await readFile(join(archives, target.archive));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      target.sha256,
    );
    packages.push({
      bytes,
      manifest: JSON.parse(readTarball(bytes)["package.json"]),
    });
  }
  for (const record of [...inventory.externalDependencies, ...tools]) {
    const bytes = await readFile(join(dependencies, dependencyArchive(record)));
    verifyIntegrity(bytes, record.integrity);
    const listing = spawnSync("tar", ["-tzf", "-"], {
      input: bytes,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(listing.status, 0);
    const paths = listing.stdout
      .toString()
      .split("\n")
      .filter((path) => /^[^/]+\/package\.json$/.test(path));
    assert.equal(paths.length, 1, record.name);
    const extracted = spawnSync("tar", ["-xzOf", "-", paths[0]], {
      input: bytes,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(extracted.status, 0, extracted.stderr.toString());
    const manifest = JSON.parse(extracted.stdout);
    assert.equal(manifest.name, record.name);
    assert.equal(manifest.version, record.version);
    packages.push({ bytes, manifest });
  }
  return packages;
}

// A sealed, in-memory fixture registry: no proxy, upstream or mutation route.
// Only previously inspected archives can be served, and only on IPv4 loopback.
export async function startRegistry(packages) {
  const requests = [];
  let origin;
  const server = createServer((request, response) => {
    let path;
    try {
      path = decodeURIComponent(new URL(request.url, origin).pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    requests.push({ method: request.method, path });
    if (request.method !== "GET" || request.headers.authorization) {
      response.writeHead(403).end();
      return;
    }
    const archive = /^\/tarballs\/(\d+)$/.exec(path);
    if (archive && packages[Number(archive[1])]) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(packages[Number(archive[1])].bytes);
      return;
    }
    const selected = packages.filter(
      (item) => `/${item.manifest.name}` === path,
    );
    if (!selected.length) {
      response.writeHead(404).end();
      return;
    }
    const versions = Object.fromEntries(
      selected.map((item) => [
        item.manifest.version,
        {
          ...item.manifest,
          dist: {
            tarball: `${origin}/tarballs/${packages.indexOf(item)}`,
            integrity: `sha512-${createHash("sha512").update(item.bytes).digest("base64")}`,
            shasum: createHash("sha1").update(item.bytes).digest("hex"),
          },
        },
      ]),
    );
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name: selected[0].manifest.name,
        versions,
        "dist-tags": { latest: selected.at(-1).manifest.version },
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = loopbackRegistry(`http://127.0.0.1:${server.address().port}`);
  return {
    origin,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
