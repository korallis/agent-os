import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

/**
 * Workspace-root flat config. `apps/marketing` carries its own
 * eslint.config.mjs (Next.js rules + the same no-explicit-any gate);
 * this config governs everything else in the workspace.
 */
const eslintConfig = defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/.next/**",
    "**/dist/**",
    "**/.turbo/**",
    "apps/marketing/**",
  ]),
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
]);

export default eslintConfig;
