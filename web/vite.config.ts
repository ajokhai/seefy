import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    rollupOptions: {
      input: { main: resolve(__dirname, "index.html"), print: resolve(__dirname, "print.html") },
    },
  },
});
