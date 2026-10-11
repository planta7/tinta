import { constants } from "node:fs";
import {
  open,
  lstat,
  realpath,
  rename,
  unlink,
  link,
  mkdir,
  rmdir,
} from "node:fs/promises";
import { dirname, resolve, relative, sep, basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Asset, AssetStore, Program } from "@tinta-lang/types";
import {
  ArtifactFailure,
  createAsset,
  imageDestinations,
  normalizeAssetPath,
  unwrap,
  limits,
} from "@tinta-lang/artifacts";

export class HostFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 3,
  ) {
    super(message);
  }
}

const isMissing = (error: unknown): boolean =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  error.code === "ENOENT";

export async function identity(path: string): Promise<
  | {
      path: string;
      dev: number;
      ino: number;
      size: number;
      mtimeMs: number;
      ctimeMs: number;
    }
  | undefined
> {
  try {
    const stat = await lstat(path);
    return {
      path: await realpath(path),
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function assertOutput(
  output: string,
  inputs: readonly string[],
  force: boolean,
): Promise<void> {
  const target = resolve(output),
    existing = await identity(target);

  for (const input of inputs) {
    if (input === "-") continue;
    const original = await identity(input);
    if (
      target === resolve(input) ||
      (existing &&
        original &&
        (existing.path === original.path ||
          (existing.dev === original.dev && existing.ino === original.ino)))
    )
      throw new HostFailure("E_IO", "Output must not replace an input file.");
  }
  if (existing) {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new HostFailure(
        "E_IO",
        "Output must be a regular file, not a link.",
      );
    if (!force)
      throw new HostFailure(
        "E_OUTPUT_EXISTS",
        "Output already exists; use --force to replace it.",
      );
    if (!(stat.mode & 0o222))
      throw new HostFailure("E_IO", "Output is read-only.");
  }

  const parent = await lstat(dirname(target));
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new HostFailure("E_IO", "Output directory must be a real directory.");
}

export async function readBounded(
  path: string,
  maximum: number,
): Promise<Uint8Array> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new HostFailure("E_IO", "Input must be a regular file, not a link.");
  if (before.size > maximum)
    throw new ArtifactFailure("E_LIMIT", "Input byte limit exceeded.");

  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const actual = await handle.stat();
    if (
      before.dev !== actual.dev ||
      before.ino !== actual.ino ||
      !actual.isFile()
    )
      throw new HostFailure("E_IO", "Input identity changed while opening.");

    const chunks: Uint8Array[] = [];
    let total = 0;

    for (;;) {
      const buffer = Buffer.alloc(Math.min(65536, maximum - total + 1));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximum)
        throw new ArtifactFailure(
          "E_LIMIT",
          "Input grew beyond the byte limit.",
        );
      chunks.push(buffer.subarray(0, bytesRead));
    }

    const after = await lstat(path);
    if (
      after.dev !== actual.dev ||
      after.ino !== actual.ino ||
      after.isSymbolicLink() ||
      after.size !== total ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new HostFailure("E_IO", "Input changed while reading.");

    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

export async function resolveAssets(
  program: Program,
  root: string | undefined,
  destinations = imageDestinations(program.flow),
): Promise<AssetStore> {
  return readAssets(destinations, root);
}

export async function assertAssetRoot(root: string): Promise<string> {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new ArtifactFailure(
      "E_ASSET_PATH",
      "Asset root must be a real directory, not a symbolic link.",
    );
  return realpath(root);
}

export async function readAssets(
  destinations: readonly string[],
  root: string | undefined,
  signal?: AbortSignal,
): Promise<AssetStore> {
  const assets = new Map<string, Asset>();
  if (!destinations.length) return assets;
  if (!root)
    throw new ArtifactFailure(
      "E_ASSET_MISSING",
      "Relative images require an explicit document root.",
    );

  const granted = await assertAssetRoot(root);

  let total = 0;
  const unique = new Set<string>();

  for (const destination of destinations) {
    signal?.throwIfAborted();
    const key = normalizeAssetPath(destination);
    let path = granted;

    for (const part of key.split("/")) {
      path = join(path, part);
      let stat;
      try {
        stat = await lstat(path);
      } catch (error) {
        if (isMissing(error))
          throw new ArtifactFailure(
            "E_ASSET_MISSING",
            "A required local image was not supplied.",
          );
        throw error;
      }
      if (stat.isSymbolicLink())
        throw new ArtifactFailure(
          "E_ASSET_PATH",
          "Image paths cannot traverse symbolic links.",
        );
    }

    const member = relative(granted, await realpath(path));
    if (
      member.startsWith(`..${sep}`) ||
      member === ".." ||
      resolve(granted, member) !== path
    )
      throw new ArtifactFailure(
        "E_ASSET_PATH",
        "Image escaped its granted root.",
      );

    const asset = unwrap(
      createAsset(await readBounded(path, limits.assetBytes)),
    );
    if ((await realpath(path)) !== path)
      throw new ArtifactFailure(
        "E_ASSET_PATH",
        "Image path changed while reading.",
      );
    if (!unique.has(asset.sha256)) {
      total += asset.bytes.length;
      unique.add(asset.sha256);
    }
    if (unique.size > limits.assetCount || total > limits.totalAssetBytes)
      throw new ArtifactFailure("E_LIMIT", "Document image limits exceeded.");
    assets.set(key, asset);
  }

  signal?.throwIfAborted();
  return assets;
}

export async function atomicWrite(
  output: string,
  bytes: Uint8Array,
  inputs: readonly string[],
  force: boolean,
  signal: AbortSignal,
  beforeCommit?: () => void,
  expectedOutput?: Awaited<ReturnType<typeof identity>> | null,
): Promise<void> {
  signal.throwIfAborted();
  await assertOutput(output, inputs, force);
  const target = resolve(output),
    original = await identity(target);
  if (
    expectedOutput !== undefined &&
    JSON.stringify(original ?? null) !== JSON.stringify(expectedOutput)
  )
    throw new HostFailure("E_IO", "Selected output changed before writing.");
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    signal.throwIfAborted();
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    signal.throwIfAborted();
    await assertOutput(target, inputs, force);
    const current = await identity(target);
    if (JSON.stringify(original) !== JSON.stringify(current))
      throw new HostFailure("E_IO", "Output identity changed before commit.");
    signal.throwIfAborted();
    beforeCommit?.();
    if (original) await rename(temporary, target);
    else {
      await link(temporary, target);
      await unlink(temporary);
    }
  } finally {
    await handle.close().catch(() => {});
    await unlink(temporary).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }
}

export async function unpackTree(
  output: string,
  entries: ReadonlyMap<string, Uint8Array>,
  signal: AbortSignal,
): Promise<void> {
  const target = resolve(output);
  if (await identity(target))
    throw new HostFailure(
      "E_OUTPUT_EXISTS",
      "Unpack target must be a new directory.",
    );

  const stage = join(
    dirname(target),
    `.${basename(target)}.${randomUUID()}.tmp`,
  );
  const created: string[] = [];
  await mkdir(stage, { mode: 0o700 });
  try {
    if ([...entries.keys()].some((key) => key.startsWith("assets/")))
      await mkdir(join(stage, "assets"));
    for (const [name, bytes] of entries) {
      signal.throwIfAborted();
      const path = join(stage, name),
        handle = await open(path, "wx", 0o600);
      created.push(path);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    signal.throwIfAborted();
    if (await identity(target))
      throw new HostFailure(
        "E_OUTPUT_EXISTS",
        "Unpack target appeared before commit.",
      );
    await rename(stage, target);
  } finally {
    for (const path of created.reverse())
      await unlink(path).catch((error) => {
        if (!isMissing(error)) throw error;
      });
    await rmdir(join(stage, "assets")).catch((error) => {
      if (!isMissing(error)) throw error;
    });
    await rmdir(stage).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }
}
