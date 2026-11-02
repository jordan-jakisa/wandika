# Wandika design

Wandika (Luganda, "write") is Jordan's personal notes app. One sentence of purpose: Jordan writes and
finds notes on his Mac, iPhone and Android phone, from one GitHub repo, with his day (meetings, mail,
tasks) beside the note he is writing.

## Mark

A single-stroke geometric lowercase w, off-white (`#FBFBF9`) on papyrus green (`#2E6A4E`), round
caps and joins. No nib, no nodes, no page: minimal and modern (Jordan, 2026-11-02). Sources are in
`src-tauri/icons/source/`: `mark.svg` full-bleed (iPhone, Android, Windows; regenerate with
`npx tauri icon`), `mark-macos.svg` inside Apple's 824 px rounded square (copy its `icon.icns`
and the 32/128 px PNGs over the generated ones), `favicon.svg`. In the app, `Mark.svelte` draws it in
the current accent colour. The wordmark is "Wandika" in the system sans, 650 weight, -0.03em
tracking, beside the mark.

## Principles

- **The note is the screen.** Chrome stays quiet; the page of text gets the space and the type.
- **Plain files, no lock-in.** Every note is a `.md` file an Obsidian vault would open. Encrypted notes
  are standard `age` files.
- **Sync is invisible until it needs you.** One quiet line says where the vault stands; only a conflict
  asks for attention.
- **Native first.** System font for interface text, platform gestures, 44pt touch targets, safe areas.

## Color

| Token        | Light     | Dark      | Use                                  |
| ------------ | --------- | --------- | ------------------------------------ |
| `--paper`    | `#F2F3EF` | `#151917` | App background, the page             |
| `--sheet`    | `#FBFBF9` | `#1C211E` | Editor surface, sheets, inputs       |
| `--ink`      | `#1C2320` | `#E3E7E2` | Body text                            |
| `--graphite` | `#59635E` | `#9AA49E` | Secondary text, icons                |
| `--rule`     | `#D6DAD4` | `#2C332F` | Separators, input borders            |
| `--papyrus`  | `#2E6A4E` | `#7FC19C` | Links, wikilinks, primary action     |
| `--amber`    | `#9A5F0E` | `#E0A94F` | Offline, waiting, due today          |
| `--alarm`    | `#B03C2C` | `#F08A78` | Conflicts, errors, destructive       |

Papyrus green comes from the papyrus swamps around Lake Victoria; it is the default and only accent
on screen at a time. No gradients. Settings → Appearance lets each device pick Lake, Indigo, Plum,
Rose or Graphite instead, a theme (system, light, dark), the note font (serif, sans, mono), text
size and line width; vault CSS snippets in `.obsidian/snippets` override anything.

## Type

- **Literata** (variable, bundled): note text, note titles. Built for long reading on screens.
- **System UI** (SF Pro, Roboto): everything else. Sentence case, no all-caps labels.
- Monospace (system `ui-monospace`) only inside code spans and code blocks.

Scale (note text 17px base on phones, 18px on Mac, ratio 1.25):
`h1 2.0em/1.2 600`, `h2 1.5em/1.25 600`, `h3 1.25em/1.3 600`, body `1em/1.65 400`, small UI `13px/1.4`. Every size is multiplied by `--text-scale` (iOS Dynamic Type).
Editor measure: `max-width: 68ch`.

## Layout

```
Mac (≥ 900px)
┌──────────────┬────────────────────────────────┬──────────────┐
│ jordan/notes │  Title (Literata 2em)          │ Today        │
│ Synced 2m    │                                │  09:00 Stand │
│ ⌕  +         │  Body text at 68ch             │  Tasks       │
│ ▸ Daily      │                                │  Inbox       │
│ ▸ Projects   │                                │              │
│   Note.md    │  Linked from: …                │              │
└──────────────┴────────────────────────────────┴──────────────┘

Phone (< 900px), same on iPhone and Android     Note open, typing
┌────────────────────┐               ┌────────────────────┐
│ notes            ⋯ │               │ ‹ Notes        ⋯   │
│ Synced 2m          │               │ Title              │
│ list of notes      │               │ Body               │
├────────────────────┤               ├────────────────────┤
│ Notes Today ⌕   [+]│               │ 🔗 # ☐ H • ⇥ ↶   ⌨ │  writing toolbar
└────────────────────┘               └────────────────────┘
```

Phones share one calm design: a bar with three places and the new-note button (on iOS a floating
Liquid Glass capsule with the button as tinted glass beside it, Jordan's ask; flat on Android), a single ⋯ menu
for everything else (Graph, Projects, New folder, Sync, Settings), Tasks reached from Today, plain
"‹ Notes" back rows, and Settings as one bottom sheet. The platform decides behaviour only (iOS edge
swipe back, Android system back, safe areas). Text follows the phone's text size setting.

Left aligned throughout. The one memorable element is the page itself: Literata at a generous size on
a quiet sheet. Everything else is restrained.

## Motion

Only motion that answers an action: sheet slide-in on phones (200ms, ease-out), panel collapse.
`prefers-reduced-motion` turns both off.
