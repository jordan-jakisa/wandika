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
- **Money.** Jordan's default for every mobile app is a hard paywall. The beta is free; Jordan to
  confirm that, and log it in docs/backlog.md as a decision.

## Done in the repo

- `WANDIKA_PUBLIC=1` builds ask Google for Calendar and Tasks only; no Gmail anywhere.
- The app says it is a beta (start screen, Settings, About) and takes feedback by email.
- `scripts/release-mac.sh`: Developer ID signed, notarized, stapled .dmg.
- `scripts/release-android.sh`: signed release APK.
- The MCP server is compiled into the Mac app only.

## Jordan's steps, in order (one at a time)

1. **Mac certificate.** Xcode, Settings, Accounts, Manage Certificates, +, Developer ID Application.
   Only the account holder can create it.
2. **Notary credentials.** An app-specific password for the Apple ID (appleid.apple.com), then in
   Terminal: `xcrun notarytool store-credentials wandika-notary --apple-id <id> --team-id <team>`.
3. **Android release key.** In Terminal (keep the file and passwords safe, a lost key can't update
   the app): `keytool -genkey -v -keystore ~/wandika-release.jks -keyalg RSA -keysize 2048 -validity
   10000 -alias wandika`, then `src-tauri/gen/android/keystore.properties` with storeFile,
   storePassword, keyAlias and keyPassword.
4. **App Store Connect.** A new app record for bundle ID me.jordanjakisa.wandika, then the
   review-readiness checklist, then TestFlight external testing with a public link.
5. **Where downloads live.** GitHub Releases on jordan-jakisa/wandika (public), linked from the site.

Then Claude runs the two release scripts, uploads the iPhone build, and the site gets its download
section (one page a day still applies to new pages).
