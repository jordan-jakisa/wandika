# Premium polish: the whole app (Mac, iPhone, Android)

- **Date:** 2026-11-03
- **Scope:** every screen on all three platforms.
- **Problem:** the app works and looks calm, but it does not yet feel cared for:
  - errors leak raw system text, and one failure hides your note;
  - nothing is remembered between launches;
  - phone screens swap with no motion and jump while loading;
  - there is no moment of reward anywhere;
  - small inconsistencies add up (three chip styles, 27 spacing values, 12 icon sizes).
- **Evidence:**
  - three read-only code audits (motion, consistency, states and copy);
  - screenshots on the Mac (Jordan's Main Vault), the iPhone 12 and the Pixel 8a, in light and dark.

## Scorecard

0 means missing, 1 partial, 2 premium.

| # | Criterion | Mac | iPhone | Android | Evidence |
|---|---|---|---|---|---|
| 1 | Anticipates needs | 1 | 1 | 1 | Last note, tab and scroll are forgotten every launch (`app.svelte.ts:31`). Going back from a note resets the list to the top (`Workspace.svelte:360`). |
| 2 | Intentional transitions | 1 | 1 | 1 | Phone push and pop are instant swaps. Auto-sync pushes a "Syncing…" row into the list. Images, embeds and backlinks make the note jump as they load. |
| 3 | Delight | 0 | 0 | 0 | Ticking a task, the last task of the day, the first sync, a new vault: none of these get a moment. No haptics. |
| 4 | Knows when not to animate | 2 | 2 | 2 | One global reduced-motion switch, and nothing animates while you type. The graph's force layout ignores reduced motion. |
| 5 | Invisible consistency | 1 | 1 | 1 | Android light mode draws white status-bar icons on a white page. Conflicts are shown in amber; DESIGN.md says red. 15 touch targets are under 44px, three chip styles exist, there are no spacing, shadow or motion tokens, and icon sizes run 12–24. |
| 6 | Empty states | 1 | 1 | 1 | Most are good. Empty "Untitled" notes pile up. The repo list with no repos says `No repositories match “”`. "All done today" reads the same as "never had tasks". |
| 7 | Rewards discovery | 1 | 0 | 0 | The Mac shows shortcut hints. Phones never mention long-press menus or pull to sync. There are no milestones. |
| 8 | Prescriptive errors | 0 | 0 | 0 | A failed save hides the editor (`Editor.svelte:365`). Raw text reaches the user, for example "GitHub returned 422: Repository creation failed." and "(os error 28)". A failed task toggle is silent. On phones a sync failure shows only "Sync failed". |
| 9 | Performance | 1 | 1 | 1 | The core is fast on the real vault: tree 15 ms, index 101 ms. But the note body waits for backlinks before it draws (`Editor.svelte:152`), and boot is a blank screen. |

## Bugs (logged in docs/backlog.md)

**P1: you could think you lost work, or a screen lies**
1. A failed save hides the editor and its text. The error string is raw, and there is no retry.
2. Ticking a task that fails leaves the box ticked with no message.
3. Android in light mode: status bar icons are white on a white page, so they are invisible.

**P2: wrong or raw information**

4. Raw GitHub, Google, Outlook, IO and JSON errors reach the screen ("GitHub returned 403…", "os error 13", "missing field …").
5. The reason for a sync failure is only in a hover tooltip, which phones cannot show.
6. Creating a repository uses the default name "notes". Anyone who already has one gets "GitHub returned 422".
7. A repository created in Wandika never gets the Welcome note, because `auto_init` adds a README.
8. Today's date and "Due today" go stale overnight on the Mac.
9. Renaming or encrypting the open note remounts the editor: flash, scroll lost, cursor lost.
10. An empty "Untitled" note is left behind every time you tap + and go back. There are two on the Pixel now.
11. Settings switches to the phone sheet below 700px, but the app's phone layout starts at 900px.
12. Settings says changes sync "a few seconds after you stop typing". The code waits 20 seconds.
13. "Due today" on the Mac lists overdue tasks too, with no separate heading.
14. Errors from Google connectors show the account key in lowercase ("Your google sign-in expired", "microsoft"), once per service.

**P3: polish**

15. Hover styles stick after a tap in four places.
16. The menu's first item looks pressed on phones.
17. On phones, sliding a finger across search results moves the selection.

## Changes, by impact per effort

### Tier 1: trust breakers (bugs 1–14)

- **Errors with codes.** The Rust `Error` type gets a code, and every error is shown through one function, `say(error)`, that maps the code to plain copy with one next action. Examples:
  - Raw "GitHub returned 403" becomes "GitHub is limiting requests. Wandika will try again in a few minutes."
  - A 404 becomes "Wandika can't find owner/repo any more…" with a Choose repository button.
  - A 422 becomes "You already have a repository called notes…".
  - An out-of-space error becomes "This device is out of space."

  The raw text goes to the console only. This removes three checks that currently match error wording (`SyncStatus.svelte:11`, `Editor.svelte:145`, `app.svelte.ts:177`).
  - Research: NN/g error-message guidelines (visible, precise, constructive).
  - Files: error.rs, github.rs, oauth.rs, a new `src/lib/errors.ts`, and about 15 call sites.
  - Size: about +180 / −60 lines.
- **Save failure keeps the note on screen.** The editor stays visible and a quiet banner reads "Couldn't save. Your text is safe here; Wandika keeps trying." Saving retries with back-off.
- **Task toggles update at once.** The box ticks immediately and is reverted with a message if the change fails.
- **Sync failure is tappable on phones.** The status line becomes, for example, "Can't reach GitHub. Tap to retry".
- **Android status bar follows light and dark.** In MainActivity, `WindowInsetsControllerCompat.isAppearanceLightStatusBars` is set from the theme and updated when the theme changes.
- **Empty new notes are discarded.** A note still empty and still named "Untitled" is moved to the trash when you leave it, as Apple Notes does.
- **One settings breakpoint**, at 900px.
- **Today:** a live date, a separate "Overdue" group, and one "Reconnect Google" row instead of three raw errors.
- **New repositories** start with the Welcome note. The suggested name avoids existing repositories.
- **Rename and encrypt** keep the same editor instance.
- **Accurate settings copy** ("about 20 seconds").

### Tier 2: invisible consistency (removes code)

- **Tokens in app.css:**
  - spacing `--space-1…8` (4–40);
  - type `--text-xs…2xl` (12, 13, 15/16, 18, 22, 28, all × `--text-scale`);
  - `--radius-md` 12 and `--radius-xl` 20;
  - `--shadow-pop`, `--shadow-modal` and `--scrim`, stronger in dark mode;
  - motion `--dur-instant/quick/base/slow` and `--ease-out/in/sheet`, zeroed under reduced motion;
  - `--titlebar` for the Mac traffic-light clearance.

  The code then snaps to these tokens: 140 off-grid spacing values, 26 font sizes, 13 shadows and 14 radius literals.
- **Shared controls in app.css** with phone variants in mobile.css:
  - `.chip`: one, instead of three;
  - `.segmented`: one, instead of two;
  - `.back`: one, instead of three;
  - `.link-btn`: one, instead of five;
  - `.btn.quiet`.

  This fixes the specificity clash that turns quiet buttons into grey pills on phones. Expected size: about −150 lines.
- **Phone styles in one place.** The dead `.phone` duplicates in Settings and Search, which disagree with mobile.css, are deleted.
- **Icon sizes from one map** (inline 14, row and menu 16 on Mac and 18 on phone, toolbar 18, tab bar 22). Menu items currently mix 16 and 18.
- **44px targets on touch** for board cards and chips, task chips, graph controls, colour swatches, segmented controls, Today links and the task checkbox. Small visuals keep their size and get a larger hit area.
- **Conflicts in `--alarm`**, as DESIGN.md says. Amber stays for offline and too-big files.
- **Dark-mode edges.** Menus and dialogs on phones get a hairline or a raised surface so they separate from the page.
- **One dark-token block.** The block is currently duplicated in app.css, prefs and app.html.

### Tier 3: pacing and restraint

- **Remembered state:**
  - the last note, tab and Today column;
  - scroll position and cursor per note;
  - list scroll per tab;
  - the Settings section;
  - graph and task view options.
- **Phone push and pop** (`--dur-base`, ease-sheet) for list → note, sub-views and Settings sections. Tab switches stay instant.
  - Swipe-back shows the real list underneath and finishes the slide.
  - The list stays mounted, so back returns to the same place.
- **No loading jumps:**
  - The note body draws before backlinks arrive.
  - Images keep their resolved URL and reserve space.
  - Note embeds are cached.
  - Today shows skeleton rows on first load and never blinks its empty text.
  - Search keeps the old results until new ones arrive.
  - Editor reloads after a sync change only the edited range.
- **Background sync stays quiet:**
  - no pull row for automatic syncs;
  - "Syncing…" shows only after 500 ms.
- **Fades** over `--dur-quick` for the toast, sheet backdrop, dialogs, the ⌘K palette and the image viewer.
- **Mac:** the sidebar and Today column collapse with motion, and the empty-note area stops repeating "Open today's note".
  - It is currently offered three times on one screen: sidebar, centre and Today column.
  - The centre shows recent notes instead (anticipates the next action).
- **Graph:** settles instantly under reduced motion, and does not reheat after background syncs.
- **Press states** on every tappable element that lacks one (about 20). Hover is gated everywhere.
- **The iOS writing toolbar** moves with a transform, in step with the keyboard.

### Tier 4: peaks and discovery

- **Small win:** a ticked task strikes through, holds briefly, then collapses. Android gets one 10 ms vibration; iOS gets none, because web views have no haptics.
- **Proportionate peak:** "All done for today." with a quiet check, when the last due task is ticked. No confetti.
- **First sync:** "Your notes are on GitHub. Every device you sign in on gets them."
- **Manual sync:** "3 notes updated" instead of nothing.
- **Trash:** "Moved “X” to the trash." with Undo, the same from the editor and the file list.
- **Contextual tips, each shown once on phones:**
  - "Press and hold a note for more." after the third note opened;
  - "Pull down to sync." on the first synced vault.
- **Mac:** shortcut hints only where they work (a synced vault for ⌘S), `title="New note (⌘N)"`, and the full shortcut list in About.

## Stays as is

- The Liquid Glass bar on iOS and the flat bar on Android (Jordan, 2026-11-03).
- The colour palette, Literata, and one accent at a time.
- No celebration animations beyond the one quiet "All done" moment.
- Typing paths stay unanimated.

## Order of work

Tier 1, then 2, then 3, then 4. Commit in small chunks. After each tier:
- build;
- install on the iPhone and the Pixel;
- check light and dark with screenshots;
- re-score the scorecard.

## Result (2026-11-03, after all four tiers)

| # | Criterion | Mac | iPhone | Android | What changed |
|---|---|---|---|---|---|
| 1 | Anticipates needs | 2 | 2 | 2 | Last note, tab, Today column and Settings section per vault. Scroll and cursor per note; scroll per tab. The Mac start screen lists recent notes. Search is ready to type. |
| 2 | Intentional transitions | 2 | 2 | 2 | Notes slide over a list that stays mounted, and a swipe back finishes from where it let go. Sub-screens slide in. Modals, the toast and the image viewer fade. Panels collapse with motion. Nothing jumps while loading. |
| 3 | Delight | 1 | 1 | 2 | A ticked task strikes through, holds, then folds away, with a vibration on Android. "All done for today." First-sync and manual-sync messages. iOS web views have no haptics. |
| 4 | Knows when not to animate | 2 | 2 | 2 | Motion tokens are zero under reduced motion, script timers read them, and the graph settles at once. Typing paths stay still. |
| 5 | Invisible consistency | 2 | 2 | 2 | Tokens for type, spacing, radius, elevation and motion. One chip, segmented control, back row and text button. 44px tap areas. Conflicts shown in alarm red. Android bar icons follow the theme. |
| 6 | Empty states | 2 | 2 | 2 | Empty Untitled notes are discarded. The repo list, search and Today each say why they are empty and what to do. |
| 7 | Discovery | 2 | 1 | 1 | One-time phone tips (long press, pull to sync). The Mac shows its shortcuts where they work. |
| 8 | Prescriptive errors | 2 | 2 | 2 | Coded errors in plain words. Saves retry without hiding the note. Sync failures say why and retry on tap. Reconnect buttons. Undo after trash. |
| 9 | Performance | 2 | 2 | 2 | The note body draws before backlinks; images and embeds are cached. Graph and task lists render in pages. |

Kept as is:
- The dark colour block appears twice in app.css (media query and chosen mode), because both are needed before the interface script runs.
- Spacing of 6, 10 and 14px stays as half-steps of the grid; only the outliers were snapped.
