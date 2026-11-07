import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "electron/*-bin/**",
    "electron/assets/**",
    // Packaged desktop build output (`npm run build:desktop` /
    // scripts/build-electron.mjs). It embeds the whole Next standalone tree
    // plus the vendored Gemini/Pi CLI bundles — hundreds of MB of JS. It was
    // the one build output not ignored here, so a full `npm run lint` after a
    // desktop build walked all of it and died at the default 4 GB heap.
    "dist-electron/**",
    "public/pdf.worker.min.mjs",
  ]),
  {
    files: ["electron/**/*.js", "**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
