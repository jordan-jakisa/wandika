# Wandika

Markdown notes for Mac, iPhone and Android, kept in a GitHub repository you choose.

- Notes are plain `.md` files in an Obsidian-compatible vault.
- Sign in with GitHub, pick a repository, and every device syncs through it.
- Encrypt any note or folder; encrypted notes are standard [age](https://age-encryption.org) files.
- Today's calendar, inbox and tasks sit beside your notes (Google, Outlook, Apple Calendar and
  Reminders, Google Tasks, and `- [ ]` tasks in the vault).

Built with Tauri 2: a Rust core for sync, search and encryption, and a Svelte interface with a
CodeMirror 6 editor.

## Develop

```bash
cp .env.example .env   # add OAuth client IDs: docs/setup.md
npm install
npm run tauri dev
```
