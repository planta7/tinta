import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

// Observe only the installed server. Keep payloads and filesystem writes out
// of the measured path; the caller saves this bounded trace after testing.
export function traceCompletionLatency(
  serverPath,
  {
    processes = childProcess,
    now = () => performance.now(),
    sync = syncBuiltinESMExports,
  } = {},
) {
  const originalFork = processes.fork;
  const children = [];
  const samples = [];
  let active;
  let droppedEvents = 0;
  let attachedServers = 0;

  function observe(direction, message) {
    if (!active || active.events.length >= 128) {
      if (active) droppedEvents++;
      return;
    }
    if (!message || typeof message !== "object") return;
    const completion = message.method === "textDocument/completion";
    const reply = direction === "receive" && active.ids.has(message.id);
    const refresh = message.method === "workspace/semanticTokens/refresh";
    if (!completion && !reply && !refresh) return;
    if (completion && direction === "send") active.ids.add(message.id);
    active.events.push({
      direction,
      kind: completion ? "completion" : reply ? "response" : "semanticRefresh",
      id: typeof message.id === "number" ? message.id : null,
      offsetMs: now() - active.started,
    });
  }

  function fork(modulePath, ...args) {
    const child = Reflect.apply(originalFork, this, [modulePath, ...args]);
    if (modulePath !== serverPath) return child;
    attachedServers++;
    const originalSend = child.send;
    function send(message, ...rest) {
      observe("send", message);
      return Reflect.apply(originalSend, this, [message, ...rest]);
    }
    const receive = (message) => observe("receive", message);
    child.send = send;
    child.prependListener("message", receive);
    children.push({ child, originalSend, send, receive });
    return child;
  }
  processes.fork = fork;
  sync();

  return {
    begin(index) {
      if (active || samples.length >= 30)
        throw new Error("Invalid latency sample.");
      active = {
        index,
        started: now(),
        cpu: process.cpuUsage(),
        utilization: performance.eventLoopUtilization(),
        ids: new Set(),
        events: [],
      };
    },
    end() {
      if (!active) return;
      const totalMs = now() - active.started;
      const cpu = process.cpuUsage(active.cpu);
      const utilization = performance.eventLoopUtilization(active.utilization);
      const requests = active.events.filter(
        (event) => event.kind === "completion",
      );
      const request = requests[0];
      const response = active.events.find(
        (event) => event.kind === "response" && event.id === request?.id,
      );
      samples.push({
        index: active.index,
        totalMs,
        requestCount: requests.length,
        beforeServerMs: request?.offsetMs ?? null,
        serverRoundTripMs:
          response && request ? response.offsetMs - request.offsetMs : null,
        afterServerMs: response ? totalMs - response.offsetMs : null,
        hostCpuUserMs: cpu.user / 1000,
        hostCpuSystemMs: cpu.system / 1000,
        hostEventLoop:
          utilization.active + utilization.idle > 0 ? utilization : null,
        events: active.events,
      });
      active = undefined;
    },
    report() {
      return {
        method:
          "Native command wall time split at installed-server IPC boundaries; server round trip includes IPC and scheduling. CPU and event loop utilization cover the extension host only; null utilization means unavailable. No document contents are recorded.",
        attachedServers,
        droppedEvents,
        samples,
      };
    },
    dispose() {
      this.end();
      if (processes.fork === fork) processes.fork = originalFork;
      sync();
      for (const { child, originalSend, send, receive } of children) {
        if (child.send === send) child.send = originalSend;
        child.off("message", receive);
      }
    },
  };
}
