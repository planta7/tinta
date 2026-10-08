import type {
  SourceInput,
  Result,
  Program,
} from "../../contracts/public-api.js";
import type { WorkerRequest } from "../../contracts/worker-protocol.js";
type Assert<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type ProfileCheck = Assert<
  Equal<SourceInput["profile"], "markdown" | "tinta">
>;
export type RequestCheck = Assert<
  Equal<WorkerRequest["kind"], "compile" | "cancel">
>;
export type FailureCheck = Assert<
  Equal<
    Extract<Result<Program>, { ok: false }> extends { value: unknown }
      ? true
      : false,
    false
  >
>;
export type InputCheck = Assert<
  Equal<
    {
      uri: string;
      profile: "tinta";
      text: string;
      bytes: Uint8Array;
    } extends SourceInput
      ? true
      : false,
    false
  >
>;
