// Tauri doesn't have a Node.js server to do proper SSR
// so we use adapter-static with a fallback to index.html to put the site in SPA mode
// See: https://svelte.dev/docs/kit/single-page-apps
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      fallback: "index.html",
    }),
    // The web demo on jordanjakisa.me lives under a path (`npm run build:demo`); the app itself
    // loads from the root, with relative asset paths as before.
    paths: process.env.WANDIKA_BASE
      ? { base: process.env.WANDIKA_BASE, relative: false }
      : {},
  },
};

export default config;
