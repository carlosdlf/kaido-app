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
    // The core must stay platform independent: no Tauri, Svelte, UI or storage.
    files: ["src/lib/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            tauriImports,
            { group: ["svelte", "svelte/*"], message: "core must not depend on Svelte." },
            { group: ["*.svelte"], message: "core must not import components." },
            {
              group: ["$lib/ui", "$lib/ui/*", "**/ui", "**/ui/*"],
              message: "core must not depend on the UI layer.",
            },
            {
              group: ["$lib/storage", "$lib/storage/*", "**/storage", "**/storage/*"],
              message: "core must not depend on storage; receive data through arguments.",
            },
          ],
        },
      ],
    },
  },
);
