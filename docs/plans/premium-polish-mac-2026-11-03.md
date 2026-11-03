# Premium polish: the Mac

- **Date:** 2026-11-03 (night)
- **Scope:** the Mac window at 900 px and wider, plus the Mac download that follows it.
- **Problem:** the Mac app works, but parts of it still feel like a web page, or like the phone app:
  - the window drags only from the sidebar header;
  - controls are phone-sized;
  - right-click does nothing;
  - several actions in full-screen Today do nothing you can see;
  - dialogs vanish instead of fading;
  - some copy says "tap".
- **Evidence:** three read-only code audits (motion and Mac feel, consistency, states and copy). The earlier passes are [the whole app](premium-polish-app-2026-11-03.md) and [phones](premium-polish-mobile-2026-11-03.md).

## Scorecard (before)

| # | Criterion | Mac | Evidence |
|---|---|---|---|
| 1 | Anticipates needs | 1 | In full-screen Today, Meeting note, ⌘N, ⌘D and ⌘K do nothing visible. "All tasks" with a note open changes nothing. An opened note doesn't take the cursor. |
| 2 | Intentional transitions | 1 | No desktop dialog fades out: a scoped rule outweighs the close rule. Dragging a resizer lags behind the pointer. The panels appear and disappear in one frame. |
| 3 | Delight | 1 | There's no Undo when a board card or column is deleted. |
| 4 | Knows when not to animate | 2 | Motion follows the tokens, and reduced motion stops all of it. |
| 5 | Invisible consistency | 1 | The traffic-light spacing is written seven ways. Buttons and fields are 44 px. There are nine icon sizes and seven row heights. The view headers differ. |
| 6 | Empty states | 1 | The Tasks empty state tells you to use "the writing bar", which only exists on phones. A note that fails to load has no Try again. |
| 7 | Rewards discovery | 1 | Nothing mentions the Claude Code connection. Many shortcuts are never shown. Right-click is swallowed. |
| 8 | Prescriptive errors | 1 | The status bar says "Tap to retry". Errors on the start screen land away from what you clicked. Toasts render under open dialogs. |
| 9 | Performance | 2 | Fast. |

## Tier 1: trust breakers

1. **Full-screen Today:** opening a note, making one, or opening today's note leaves full-screen Today. "All tasks" closes the open note first. ⌘K works there.
2. **Dialogs on the Mac:**
   - every one fades out with its content still in it;
   - Esc closes the image viewer and the mail reader the same way their X does;
   - Settings, the ⌘K palette and the focus session close the same way as the others.
3. **The window:**
   - it drags from the top strip of every column and from the start screen;
   - the drawing pad and the image viewer leave room for the traffic lights.
4. **Right-click** opens a row's menu: notes and folders in the tree, and tasks.
5. **Opening a note** puts the cursor in it.
6. **Resizing a column** follows the pointer.
7. **Phone words on the Mac:**
   - "Click to retry" instead of "Tap to retry";
   - the empty Tasks message names ⌘L;
   - the drawing hint names the trackpad.
8. **Toasts** show above open dialogs, so Settings' messages and Undo stay readable and clickable.
9. **The ⌘K palette** keeps the highlighted result in view.
10. **App-wide shortcuts** wait while a dialog is open.
11. **Claude Code:**
    - Connections on the Mac has a row for it, with a button that copies the one-line setup command;
    - a note Claude changes says so.
12. **Board:** deleting a card or a column gives Undo.
13. **Errors that point the wrong way or lead nowhere:**
    - start screen errors show under what you clicked;
    - the first-open copy no longer mentions Settings or the status bar;
    - a note that fails to load gets Try again;
    - Esc during a focus round asks first;
    - the graph gets Try again;
    - a picture that hasn't arrived offers Sync now.

## Tier 2: one Mac look

- **Title bar:** one height token for the toolbar row, centred on the traffic lights. Every column's head uses it, and the show-sidebar button leaves room in every view.
- **Controls:** buttons and fields are 32 px on the Mac (macOS push-button height), and 44 px on touch.
- **Icons:** one size per job (inline 14, rows and menus 16, toolbars 18). The Today links stay small on the Mac.
- **Rows:** one height, gap and hover across lists. The selected row uses a stronger dark-mode tint.
- **Headers and dialogs:**
  - one view-head style (padding, alignment, one action slot);
  - one dialog head and actions style;
  - destructive confirms use the shared danger style;
  - "Show more" uses the link control.
- **Separators:** hairlines between rows, and rules only for edges.
- **Tokens and fixes:**
  - page gutters use a token;
  - in the image viewer, the Edit drawing button stays visible on the black background.

## Tier 3: pacing

- **Shortcuts:**
  - ⌘[ and ⌘] go back and forward between notes;
  - ⌘⌥T shows or hides Today, and its button says so;
  - the About list has the formatting shortcuts.
- **Keyboard:**
  - the file tree moves with the arrow keys;
  - a menu gives focus back to its button after you choose;
  - the focus ring and the tick hold use tokens.

## Decided against

- **A toast for every ticked task:** Reminders and Things don't give one. Done tasks stay one click away under "Show done".
- **Vibrancy in the sidebar:** it would mean a native window effect and a translucent page. That's a new look, so it's Jordan's call.

## Result (2026-11-03, after all three tiers)

| # | Criterion | Mac | What changed |
|---|---|---|---|
| 1 | Anticipates needs | 2 | Full-screen Today hands over to whatever you open. An opened note takes the cursor. ⌘[ and ⌘] go back and forward. App shortcuts wait while a dialog is open. |
| 2 | Intentional transitions | 2 | Every dialog fades out with its content, at the same pace it came in. Resizing a column follows the pointer. |
| 3 | Delight | 2 | Board cards and columns come back with Undo. |
| 4 | Knows when not to animate | 2 | New timings use tokens (`--dur-close`, `--dur-hold`), so reduced motion makes them instant. |
| 5 | Invisible consistency | 2 | The window drags from every column's top and from the start screen. Controls are 32 px. There's one icon size per job, a selected-row token and hairline separators, and the corner buttons have room in every view. |
| 6 | Empty states | 2 | The empty Tasks message names ⌘L. A note, the graph or a picture that fails to load offers Try again or Sync. |
| 7 | Rewards discovery | 2 | Claude Code has a row in Connections with its setup command. About lists every shortcut. Right-click opens row menus, and the tree moves with the arrow keys. |
| 8 | Prescriptive errors | 2 | The status bar says "Click". Start-screen errors sit under what you clicked. Toasts show above dialogs, and a note Claude changes says so. |
| 9 | Performance | 2 | Unchanged. |

Checked:
- 1,338 interface tests and 181 Rust tests pass.
- The type-check is clean.
- Screenshots at 1280 × 800 in light and dark: the notes list, a note, full-screen Today handing over to Tasks, and the start screen.

Not yet checked: the drag regions and the traffic-light spacing in the real Mac app, which happens with the next Mac build.
