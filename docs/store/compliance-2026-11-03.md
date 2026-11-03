# Wandika compliance check

Checked 2026-11-03 against the current primary sources. The key quotes below were re-read on the
source pages by Claude after the research. Anything not a clear yes blocks the release it applies to.

Releases: Mac (Developer ID .dmg from the website), Android (signed APK from the website), iPhone
(public TestFlight). Free, no payments of any kind (Jordan, 2026-11-03).

## Apple (App Store Review Guidelines, last updated 16 Oct 2026)

| Rule | Wandika | Status |
|---|---|---|
| 2.2 "Demos, betas, and trial versions of your app don't belong on the App Store – use TestFlight instead." TestFlight builds "cannot be distributed to testers in exchange for compensation of any kind". | Beta on TestFlight only; nothing offered for the beta. The "beta" label must come off before any App Store release. | Yes for TestFlight |
| 4.8 applies to the login for "the account they establish with your app". | Wandika has no account. GitHub, Google and Outlook sign-ins reach the user's own data. Sign in with Apple isn't needed. | Yes |
| 5.1.1(i) privacy policy "within the app" and in App Store Connect. | Settings, About, Privacy policy (added). App Store Connect field: Jordan. | Yes in app; ASC open |
| 5.1.1(v) account deletion "If your app supports account creation". Revoke social credentials "from within the app". | No account. Disconnect and Sign out delete the stored token. | Yes |
| 5.1.2 disclose sharing with third parties. | PRIVACY.md names GitHub, Google, Microsoft, Claude Code (Mac). | Yes |
| 2.5.2 no downloaded code. | Notes are data. Rendered notes can't run script: HTML is escaped, and diagrams are tested (diagrams.safety.test.ts). | Yes |
| 2.5.19 no hidden or dormant features. | No remote flags. The MCP server is compiled into the Mac app only. Public builds have no Gmail code path offered. | Yes |
| 2.3.1(a) Notes for Review describe every feature; 2.1 demo account info for logins. | To write; reviewer needs test GitHub (and Outlook) accounts with sample notes. | Open |
| Export compliance. | Uses standard encryption not provided by iOS (age, OpenSSL TLS). Answer in App Store Connect; the French declaration applies only if France is on (it stays off under Jordan's EU rule). BIS self-classification duty not verified. | Open (Jordan) |
| App Privacy label: "collect" means transmitting data off the device so that "you and/or your third-party partners" can access it. | No server, no analytics, no SDKs. "Data Not Collected" is defensible. | Open (Jordan, in ASC) |
| Developer ID and notarization (Mac): "Notarization of macOS software is not App Review." | Hardened runtime, secure timestamp, Developer ID certificate. | Open (certificate) |

## Google (OAuth policies; API Services User Data Policy)

| Rule | Wandika | Status |
|---|---|---|
| Sensitive or restricted scopes "can't be used in production apps without review". A production app "isn't for personal use", which means "fewer than 100 people (all of whom are known personally to you)". | A public beta is production. Public builds now offer Google only after review (WANDIKA_GOOGLE_REVIEWED). | Yes (Google off until reviewed) |
| "You must create separate projects in the Google Cloud Console for each deployment tier". | The existing project (with Gmail) stays Jordan's personal one. A new production project with Calendar and Tasks only is needed for review. | Open (Jordan, console) |
| Verification needs a home page "hosted on a verified domain you own" and a privacy policy on that domain, a demo video, and scope justification. | jordanjakisa.me pages (site PR #68: 2026-11-11 and 2026-11-12), Search Console verification, video. `tasks` (not read-only) because the app ticks tasks done. | Open |
| Limited Use statement. | PRIVACY.md: "will adhere to the Google API Services User Data Policy, including the Limited Use requirements". | Yes |
| Never commit client credentials to public repositories. | The desktop client secret is read from .env at build time; not in git history. | Yes |

## Microsoft (Microsoft APIs Terms of Use)

| Rule | Wandika | Status |
|---|---|---|
| Privacy statement links https://account.live.com/consent/Manage and/or https://myapps.microsoft.com for revoking consent. | Both in PRIVACY.md. | Yes |
| Publisher verification: without it, users in many organisations can't consent to new multitenant apps. | Personal Outlook accounts work. Work accounts may be blocked; verification needs a Partner Program account and an Entra work account. Say so in the beta notes. | Known limit |

## GitHub (REST API guidance, Terms of Service)

| Rule | Wandika | Status |
|---|---|---|
| At most 80 content-creating requests a minute and 500 an hour; writes serial and a second apart. | 70 a minute, 450 an hour, one at a time, a second apart (github.rs, tested). | Yes |
| Files under 100 MiB; repositories ideally under 1 GB. | Files over 50 MB stay local; pushes in parts under 100 MB. | Yes |
| Release assets under 2 GiB each. | The .dmg and APK are far smaller. | Yes |

## Google Play and Android

| Rule | Wandika | Status |
|---|---|---|
| Developer verification: sideloaded apps "won't apply to your app yet"; global enforcement "in 2027". | Register the package name and release key in Play Console before 2027. Back up the key. | Open (Jordan, before 2027) |
| Play apps had to be registered "by September 30, 2026 to avoid global removal from Google Play" (99% were automatic). | Concerns Jordan's existing Play apps, not Wandika. | Check Play Console Home now |
| Target API 36 or higher for new apps and updates. | targetSdk 37. | Yes |
| Website downloads: users opt in under "Install unknown apps"; Play Protect may warn about an unknown app. | Say both on the download page; publish the signing certificate's SHA-256. | Open (site) |

## Sources

- https://developer.apple.com/app-store/review/guidelines/
- https://developer.apple.com/app-store/app-privacy-details/
- https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations
- https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- https://developers.google.com/identity/protocols/oauth2/policies
- https://support.google.com/cloud/answer/13464321 and https://support.google.com/cloud/answer/15549945
- https://developers.google.com/terms/api-services-user-data-policy
- https://learn.microsoft.com/en-us/legal/microsoft-apis/terms-of-use
- https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview
- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
- https://developer.android.com/developer-verification/guides/faq
- https://android-developers.googleblog.com/2026/06/android-developer-verification.html
- https://support.google.com/googleplay/android-developer/answer/11926878
- https://developer.android.com/distribute/marketing-tools/alternative-distribution
