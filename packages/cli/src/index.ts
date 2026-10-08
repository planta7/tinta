import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  Artifact,
  AssetStore,
  Diagnostic,
  ImportColumn,
  SourceProfile,
} from "@tinta/types";
import { compile, createSession, importCsv, importJson } from "@tinta/engine";
import {
  artifact,
  ArtifactFailure,
  decodeUtf8,
  encodeUtf8,
  enrichMarkdown,
  exportHtml,
  hash,
  imageDestinations,
  limits,
  openBundle,
  packSource,
  strictJson,
  unwrap,
  validateStateSnapshot,
  validatedBundleEntries,
} from "@tinta/artifacts";
import {
  assertOutput,
  atomicWrite,
  HostFailure,
  readBounded,
  resolveAssets,
  unpackTree,
} from "./files.js";
import { help, parseArguments, usage } from "./arguments.js";

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const version = "tinta 0.0.0; source format 1.0; IR ABI tinta-ir-1\n";

function decodeInput(bytes: Uint8Array): string {
  try {
    return decodeUtf8(bytes);
  } catch {
    throw new ArtifactFailure("E_ENCODING", "Input is not valid UTF-8.");
  }
}

async function stdinBytes(
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    signal.throwIfAborted();
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += bytes.length;
    if (total > maximum)
      throw new ArtifactFailure(
        "E_LIMIT",
        "Standard input byte limit exceeded.",
      );
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export async function run(
  argv: readonly string[],
  signal: AbortSignal = new AbortController().signal,
): Promise<CliResult> {
  if (argv.length === 1 && argv[0] === "--help")
    return { exitCode: 0, stdout: help, stderr: "" };
  if (argv.length === 1 && argv[0] === "--version")
    return { exitCode: 0, stdout: version, stderr: "" };

  let command = argv[0] ?? "",
    json = argv.includes("--json");
  const diagnostics: Diagnostic[] = [],
    artifacts: {
      path: string;
      bytes: number;
      sha256: string;
      mediaType: string;
    }[] = [];
  const details: Record<string, unknown> = {};
  let human = "";
  const finish = (exitCode: number): CliResult => ({
    exitCode,
    stdout: json
      ? JSON.stringify({
          ok: exitCode === 0,
          command,
          artifacts,
          diagnostics,
          details,
        }) + "\n"
      : exitCode === 0
        ? human || `${command}: OK\n`
        : "",
    stderr: json
      ? ""
      : diagnostics.map((item) => `${item.code}: ${item.message}\n`).join(""),
  });
  try {
    const args = parseArguments(argv);
    command = args.command;
    const { input, flags } = args;
    json = flags.json === true;
    const flag = (name: string): string | undefined =>
      typeof flags[name] === "string" ? flags[name] : undefined;
    const output = flag("output"),
      force = flags.force === true;
    const inputs = [input, flag("snapshot"), flag("schema")].filter(
      (path): path is string => !!path,
    );
    if (output) await assertOutput(output, inputs, force);
    const produce = async (value: Artifact): Promise<void> => {
      if (!output) usage("An output path is required.");
      await atomicWrite(output, value.bytes, inputs, force, signal);
      artifacts.push({
        path: resolve(output),
        bytes: value.bytes.length,
        sha256: value.sha256,
        mediaType: value.mediaType,
      });
      human = `Wrote ${resolve(output)} (${value.bytes.length} bytes).\n`;
    };
    if (command === "studio") {
      const path = fileURLToPath(
        new URL("../assets/tinta-studio.html", import.meta.url),
      );
      const bytes = await readBounded(path, limits.htmlBytes);
      if (output)
        await produce(artifact(bytes, "text/html", "tinta-studio.html"));
      else {
        human = pathToFileURL(path).href + "\n";
        details.uri = human.trim();
      }
      return finish(0);
    }
    if (command === "import-data") {
      const extension = extname(input).toLowerCase();
      if (![".csv", ".json"].includes(extension) || input === "-")
        usage("Import input must be a CSV or JSON file.");

      const bytes = await readBounded(input, 5242880);
      let columns: readonly ImportColumn[] | undefined;
      const schema = flag("schema");
      if (schema) {
        const envelope = strictJson(
          decodeInput(await readBounded(schema, 5242880)),
        );
        if (
          !envelope ||
          typeof envelope !== "object" ||
          Array.isArray(envelope) ||
          Object.keys(envelope).length !== 2 ||
          !("kind" in envelope) ||
          envelope.kind !== "tinta-import-schema" ||
          !("columns" in envelope) ||
          !Array.isArray(envelope.columns) ||
          !envelope.columns.length ||
          envelope.columns.length > 64
        )
          throw new ArtifactFailure(
            "E_IMPORT_SCHEMA",
            "Invalid import schema envelope.",
          );
        for (const item of envelope.columns as unknown[])
          if (
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            Object.keys(item).length !== 3 ||
            !("input" in item) ||
            typeof item.input !== "string" ||
            !item.input ||
            !("name" in item) ||
            typeof item.name !== "string" ||
            !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(item.name) ||
            !("type" in item) ||
            !["text", "number", "boolean"].includes(String(item.type))
          )
            throw new ArtifactFailure(
              "E_IMPORT_SCHEMA",
              "Invalid import schema column.",
            );
        columns = envelope.columns as ImportColumn[];
      }

      const imported = unwrap(
        (extension === ".csv" ? importCsv : importJson)(bytes, {
          name: flag("name")!,
          ...(columns ? { columns } : {}),
        }),
      );
      unwrap(
        compile({
          text: imported.source,
          uri: "tinta:import",
          profile: "tinta",
        }),
      );
      details.columns = imported.columns;
      details.rowCount = imported.rowCount;
      await produce(
        artifact(encodeUtf8(imported.source), "text/plain", "data.tinta"),
      );

      return finish(0);
    }
    if (input === "-" && !["check", "build", "enrich"].includes(command))
      usage("This command does not accept standard input.");

    const bundle = input.toLowerCase().endsWith(".tinta.zip");
    if (command === "unpack" && !bundle)
      usage("Unpack requires a source bundle.");
    if (command === "pack" && !input.toLowerCase().endsWith(".tinta"))
      usage("Pack requires Tinta source.");
    if (
      command === "enrich" &&
      input !== "-" &&
      !input.toLowerCase().endsWith(".md")
    )
      usage("Enrich requires Markdown source.");
    if (bundle && (flag("profile") === "markdown" || flag("asset-root")))
      usage("Bundles use their declared profile and resources.");

    let profile: SourceProfile = "tinta";
    if (command !== "enrich") {
      const selected =
        flag("profile") ??
        (input.toLowerCase().endsWith(".md")
          ? "markdown"
          : bundle || input.toLowerCase().endsWith(".tinta")
            ? "tinta"
            : undefined);
      if (!selected) usage("This input requires an explicit --profile.");
      profile = selected as SourceProfile;
    }
    if (profile === "markdown" && flag("state") === "snapshot")
      usage("Markdown permits initial state only.");

    const bytes =
      input === "-"
        ? await stdinBytes(limits.sourceBytes, signal)
        : await readBounded(
            input,
            bundle ? limits.bundleBytes : limits.sourceBytes,
          );
    if (command === "enrich") {
      const result = enrichMarkdown({
        bytes,
        uri: input === "-" ? "tinta:stdin" : pathToFileURL(resolve(input)).href,
        profile: "markdown",
      });
      diagnostics.push(...result.diagnostics);
      const enriched = unwrap(result);
      details.edits = enriched.edits;
      details.originalSha256 = enriched.originalSha256;
      await produce(
        artifact(encodeUtf8(enriched.source), "text/plain", "document.tinta"),
      );
      return finish(0);
    }

    const opened = bundle ? unwrap(await openBundle(bytes)) : undefined;
    if (command === "unpack") {
      const loaded = opened!;
      const entries = unwrap(await validatedBundleEntries(bytes));
      const target = flag("output-dir")!;
      await unpackTree(target, entries, signal);
      for (const [name, data] of entries)
        artifacts.push({
          path: resolve(target, name),
          bytes: data.length,
          sha256: hash(data),
          mediaType:
            name === "document.tinta"
              ? "text/plain"
              : name === "manifest.json"
                ? "application/json"
                : loaded.assets.get(name)!.mime,
        });
      human = `Unpacked ${entries.size} files into ${resolve(target)}.\n`;
      return finish(0);
    }

    const compiled = compile(
      opened?.source ?? {
        bytes,
        profile,
        uri: input === "-" ? "tinta:stdin" : pathToFileURL(resolve(input)).href,
      },
    );
    diagnostics.push(...compiled.diagnostics);
    const program = unwrap(compiled);
    const baseline =
      flag("state") === "snapshot"
        ? unwrap(
            validateStateSnapshot(
              program,
              decodeInput(
                await readBounded(flag("snapshot")!, limits.htmlBytes),
              ),
            ),
          )
        : undefined;
    const session = unwrap(
      createSession(program, baseline ? { baseline } : undefined),
    );
    try {
      details.profile = profile;
      details.sourceVersion = "1.0";
      details.state = flag("state") ?? "initial";
      let assets: AssetStore = opened?.assets ?? new Map();
      const checkAssets = command !== "check" || flags["with-assets"] === true;
      if (checkAssets && !opened)
        assets = await resolveAssets(
          program,
          flag("asset-root") ??
            (input === "-" ? undefined : dirname(resolve(input))),
          command === "build" && flag("format") === "static"
            ? imageDestinations(session.getRevision().nodes)
            : undefined,
        );
      details.assetsChecked = checkAssets;
      if (command === "pack")
        await produce(unwrap(await packSource(program, assets)));
      else if (command === "build")
        await produce(
          unwrap(
            await exportHtml(session, assets, {
              format: flag("format") as "interactive" | "static",
              answers: baseline ? "current" : "initial",
            }),
          ),
        );
      if (
        command === "check" &&
        flags["warnings-as-errors"] &&
        diagnostics.some((item) => item.severity === "warning")
      )
        return finish(1);

      return finish(0);
    } finally {
      session.destroy();
    }
  } catch (error) {
    const interrupted = signal.aborted;
    const exitCode = interrupted
      ? 130
      : error instanceof HostFailure
        ? error.exitCode
        : error instanceof ArtifactFailure
          ? 1
          : error &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "string"
            ? 3
            : 4;
    diagnostics.push({
      code:
        error instanceof HostFailure || error instanceof ArtifactFailure
          ? error.code
          : interrupted || exitCode === 3
            ? "E_IO"
            : "E_INTERNAL",
      severity: "error",
      phase: "host",
      message: interrupted
        ? "Operation cancelled; staged output discarded."
        : error instanceof HostFailure || error instanceof ArtifactFailure
          ? error.message
          : exitCode === 3
            ? "Authorized filesystem operation failed."
            : "Unexpected internal failure.",
      span: {
        uri: "tinta:cli",
        start: { offset: 0, line: 1, column: 1 },
        end: { offset: 0, line: 1, column: 1 },
      },
    });

    return finish(exitCode);
  }
}

export async function main(): Promise<void> {
  const controller = new AbortController();
  const interrupt = (): void => {
    controller.abort();
    process.stdin.destroy();
  };
  process.once("SIGINT", interrupt);
  try {
    const result = await run(process.argv.slice(2), controller.signal);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}
