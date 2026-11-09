import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  // Build output and Cesium's copied assets (see next.config.js)
  { ignores: [".next/**", "public/cesium/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Cesium and splat-viewer objects are typed `any` throughout, on purpose (see CLAUDE.md)
      "@typescript-eslint/no-explicit-any": "off",
      // Preview images come straight from the R2 bucket; next/image's optimizer isn't set up for it
      "@next/next/no-img-element": "off",
    },
  },
  {
    // CommonJS config file
    files: ["next.config.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
];

export default eslintConfig;
