import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// `@shared` resolves to the repo-root shared/ directory imported by both apps.
// `dedupe` forces react/react-dom to resolve from this app's node_modules even
// for those out-of-root shared files, and `fs.allow` lets the dev server read them.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("../shared", import.meta.url)) },
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 5174,
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
  },
});
