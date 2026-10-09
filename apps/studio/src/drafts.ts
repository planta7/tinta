import { RecoveryStore, type Recovery } from "./recovery.js";

/** Persistence belongs to the application, never the document runtime. */
export class Drafts {
  readonly store = new RecoveryStore();
  enabled = true;
  pending = false;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;

  constructor(private readonly report: (message: string) => void) {
    try {
      this.enabled = localStorage.getItem("tinta-drafts-enabled") !== "false";
    } catch {
      this.report("Local storage preferences are unavailable.");
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.cancel();
    this.report(
      enabled
        ? "Automatic local drafts enabled"
        : "Local drafts off · Save source to keep a file",
    );
    try {
      localStorage.setItem("tinta-drafts-enabled", String(enabled));
    } catch {
      this.report("Local storage preferences could not be saved.");
    }
  }

  lastId(): string | undefined {
    try {
      return localStorage.getItem("tinta-active-draft") ?? undefined;
    } catch {
      return undefined;
    }
  }

  cancel(): void {
    clearTimeout(this.timer);
    this.generation++;
    this.pending = false;
  }

  schedule(copy: Recovery): void {
    this.cancel();
    if (!this.enabled) return;
    this.pending = true;
    const generation = this.generation;
    this.report("Saving local draft…");
    this.timer = setTimeout(() => {
      void this.store
        .save(copy)
        .then(() => {
          if (generation !== this.generation) return;
          this.pending = false;
          try {
            localStorage.setItem("tinta-active-draft", copy.id);
          } catch {
            /* The document URL still identifies the IndexedDB draft. */
          }
          this.report("Local draft up to date · Save source to keep a file");
        })
        .catch(() => {
          if (generation !== this.generation) return;
          this.report(
            "W_RECOVERY_UNAVAILABLE: Recovery storage is unavailable or full. Your source remains in memory; save source is available.",
          );
        });
    }, 1000);
  }
}
