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
│ Notes Today ⌕ ⚙ [+]│               │ 🔗 # ☐ H • ⇥ ↶   ⌨ │  writing toolbar
└────────────────────┘               └────────────────────┘
```

Phones share one calm layout: a bar with four places (Notes, Today, Search, Settings) and the
new-note button (on iOS a floating Liquid Glass capsule with the button as tinted glass beside it,
Jordan's ask; flat on Android), New folder as a button in the Notes header, a ⋯ menu for Graph,
Projects and Sync, Tasks reached from Today, and plain "‹ Notes" back rows. Settings is a tab: the
list of sections, then one page at a time. On iPhone, Settings and the task editor follow iOS
(Jordan, 2026-11-03): inset grouped lists on the paper colour with rows on the sheet colour, small
grey headers and footers, a centred page title, and the task editor as a form sheet with Cancel and
Save in its top bar and Pin as a switch. Task rows swipe on both phones: right for Pin, left for
Archive and Delete. Back gestures follow the platform (iOS edge swipe, Android system back), and
text follows the phone's text size setting.

Drawings (Jordan, 2026-11-03): a full-screen pad with Cancel, Undo and Done on top, the drawing on
its own light paper, and three inks, two widths, an eraser and Clear below. A pen draws with
pressure and, once used, makes a resting palm draw nothing. The drawing is saved as an SVG in the
attachments folder and embedded with `![[…]]`, so Obsidian and GitHub show it; Wandika keeps the
strokes inside the file and offers "Edit drawing" on its own drawings only.

Left aligned throughout. The one memorable element is the page itself: Literata at a generous size on
a quiet sheet. Everything else is restrained.

## Motion

Only motion that answers an action, from tokens in `app.css`:
- `--dur-instant` 100ms: press tint, chevrons.
- `--dur-quick` 160ms: fades for dialogs, toast and image; toggles.
- `--dur-base` 240ms: push and pop of phone screens, sheet close, panel collapse, a ticked task
  folding away.
- `--dur-slow` 360ms: sheet open.

Easings are `--ease-out` for arrivals, `--ease-in` for departures and `--ease-sheet` for sheets.
Reduced motion sets every duration to 0, and script timers read the same tokens (`src/lib/motion.ts`).
Tab switches, typing and repeated actions never animate.

## Tokens beyond colour

- Type: `--text-2xs` to `--text-2xl` (11, 12, 13, 15/16, 18, 22, 28), all × `--text-scale`.
- Space: `--space-1` to `--space-8` (4 to 40).
- Radius: `--radius-xs` 4, `-sm` 6, base 10, `-md` 12, `-lg` 14, `-xl` 20.
- Elevation: `--shadow-raise`, `--shadow-pop`, `--shadow-modal`, `--scrim` (stronger in dark).

Shared controls live in `app.css`: `.btn` (`.primary`, `.quiet`, `.danger`), `.icon-btn`, `.link-btn`,
`.back`, `.chip`, `.segmented`, `.field`. Small controls keep their look and get a 44px tap area on
touch.
