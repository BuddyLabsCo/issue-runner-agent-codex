import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const portableImports = [
  {
    name: "node:os",
    message: "OS-bound code is prohibited; use portable APIs and the Host.",
  },
  {
    name: "os",
    message: "OS-bound code is prohibited; use portable APIs and the Host.",
  },
  ...["node:path", "path"].map((name) => ({
    name,
    importNames: ["win32", "posix"],
    message: "Use portable path operations, not platform-specific variants.",
  })),
  ...["node:process", "process"].map((name) => ({
    name,
    importNames: ["platform", "arch"],
    message: "Platform-dependent execution is prohibited.",
  })),
  ...["node:child_process", "child_process"].map((name) => ({
    name,
    importNames: ["exec", "execSync"],
    message: "Use direct executable arguments without an OS shell.",
  })),
];

const productionImports = [
  {
    regex: "(^|/)tests(/|$)",
    message: "Production code must not depend on tests.",
  },
  {
    regex: "^issue-runner-core(?:$|/(?!terminal$))",
    message: "Use only the public issue-runner-core/terminal contract.",
  },
  {
    regex: "^(issue-runner-herdr|herdr)(/|$)",
    message: "Use the injected Host; do not depend on a terminal plugin.",
  },
];

export default defineConfig(
  { ignores: ["coverage/**", "dist/**"] },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
    rules: {
      "max-lines": [
        "error",
        { max: 500, skipBlankLines: true, skipComments: true },
      ],
      "no-restricted-imports": ["error", { paths: portableImports }],
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "platform",
          message: "OS-bound code is prohibited.",
        },
        {
          object: "process",
          property: "arch",
          message: "Platform-dependent execution is prohibited.",
        },
        {
          property: "win32",
          message: "Use portable path operations.",
        },
        {
          property: "posix",
          message: "Use portable path operations.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "Property[key.name='shell'][value.value=true]",
          message: "Use direct executable arguments without an OS shell.",
        },
      ],
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
  },
  {
    files: ["src/**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: portableImports, patterns: productionImports },
      ],
    },
  },
  {
    files: ["src/enhancement/**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: portableImports,
          patterns: [
            ...productionImports,
            {
              regex:
                "^(node:)?(fs|net|tls|http|https|http2|dns|dgram|child_process|cluster|worker_threads|readline|tty)(/|$)",
              message: "Keep Codex and filesystem I/O in src/codex/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/codex/**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: portableImports,
          patterns: [
            ...productionImports,
            {
              regex: "(^|/)enhancement(/|$)",
              message: "Codex I/O must not depend on enhancement policy.",
            },
          ],
        },
      ],
    },
  },
);
