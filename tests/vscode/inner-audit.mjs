const result = { kind: "audit" };

try {
  void parent.document.body;
  result.parentDenied = false;
} catch {
  result.parentDenied = true;
}

try {
  void localStorage.length;
  result.storageDenied = false;
} catch {
  result.storageDenied = true;
}

result.vscodeAbsent = typeof globalThis.acquireVsCodeApi === "undefined";

const script = document.createElement("script");
script.textContent = "globalThis.untrustedProbeExecuted = true";
document.body.append(script);
result.unhashedScriptBlocked = globalThis.untrustedProbeExecuted !== true;

Promise.all([
  fetch("file:///tinta-probe-forbidden").then(
    () => false,
    () => true,
  ),
  fetch("https://example.invalid/tinta-probe").then(
    () => false,
    () => true,
  ),
]).then(([fileDenied, networkDenied]) => {
  parent.postMessage({ ...result, fileDenied, networkDenied }, "*");
});
