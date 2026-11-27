import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["vendor/**", "node_modules/**", "test-results/**", "playwright-report/**"] },
  js.configs.recommended,
  {
    files: ["js/**/*.js"],
    ignores: ["js/worklets/**"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: globals.browser },
    rules: { "no-empty": ["error", { allowEmptyCatch: true }], "no-shadow": "error" },
  },
  {
    files: ["js/worklets/**/*.js"],
    rules: { "no-shadow": "error" },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { AudioWorkletProcessor: "readonly", registerProcessor: "readonly", sampleRate: "readonly", currentFrame: "readonly", currentTime: "readonly" },
    },
  },
  {
    files: ["tests/**/*.js", "*.config.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node, ...globals.browser } },
  },
];
