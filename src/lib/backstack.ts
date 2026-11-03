// Phones: every sheet over the app (the task editor, a drawing, an email, a picture, a question)
// gets one history entry while it is open, so the system back gesture closes the sheet on top
// instead of leaving the app or the note underneath.

const PHONE_MAX = 900;
const isPhone = () => typeof window !== "undefined" && window.innerWidth < PHONE_MAX;

type Entry = { id: number; back: () => void };
const stack: Entry[] = [];
let next = 0;
/** Back steps Wandika takes itself, when a sheet closes on its own; their popstate is not a back. */
let own = 0;

function push(e: Entry) {
  history.pushState({ wandika: "sheet", sheet: e.id }, "");
}

/**
 * Call when a sheet opens; `back` runs when the person goes back (it may ask first and stay open).
 * Returns the function to call when the sheet closes in any other way.
 */
export function sheetOpened(back: () => void): () => void {
  if (!isPhone()) return () => {};
  const e: Entry = { id: ++next, back };
  stack.push(e);
  push(e);
  return () => {
    const i = stack.indexOf(e);
    if (i < 0) return;
    stack.splice(i, 1);
    if (history.state?.wandika === "sheet" && history.state.sheet === e.id) {
      own++;
      history.back();
    }
  };
}

/** For the workspace's popstate handler: true when the back gesture belonged to a sheet. */
export function sheetBack(): boolean {
  if (own) {
    own--;
    return true;
  }
  const top = stack.at(-1);
  if (!top) return false;
  top.back();
  // Sheets close in their effects, a moment later. One still open then (it asked first, or it
  // can't close yet) keeps its place in history.
  setTimeout(() => stack.includes(top) && push(top), 0);
  return true;
}

/** For tests. */
export function resetSheets() {
  stack.length = 0;
  own = 0;
}
