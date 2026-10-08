import type { Asset, SourceProfile } from "@tinta/types";
import {
  decodeUtf8,
  encodeUtf8,
  limits,
  validateAssets,
} from "@tinta/artifacts";
import { exact, record } from "./protocol.js";

export interface Recovery {
  id: string;
  source: string;
  profile: SourceProfile;
  filename: string;
  edited: number;
  assets: [string, Asset][];
}

export function recoveryBytes(value: Recovery): number {
  return (
    encodeUtf8(value.source).length +
    value.assets.reduce((sum, [, asset]) => sum + asset.bytes.length, 0)
  );
}

export function validateRecovery(value: unknown): Recovery {
  if (
    !record(value) ||
    !exact(value, [
      "id",
      "source",
      "profile",
      "filename",
      "edited",
      "assets",
    ]) ||
    typeof value.id !== "string" ||
    value.id.length > 128 ||
    typeof value.source !== "string" ||
    typeof value.filename !== "string" ||
    value.filename.length > 255 ||
    !["markdown", "tinta"].includes(String(value.profile)) ||
    !Array.isArray(value.assets) ||
    typeof value.edited !== "number" ||
    !Number.isFinite(value.edited) ||
    encodeUtf8(value.source).length > limits.sourceBytes
  )
    throw new Error("Invalid recovery copy.");
  decodeUtf8(encodeUtf8(value.source));
  const candidate = value as unknown as Recovery;
  validateAssets(new Map(candidate.assets));
  if (recoveryBytes(candidate) > 30 * 1024 * 1024)
    throw new Error("Recovery copy exceeds storage limit.");
  return candidate;
}

export function retainedRecoveries(
  entries: Recovery[],
  active: Recovery,
): Recovery[] {
  const result = [
    ...entries.filter((e) => e.id !== active.id),
    validateRecovery(active),
  ].sort((a, b) => b.edited - a.edited);
  while (
    result.length > 10 ||
    result.reduce((sum, item) => sum + recoveryBytes(item), 0) >
      30 * 1024 * 1024
  ) {
    let oldest = result.length - 1;
    while (oldest >= 0 && result[oldest]!.id === active.id) oldest--;
    if (oldest < 0) throw new Error("Active recovery exceeds quota.");
    result.splice(oldest, 1);
  }
  return result;
}

export class RecoveryStore {
  private async database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("tinta-recovery", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("copies", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("Recovery storage is blocked."));
    });
  }

  async list(): Promise<Recovery[]> {
    const db = await this.database();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction("copies", "readonly");
        const request = transaction.objectStore("copies").getAll();
        transaction.oncomplete = () => {
          try {
            resolve(request.result.map(validateRecovery));
          } catch (error) {
            reject(error);
          }
        };
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  }

  async save(active: Recovery): Promise<void> {
    const db = await this.database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("copies", "readwrite");
        const store = transaction.objectStore("copies");
        const request = store.getAll();
        request.onsuccess = () => {
          try {
            const retained = retainedRecoveries(
              request.result.map(validateRecovery),
              active,
            );
            const ids = new Set(retained.map((item) => item.id));
            for (const item of request.result as Recovery[])
              if (!ids.has(item.id)) store.delete(item.id);
            store.put(active);
          } catch {
            transaction.abort();
          }
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () =>
          reject(
            transaction.error ??
              new Error("Recovery storage unavailable or quota exceeded."),
          );
      });
    } finally {
      db.close();
    }
  }

  async delete(id?: string): Promise<void> {
    const db = await this.database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("copies", "readwrite");
        const store = transaction.objectStore("copies");
        if (id === undefined) store.clear();
        else store.delete(id);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  }
}
