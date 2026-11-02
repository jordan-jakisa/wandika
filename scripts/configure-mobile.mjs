// Registers the Google sign-in URL scheme for the iPhone and Android builds.
// Google redirects to the reversed iOS client ID, so the scheme depends on .env:
//   node scripts/configure-mobile.mjs
import { readFileSync, writeFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const id = env.WANDIKA_GOOGLE_IOS_CLIENT_ID;
if (!id) {
  console.error("WANDIKA_GOOGLE_IOS_CLIENT_ID is empty in .env; Google won't connect on phones.");
  process.exit(1);
}
const scheme = `com.googleusercontent.apps.${id.replace(/\.apps\.googleusercontent\.com$/, "")}`;
const config = { plugins: { "deep-link": { mobile: [{ scheme: [scheme], appLink: false }] } } };
for (const platform of ["ios", "android"]) {
  writeFileSync(
    new URL(`../src-tauri/tauri.${platform}.conf.json`, import.meta.url),
    JSON.stringify(config, null, 2) + "\n",
  );
}
console.log(`Google redirect scheme set to ${scheme}`);
