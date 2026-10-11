import { limits, encodeUtf8 } from "@tinta-lang/artifacts";
import { safeFilename } from "./model.js";

interface WritableFile {
  createWritable(): Promise<{
    write(bytes: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }>;
}

interface PickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
  }) => Promise<WritableFile>;
}

export async function readFile(
  file: File,
  max: number = limits.sourceBytes,
): Promise<Uint8Array> {
  if (file.size > max)
    throw new Error("E_LIMIT: Selected file exceeds the byte limit.");
  return new Uint8Array(await file.arrayBuffer());
}

export async function saveFile(
  bytes: Uint8Array,
  name: string,
  type: string,
  usePicker = false,
): Promise<string> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (usePicker && picker) {
    const handle = await picker({ suggestedName: safeFilename(name) });
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
    return "Saved";
  }

  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = safeFilename(name);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);

  return type === "text/plain"
    ? "Source download started — check your browser's Downloads."
    : "Download started — check your browser's Downloads.";
}

export const sourceBytes = (source: string): Uint8Array => encodeUtf8(source);
