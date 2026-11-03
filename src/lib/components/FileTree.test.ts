import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetApp, status } from "../../test/components-workspace";
import { api, AppError } from "../api";
import { app } from "../app.svelte";
import type { Entry } from "../types";
import Dialog from "./Dialog.svelte";
import FileTree from "./FileTree.svelte";

const entry = (path: string, kind: Entry["kind"] = "note", encrypted = false): Entry => ({
  path,
  name: kind === "note" ? path.split("/").pop()!.replace(/\.md(\.age)?$/, "") : path.split("/").pop()!,
  kind,
  encrypted,
  modified: 0,
});

beforeEach(async () => {
  resetApp();
  app.status = status();
  await app.refreshFiles();
});

afterEach(() => vi.useRealTimers());

function renderTree() {
  render(Dialog);
  return render(FileTree);
}

const tree = () => screen.getByRole("tree", { name: "Notes" });
const row = (name: string | RegExp) => within(tree()).getByRole("button", { name });

test("with no files it says how to start", () => {
  app.tree = [];
  renderTree();
  expect(screen.getByText("No notes yet. Create one with the + button.")).toBeInTheDocument();
  expect(screen.queryByRole("tree")).not.toBeInTheDocument();
});

test("lists folders first, then notes, in natural order", () => {
  app.tree = [entry("b.md"), entry("Note 10.md"), entry("Note 2.md"), entry("Zeta", "folder"), entry("Alpha", "folder")];
  renderTree();
  const names = within(tree())
    .getAllByRole("treeitem")
    .map((li) => li.querySelector(".name")?.textContent);
  expect(names).toEqual(["Alpha", "Zeta", "b", "Note 2", "Note 10"]);
});

test("a folder opens and closes, and stays open next time", async () => {
  const user = userEvent.setup();
  const { unmount } = renderTree();
  const projects = row(/^Projects$/).closest("li")!;
  expect(projects).toHaveAttribute("aria-expanded", "false");
  expect(within(tree()).queryByRole("button", { name: /^Wandika$/ })).not.toBeInTheDocument();
  await user.click(row(/^Projects$/));
  expect(projects).toHaveAttribute("aria-expanded", "true");
  expect(within(projects).getByRole("group")).toBeInTheDocument();
  expect(row(/^Wandika$/)).toBeInTheDocument();
  unmount();
  renderTree();
  expect(row(/^Wandika$/)).toBeInTheDocument();
  await user.click(row(/^Projects$/));
  expect(within(tree()).queryByRole("button", { name: /^Wandika$/ })).not.toBeInTheDocument();
});

test("clicking a note opens it and marks it as the current one", async () => {
  const user = userEvent.setup();
  renderTree();
  await user.click(row(/^Welcome$/));
  expect(app.current).toBe("Welcome.md");
  expect(row(/^Welcome$/).closest("li")).toHaveAttribute("aria-selected", "true");
});

test("the open note's folders open by themselves", async () => {
  renderTree();
  app.open("Projects/Sync design.md");
  expect(await within(tree()).findByRole("button", { name: /^Sync design$/ })).toBeInTheDocument();
  expect(row(/^Projects$/).closest("li")).toHaveAttribute("aria-expanded", "true");
});

test("an image opens in the viewer; other files can't be opened", async () => {
  const user = userEvent.setup();
  app.tree = [entry("attachments", "folder"), entry("attachments/Sketch.svg", "file"), entry("attachments/Data.csv", "file")];
  renderTree();
  await user.click(row(/^attachments$/));
  await user.click(row(/^Sketch\.svg$/));
  expect(app.viewing).toBe("attachments/Sketch.svg");
  expect(row(/^Data\.csv$/)).toHaveAttribute("aria-disabled", "true");
  await user.click(row(/^Data\.csv$/));
  expect(app.viewing).toBe("attachments/Sketch.svg");
  expect(app.current).toBeNull();
});

test("encrypted notes and folders carry a lock", async () => {
  const user = userEvent.setup();
  renderTree();
  expect(within(row(/^Private/)).getByLabelText("Encrypted")).toBeInTheDocument();
  await user.click(row(/^Private/));
  expect(within(row(/^Passport renewal/)).getByLabelText("Encrypted")).toBeInTheDocument();
  expect(within(row(/^Welcome$/)).queryByLabelText("Encrypted")).not.toBeInTheDocument();
});

test("each row's menu offers what fits it", async () => {
  const user = userEvent.setup();
  app.tree = [entry("Projects", "folder"), entry("Welcome.md"), entry("Sketch.svg", "file")];
  renderTree();
  const items = async (name: string) => {
    await user.click(screen.getByRole("button", { name: `Actions for ${name}` }));
    const list = screen.getAllByRole("menuitem").map((m) => m.textContent?.trim());
    await user.keyboard("{Escape}");
    return list;
  };
  expect(await items("Projects")).toEqual(["New note here", "New folder here", "Rename", "Encrypt", "Move to trash"]);
  expect(await items("Welcome")).toEqual(["Rename", "Encrypt", "Move to trash"]);
  expect(await items("Sketch.svg")).toEqual(["Rename", "Move to trash"]);
});

test("new note here creates a note in that folder and opens it", async () => {
  const user = userEvent.setup();
  renderTree();
  await user.click(screen.getByRole("button", { name: "Actions for Templates" }));
  await user.click(screen.getByRole("menuitem", { name: "New note here" }));
  await waitFor(() => expect(app.current).toBe("Templates/Untitled.md"));
  expect(await within(tree()).findByRole("button", { name: /^Untitled$/ })).toBeInTheDocument();
});

test("new folder asks for a name, creates it, opens it and starts a note in it", async () => {
  const user = userEvent.setup();
  const folder = vi.spyOn(api, "folderCreate");
  renderTree();
  await user.click(screen.getByRole("button", { name: "New folder" }));
  const dialog = screen.getByRole("dialog", { name: "New folder" });
  await user.type(within(dialog).getByRole("textbox", { name: "Folder name" }), "Recipes");
  await user.click(within(dialog).getByRole("button", { name: "Create folder" }));
  await waitFor(() => expect(app.current).toBe("Recipes/Untitled.md"));
  expect(folder).toHaveBeenCalledWith("Recipes");
  const recipes = row(/^Recipes$/).closest("li")!;
  expect(recipes).toHaveAttribute("aria-expanded", "true");
  expect(within(recipes).getByRole("button", { name: /^Untitled$/ })).toBeInTheDocument();
});

test("new folder here nests it in the folder", async () => {
  const user = userEvent.setup();
  const folder = vi.spyOn(api, "folderCreate").mockResolvedValue();
  renderTree();
  await user.click(screen.getByRole("button", { name: "Actions for Projects" }));
  await user.click(screen.getByRole("menuitem", { name: "New folder here" }));
  await user.type(screen.getByRole("textbox", { name: "Folder name" }), "Ideas{Enter}");
  await waitFor(() => expect(app.current).toBe("Projects/Ideas/Untitled.md"));
  expect(folder).toHaveBeenCalledWith("Projects/Ideas");
});

test("rename updates the tree and keeps the open note open", async () => {
  const user = userEvent.setup();
  const path = await api.noteCreate("", "Draft");
  await app.refreshFiles();
  app.open(path);
  renderTree();
  await user.click(screen.getByRole("button", { name: "Actions for Draft" }));
  await user.click(screen.getByRole("menuitem", { name: "Rename" }));
  const input = screen.getByRole("textbox", { name: "New name" });
  expect(input).toHaveFocus();
  expect(input).toHaveValue("Draft");
  await user.clear(input);
  await user.type(input, "Final{Enter}");
  expect(await within(tree()).findByRole("button", { name: /^Final$/ })).toBeInTheDocument();
  expect(within(tree()).queryByRole("button", { name: /^Draft$/ })).not.toBeInTheDocument();
  expect(app.current).toBe("Final.md");
});

test("renaming a folder moves the open note with it", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "entryRename").mockResolvedValue("Work");
  vi.spyOn(app, "refreshFiles").mockResolvedValue();
  app.current = "Projects/Wandika.md";
  renderTree();
  await user.click(screen.getByRole("button", { name: "Actions for Projects" }));
  await user.click(screen.getByRole("menuitem", { name: "Rename" }));
  await user.clear(screen.getByRole("textbox", { name: "New name" }));
  await user.type(screen.getByRole("textbox", { name: "New name" }), "Work{Enter}");
  await waitFor(() => expect(app.current).toBe("Work/Wandika.md"));
});

test("Escape leaves the name as it was", async () => {
  const user = userEvent.setup();
  const rename = vi.spyOn(api, "entryRename");
  renderTree();
  await user.click(screen.getByRole("button", { name: "Actions for Welcome" }));
  await user.click(screen.getByRole("menuitem", { name: "Rename" }));
  const input = screen.getByRole("textbox", { name: "New name" });
  await user.type(input, " changed");
  await fireEvent.keyDown(input, { key: "Escape" });
  // WebKit and Chrome blur an input as it leaves the page; that must not save the name.
  await fireEvent.blur(input);
  expect(screen.queryByRole("textbox", { name: "New name" })).not.toBeInTheDocument();
  expect(row(/^Welcome$/)).toBeInTheDocument();
  expect(rename).not.toHaveBeenCalled();
});

test("an unchanged or empty name renames nothing", async () => {
  const user = userEvent.setup();
  const rename = vi.spyOn(api, "entryRename");
  renderTree();
  await user.click(screen.getByRole("button", { name: "Actions for Welcome" }));
  await user.click(screen.getByRole("menuitem", { name: "Rename" }));
  await user.keyboard("{Enter}");
  await user.click(screen.getByRole("button", { name: "Actions for Welcome" }));
  await user.click(screen.getByRole("menuitem", { name: "Rename" }));
  await user.clear(screen.getByRole("textbox", { name: "New name" }));
  await user.keyboard("   {Enter}");
  expect(rename).not.toHaveBeenCalled();
  expect(row(/^Welcome$/)).toBeInTheDocument();
});

test("a failed rename says why", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "entryRename").mockRejectedValue(new AppError("A note with that name already exists.", "message"));
  renderTree();
  await user.click(screen.getByRole("button", { name: "Actions for Welcome" }));
  await user.click(screen.getByRole("menuitem", { name: "Rename" }));
  await user.type(screen.getByRole("textbox", { name: "New name" }), "2{Enter}");
  await waitFor(() => expect(app.toast).toBe("A note with that name already exists."));
});

test("encrypt while locked sends you to unlock first", async () => {
  const user = userEvent.setup();
  app.status = status({ encryption: { set_up: true, unlocked: false, folders: [] } });
  const set = vi.spyOn(api, "setEncrypted");
  renderTree();
  await user.click(screen.getByRole("button", { name: "Actions for Welcome" }));
  await user.click(screen.getByRole("menuitem", { name: "Encrypt" }));
  expect(app.settingsOpen).toBe(true);
  expect(app.settingsSection).toBe("encryption");
  expect(app.toast).toBe("Unlock encrypted notes first.");
  expect(set).not.toHaveBeenCalled();
});

test("encrypt before set-up sends you to set it up", async () => {
  const user = userEvent.setup();
  app.status = status({ encryption: { set_up: false, unlocked: false, folders: [] } });
  renderTree();
  await user.click(screen.getByRole("button", { name: "Actions for Welcome" }));
  await user.click(screen.getByRole("menuitem", { name: "Encrypt" }));
  expect(app.toast).toBe("Set up encryption in Settings first.");
});

test("encrypt turns a note into an encrypted one and follows it if open", async () => {
  const user = userEvent.setup();
  const path = await api.noteCreate("", "Secret");
  await app.refreshFiles();
  app.open(path);
  vi.spyOn(api, "status").mockResolvedValue(status());
  renderTree();
  await user.click(screen.getByRole("button", { name: "Actions for Secret" }));
  await user.click(screen.getByRole("menuitem", { name: "Encrypt" }));
  await waitFor(() => expect(app.toast).toBe("Note encrypted."));
  expect(app.current).toBe("Secret.md.age");
  expect(within(row(/^Secret/)).getByLabelText("Encrypted")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Actions for Secret" }));
  expect(screen.getByRole("menuitem", { name: "Decrypt" })).toBeInTheDocument();
});

test("a folder is encrypted and decrypted from its menu", async () => {
  const user = userEvent.setup();
  const set = vi.spyOn(api, "setEncrypted").mockImplementation(async (p) => p);
  vi.spyOn(api, "status").mockResolvedValue(status());
  renderTree();
  await user.click(screen.getByRole("button", { name: "Actions for Projects" }));
  await user.click(screen.getByRole("menuitem", { name: "Encrypt" }));
  await waitFor(() => expect(app.toast).toBe("Folder encrypted. New notes in it are encrypted too."));
  expect(set).toHaveBeenCalledWith("Projects", true);
  await user.click(screen.getByRole("button", { name: "Actions for Private" }));
  await user.click(screen.getByRole("menuitem", { name: "Decrypt" }));
  await waitFor(() => expect(app.toast).toBe("Folder decrypted."));
  expect(set).toHaveBeenCalledWith("Private", false);
});

test("move to trash asks, removes the note and offers undo", async () => {
  const user = userEvent.setup();
  const path = await api.noteCreate("", "Old idea");
  await app.refreshFiles();
  app.open(path);
  renderTree();
  await user.click(screen.getByRole("button", { name: "Actions for Old idea" }));
  await user.click(screen.getByRole("menuitem", { name: "Move to trash" }));
  const dialog = screen.getByRole("dialog", { name: "Move “Old idea” to the trash?" });
  await user.click(within(dialog).getByRole("button", { name: "Move to trash" }));
  await waitFor(() => expect(within(tree()).queryByRole("button", { name: /^Old idea$/ })).not.toBeInTheDocument());
  expect(app.current).toBeNull();
  expect(app.toast).toBe("Moved “Old idea” to the trash.");
  app.toastAction!.run();
  expect(await within(tree()).findByRole("button", { name: /^Old idea$/ })).toBeInTheDocument();
});

test("trashing a folder warns that everything in it goes", async () => {
  const user = userEvent.setup();
  const trash = vi.spyOn(api, "entryTrash");
  renderTree();
  await user.click(screen.getByRole("button", { name: "Actions for Templates" }));
  await user.click(screen.getByRole("menuitem", { name: "Move to trash" }));
  const dialog = screen.getByRole("dialog", { name: "Move the folder “Templates” and everything in it to the trash?" });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(trash).not.toHaveBeenCalled();
  expect(row(/^Templates$/)).toBeInTheDocument();
});

test("a long list in one folder shows 200 at a time", async () => {
  const user = userEvent.setup();
  app.tree = Array.from({ length: 450 }, (_, i) => entry(`Note ${i}.md`));
  renderTree();
  expect(within(tree()).getAllByRole("treeitem")).toHaveLength(200);
  await user.click(screen.getByRole("button", { name: "Show 200 more of 250" }));
  expect(within(tree()).getAllByRole("treeitem")).toHaveLength(400);
  await user.click(screen.getByRole("button", { name: "Show 50 more" }));
  expect(within(tree()).getAllByRole("treeitem")).toHaveLength(450);
  expect(screen.queryByRole("button", { name: /^Show/ })).not.toBeInTheDocument();
});

test("touch and hold opens the row's menu instead of the note", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  renderTree();
  const welcome = row(/^Welcome$/);
  await fireEvent.pointerDown(welcome, { pointerType: "touch", clientX: 10, clientY: 10 });
  await vi.advanceTimersByTimeAsync(500);
  await fireEvent.pointerUp(welcome, { pointerType: "touch" });
  await fireEvent.click(welcome);
  expect(screen.getByRole("button", { name: "Actions for Welcome" })).toHaveAttribute("aria-expanded", "true");
  expect(app.current).toBeNull();
  // The next tap opens the note as usual.
  await fireEvent.click(welcome);
  expect(app.current).toBe("Welcome.md");
});

test("a touch that moves is a scroll, not a hold", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  renderTree();
  const welcome = row(/^Welcome$/);
  await fireEvent.pointerDown(welcome, { pointerType: "touch", clientX: 10, clientY: 10 });
  await fireEvent.pointerMove(welcome, { pointerType: "touch", clientX: 10, clientY: 40 });
  await vi.advanceTimersByTimeAsync(500);
  expect(screen.getByRole("button", { name: "Actions for Welcome" })).toHaveAttribute("aria-expanded", "false");
});

test("the arrow keys move between rows; Right opens a folder and Left closes it", async () => {
  app.tree = [entry("Daily", "folder"), entry("Daily/2026-11-03.md"), entry("Welcome.md")];
  renderTree();
  const daily = row(/^Daily/);
  daily.focus();
  await fireEvent.keyDown(daily, { key: "ArrowRight" });
  await waitFor(() => expect(row("2026-11-03")).toBeInTheDocument());
  await fireEvent.keyDown(daily, { key: "ArrowDown" });
  expect(row("2026-11-03")).toHaveFocus();
  await fireEvent.keyDown(row("2026-11-03"), { key: "ArrowUp" });
  expect(daily).toHaveFocus();
  await fireEvent.keyDown(daily, { key: "ArrowLeft" });
  await waitFor(() => expect(within(tree()).queryByRole("button", { name: "2026-11-03" })).not.toBeInTheDocument());
});

test("a right-click opens the row's menu", async () => {
  app.tree = [entry("Welcome.md")];
  renderTree();
  await fireEvent.contextMenu(row(/^Welcome/));
  expect(await screen.findByRole("menuitem", { name: /Rename/ })).toBeInTheDocument();
});
