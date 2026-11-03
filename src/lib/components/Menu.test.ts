import "@testing-library/jest-dom/vitest";
import "../../test/components-views";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { createRawSnippet } from "svelte";
import { describe, expect, test, vi } from "vitest";
import Menu from "./Menu.svelte";

/** A menu with three items; `picked` records which one ran. */
function setup(props: { open?: boolean } = {}) {
  const picked = vi.fn();
  const children = createRawSnippet(() => ({
    render: () =>
      `<div><button role="menuitem">Rename</button><button role="menuitem">Move</button><button role="menuitem" class="danger">Delete</button></div>`,
    setup(el) {
      for (const b of el.querySelectorAll("button")) b.addEventListener("click", () => picked(b.textContent));
    },
  }));
  const r = render(Menu, { label: "Note actions", children, ...props });
  return { ...r, picked, trigger: within(r.container).getByRole("button", { name: "Note actions" }) };
}

test("starts closed, with a named trigger that says it opens a menu", () => {
  const { trigger } = setup();
  expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

describe("mouse and touch", () => {
  test("a click opens the menu and leaves focus on the trigger", async () => {
    const user = userEvent.setup();
    const { trigger } = setup();
    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Rename", "Move", "Delete"]);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await Promise.resolve();
    expect(trigger).toHaveFocus();
  });

  test("a second click closes it", async () => {
    const user = userEvent.setup();
    const { trigger } = setup();
    await user.click(trigger);
    await user.click(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("choosing an item runs it and closes the menu", async () => {
    const user = userEvent.setup();
    const { trigger, picked } = setup();
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Move" }));
    expect(picked).toHaveBeenCalledWith("Move");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  test("a tap outside closes it", async () => {
    const user = userEvent.setup();
    const { trigger } = setup();
    await user.click(trigger);
    await user.click(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  test("a press inside the menu keeps it open", async () => {
    const { trigger } = setup();
    await fireEvent.click(trigger);
    await fireEvent.pointerDown(screen.getByRole("menuitem", { name: "Rename" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});

describe("keyboard", () => {
  test("Enter opens the menu with the first item focused", async () => {
    const user = userEvent.setup();
    const { trigger } = setup();
    trigger.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus());
  });

  test("Space opens it too", async () => {
    const user = userEvent.setup();
    const { trigger } = setup();
    trigger.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus());
  });

  test("arrow keys move through the items and wrap around", async () => {
    const user = userEvent.setup();
    const { trigger } = setup();
    trigger.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Move" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
  });

  test("ArrowDown from the trigger of an open menu goes to the first item", async () => {
    const user = userEvent.setup();
    const { trigger } = setup();
    await user.click(trigger);
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
  });

  test("Escape closes the menu and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const { trigger } = setup();
    trigger.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  test("Enter on an item runs it and closes the menu", async () => {
    const user = userEvent.setup();
    const { trigger, picked } = setup();
    trigger.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus());
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(picked).toHaveBeenCalledWith("Delete");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  test("keys on a closed menu do nothing", async () => {
    const user = userEvent.setup();
    const { trigger } = setup();
    trigger.focus();
    await user.keyboard("{ArrowDown}{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

test("can be opened from outside, as a long press on the row does", () => {
  setup({ open: true });
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Note actions" })).toHaveAttribute("aria-expanded", "true");
});

test("only an open menu listens for taps outside it", async () => {
  const user = userEvent.setup();
  const add = vi.spyOn(window, "addEventListener");
  const remove = vi.spyOn(window, "removeEventListener");
  const downs = (spy: typeof add) => spy.mock.calls.filter(([type]) => type === "pointerdown").length;
  setup();
  setup();
  const { trigger } = setup();
  expect(downs(add)).toBe(0);
  await user.click(trigger);
  expect(downs(add)).toBe(1);
  await user.click(trigger);
  expect(downs(remove)).toBe(1);
  add.mockRestore();
  remove.mockRestore();
});
