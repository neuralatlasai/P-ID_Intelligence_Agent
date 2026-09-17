import js from "@eslint/js";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

/**
 * Lint configuration.
 *
 * The Next.js presets carry the React, hooks and framework rules. On top of them this file
 * adds the rules that protect the architecture: nothing may import the server-only gateway
 * from client code, and nothing may reach into the OpenAI package outside the one type
 * boundary that re-exports it.
 */
const config = [
  {
    ignores: [
      ".next/**",
      ".releases/**",
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "smart"],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "openai",
              message:
                "Import Responses types from @/lib/responses/native-types, which is the single protocol boundary.",
            },
          ],
          patterns: [
            {
              group: ["openai/*"],
              message:
                "Import Responses types from @/lib/responses/native-types, which is the single protocol boundary.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            "Model output is untrusted. Render Markdown with raw HTML disabled instead.",
        },
      ],
    },
  },
  {
    // The protocol boundary is the one place allowed to import the OpenAI package.
    files: ["src/lib/responses/native-types.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "tests/**/*.ts", "tests/**/*.tsx"],
    rules: { "no-console": "off" },
  },
];

export default config;
