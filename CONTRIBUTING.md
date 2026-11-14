# Contributing to Wandika

Thanks for helping. Wandika is open source under the
[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Keep the promises in [PRIVACY.md](PRIVACY.md): no Wandika server, no analytics, no tracking.
- Notes stay plain files that Obsidian can open. Don't add a format only Wandika understands.

## Making a change

```bash
cp .env.example .env   # client IDs: docs/setup.md
npm install
npm run tauri dev
```

The interface also runs in a browser with a demo vault: `npm run dev`, then open
`http://localhost:1420/?mock=vault`.

Before you open a pull request, run the checks:

```bash
npm run check                       # types
npm test                            # interface tests (Vitest)
cd src-tauri && cargo test --lib    # Rust tests
```

Add or update tests for what you change.

## Licensing your contribution

By opening a pull request you agree that:

1. your contribution is your own work, or you have the right to submit it; and
2. it is licensed under the AGPL-3.0-only, and you also give Jordan Mungujakisa permission to
   distribute it as part of Wandika under other terms, for example in the builds published on
   the App Store and Google Play.

Point 2 is what lets the store builds include outside contributions, since app store terms don't
fit the AGPL. Your contribution always stays available under the AGPL too.
