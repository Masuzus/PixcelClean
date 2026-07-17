import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        oklab: "oklab.html",
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
