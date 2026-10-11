const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function openInstalledPreview(
  vscode,
  { now = Date.now, wait = delay } = {},
) {
  const deadline = now() + 20000;
  while (now() < deadline) {
    // The command asks users to retry while source verification is pending.
    await vscode.commands.executeCommand("tinta.openPreview");
    if (
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .some((tab) => tab.input instanceof vscode.TabInputWebview)
    )
      return;
    await wait(20);
  }
  throw new Error("Installed preview did not open after source verification.");
}
