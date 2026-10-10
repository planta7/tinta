/* global acquireVsCodeApi, payload */
const api = acquireVsCodeApi();
const frame = document.createElement("iframe");
frame.setAttribute(
  "sandbox",
  "allow-scripts allow-popups allow-popups-to-escape-sandbox",
);
const header = {
  protocol: "tinta-host-1",
  documentId: crypto.randomUUID().replaceAll("-", ""),
  capability: crypto.randomUUID().replaceAll("-", ""),
  requestId: 0,
  sourceRevision: 1,
};
const result = { kind: "result", loaded: false, protocolRejected: false };
let channel;
let sent = false;
function finish() {
  if (result.loaded && result.protocolRejected && result.fileDenied && !sent) {
    sent = true;
    api.postMessage(result);
  }
}
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;
  if (event.data?.kind === "audit") {
    Object.assign(result, event.data, {
      kind: "result",
      opaque: event.origin === "null",
    });
    if (!payload.allowReader) {
      setTimeout(() => {
        result.inheritedReaderBlock = !channel;
        api.postMessage(result);
      }, 250);
    } else finish();
    return;
  }
  if (
    JSON.stringify(event.data) !==
      JSON.stringify({ protocol: "tinta-host-1", kind: "hello" }) ||
    channel
  )
    return;
  channel = new MessageChannel();
  channel.port1.onmessage = ({ data }) => {
    if (
      data.protocol !== header.protocol ||
      data.documentId !== header.documentId ||
      data.capability !== header.capability
    )
      throw new Error("Invalid identity");
    if (data.kind === "ready") {
      channel.port1.postMessage({
        ...header,
        requestId: 1,
        kind: "load",
        program: payload.program,
        assets: [],
      });
    } else if (data.kind === "state") {
      result.loaded = true;
      channel.port1.postMessage({
        ...header,
        requestId: 2,
        kind: "read-file",
        path: "forbidden",
      });
    } else if (data.kind === "diagnostics") {
      result.protocolRejected = data.diagnostics.some(
        (item) => item.code === "E_PROTOCOL",
      );
      finish();
    }
  };
  frame.contentWindow.postMessage({ ...header, kind: "connect" }, "*", [
    channel.port2,
  ]);
});
frame.srcdoc = payload.preview;
document.body.append(frame);
