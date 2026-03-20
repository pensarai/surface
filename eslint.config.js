import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import unusedImports from "eslint-plugin-unused-imports";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "unused-imports": unusedImports,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "no-useless-escape": "off",
    },
  },
  prettierConfig,
  {
    ignores: ["node_modules/**", "dist/**", "build/**"],
  },
);
