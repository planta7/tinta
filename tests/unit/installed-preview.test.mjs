import { describe, expect, it, vi } from "vitest";
import { openInstalledPreview } from "../vscode/installed-preview.mjs";

describe("installed preview source verification", () => {
  function fixture(readyAfter) {
    class TabInputWebview {}
    let attempts = 0;
    let time = 0;
    const tabs = [];
    const vscode = {
      TabInputWebview,
      window: { tabGroups: { all: [{ tabs }] } },
      commands: {
        executeCommand: vi.fn(async (name) => {
          expect(name).toBe("tinta.openPreview");
          if (++attempts === readyAfter)
            tabs.push({ input: new TabInputWebview() });
        }),
      },
    };
    return {
      vscode,
      clock: {
        now: () => time,
        wait: async (ms) => {
          time += ms;
        },
      },
    };
  }
  it("waits for a verified source instead of assuming command completion created a panel", async () => {
    const { vscode, clock } = fixture(4);
    await openInstalledPreview(vscode, clock);
    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(4);
    expect(vscode.window.tabGroups.all[0].tabs[0].input).toBeInstanceOf(
      vscode.TabInputWebview,
    );
  });
  it("does not retry an already successful command", async () => {
    const { vscode, clock } = fixture(1);
    await openInstalledPreview(vscode, clock);
    expect(vscode.commands.executeCommand).toHaveBeenCalledOnce();
  });
  it("fails within the existing native wait deadline if no panel is created", async () => {
    const { vscode, clock } = fixture(Infinity);
    await expect(openInstalledPreview(vscode, clock)).rejects.toThrow(
      "Installed preview did not open",
    );
    expect(clock.now()).toBe(20000);
    expect(vscode.window.tabGroups.all[0].tabs).toEqual([]);
  });
});
