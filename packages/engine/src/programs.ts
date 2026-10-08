import type { Program } from "@tinta/types";
import type { Bound } from "./binding.js";
export const programs = new WeakMap<Program, Bound>();
