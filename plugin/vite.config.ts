import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gui } from "@opencode/plugin/gui/vite";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [
    gui({
      entry: "gui.tsx",
      outFile: "dist/gui-experimental.cjs",
    }),
  ],
});