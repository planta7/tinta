import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  mode: "valid",
  reads: 0,
  stats: 0,
  closed: false,
}));
vi.mock("node:fs/promises", () => {
  const stat = (overrides = {}) => ({
    dev: 1,
    ino: 2,
    size: 1,
    mtimeMs: 1,
    ctimeMs: 1,
    isFile: () => true,
    isSymbolicLink: () => false,
    ...overrides,
  });
  return {
    lstat: async () =>
      ++state.stats > 1 && state.mode === "replaced"
        ? stat({ ino: 3 })
        : stat(),
    realpath: async () =>
      state.reads > 0 && state.mode === "path" ? "/other" : "/source",
    open: async () => ({
      stat: async () => (state.mode === "opened" ? stat({ ino: 4 }) : stat()),
      read: async (buffer) => {
        state.reads++;
        if (state.mode === "grow") return { bytesRead: buffer.length };
        if (state.mode === "read") throw new Error("Read failure");
        return { bytesRead: state.reads === 1 ? 1 : 0 };
      },
      close: async () => {
        state.closed = true;
      },
    }),
  };
});
import { readOpenedSource } from "../../packages/local-files/dist/index.js";
afterEach(() =>
  Object.assign(state, { mode: "valid", reads: 0, stats: 0, closed: false }),
);
describe("exact source read race boundaries", () => {
  for (const mode of ["opened", "replaced", "path", "grow", "read"]) {
    it(`closes the descriptor after ${mode} failure`, async () => {
      state.mode = mode;
      await expect(readOpenedSource("/chosen/source")).rejects.toThrow();
      expect(state.closed).toBe(true);
    });
  }
});
