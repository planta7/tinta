import { win32 } from "node:path";

export function deploymentTemporaryRoot(platform, workspace, systemTemporary) {
  // The pinned deploy implementation encodes workspace paths as relative
  // directories. Windows cannot represent a relative path across volumes.
  if (platform === "win32") return win32.dirname(workspace);
  return systemTemporary;
}
