# Setting up Wandika

A vault needs no account: on the start screen, create one on this device or, on the Mac, open any
folder. Everything below is only for the services you choose to connect.

Wandika needs one OAuth client per service you connect. Client IDs go in `.env` (copy
`.env.example`); they are read when the app is built. `.env` is git-ignored.

Checked against the providers' docs on 2 November 2026.

## 1. GitHub sync (optional)

1. GitHub → profile picture → **Settings** → **Developer settings** → **OAuth apps** →
   **New OAuth App**.
2. Application name `Wandika`, Homepage URL `https://github.com/jordan-jakisa/wandika`,
   Authorization callback URL `https://github.com/jordan-jakisa/wandika` (device flow doesn't use it,
   but the form asks for one).
3. Tick **Enable Device Flow**. If the form shows **Expire user access tokens**, untick it: renewing
   an expired token needs the client secret, which an app on a phone can't keep. Then click
   **Register application**.
4. Copy the **Client ID** into `WANDIKA_GITHUB_CLIENT_ID`. Do not create a client secret.

Wandika asks for the `repo` scope, which covers private repositories. It reaches only the repository
you pick, but the token itself can read any repository your account can.

## 2. Google: Gmail, Calendar and Tasks (Mac and iPhone)

1. Google Cloud console → new project `Wandika` → enable **Gmail API**, **Google Calendar API**,
   **Google Tasks API**.
2. Google Auth Platform → Branding and Audience: external app, your address as the contact.
   Add scopes `gmail.readonly`, `calendar.readonly` and `tasks`.
3. Set the publishing status to **In production**. In **Testing**, Google expires sign-ins after
   seven days. In production without verification, Google shows you an "unverified app" warning on
   sign-in; continue past it on your own account. Gmail read access is a restricted scope, so this
   stays a personal app (Google caps unverified apps at 100 users).
4. Clients → **Create client**:
   - **Desktop app** → copy the ID and secret into `WANDIKA_GOOGLE_DESKTOP_CLIENT_ID` and
     `WANDIKA_GOOGLE_DESKTOP_CLIENT_SECRET` (Google treats a desktop secret as public; PKCE protects
     the sign-in).
   - **iOS**, bundle ID `me.jordanjakisa.wandika` → copy the ID into `WANDIKA_GOOGLE_IOS_CLIENT_ID`,
     then run `node scripts/configure-mobile.mjs` to register its URL scheme.

Google no longer accepts custom-scheme redirects from Android clients, so Google stays off on Android
for now. Outlook connects on every platform.

## 3. Outlook mail and calendar (all platforms)

1. Microsoft Entra admin center → **App registrations** → **New registration**.
2. Name `Wandika`; supported account types: **Any Entra ID Tenant + Personal Microsoft accounts**;
   no redirect URI.
3. **Authentication** → **Allow public client flows** → **Yes** (needed for the device-code
   sign-in; this label is from the portal, not from the docs page).
4. **API permissions** → Microsoft Graph, delegated: `User.Read`, `Mail.Read`, `Calendars.Read`,
   `offline_access`.
5. Copy the **Application (client) ID** into `WANDIKA_MICROSOFT_CLIENT_ID`.

## 4. Apple Calendar and Reminders (Mac and iPhone)

Nothing to register. Wandika asks for access the first time you connect them in Settings.

## 5. Claude Code (Mac)

Wandika's app binary is also an MCP server. Register it once:

```bash
claude mcp add --scope user wandika -- /Applications/Wandika.app/Contents/MacOS/wandika mcp
```

Claude can then search, read, write and create notes, open today's note, and list, add, tick and edit
tasks in the vault open in Wandika. Encrypted notes stay locked; mail and calendars aren't offered. A
running Wandika reloads what Claude changed within a few seconds, and sync takes it to GitHub.

## Releases (public beta)

Public builds are made with `WANDIKA_PUBLIC=1` (no Gmail; Google only after Google's review) and
only from code that is pushed to GitHub. Compliance: docs/store/compliance-2026-11-03.md.

**Android (signed APK).** The release key lives outside the repo in `~/keys/wandika/`, like the
other projects' keys: `wandika-release.jks`, `signing.properties` (its passwords) and a README with
the certificate fingerprint. `src-tauri/gen/android/keystore.properties` is a git-ignored link to
that `signing.properties`. Back up the folder in two places: a lost key means existing installs
can't be updated. Build with `scripts/release-android.sh`.

**Mac (notarized .dmg).** Once:
1. Xcode, Settings, Accounts, Manage Certificates, +, Developer ID Application.
2. App Store Connect, Users and Access, Integrations, App Store Connect API: Request Access the
   first time (Account Holder), then Team Keys, Generate, role Developer. Download the key (it
   downloads only once) to `~/.appstoreconnect/private_keys/` and `chmod 600` it.
3. Add `WANDIKA_APPLE_API_KEY_ID` and `WANDIKA_APPLE_API_ISSUER` (both shown on that page) to `.env`.

Build with `scripts/release-mac.sh`. No Apple Account password is used.

**iPhone (TestFlight).** Raise `bundle > iOS > bundleVersion` in `src-tauri/tauri.conf.json` for
every upload. Run `WANDIKA_PUBLIC=1 npm run tauri ios build -- --open`, then in Xcode: Product,
Archive (Any iOS Device), then Organizer, Distribute App, App Store Connect, Upload. Xcode uses the
Apple Account it is already signed in with.

## Build and run

```bash
npm install
npm run tauri dev            # Mac
scripts/install-mac.sh       # Mac: signed build in /Applications (the keychain asks only once)
npm run tauri ios init       # once, then: npm run tauri ios dev
npm run tauri android init   # once, then: npm run tauri android dev
```

Sync uses libgit2. On iPhone and Android its HTTPS needs OpenSSL, which is built from source.
For Android, point OpenSSL's build at the NDK's archive tools before building:

```bash
T="$NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64/bin"
export RANLIB_aarch64_linux_android="$T/llvm-ranlib" AR_aarch64_linux_android="$T/llvm-ar"
npm run tauri android build -- --debug --apk --target aarch64
```

Checks: `npm run check`, `npm test` (Vitest: unit and component tests in jsdom), and `cargo test` in `src-tauri`.

The interface also runs in a plain browser with a stand-in backend, for design work:
`npm run dev`, then open `http://localhost:1420/?mock=vault`.

## Encryption

Settings → Encryption → choose a passphrase. Encrypt a note or folder from its menu. Encrypted notes
are ASCII-armored [age](https://age-encryption.org) files. To read one without Wandika, take the
`identity` value from `.wandika/encryption.json` in the repository, decrypt it with
`age -d` and your passphrase to get the key, then run `age -d -i key.txt note.md.age`.
