import { vi } from "vitest";
export const TransportKind = { ipc: 1 };
export const RevealOutputChannelOn = { Never: 4 };
export class LanguageClient {
  static instances = [];
  static failStart = false;
  diagnostics = { delete: vi.fn(), set: vi.fn() };
  sendRequest = vi.fn();
  sendNotification = vi.fn();
  stop = vi.fn();
  constructor(id, name, server, options) {
    Object.assign(this, { id, name, server, options });
    LanguageClient.instances.push(this);
  }
  async start() {
    if (LanguageClient.failStart) throw new Error("SECRET SOURCE");
  }
  onNotification(name, callback) {
    this.notification = callback;
    return { dispose() {} };
  }
}
