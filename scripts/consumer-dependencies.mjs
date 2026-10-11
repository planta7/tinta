import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { dependencyArchive, verifyIntegrity } from "./consumer-registry.mjs";

export async function consumerTools() {
  const inventory = JSON.parse(
    await readFile(
      new URL("../toolchain/lock-inventory.json", import.meta.url),
    ),
  );
  return ["typescript", "@types/node", "undici-types"].map((name) => {
    const records = inventory.filter((item) => item.name === name);
    if (records.length !== 1) throw new Error(`Ambiguous tool pin: ${name}`);
    return records[0];
  });
}

// Acquisition is separate from the sealed registry and all consumer processing.
// Cache entries and downloads must match the reviewed SHA-512 lock integrity.
export async function acquireDependencies(
  inventoryPath,
  destination,
  download,
) {
  const inventory = JSON.parse(await readFile(inventoryPath));
  await mkdir(destination, { recursive: true });
  const records = [
    ...inventory.externalDependencies,
    ...(await consumerTools()),
  ];
  const results = [];
  for (const record of records) {
    const output = join(destination, dependencyArchive(record));
    let bytes;
    let source = "existing";
    try {
      bytes = await readFile(output);
    } catch {
      const hex = Buffer.from(record.integrity.slice(7), "base64").toString(
        "hex",
      );
      try {
        bytes = await readFile(
          join(
            homedir(),
            ".npm/_cacache/content-v2/sha512",
            hex.slice(0, 2),
            hex.slice(2, 4),
            hex.slice(4),
          ),
        );
        source = "integrity-cache";
      } catch {
        if (!download)
          throw new Error(
            `Missing reviewed archive: ${record.name}@${record.version}; run acquisition with --download explicitly.`,
          );
        const basename = record.name.split("/").at(-1);
        const url = `https://registry.npmjs.org/${record.name}/-/${basename}-${record.version}.tgz`;
        const response = await fetch(url, {
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok)
          throw new Error(`Acquisition failed: ${url}: ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
        source = url;
      }
    }
    verifyIntegrity(bytes, record.integrity);
    await writeFile(output, bytes);
    results.push({
      name: record.name,
      version: record.version,
      integrity: record.integrity,
      source,
    });
  }
  await writeFile(
    join(destination, "acquisition.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  console.log(`Verified ${results.length} dependency archives.`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [inventory, destination, option] = process.argv.slice(2);
  if (!inventory || !destination || (option && option !== "--download"))
    throw new Error(
      "Pass inventory.json, dependency directory and optional --download.",
    );
  await acquireDependencies(inventory, destination, option === "--download");
}
