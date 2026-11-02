# Wandika design

Wandika (Luganda, "write") is Jordan's personal notes app. One sentence of purpose: Jordan writes and
finds notes on his Mac, iPhone and Android phone, from one GitHub repo, with his day (meetings, mail,
tasks) beside the note he is writing.

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

Papyrus green comes from the papyrus swamps around Lake Victoria; it is the only accent. No gradients.

## Type

- **Literata** (variable, bundled): note text, note titles. Built for long reading on screens.
- **System UI** (SF Pro, Roboto): everything else. Sentence case, no all-caps labels.
- Monospace (system `ui-monospace`) only inside code spans and code blocks.

Scale (note text 17px base on phones, 18px on Mac, ratio 1.25):
`h1 2.0em/1.2 600`, `h2 1.5em/1.25 600`, `h3 1.25em/1.3 600`, body `1em/1.65 400`, small UI `14px/1.4`.
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

Phone (< 900px)                      Note open
┌────────────────────┐               ┌────────────────────┐
│ jordan/notes   ⟳ ✎ │               │ ‹ Notes        ⋯   │
│ list of notes      │               │ Title              │
│                    │               │ Body               │
├────────────────────┤               │                    │
│ Notes Today Tasks ⌕│               └────────────────────┘
└────────────────────┘
```

Left aligned throughout. The one memorable element is the page itself: Literata at a generous size on
a quiet sheet. Everything else is restrained.

## Motion

Only motion that answers an action: sheet slide-in on phones (200ms, ease-out), panel collapse.
`prefers-reduced-motion` turns both off.
