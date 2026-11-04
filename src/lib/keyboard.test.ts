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

test("a radio group is one Tab stop, and coming in lands on the chosen option", () => {
  installKeyboard();
  document.body.innerHTML =
    '<button id="before">a</button><div role="radiogroup"><button role="radio" id="r1" aria-checked="false"></button><button role="radio" id="r2" aria-checked="true"></button><button role="radio" id="r3" aria-checked="false"></button></div><button id="after">b</button>';
  // jsdom lays nothing out; every element counts as shown.
  for (const el of document.querySelectorAll<HTMLElement>("button")) Object.defineProperty(el, "offsetParent", { get: () => document.body });
  document.getElementById("r1")!.focus();
  expect(document.activeElement?.id).toBe("r2");
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  expect(document.activeElement?.id).toBe("after");
  document.getElementById("r2")!.focus();
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  expect(document.activeElement?.id).toBe("before");
});
