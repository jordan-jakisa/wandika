import { afterEach, expect, test } from "vitest";
import { installKeyboard, rememberMenuTrigger } from "./keyboard";

afterEach(() => (document.body.innerHTML = ""));

// jsdom has no modal dialogs; enough of one to open and close.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};

test("a dialog gives focus back to the menu button whose item opened it", async () => {
  installKeyboard();
  document.body.innerHTML = '<button id="trigger">⋯</button><button id="item">Edit</button><dialog id="d"><button>Save</button></dialog>';
  const item = document.getElementById("item")!;
  item.focus();
  const d = document.getElementById("d") as HTMLDialogElement;
  d.showModal();
  // The menu closes as its item is chosen: the item leaves the page.
  rememberMenuTrigger(document.getElementById("trigger"));
  item.remove();
  d.close();
  d.dispatchEvent(new Event("close"));
  await new Promise((r) => setTimeout(r, 10));
  expect(document.activeElement?.id).toBe("trigger");
});

test("arrow keys move through a radio group and choose", () => {
  installKeyboard();
  document.body.innerHTML = '<div role="radiogroup"><button role="radio" id="a"></button><button role="radio" id="b"></button></div>';
  let chosen = "";
  for (const id of ["a", "b"]) document.getElementById(id)!.addEventListener("click", () => (chosen = id));
  document.getElementById("a")!.focus();
  document.getElementById("a")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(document.activeElement?.id).toBe("b");
  expect(chosen).toBe("b");
});
