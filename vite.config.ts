import { defineConfig } from "vite-plus";

export default defineConfig({
    fmt: {
        printWidth: 120,
        // Compiled from main.scss.
        ignorePatterns: ["public/demo-kuma/main.css"],
    },
    pack: {
        entry: ["server.ts"],
        format: "esm",
        platform: "node",
        outDir: "dist",
        // One self-contained file: the runtime image ships no node_modules.
        deps: { alwaysBundle: [/./] },
    },
    lint: {
        jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
        options: { typeAware: true, typeCheck: true },
        rules: {
            "vite-plus/prefer-vite-plus-imports": "error",
            yoda: "error",
            curly: "error",
            "no-var": "error",
            "no-unneeded-ternary": "error",
            "no-empty": ["error", { allowEmptyCatch: true }],
            "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
            "no-constant-condition": ["error", { checkLoops: false }],
        },
    },
});
