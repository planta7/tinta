import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const name = "@fixture/publication";
const versions = {};
const tags = {};
const tarballs = new Map();
const stats = { uploads: 0, promotions: 0, requests: 0 };
let origin;
const server = createServer(async (req, res) => {
  stats.requests += 1;
  try {
    assert.equal(req.headers.host, new URL(origin).host);
    const url = new URL(req.url, origin);
    const path = decodeURIComponent(url.pathname);
    res.setHeader("content-type", "application/json");
    if (path === "/stats") return res.end(JSON.stringify(stats));
    if (req.method === "GET" && path === `/${name}`) {
      return res.end(JSON.stringify({ name, versions, "dist-tags": tags }));
    }
    if (req.method === "GET" && tarballs.has(path)) {
      res.setHeader("content-type", "application/octet-stream");
      return res.end(tarballs.get(path));
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      assert.ok(size < 1024 * 1024);
      chunks.push(chunk);
    }
    if (req.method === "PUT" && path === `/${name}`) {
      assert.equal(req.headers.authorization, "Bearer loopback-fixture");
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(body.name, name);
      const [version, record] = Object.entries(body.versions)[0];
      assert.equal(record.name, name);
      assert.equal(record.version, version);
      assert.equal(versions[version], undefined, "Immutable fixture version");
      const bytes = Buffer.from(
        Object.values(body._attachments)[0].data,
        "base64",
      );
      const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
      assert.equal(record.dist.integrity, integrity);
      const archive = `/archives/${version}.tgz`;
      tarballs.set(archive, bytes);
      versions[version] = {
        ...record,
        dist: { ...record.dist, tarball: origin + archive },
      };
      Object.assign(tags, body["dist-tags"]);
      stats.uploads += 1;
      res.statusCode = 201;
      return res.end('{"ok":true}');
    }
    if (path === `/-/package/${name}/dist-tags` && req.method === "GET") {
      return res.end(JSON.stringify(tags));
    }
    if (
      path.startsWith(`/-/package/${name}/dist-tags/`) &&
      req.method === "PUT"
    ) {
      assert.equal(req.headers.authorization, "Bearer loopback-fixture");
      const tag = path.split("/").at(-1);
      const version = JSON.parse(Buffer.concat(chunks));
      assert.ok(versions[version]);
      tags[tag] = version;
      stats.promotions += 1;
      return res.end('{"ok":true}');
    }
    res.statusCode = 404;
    res.end('{"error":"fixture route absent"}');
  } catch {
    res.statusCode = 400;
    res.end('{"error":"fixture rejected request"}');
  }
});
server.listen(0, "127.0.0.1", () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  process.send({ origin });
});
process.on("disconnect", () => server.close());
