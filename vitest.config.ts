import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts", "{apps,packages}/**/*.{test,spec}.{ts,tsx}"],
    exclude: [...configDefaults.exclude, "**/dist/**", "**/coverage/**"],
    globalSetup: ["./tests/global-setup.ts"],
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    allowOnly: false,
    coverage: {
      provider: "v8",
      include: ["{apps,packages}/*/src/**/*.{ts,tsx}"],
      exclude: ["**/*.{test,spec}.{ts,tsx}", "**/*.d.ts"],
      reporter: ["text", "html", "lcov"],
    },
  },
});
