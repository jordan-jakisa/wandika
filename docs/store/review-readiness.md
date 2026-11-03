# Review readiness: Wandika (TestFlight external beta)

Fill in before the first TestFlight external submission, after reading the current App Store Review
Guidelines twice. Anything not a clear yes blocks the submission.

| Check | Yes/No | Evidence |
|---|---|---|
| Built with WANDIKA_PUBLIC=1 (no Gmail scope) | No | not built yet |
| Works without any account (a vault on this device) | Yes | Start screen: Keep notes on this device |
| Reviewer can reach every feature (GitHub sync needs an account: demo account or note) | No | open |
| Privacy policy link live and matches the app | Yes | PRIVACY.md (3 Nov 2026), linked in Settings, About |
| Privacy label: no data collected (no server; tokens stay on device) | No | to set in App Store Connect |
| Export compliance answered (age encryption, TLS) | No | open |
| 4.8 Sign in with Apple: not needed, Wandika has no account of its own | Yes | 4.8 covers "the account they establish with your app"; docs/store/compliance-2026-11-03.md |
| 2.2 beta only on TestFlight, nothing given in return for testing | Yes | no payments of any kind |
| 2.5.2 notes can't run code | Yes | escaped HTML; src/lib/editor/diagrams.safety.test.ts |
| Google not offered until Google has reviewed the app | Yes | WANDIKA_GOOGLE_REVIEWED, src-tauri/src/config.rs |
| 2.5.19 no hidden features: MCP server is Mac only, not in the iPhone binary | Yes | `#[cfg(desktop)]` in src-tauri/src/lib.rs |
| No debug code or test menus in the release build | No | check the archive |
| Notes for Review describe every feature and the beta | No | draft |
| Storefronts: only where the app has an audience; China mainland off; EU off until DSA trader declaration | No | Pricing and Availability |
| Beta labelled in the app | Yes | Start screen and About |
