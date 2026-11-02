// Writes the git-ignored iPhone build config from .env: the Apple team that signs the app, and the
// Google sign-in URL scheme. (Google refuses custom-scheme redirects for Android clients.)
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
const config = {};
const team = env.WANDIKA_APPLE_TEAM;
if (team) config.bundle = { iOS: { developmentTeam: team } };
else console.warn("WANDIKA_APPLE_TEAM is empty in .env; Xcode will ask for a team when signing.");
const id = env.WANDIKA_GOOGLE_IOS_CLIENT_ID;
if (id) {
  const scheme = `com.googleusercontent.apps.${id.replace(/\.apps\.googleusercontent\.com$/, "")}`;
  config.plugins = { "deep-link": { mobile: [{ scheme: [scheme], appLink: false }] } };
  console.log(`Google redirect scheme set to ${scheme}`);
} else {
  console.warn("WANDIKA_GOOGLE_IOS_CLIENT_ID is empty in .env; Google won't connect on the iPhone.");
}
for (const platform of ["ios"]) {
  writeFileSync(
    new URL(`../src-tauri/tauri.${platform}.conf.json`, import.meta.url),
    JSON.stringify(config, null, 2) + "\n",
  );
}
console.log("Wrote src-tauri/tauri.ios.conf.json");
