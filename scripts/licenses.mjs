import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

const accepted = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "CC0-1.0",
  "(MIT OR CC0-1.0)",
  "(MIT OR WTFPL)",
  "MPL-2.0",
  "BlueOak-1.0.0",
]);

const inventory = read("toolchain/lock-inventory.json");
const lock = parse(readFileSync("pnpm-lock.yaml", "utf8"));

for (const [key, value] of Object.entries(lock.packages)) {
  const record = inventory.find((r) => `${r.name}@${r.version}` === key);
  if (!record || record.integrity !== value.resolution.integrity)
    throw new Error(`Missing locked provenance: ${key}`);
  const reviewedToolLicense =
    (key === "argparse@2.0.1" && record.license === "Python-2.0") ||
    (key === "rc@1.2.8" &&
      record.license === "(BSD-2-Clause OR MIT OR Apache-2.0)");
  if (!accepted.has(record.license) && !reviewedToolLicense)
    throw new Error(`License requires review: ${key}: ${record.license}`);
  if (
    record.license === "MPL-2.0" &&
    !["axe-core", "@axe-core/playwright", "lightningcss"].includes(
      nativeParent(record.name),
    )
  )
    throw new Error(`MPL scope requires review: ${key}`);
}

const packages = new Map(),
  notices = new Set();

for (const dir of readdirSync("node_modules/.pnpm")) {
  const base = join("node_modules/.pnpm", dir, "node_modules");
  if (!existsSync(base)) continue;
  for (const scope of readdirSync(base, { withFileTypes: true }).filter((e) =>
    e.isDirectory(),
  )) {
    const dirs = scope.name.startsWith("@")
      ? readdirSync(join(base, scope.name), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => join(base, scope.name, e.name))
      : [join(base, scope.name)];
    for (const path of dirs)
      if (existsSync(join(path, "package.json"))) {
        const pkg = read(join(path, "package.json"));
        packages.set(`${pkg.name}@${pkg.version}`, { ...pkg, path });
      }
  }
}

function nativeParent(name) {
  if (name.startsWith("@esbuild/")) return "esbuild";
  if (name.startsWith("@rolldown/binding-")) return "rolldown";
  if (name.startsWith("lightningcss-")) return "lightningcss";
  return name;
}

for (const original of packages.values()) {
  const pkg = packages.get(
    `${nativeParent(original.name)}@${original.version}`,
  );
  if (!pkg) throw new Error(`Missing matching native parent: ${original.name}`);
  let texts = readdirSync(pkg.path)
    .filter((n) => /^(licen[cs]e|copying|notice)([._-]|$)/i.test(n))
    .map((f) => readFileSync(join(pkg.path, f), "utf8"));
  if (!texts.length && ["esrecurse", "imurmurhash"].includes(pkg.name))
    texts = [
      readFileSync(join(pkg.path, "README.md"), "utf8").split(
        pkg.name === "esrecurse" ? "### License" : "License (MIT)",
      )[1],
    ];
  if (!texts.length && pkg.name === "natural-compare") {
    const mit = readFileSync(
      join(packages.get("esbuild@0.28.2").path, "LICENSE.md"),
      "utf8",
    );
    texts = [
      mit.replace(
        "Copyright (c) 2020 Evan Wallace",
        "Copyright (c) 2012-2015 Lauri Rooden <lauri@rooden.ee>",
      ),
    ];
  }
  if (!texts.length && pkg.name === "@humanfs/types") {
    const core = [...packages.values()].find((p) => p.name === "@humanfs/core");
    texts = [readFileSync(join(core.path, "LICENSE"), "utf8")];
  }
  const omittedNotices = new Set([
    "boolbase@1.0.0",
    "proxy-agent-negotiate@1.1.0",
    "quickjs-wasi@2.2.0",
    "type-fest@2.19.0",
  ]);
  if (!texts.length && omittedNotices.has(`${pkg.name}@${pkg.version}`))
    texts = [readFileSync(`third_party/vsce/${pkg.name}-LICENSE`, "utf8")];
  if (!texts.length || texts.some((t) => !t))
    throw new Error(`Missing license text: ${pkg.name}`);
  notices.add(
    `## ${pkg.name}@${pkg.version} (${pkg.license})\n\n${texts.join("\n")}`,
  );
}

if (!notices.size) throw new Error("Empty notice inventory");

mkdirSync("reports/verification", { recursive: true });
writeFileSync(
  "reports/verification/licenses.json",
  JSON.stringify(
    {
      locked: inventory.length,
      installed: packages.size,
      noticeGroups: notices.size,
    },
    null,
    2,
  ) + "\n",
);

const header =
  "# Third-party notices\n\nLocked dependencies including development tools. Platform bindings use the same-version parent project license. See toolchain/lock-inventory.json for the complete integrity/license inventory and docs/09_FOUNDATION_TOOLCHAIN.md for reviewed notice sources.\n\n";

if (process.argv.includes("--write"))
  writeFileSync(
    "THIRD_PARTY_NOTICES.txt",
    header + [...notices].sort().join("\n\n"),
  );
else {
  const existing = readFileSync("THIRD_PARTY_NOTICES.txt", "utf8");
  for (const notice of notices)
    if (!existing.includes(notice))
      throw new Error(
        "Installed notice missing or changed; regenerate and review",
      );
}

console.log(
  `License PASS: ${inventory.length} locked records, ${packages.size} installed packages, ${notices.size} notice groups`,
);

const corpusProvenance = read("third_party/commonmark/provenance.json");
if (corpusProvenance.version !== "0.31.2")
  throw new Error("Unexpected CommonMark corpus version");
const corpusLicense = readFileSync("third_party/commonmark/LICENSE", "utf8");
if (
  !corpusLicense.includes("CC-BY-SA 4.0") ||
  !corpusLicense.includes("John MacFarlane")
)
  throw new Error("Missing CommonMark specification attribution/license");
console.log(
  "CommonMark corpus: separate upstream CC-BY-SA 4.0 attribution retained; not project MIT.",
);
