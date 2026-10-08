import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "build/**",
      "coverage/**",
      "reports/**",
      ".local/**",
      "packages/engine/src/program-validator.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      "scripts/**/*.mjs",
      "conformance/runner/**/*.mjs",
      "*.js",
      "tests/**/*.mjs",
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["tests/browser/**/*.mjs"],
    languageOptions: { globals: globals.browser },
  },
  { rules: { "@typescript-eslint/no-explicit-any": "error" } },
);
