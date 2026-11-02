# Wandika

Markdown notes for Mac, iPhone and Android, kept in a GitHub repository you choose.

- Notes are plain `.md` files in an Obsidian-compatible vault.
- Keep a vault on one device with no account, or in any folder on the Mac (an Obsidian vault, a
  local git repository). Connect it to a GitHub repository later, or disconnect it, from Settings.
- Sign in with GitHub, pick a repository, and every device syncs through it.
- Kanban boards in the Obsidian Kanban format, with tags and links between cards and notes.
- A graph of notes and links, for the whole vault or around one note.
- Tables and Mermaid diagrams in notes, drawn by [Pele](https://github.com/obsidianmd/pele).
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
