import { Studio } from "../../apps/studio/dist/studio.js";
import { ArtifactFailure } from "../../packages/types/dist/common.js";

globalThis.describeInternalArtifactFault = () => {
  const messages = [];
  const host = { message: (message) => messages.push(message) };
  Studio.prototype.error.call(
    host,
    new ArtifactFailure("E_INTERNAL", "private artifact payload"),
  );
  Studio.prototype.error.call(
    host,
    new ArtifactFailure("E_LIMIT", "Source byte limit exceeded."),
  );
  return messages;
};
