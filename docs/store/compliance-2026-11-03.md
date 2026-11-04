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
| 2.3.1(a) Notes for Review describe every feature; 2.1 demo account info for logins. | To write; reviewer needs test GitHub (and Outlook) accounts with sample notes. Must cover voice notes (in a note, New voice note, the Voice note control and Live Activity), Export as PDF and task filters. | Open |
| Export compliance. | Uses standard encryption not provided by iOS (age, OpenSSL TLS). Apple's table: "an industry standard algorithm, not provided within the Apple operating system" needs only the French declaration, "only required if you're distributing your app on the App Store in France" (France stays off). Answered on build 1 (3 Nov 2026): standard algorithms in addition to iOS, not in France; App Store Connect then said the build counts as exempt and the key can go in Info.plist, so ITSAppUsesNonExemptEncryption is NO from build 2. Revisit if the crypto or the storefronts change. | Yes |
| App Privacy label: "collect" means transmitting data off the device so that "you and/or your third-party partners" can access it. | No server, no analytics, no SDKs. "Data Not Collected" is defensible. | Open (Jordan, in ASC) |
| Developer ID and notarization (Mac): "Notarization of macOS software is not App Review." | Hardened runtime, secure timestamp, Developer ID certificate. | Open (certificate) |
| App record (ASC Help, Add a new app): "You can't add an app to your account until the Account Holder signs the latest agreement". | Program License Agreement LYL262 (issued 29 Oct 2026) read by Claude: the only addition since 14 Oct is Attachment 15 (26% commission on paid apps in the Taiwan storefront). Accepted on Jordan's yes, 3 Nov 2026. | Yes |
| App record fields: SKU can't change once added; bundle ID locks at the first build upload; name editable until App Review; 30 characters, no brands, prices or keywords (2.3.7, 4.1(c)). | iOS only, name "Wandika", SKU "wandika", bundle ID me.jordanjakisa.wandika (explicit App ID registered 2026-11-03, no capabilities beyond Apple's default In-App Purchase), English (U.S.), Full Access. | Yes |
| 2.5.14 "explicit user consent and … a clear visual and/or audible indication when recording … This includes any use of the … microphone". | The system asks before the mic and speech recognition are used. While listening, the voice sheet shows a red mic and "Listening, 0:12"; from the Lock Screen, the Live Activity shows the timer and Stop, and iOS shows its own mic indicator. (Checked 2026-11-04 against the guidelines of 16 Oct 2026.) | Yes |
| 2.5.4 "background services for their intended purposes". | The `audio` background mode is used only while a voice note started from the Lock Screen records (an audio recording intent, which iOS requires to keep a Live Activity running). Nothing runs in the background otherwise. | Yes |
| 5.1.1(ii) "Ensure your purpose strings clearly and completely describe your use of the data." | Microphone: "Wandika listens while you make a voice note and turns your words into text." Speech: "Wandika turns your voice notes into text on this device. Your audio never leaves it." Only on-device recognition is used, so the second sentence holds. PRIVACY.md says the same. | Yes |
| 2.5.16 "Widgets, extensions, and notifications should be related to the content and functionality of your app." | The only extension is the Voice note control and its Live Activity. | Yes |
| App Privacy label after voice notes. | Audio is processed on the device and never leaves it, so it isn't "collected"; "Data Not Collected" still holds. | Yes (label itself: Jordan, in ASC) |
| New App ID for the widget extension (me.jordanjakisa.wandika.widgets). | Automatic signing registers it at the next upload; that is a developer-account change, so it waits for Jordan's yes. iOS minimum is now 18.0 (every iPhone that runs 17 runs 18). | Open (Jordan's yes) |
| TestFlight: internal testers (up to 100, team roles) need no review; builds last 90 days; external testers need TestFlight App Review, a Beta App Description and test information. | Internal first. External only after the review-readiness checklist is a yes. | Yes for internal |

## US export rules for encryption (15 CFR, current to 2026-10-30)

| Rule | Wandika | Status |
|---|---|---|
| 742.15(b)(1): "publicly available ... encryption source code classified under ECCN 5D002 is not subject to the EAR". Since 2021, notifying BIS and NSA is needed only for "non-standard cryptography". | age (X25519, ChaCha20-Poly1305, scrypt) and TLS are published standards; the source is public on GitHub. | Yes |
| 734.3 note: "Publicly available encryption object code 'software' classified under ECCN 5D002 is not subject to the EAR when the corresponding source code meets the criteria specified in § 742.15(b)." | Released binaries are built only from pushed code (the release scripts refuse anything else). | Yes |
| Apple's agreement 5.3: no uploads for notarization of apps needing export authorization. | Not subject to the EAR, so notarization is fine. | Yes |
| Sanctions: Uganda is only in EAR Country Group B; OFAC has no Uganda program. | Jordan keeps the agreement's 14.8 statement true. | Yes |

Note: a BIS guidance page still mentions an email notification and a self-classification report;
it predates the 2021 rule (86 FR 16482), and the regulation governs. A one-time email to
crypt@bis.doc.gov and enc@nsa.gov with the repository link is optional.

## Apple Developer Program License Agreement (Developer ID, Mac)

| Rule | Wandika | Status |
|---|---|---|
| Mac apps "can additionally be separately distributed"; iPhone apps only through the App Store, TestFlight or Ad Hoc. | Mac .dmg from the website; iPhone through TestFlight only. | Yes |
| 5.1: keep the signing keys safe; never sign a third party's app. | The certificate lives only in Jordan's keychain; forks and contributors' builds are never signed. | Yes |
| 5.3: don't say Apple checked, reviewed or approved the app. | Release notes and the site never say "Apple-approved" or "verified by Apple". | Yes |

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
