import * as vscode from "vscode";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { residentBytes } from "./resident-memory.mjs";

const percentile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
export async function measureInstalled(open) {
  const extension = vscode.extensions.getExtension(
    process.env.TINTA_INSTALLED_ID,
  );
  assert.ok(extension, "VSIX was not installed for performance checks.");
  const worker = new Worker(join(extension.extensionPath, "dist/worker.mjs"));
  const loop = monitorEventLoopDelay({ resolution: 5 });
  const samples = [];
  let version = 0;
  const request = (text) =>
    new Promise((accept, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Analysis watchdog budget exceeded.")),
        3000,
      );
      worker.once("message", (reply) => {
        clearTimeout(timeout);
        worker.off("error", reject);
        if (!reply.result.ok || reply.result.value.validity !== "valid")
          reject(new Error("Performance corpus did not compile."));
        else accept(reply);
      });
      worker.once("error", reject);
      worker.postMessage({
        uri: "tinta:performance",
        instance: "a".repeat(32),
        version: ++version,
        text,
      });
    });
  const baselineRss = await residentBytes();
  let peakRss = baselineRss;
  let sampling = false;
  let pendingSample = Promise.resolve();
  let samplingError;
  const sampler = setInterval(() => {
    if (sampling) return;
    sampling = true;
    pendingSample = residentBytes()
      .then((rss) => {
        peakRss = Math.max(peakRss, rss);
      })
      .catch((error) => {
        samplingError ??= error;
      })
      .finally(() => {
        sampling = false;
      });
  }, 100);
  try {
    loop.enable();
    for (const [bytes, budgetMs] of [
      [10240, 200],
      [102400, 500],
      [1048576, 2000],
    ]) {
      let text = "@let amount = 2\n{{ amount }}\n\n";
      while (text.length < bytes) {
        const blockBytes = Math.min(32000, bytes - text.length);
        if (blockBytes < 14) {
          text += " ".repeat(blockBytes);
          break;
        }
        const start = "```text\n";
        const end = "\n```\n";
        text +=
          start +
          "Reference listing. "
            .repeat(Math.ceil(blockBytes / 19))
            .slice(0, blockBytes - start.length - end.length) +
          end;
      }
      for (let warm = 0; warm < 3; warm++) await request(text);
      const durations = [];
      for (let index = 0; index < 30; index++) {
        const started = performance.now();
        await request(text);
        durations.push(performance.now() - started);
      }
      samples.push({
        bytes,
        samples: durations,
        p95Ms: percentile(durations, 0.95),
        budgetMs,
      });
    }
    const doc = await open("cached.tinta", "@let amount = 2\n{{ amount }}\n");
    const complete = () =>
      vscode.commands.executeCommand(
        "vscode.executeCompletionItemProvider",
        doc.uri,
        new vscode.Position(1, 6),
      );
    await complete();
    const completions = [];
    for (let index = 0; index < 30; index++) {
      const started = performance.now();
      const result = await complete();
      assert.ok(result.items.some((item) => item.label === "amount"));
      completions.push(performance.now() - started);
    }
    const documents = [];
    for (let index = 0; index < 8; index++)
      documents.push(
        await open(`rapid-${index}.tinta`, "@let amount = 2\n{{ amount }}\n"),
      );
    for (let revision = 0; revision < 20; revision++) {
      const edit = new vscode.WorkspaceEdit();
      for (const document of documents)
        edit.replace(
          document.uri,
          new vscode.Range(0, 14, 0, 15),
          String(revision % 10),
        );
      assert.ok(await vscode.workspace.applyEdit(edit));
    }
    for (const document of documents) {
      const definitions = await vscode.commands.executeCommand(
        "vscode.executeDefinitionProvider",
        document.uri,
        new vscode.Position(1, 6),
      );
      assert.equal(definitions.length, 1);
    }
    loop.disable();
    clearInterval(sampler);
    await pendingSample;
    if (samplingError) throw samplingError;
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    setFlagsFromString("--expose-gc");
    const collect = runInNewContext("gc");
    collect();
    const heapBefore = process.memoryUsage().heapUsed;
    for (let index = 0; index < 100; index++) {
      const document = await open(
        `cycle-${index}.tinta`,
        "@let amount = 2\n{{ amount }}\n",
      );
      await vscode.commands.executeCommand(
        "vscode.executeDefinitionProvider",
        document.uri,
        new vscode.Position(1, 6),
      );
      await vscode.commands.executeCommand(
        "workbench.action.closeActiveEditor",
      );
    }
    collect();
    const retainedHeapGrowth = process.memoryUsage().heapUsed - heapBefore;
    const completionP95Ms = percentile(completions, 0.95);
    const loopP95Ms = loop.percentile(95) / 1e6;
    const loopMaxMs = loop.max / 1e6;
    const rssGrowth = peakRss === null ? null : peakRss - baselineRss;
    return {
      status:
        samples.every((sample) => sample.p95Ms < sample.budgetMs) &&
        completionP95Ms < 50 &&
        loopP95Ms < 50 &&
        loopMaxMs <= 100 &&
        retainedHeapGrowth <= 32 * 1024 ** 2 &&
        rssGrowth !== null &&
        rssGrowth <= 512 * 1024 ** 2
          ? "PASS"
          : "FAIL",
      analysis: samples,
      completionP95Ms,
      completionSamples: completions,
      loopP95Ms,
      loopMaxMs,
      retainedHeapGrowth,
      baselineRss,
      peakRss,
      rssGrowth,
      rapidDocuments: 8,
      rapidRevisions: 20,
      openCloseCycles: 100,
      method:
        "Corpus: one expression plus bounded reference listings (each below " +
        "textValueUnits); all sizes must compile and initially evaluate. " +
        "Installed analysis worker round trips exclude debounce; completion " +
        "through native provider; RSS collection is asynchronous without " +
        "overlapping samplers; post-GC heap is extension host only; RSS sums host " +
        "descendants including server and worker threads in their owner process.",
    };
  } finally {
    clearInterval(sampler);
    loop.disable();
    await worker.terminate();
  }
}
