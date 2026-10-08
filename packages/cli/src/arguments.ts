import { parseArgs, type ParseArgsConfig } from "node:util";
import { HostFailure } from "./files.js";
export const help =
  "Tinta local document tools\n" +
  "Usage:\n" +
  "  tinta check INPUT [--profile markdown|tinta] [--with-assets] " +
  "[--asset-root DIR] [--json] [--warnings-as-errors]\n" +
  "  tinta enrich INPUT.md --output OUTPUT.tinta [--force] [--json]\n" +
  "  tinta build INPUT --format interactive|static --output " +
  "OUTPUT.html [--profile markdown|tinta] [--state initial|snapshot] " +
  "[--snapshot FILE.tinta.state.json] [--asset-root DIR] [--force] " +
  "[--json]\n" +
  "  tinta pack INPUT.tinta --output OUTPUT.tinta.zip [--asset-root " +
  "DIR] [--force] [--json]\n" +
  "  tinta unpack INPUT.tinta.zip --output-dir NEW_DIRECTORY " +
  "[--json]\n" +
  "  tinta import-data INPUT.csv|INPUT.json --name IDENTIFIER " +
  "--output OUTPUT.tinta [--schema SCHEMA.json] [--force] [--json]\n" +
  "  tinta studio [--output OUTPUT.html] [--force] [--json]\n" +
  "  tinta --help\n  tinta --version\n";
const allowed: Record<string, readonly string[]> = {
  check: ["profile", "with-assets", "asset-root", "json", "warnings-as-errors"],
  enrich: ["output", "force", "json"],
  build: [
    "format",
    "output",
    "profile",
    "state",
    "snapshot",
    "asset-root",
    "force",
    "json",
  ],
  pack: ["output", "asset-root", "force", "json"],
  unpack: ["output-dir", "json"],
  "import-data": ["name", "output", "schema", "force", "json"],
  studio: ["output", "force", "json"],
};
const booleans = ["with-assets", "json", "warnings-as-errors", "force"];
export function usage(message: string): never {
  throw new HostFailure("E_PROTOCOL", message, 2);
}
export function parseArguments(argv: readonly string[]): {
  command: string;
  input: string;
  flags: Record<string, string | true>;
} {
  const command = argv[0] ?? "";
  if (!Object.hasOwn(allowed, command))
    usage("Unknown or missing command. Use --help.");
  const options: NonNullable<ParseArgsConfig["options"]> = Object.fromEntries(
    allowed[command]!.map((name) => [
      name,
      { type: booleans.includes(name) ? "boolean" : "string" },
    ]),
  );
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv.slice(1)],
      options,
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
  } catch {
    usage("Unknown flag or invalid flag value.");
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) usage("Duplicate flag.");
    seen.add(token.name);
    if (token.value === "") usage("Missing flag value.");
  }
  const flags = parsed.values as Record<string, string | true>;
  const operands = parsed.positionals;
  if (operands.length !== (command === "studio" ? 0 : 1))
    usage("Incorrect number of input operands.");
  for (const required of command === "build"
    ? ["format", "output"]
    : ["enrich", "pack", "import-data"].includes(command)
      ? ["output", ...(command === "import-data" ? ["name"] : [])]
      : command === "unpack"
        ? ["output-dir"]
        : [])
    if (!flags[required]) usage(`Missing --${required}.`);
  if (flags.profile && !["markdown", "tinta"].includes(String(flags.profile)))
    usage("Invalid source profile.");
  if (flags.format && !["interactive", "static"].includes(String(flags.format)))
    usage("Invalid export format.");
  if (flags.state && !["initial", "snapshot"].includes(String(flags.state)))
    usage("Invalid selected state.");
  if (command === "build" && (flags.state === "snapshot") !== !!flags.snapshot)
    usage("Snapshot state requires --snapshot and vice versa.");
  if (command === "check" && flags["asset-root"] && !flags["with-assets"])
    usage("--asset-root requires --with-assets.");
  if (command === "studio" && flags.force && !flags.output)
    usage("--force requires --output.");
  return { command, input: operands[0] ?? "", flags };
}
