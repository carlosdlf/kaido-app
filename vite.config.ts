/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig } from "vite";

// Set by the Tauri CLI when developing on a physical device.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
    },
  },
  // Keep Rust errors visible in the terminal.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    outDir: "dist",
    // Tauri uses WebView2 (Chromium) on Windows and WebKit on macOS and Linux.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
  test: {
    projects: [
      {
        // Logic tests run in plain Node, so nothing can lean on DOM globals by accident.
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/lib/ui/**", "src/App.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        plugins: [svelteTesting()],
        test: {
          name: "ui",
          include: ["src/lib/ui/**/*.test.ts", "src/App.test.ts"],
          environment: "jsdom",
          setupFiles: ["src/lib/ui/testing/setup.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,svelte}"],
      exclude: [
        "src/**/*.test.ts",
        // Test helpers and sample data, not shipped behavior.
        "src/**/fixtures.ts",
        "src/**/testing/**",
        // Type-only declarations have no runtime code.
        "src/**/*.d.ts",
        "src/**/types.ts",
        // Entry point: only mounts the app.
        "src/main.ts",
      ],
      reporter: ["text", "html"],
      thresholds: {
        "src/lib/core/**": { lines: 95, statements: 95, functions: 95, branches: 90 },
        "src/lib/storage/**": { lines: 95, statements: 95, functions: 95, branches: 90 },
        "src/lib/config/**": { lines: 95, statements: 95, functions: 95, branches: 90 },
        "src/lib/ui/**": { lines: 80, statements: 80, functions: 80, branches: 75 },
      },
    },
  },
});
