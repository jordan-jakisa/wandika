# Review readiness: Wandika (TestFlight external beta)

Fill in before the first TestFlight external submission, after reading the current App Store Review
Guidelines twice. Anything not a clear yes blocks the submission.

| Check | Yes/No | Evidence |
|---|---|---|
| Built with WANDIKA_PUBLIC=1 (no Gmail scope) | No | not built yet |
| Works without any account (a vault on this device) | Yes | Start screen: Keep notes on this device |
| Reviewer can reach every feature (GitHub sync needs an account: demo account or note) | No | open |
| Privacy policy link live and matches the app | Yes | github.com/jordan-jakisa/wandika/blob/main/PRIVACY.md |
| Privacy label: no data collected (no server; tokens stay on device) | No | to set in App Store Connect |
| Export compliance answered (age encryption, TLS) | No | open |
| 4.8 Sign in with Apple: exempt as a client of the user's own GitHub, Google, Outlook accounts | No | confirm against current text |
| 2.5.19 no hidden features: MCP server is Mac only, not in the iPhone binary | Yes | `#[cfg(desktop)]` in src-tauri/src/lib.rs |
| No debug code or test menus in the release build | No | check the archive |
| Notes for Review describe every feature and the beta | No | draft |
| Storefronts: only where the app has an audience; China mainland off; EU off until DSA trader declaration | No | Pricing and Availability |
| Beta labelled in the app | Yes | Start screen and About |
