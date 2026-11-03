# Wandika beta: downloads for Mac, Android and iPhone

Date: 2026-11-03. Decided by Jordan: public beta downloads on jordanjakisa.me/wandika for Mac and
Android, and a public TestFlight link for iPhone. Public builds leave Gmail out.

## Open risks (stated before work started)

- **Demand is not measured.** Validation said Stop as a store product. This is a free beta and a
  portfolio piece, not a measured launch.
- **Google.** Public users sign in to the project's Google app. Until Google verifies it they see an
  "unverified app" screen and the project has a lifetime cap of 100 users. Verification for Calendar
  and Tasks (sensitive scopes) is free but needs a home page and privacy policy on a domain Jordan
  owns (jordanjakisa.me, verified in Search Console), plus a short demo video.
- **TestFlight.** External testers need Beta App Review, so the review-readiness gate
  (docs/store/review-readiness.md) must be all yes first. It puts the app in front of App Review on
  Jordan's account.
- **Money.** Jordan's default for every mobile app is a hard paywall. Jordan decided Wandika is free
  for good (2026-11-03): no paywall, subscription or in-app purchase, now or later, and nothing to
  do with payments (no donation links) unless he says otherwise.

## Done in the repo

- `WANDIKA_PUBLIC=1` builds ask Google for Calendar and Tasks only; no Gmail anywhere.
- The app says it is a beta (start screen, Settings, About) and takes feedback by email.
- `scripts/release-mac.sh`: Developer ID signed, notarized, stapled .dmg.
- `scripts/release-android.sh`: signed release APK.
- The MCP server is compiled into the Mac app only.

## Jordan's steps, in order (one at a time)

1. **Mac certificate.** Done 2026-11-03: "Developer ID Application" is in the keychain.
2. **Android release key.** Done 2026-11-03: `~/keys/wandika/` (RSA 4096, SHA-256 F1:85:CD:0C:...:85:C7).
   Jordan to back the folder up in two places.
3. **iPhone.** An App Store Connect app record (console, Jordan's yes), then Xcode Archive and
   Upload with the Apple Account Xcode already has, then the review-readiness checklist and an
   external TestFlight group.
4. **Mac notarizing.** An App Store Connect team API key (no Apple Account password; Tauri's and
   Apple's docs, and real Tauri apps such as Jan, use it). Waits until Jordan is ready.
5. **Where downloads live.** GitHub Releases on jordan-jakisa/wandika (public), linked from the site.

Then Claude runs the two release scripts, uploads the iPhone build, and the site gets its download
section (one page a day still applies to new pages).
