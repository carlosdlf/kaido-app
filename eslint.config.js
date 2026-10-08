import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";
import svelteConfig from "./svelte.config.js";

const tauriImports = {
  group: ["@tauri-apps/*"],
  message: "Only src/lib/storage may use Tauri APIs; go through the Storage interface.",
};

/** Imports forbidden in the platform-independent layers (core and config). */
const pureLayerPatterns = [
  tauriImports,
  { group: ["svelte", "svelte/*"], message: "core and config must not depend on Svelte." },
  { group: ["*.svelte"], message: "core and config must not import components." },
  {
    group: ["$lib/ui", "$lib/ui/*", "**/ui", "**/ui/*"],
    message: "core and config must not depend on the UI layer.",
  },
  {
    group: ["$lib/storage", "$lib/storage/*", "**/storage", "**/storage/*"],
    message: "core and config must not depend on storage; receive data through arguments.",
  },
];

export default defineConfig(
  {
    ignores: ["dist/", "node_modules/", "src-tauri/", "site/", "coverage/"],
  },
  js.configs.recommended,
  ts.configs.strict,
  svelte.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  {
    files: ["src/**/*.ts", "src/**/*.svelte"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ["*.config.js", "*.config.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: [".svelte"],
        parser: ts.parser,
        svelteConfig,
      },
    },
  },
  {
    // Tauri APIs are reached only through the storage layer.
    files: ["src/**/*.ts", "src/**/*.svelte"],
    ignores: ["src/lib/storage/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [tauriImports] }],
    },
  },
  {
    // Core and config must stay platform independent: no Tauri, Svelte, UI or storage.
    files: ["src/lib/core/**/*.ts", "src/lib/config/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: pureLayerPatterns }],
    },
  },
  {
    // Storage builds on core only: no configuration, UI or Svelte.
    files: ["src/lib/storage/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["svelte", "svelte/*"], message: "storage must not depend on Svelte." },
            { group: ["*.svelte"], message: "storage must not import components." },
            {
              group: ["$lib/ui", "$lib/ui/*", "**/ui", "**/ui/*"],
              message: "storage must not depend on the UI layer.",
            },
            {
              group: ["$lib/config", "$lib/config/*", "**/config", "**/config/*"],
              message: "storage must not depend on config; shared constants live in core.",
            },
          ],
        },
      ],
    },
  },
  {
    // The core is the bottom layer; configuration builds on it, not the reverse.
    files: ["src/lib/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...pureLayerPatterns,
            {
              group: ["$lib/config", "$lib/config/*", "**/config", "**/config/*"],
              message: "core must not depend on config; receive settings through arguments.",
            },
          ],
        },
      ],
    },
  },
);
