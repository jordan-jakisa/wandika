// Keyboard use across the app, in one place:
// - a sheet or dialog puts focus on its first control when it opens, and gives it back to what
//   opened it when it closes (or to the ⋯ button whose menu item opened it, as that item is gone);
// - arrow keys move through a radio group (Settings' segmented choices, the drawing inks).

let lastMenuTrigger: HTMLElement | null = null;

/** Menu.svelte calls this as an item is chosen, so a dialog the item opened can return there. */
export function rememberMenuTrigger(el: HTMLElement | null) {
  lastMenuTrigger = el;
}

const FOCUSABLE = '[autofocus], input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** ⇧F10 or the menu key: what a right-click does, from the keyboard. */
export const isMenuKey = (e: KeyboardEvent) => e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");

/** After a row's menu opens from the keyboard, its first item takes focus. */
export function focusMenuIn(row: Element | null) {
  setTimeout(() => row?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
}

let installed = false;

export function installKeyboard() {
  if (installed || typeof HTMLDialogElement === "undefined") return;
  installed = true;
  const openers = new WeakMap<HTMLDialogElement, HTMLElement | null>();

  const show = HTMLDialogElement.prototype.showModal;
  if (!show) return;
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    const at = document.activeElement as HTMLElement | null;
    openers.set(this, at && at !== document.body ? at : lastMenuTrigger);
    show.call(this);
    // Sheets draw their content right after opening; then the first control takes focus,
    // unless the sheet already put it somewhere.
    // Not on phones: focusing a field there raises the on-screen keyboard unasked.
    if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) return;
    requestAnimationFrame(() => {
      if (document.activeElement === this || document.activeElement === document.body) {
        this.querySelector<HTMLElement>(FOCUSABLE)?.focus();
      }
    });
  };

  document.addEventListener(
    "close",
    (e) => {
      const dialog = e.target as HTMLDialogElement;
      if (!(dialog instanceof HTMLDialogElement)) return;
      const opener = openers.get(dialog);
      setTimeout(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        const back = opener?.isConnected ? opener : lastMenuTrigger?.isConnected ? lastMenuTrigger : null;
        back?.focus();
      });
    },
    true,
  );

  // A radio group is one Tab stop: coming in lands on the chosen option; Tab leaves the group.
  document.addEventListener("focusin", (e) => {
    const radio = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[role="radio"]');
    const group = radio?.closest<HTMLElement>('[role="radiogroup"]');
    if (!radio || !group || group.contains(e.relatedTarget as Node | null)) return;
    const chosen = group.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
    if (chosen && chosen !== radio) chosen.focus();
  });

  document.addEventListener("keydown", (e) => {
    const radio = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[role="radio"]');
    const group = radio?.closest<HTMLElement>('[role="radiogroup"]');
    if (!radio || !group) return;
    if (e.key === "Tab") {
      const scope = group.closest("dialog[open]") ?? document;
      const all = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      const inGroup = all.filter((el) => group.contains(el));
      const edge = e.shiftKey ? all.indexOf(inGroup[0]) - 1 : all.indexOf(inGroup[inGroup.length - 1]) + 1;
      const next = all[edge];
      if (next) {
        e.preventDefault();
        next.focus();
      }
      return;
    }
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    const all = [...group.querySelectorAll<HTMLElement>('[role="radio"]:not([disabled])')];
    const next = all[(all.indexOf(radio) + step + all.length) % all.length];
    if (!next) return;
    e.preventDefault();
    next.focus();
    next.click();
  });
}
