import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

// Fault injection changes only a disposable worker sibling. The supplied server
// stays byte-identical, and recovery uses the supplied production worker bytes.
export async function checkIpcWatchdog(server, directory) {
  await mkdir(directory);
  const copiedServer = join(directory, "server.mjs");
  const worker = join(directory, "worker.mjs");
  await copyFile(server, copiedServer);
  await writeFile(
    worker,
    'import { parentPort } from "node:worker_threads";\nparentPort.on("message", () => { while (true) {} });\n',
  );
  const child = fork(copiedServer, [], {
    execArgv: [],
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: "" },
  });
  let stderr = "";
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  let timedOut = false;
  const started = performance.now();
  const uri = "file:///watchdog.tinta";
  let timer;
  try {
    await new Promise((accept, reject) => {
      timer = setTimeout(
        () => reject(new Error(`IPC watchdog/restart missing: ${stderr}`)),
        12000,
      );
      child.on("error", reject);
      child.on("exit", (code) =>
        reject(new Error(`IPC exited ${code}: ${stderr}`)),
      );
      child.on("message", async (message) => {
        try {
          if (message.id === 1) {
            child.send({ jsonrpc: "2.0", method: "initialized", params: {} });
            child.send({
              jsonrpc: "2.0",
              method: "textDocument/didOpen",
              params: {
                textDocument: {
                  uri,
                  languageId: "tinta",
                  version: 1,
                  text: "@let x = 1\n{{ x }}",
                },
              },
            });
          }
          if (
            message.method === "textDocument/publishDiagnostics" &&
            message.params.diagnostics.some(
              (item) => item.code === "E_WORKER_TIMEOUT",
            )
          ) {
            assert.ok(
              performance.now() - started < 5000,
              "Watchdog exceeded its response budget",
            );
            timedOut = true;
            await copyFile(join(dirname(server), "worker.mjs"), worker);
            child.send({
              jsonrpc: "2.0",
              method: "textDocument/didChange",
              params: {
                textDocument: { uri, version: 2 },
                contentChanges: [{ text: "@let x = 2\n{{ x }}" }],
              },
            });
          }
          if (
            message.method === "tinta/status" &&
            message.params.version === 2 &&
            message.params.source === "valid"
          ) {
            assert.ok(timedOut);
            accept();
          }
        } catch (error) {
          reject(error);
        }
      });
      child.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { processId: process.pid, capabilities: {}, rootUri: null },
      });
    });
    return {
      status: "PASS",
      timeoutObserved: timedOut,
      recoveryVersion: 2,
      serverSha256: createHash("sha256")
        .update(await readFile(copiedServer))
        .digest("hex"),
      workerSha256: createHash("sha256")
        .update(await readFile(worker))
        .digest("hex"),
    };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}
