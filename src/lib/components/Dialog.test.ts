import "@testing-library/jest-dom/vitest";
import { isModal, resetApp } from "../../test/components-views";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { flushSync } from "svelte";
import { beforeEach, describe, expect, test } from "vitest";
import { app } from "../app.svelte";
import Dialog from "./Dialog.svelte";

beforeEach(resetApp);

/** Renders the dialog and asks; the promise settles with what the person chose. */
function ask(opts: Parameters<typeof app.ask>[0]) {
  const answer = app.ask(opts);
  flushSync();
  return answer;
}

test("stays closed until something asks", () => {
  render(Dialog);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

describe("confirm", () => {
  test("opens as a modal named by its title, with the message", () => {
    render(Dialog);
    void ask({ title: "Delete “Plan”?", message: "It goes to the trash.", confirm: "Delete" });
    const dialog = screen.getByRole("dialog", { name: "Delete “Plan”?" });
    expect(isModal(dialog)).toBe(true);
    expect(screen.getByText("It goes to the trash.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  test("the confirm button resolves and closes", async () => {
    const user = userEvent.setup();
    render(Dialog);
    const answer = ask({ title: "Sign out?", confirm: "Sign out" });
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await expect(answer).resolves.toBe("");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("Cancel resolves with nothing and closes", async () => {
    const user = userEvent.setup();
    render(Dialog);
    const answer = ask({ title: "Sign out?", confirm: "Sign out" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("Escape cancels", async () => {
    const user = userEvent.setup();
    render(Dialog);
    const answer = ask({ title: "Sign out?", confirm: "Sign out" });
    await user.keyboard("{Escape}");
    await expect(answer).resolves.toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("a destructive action is drawn as danger, others as primary", () => {
    render(Dialog);
    void ask({ title: "Delete column?", confirm: "Delete column", danger: true });
    expect(screen.getByRole("button", { name: "Delete column" })).toHaveClass("danger-fill");
    expect(screen.getByRole("button", { name: "Delete column" })).not.toHaveClass("primary");
    void ask({ title: "Rename?", confirm: "Rename" });
    flushSync();
    expect(screen.getByRole("button", { name: "Rename" })).toHaveClass("primary");
  });
});

describe("text input", () => {
  test("shows a labelled field with the starting value, focused", async () => {
    render(Dialog);
    void ask({ title: "Rename column", confirm: "Rename", input: { label: "Column name", value: "Doing" } });
    const field = screen.getByRole("textbox", { name: "Column name" });
    expect(field).toHaveValue("Doing");
    await Promise.resolve();
    expect(field).toHaveFocus();
  });

  test("Enter resolves with what was typed", async () => {
    const user = userEvent.setup();
    render(Dialog);
    const answer = ask({ title: "New folder", confirm: "Create folder", input: { label: "Folder name", value: "" } });
    await user.type(screen.getByRole("textbox", { name: "Folder name" }), "Recipes{Enter}");
    await expect(answer).resolves.toBe("Recipes");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("the confirm button resolves with the field's value", async () => {
    const user = userEvent.setup();
    render(Dialog);
    const answer = ask({ title: "Rename", confirm: "Rename", input: { label: "Name", value: "Old" } });
    const field = screen.getByRole("textbox", { name: "Name" });
    await user.clear(field);
    await user.type(field, "New");
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await expect(answer).resolves.toBe("New");
  });

  test("an empty or blank field doesn't submit", async () => {
    const user = userEvent.setup();
    render(Dialog);
    let settled = false;
    void ask({ title: "New folder", confirm: "Create folder", input: { label: "Folder name", value: "" } }).then(() => (settled = true));
    await user.click(screen.getByRole("button", { name: "Create folder" }));
    await user.type(screen.getByRole("textbox", { name: "Folder name" }), "   {Enter}");
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(screen.getByRole("dialog", { name: "New folder" })).toBeInTheDocument();
  });

  test("the next dialog starts from its own value, not what was typed before", async () => {
    const user = userEvent.setup();
    render(Dialog);
    const first = ask({ title: "Rename", confirm: "Rename", input: { label: "Name", value: "Plan" } });
    await user.type(screen.getByRole("textbox", { name: "Name" }), " draft");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await first;
    void ask({ title: "Rename", confirm: "Rename", input: { label: "Name", value: "Ideas" } });
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Ideas");
  });
});

describe("choices", () => {
  const choices = [
    { label: "Projects", value: "Projects" },
    { label: "Vault root", value: "" },
  ];

  test("lists each choice and has no confirm button", () => {
    render(Dialog);
    void ask({ title: "Move to", confirm: "Move", choices });
    expect(screen.getByRole("button", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vault root" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  test("picking one resolves with its value", async () => {
    const user = userEvent.setup();
    render(Dialog);
    const answer = ask({ title: "Move to", confirm: "Move", choices });
    await user.click(screen.getByRole("button", { name: "Vault root" }));
    await expect(answer).resolves.toBe("");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("Cancel resolves with nothing", async () => {
    const user = userEvent.setup();
    render(Dialog);
    const answer = ask({ title: "Move to", confirm: "Move", choices });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toBeNull();
  });
});

test("a new question replaces an open one, which resolves with nothing", async () => {
  render(Dialog);
  const first = ask({ title: "First", confirm: "OK", input: { label: "Name", value: "one" } });
  void ask({ title: "Second", confirm: "OK", input: { label: "Name", value: "two" } });
  await expect(first).resolves.toBeNull();
  expect(screen.getByRole("dialog", { name: "Second" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("two");
});

test("closes when the question is withdrawn", () => {
  render(Dialog);
  void ask({ title: "Sign out?", confirm: "Sign out" });
  app.dialog?.resolve(null);
  flushSync();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
