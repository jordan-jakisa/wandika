# Premium polish: phones (iPhone and Android)

- **Date:** 2026-11-03 (evening)
- **Scope:** every phone screen, including what shipped today: the Settings tab, swipe on tasks,
  the iOS task sheet, drawings.
- **Problem:** the phone app works, but parts of it still feel unfinished:
  - some errors point to buttons that don't exist;
  - Android back leaves the app from places it shouldn't;
  - screens differ in titles, margins, rows and back buttons;
  - several sheets appear and vanish with no motion.
- **Evidence:** three read-only code audits (motion, consistency, states and copy), plus a
  screenshot tour of every tab at 390 × 844 in light and dark, as iOS and as Android. The earlier
  whole-app pass is [premium-polish-app-2026-11-03.md](premium-polish-app-2026-11-03.md); nothing
  it fixed is repeated here.

## Scorecard (before)

0 missing, 1 partial, 2 premium.

| # | Criterion | iPhone | Android | Evidence |
|---|---|---|---|---|
| 1 | Anticipates needs | 1 | 0 | Android back from Tasks, the mail reader or a drawing sends the app away (`Workspace.svelte:120`). The task editor drops unsaved edits on a backdrop tap or Esc (`TaskEditor.svelte:146`). |
| 2 | Intentional transitions | 1 | 1 | Settings pages swap with no motion. Five sheets enter five ways and none animates out. Tasks slides in empty, then rows pop in. |
| 3 | Delight | 0 | 0 | iPhone has no haptics at all. Android's vibration never fires: the manifest lacks `VIBRATE`. |
| 4 | Knows when not to animate | 2 | 2 | One reduced-motion switch; CSS and script timers share tokens. |
| 5 | Invisible consistency | 1 | 1 | Projects has no page margin. Six tab titles use three styles. There are three back-row layouts, ten icon sizes, eight targets under 44 px, and square checkboxes on iPhone. |
| 6 | Empty states | 1 | 1 | Today stays on skeletons forever if it fails to load. The Tasks and Today empty states teach Markdown syntax (`- [ ]`, `📅`). |
| 7 | Rewards discovery | 1 | 1 | Swiping a task is never taught. The long-press tip shows while a note covers the list. |
| 8 | Prescriptive errors | 1 | 1 | "Refresh and try again" names a button that doesn't exist. A Google sign-in error is raw on iPhone. "Repository not found. Tap to retry" can't work. A failed manual sync is silent. |
| 9 | Performance | 2 | 2 | Fast. The Tasks remount and Search's blank first keystroke are the only visible waits. |

## Tier 1: trust breakers (bugs, logged in docs/backlog.md)

1. A stale task says "Refresh and try again", but there's no Refresh. The list now reloads itself, and the message says the task changed in its note.
2. If Today fails to load, it shows skeletons forever. Now it shows "Today didn't load" with a Try again button.
3. Google sign-in errors reach the toast raw on iPhone (`commands.rs:599`). They now go through `friendly()`.
4. Two sync failures offer a retry that can't work: "Repository not found" and an expired GitHub sign-in. The line now opens the right Settings page.
5. A manual sync or pull-to-sync that fails says nothing. It now shows a toast with Try again.
6. The task editor discards edits on a backdrop tap, Esc or back. With unsaved edits it now asks before discarding, and a tap on its own padding no longer closes it.
7. Disconnecting a vault from GitHub fails silently. It now says why.
8. Android haptics never fire. The manifest gets `VIBRATE`.
9. Android back from Tasks, Projects, Graph or any sheet leaves the app. Each now gets one history entry, and back closes the top one.
10. Projects has no page margin. It now uses the Tasks padding.
11. The Android Settings tab's list sits on a white block that stops halfway. Both phones now use the paper colour.
12. In the drawing pad, the selected black ink has no ring in dark mode. The ring now uses the page ink.
13. The Settings tab doubles the bottom space. Only the tab body keeps it.
14. The save banner says both "try again" and "keeps trying". iOS errors also say "System Settings". The banner now gives only the cause, and iOS says "Settings".
15. The backlink excerpt shows raw `[[Welcome]]`. It now shows the plain name.
16. New folder leaves an empty folder when its new note is discarded, and an empty folder doesn't sync. It now says the folder was made, and asks you to add a note so it reaches your other devices.

## Tier 2: invisible consistency

- **Titles and pages:** one `.view-title` and one page padding, for all tabs and sub-screens. Search gets its title.
- **Back rows:** one style. On iOS the back label is in the accent, like Cancel and Done.
- **iOS top bars:** one shared bar for the task sheet, the drawing pad and Settings.
- **Touch targets:** every one under 44 px gets the shared tap area:
  - "Show more"
  - the task meta links
  - the board checkbox
  - Undo
  - Edit drawing
  - the graph depth select
  - the format bubble
- **Lists:**
  - one row minimum height;
  - one separator colour, `--hairline`;
  - `--press` for every loading skeleton.
- **Icons and section labels:** a phone icon size per job (row, bar, tab), and one style for section labels.
- **iPhone checkboxes:** round, like Reminders.
- **Search fields:** the Tasks search field is filled, like Search.
- **Copy:**
  - "Pin to top" and "Focus" everywhere;
  - "Reminders, Home" in both places;
  - toasts name the task: "Deleted “X”." and "Archived “X”.";
  - the drawing discard dialog says "Keep drawing" or "Discard";
  - empty states give a way to act instead of Markdown syntax.
- **Tokens:**
  - spacing and radius literals snap to tokens;
  - shadows use the elevation tokens;
  - dead fallbacks are removed;
  - the email page follows the text size setting.

## Tier 3: pacing and restraint

- **Pushed pages:** Settings pages push in and out. Each opens at its top. iOS edge-swipe back works on every pushed page, not only notes.
- **Sheets:** one shared motion for every sheet. They slide up over `--dur-slow` with `--ease-sheet`, and slide away over `--dur-base` before they close.
- **Tasks:** shows its last list at once, then refreshes it, with no empty flash. Scroll comes back after the rows do.
- **Sub-screens:** Tasks, Projects and Graph push over their parent, which stays underneath, and back animates too.
- **Task rows:** a deleted or archived task folds away like a ticked one. The fold animates its real height.
- **Pull to sync:** the row settles instead of snapping, the phone gives a tick at the threshold, and on Today a pull also reloads calendar and mail.
- **Toasts:** a toast keeps its text while it fades.
- **Search:** keeps showing Recent until the first results arrive.
- **Press feedback:** added on the drawing tools, the swipe actions, the task title and the mail rows.
- **Motion tokens:** push and pop use `--ease-sheet`, and the hold before a ticked task folds is a token.

## Tier 4: peaks and discovery

- **Haptics:** through Tauri's haptics plugin, so iPhone gets them too:
  - a selection tick at the long-press, swipe and pull thresholds;
  - a light tap when a task is ticked;
  - a success pattern when a focus round ends and for "All done for today".
- **Swipe tip:** one tip, once: "Tip: swipe a task right to pin it, or left to archive or delete it."
- **Long-press tip:** shown the next time the Notes list is on screen.

## Stays as is

- Notes is a plain list, as in Files. Apple's grouped style is for settings-like screens.
- The drawing paper stays light in dark mode, as the saved file does everywhere else.
- Android keeps its flat Material rows and its bar. The earlier pass checked them on the Pixel.
