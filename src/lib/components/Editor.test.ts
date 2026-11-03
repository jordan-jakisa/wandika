import "@testing-library/jest-dom/vitest";
import "../../test/components-views";
import { render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetApp, status } from "../../test/components-workspace";
import { api, AppError } from "../api";
import { app } from "../app.svelte";
import Dialog from "./Dialog.svelte";
import Editor from "./Editor.svelte";
import StatusBar from "./StatusBar.svelte";

beforeEach(async () => {
  resetApp();
  app.status = status();
  await app.refreshFiles();
});

afterEach(() => vi.useRealTimers());

const body = () => screen.getByRole("textbox", { name: "Note text" });
const title = () => screen.getByRole("textbox", { name: "Note title" });

/** A fresh note with `text`, open in the editor; each test gets its own so none share a file. */
async function openNote(name: string, text: string, folder = "", props: { compact?: boolean } = {}) {
  const path = await api.noteCreate(folder, name, text);
  await app.refreshFiles();
  app.open(path);
  render(Dialog);
  const view = render(Editor, { path, ...props });
  if (text) await waitFor(() => expect(body()).toHaveTextContent(text.split("\n")[0].replace(/^#+ /, "")));
  return { path, ...view };
}

async function action(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: "Note actions" }));
  await user.click(screen.getByRole("menuitem", { name }));
}

test("opens the note's text under its title, and the status bar counts it", async () => {
  render(StatusBar);
  await openNote("Groceries", "Milk bread and eggs");
  expect(title()).toHaveValue("Groceries");
  expect(body()).toHaveTextContent("Milk bread and eggs");
  expect(screen.getByRole("contentinfo", { name: "Status" })).toHaveTextContent("4 words");
  expect(screen.getByRole("contentinfo", { name: "Status" })).toHaveTextContent("19 characters");
});

test("typing is saved a moment later", async () => {
  const user = userEvent.setup();
  const { path } = await openNote("Diary", "Woke up");
  const write = vi.spyOn(api, "noteWrite");
  await user.click(body());
  await user.keyboard("{Control>}{End}{/Control} early");
  expect(write).not.toHaveBeenCalled();
  await waitFor(() => expect(write).toHaveBeenCalledWith(path, "Woke up early"));
  expect(await api.noteRead(path)).toBe("Woke up early");
});

test("leaving the window saves at once", async () => {
  const user = userEvent.setup();
  const { path } = await openNote("Quick", "One");
  const write = vi.spyOn(api, "noteWrite");
  await user.click(body());
  await user.keyboard("{Control>}{End}{/Control} two");
  window.dispatchEvent(new Event("blur"));
  expect(write).toHaveBeenCalledWith(path, "One two");
});

test("a failed save keeps the text, says so, and Try again saves it", async () => {
  const user = userEvent.setup();
  const { path } = await openNote("Draft", "Text");
  const write = vi.spyOn(api, "noteWrite").mockRejectedValueOnce(new AppError("The disk is full.", "message"));
  await user.click(body());
  await user.keyboard("{Control>}{End}{/Control} more");
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Couldn't save. The disk is full. Your text is safe here, and Wandika keeps trying.");
  expect(body()).toHaveTextContent("Text more");
  await user.click(within(alert).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(write).toHaveBeenLastCalledWith(path, "Text more");
  expect(await api.noteRead(path)).toBe("Text more");
});

test("a failed save tries again by itself", async () => {
  const user = userEvent.setup();
  const { path } = await openNote("Retry", "Text");
  vi.spyOn(api, "noteWrite").mockRejectedValueOnce(new AppError("The disk is full.", "message"));
  await user.click(body());
  await user.keyboard("{Control>}{End}{/Control}!");
  await screen.findByRole("alert");
  // The first retry comes two seconds later.
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument(), { timeout: 3000 });
  expect(await api.noteRead(path)).toBe("Text!");
});

test("a new note opens with its title selected, so typing names it", async () => {
  const user = userEvent.setup();
  await openNote("Untitled", "");
  await waitFor(() => expect(title()).toHaveFocus());
  const input = title() as HTMLInputElement;
  expect(input.value).toMatch(/^Untitled( \d+)?$/);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
  await user.keyboard("Shopping{Enter}");
  await waitFor(() => expect(app.current).toBe("Shopping.md"));
  expect(body()).toHaveFocus();
});

test("renaming in the title renames the file, the tree and the open note", async () => {
  const user = userEvent.setup();
  const { path } = await openNote("Ideas", "Lots");
  const rename = vi.spyOn(api, "entryRename");
  await user.clear(title());
  await user.type(title(), "Better ideas{Enter}");
  await waitFor(() => expect(app.current).toBe("Better ideas.md"));
  expect(rename).toHaveBeenCalledWith(path, "Better ideas");
  expect(app.tree.some((e) => e.path === "Better ideas.md")).toBe(true);
  expect(app.tree.some((e) => e.path === path)).toBe(false);
  expect(title()).toHaveValue("Better ideas");
});

test("Escape puts the title back", async () => {
  const user = userEvent.setup();
  await openNote("Keep me", "Text");
  const rename = vi.spyOn(api, "entryRename");
  await user.type(title(), " please{Escape}");
  expect(title()).toHaveValue("Keep me");
  expect(title()).not.toHaveFocus();
  expect(rename).not.toHaveBeenCalled();
});

test("an empty or unchanged title renames nothing", async () => {
  const user = userEvent.setup();
  await openNote("Same", "Text");
  const rename = vi.spyOn(api, "entryRename");
  await user.click(title());
  await user.keyboard("{Enter}");
  await user.clear(title());
  await user.keyboard("{Enter}");
  expect(title()).toHaveValue("Same");
  expect(rename).not.toHaveBeenCalled();
});

test("a failed rename says why and puts the title back", async () => {
  const user = userEvent.setup();
  await openNote("Taken", "Text");
  vi.spyOn(api, "entryRename").mockRejectedValue(new AppError("“Welcome” already exists here.", "message"));
  await user.clear(title());
  await user.type(title(), "Welcome{Enter}");
  await waitFor(() => expect(app.toast).toBe("“Welcome” already exists here."));
  expect(title()).toHaveValue("Taken");
});

test("a note renamed from elsewhere keeps its text and takes the new title", async () => {
  const { path, rerender } = await openNote("Old name", "Body");
  const read = vi.spyOn(api, "noteRead");
  await rerender({ path: path.replace("Old name", "New name") });
  expect(title()).toHaveValue("New name");
  expect(body()).toHaveTextContent("Body");
  expect(read).not.toHaveBeenCalled();
});

test("a locked note asks for the passphrase, then shows the note", async () => {
  const user = userEvent.setup();
  const path = await api.noteCreate("Private", "Diary", "Dear diary");
  vi.spyOn(api, "noteRead").mockRejectedValueOnce(new AppError("Encrypted notes are locked.", "locked"));
  app.status = status({ encryption: { set_up: true, unlocked: false, folders: ["Private"] } });
  app.open(path);
  render(Editor, { path });
  expect(await screen.findByText("This note is encrypted.")).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Note text" })).not.toBeInTheDocument();
  expect(screen.getByText("Encrypted")).toBeInTheDocument();
  await user.type(screen.getByLabelText("Passphrase"), "correct horse");
  await user.click(screen.getByRole("button", { name: "Unlock" }));
  await waitFor(() => expect(body()).toHaveTextContent("Dear diary"));
  expect(body()).toBeVisible();
  expect(screen.queryByLabelText("Passphrase")).not.toBeInTheDocument();
});

test("a note that can't be read says why and offers no writing tools", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "noteRead").mockRejectedValue(new AppError("That note no longer exists.", "message"));
  app.open("Gone.md");
  render(Editor, { path: "Gone.md" });
  expect(await screen.findByText("That note no longer exists.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Note actions" }));
  expect(screen.queryByRole("menuitem", { name: "Add image" })).not.toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: "Insert template" })).not.toBeInTheDocument();
});

test("Encrypt note encrypts it, says so and keeps it open", async () => {
  const user = userEvent.setup();
  const { path, rerender } = await openNote("Bank", "PIN hint");
  expect(screen.queryByText("Encrypted")).not.toBeInTheDocument();
  await action(user, "Encrypt note");
  await waitFor(() => expect(app.toast).toBe("Note encrypted."));
  expect(app.current).toBe(path + ".age");
  // The workspace passes the open note's new path, as it does for a rename.
  await rerender({ path: app.current! });
  expect(screen.getByText("Encrypted")).toBeInTheDocument();
  expect(body()).toHaveTextContent("PIN hint");
  await user.click(screen.getByRole("button", { name: "Note actions" }));
  expect(screen.getByRole("menuitem", { name: "Decrypt note" })).toBeInTheDocument();
});

test("Decrypt note turns it back into a plain note", async () => {
  const user = userEvent.setup();
  const path = await api.noteCreate("", "Plain again", "Text");
  const encrypted = await api.setEncrypted(path, true);
  await app.refreshFiles();
  vi.spyOn(api, "noteRead").mockResolvedValue("Text");
  app.open(encrypted);
  render(Dialog);
  render(Editor, { path: encrypted });
  await waitFor(() => expect(body()).toHaveTextContent("Text"));
  await action(user, "Decrypt note");
  await waitFor(() => expect(app.toast).toBe("Note decrypted."));
  expect(app.current).toBe(path);
});

test("Encrypt note while locked sends you to unlock first", async () => {
  const user = userEvent.setup();
  await openNote("Later", "Text");
  app.status = status({ encryption: { set_up: true, unlocked: false, folders: [] } });
  const set = vi.spyOn(api, "setEncrypted");
  await action(user, "Encrypt note");
  expect(app.settingsOpen).toBe(true);
  expect(app.settingsSection).toBe("encryption");
  expect(app.toast).toBe("Unlock encrypted notes first.");
  expect(set).not.toHaveBeenCalled();
});

test("Encrypt note before set-up sends you to set it up", async () => {
  const user = userEvent.setup();
  await openNote("Not yet", "Text");
  app.status = status({ encryption: { set_up: false, unlocked: false, folders: [] } });
  await action(user, "Encrypt note");
  expect(app.settingsSection).toBe("encryption");
  expect(app.toast).toBe("Set up encryption in Settings first.");
});

test("a failed encrypt says why", async () => {
  const user = userEvent.setup();
  const { path } = await openNote("Stuck", "Text");
  vi.spyOn(api, "setEncrypted").mockRejectedValue(new AppError("Encrypted notes are locked.", "locked"));
  await action(user, "Encrypt note");
  await waitFor(() => expect(app.toast).toBe("Encrypted notes are locked."));
  expect(app.current).toBe(path);
});

test("Move to trash asks, then closes the note and offers undo", async () => {
  const user = userEvent.setup();
  const { path } = await openNote("Scrap", "Text");
  await action(user, "Move to trash");
  const dialog = screen.getByRole("dialog", { name: "Move “Scrap” to the trash?" });
  await user.click(within(dialog).getByRole("button", { name: "Move to trash" }));
  await waitFor(() => expect(app.toast).toBe("Moved “Scrap” to the trash."));
  expect(app.current).toBeNull();
  expect(app.tree.some((e) => e.path === path)).toBe(false);
  expect(app.toastAction?.label).toBe("Undo");
});

test("Cancel on the trash question keeps the note", async () => {
  const user = userEvent.setup();
  const { path } = await openNote("Keeper", "Text");
  await action(user, "Move to trash");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(app.current).toBe(path);
  expect(app.tree.some((e) => e.path === path)).toBe(true);
});

test("Show in graph saves, then shows the graph around this note", async () => {
  const user = userEvent.setup();
  const { path } = await openNote("Hub", "Links");
  await user.click(body());
  await user.keyboard("{Control>}{End}{/Control} here");
  await action(user, "Show in graph");
  await waitFor(() => expect(app.tab).toBe("graph"));
  expect(app.current).toBeNull();
  expect(app.graphFocus).toBe(path);
  expect(app.graphLocal).toBe(true);
  expect(await api.noteRead(path)).toBe("Links here");
});

test("Insert template puts the chosen template, filled in, at the end of the note", async () => {
  const user = userEvent.setup();
  const { path } = await openNote("Standup", "Before");
  const write = vi.spyOn(api, "noteWrite");
  await action(user, "Insert template");
  const dialog = await screen.findByRole("dialog", { name: "Insert template" });
  await user.click(within(dialog).getByRole("button", { name: "Meeting" }));
  await waitFor(() => expect(body()).toHaveTextContent("Standup"));
  expect(body()).toHaveTextContent("Attendees");
  await waitFor(() => expect(write).toHaveBeenCalled());
  expect(write.mock.lastCall![1]).toMatch(/^Before\n\n## Standup\n/);
  expect(write.mock.lastCall![0]).toBe(path);
});

test("Insert template with no templates says where to put them", async () => {
  const user = userEvent.setup();
  await openNote("Bare", "Text");
  vi.spyOn(api, "templatesList").mockResolvedValue([]);
  await action(user, "Insert template");
  await waitFor(() => expect(app.toast).toBe("Put notes in a Templates folder to insert them here."));
  expect(screen.queryByRole("dialog", { name: "Insert template" })).not.toBeInTheDocument();
});

test("Add image saves the picked images and embeds each on its own line", async () => {
  const user = userEvent.setup({ applyAccept: true });
  const { path } = await openNote("Trip", "Photos:");
  const save = vi.spyOn(api, "attachmentSave");
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const click = vi.spyOn(picker, "click");
  await action(user, "Add image");
  expect(click).toHaveBeenCalled();
  await user.upload(picker, [new File(["a"], "beach.png", { type: "image/png" }), new File(["b"], "sunset.png", { type: "image/png" })]);
  await waitFor(() => expect(body()).toHaveTextContent("sunset.png"));
  expect(save.mock.calls.map((c) => [c[0], c[1]])).toEqual([
    [path, "beach.png"],
    [path, "sunset.png"],
  ]);
  const write = vi.spyOn(api, "noteWrite");
  await waitFor(() => expect(write).toHaveBeenCalled());
  expect(write.mock.lastCall![1]).toMatch(/^Photos:\n!\[\[beach( \d+)?\.png\]\]\n!\[\[sunset( \d+)?\.png\]\]$/);
});

test("Add drawing opens the drawing pad; the saved drawing is embedded in the note", async () => {
  const user = userEvent.setup();
  const { path } = await openNote("Sketches", "Ideas:");
  await action(user, "Add drawing");
  expect(app.drawing).toMatchObject({ note: path, edit: null });
  app.drawing!.saved!("attachments/Drawing 2026-11-03 0900.svg");
  app.drawing = null;
  const write = vi.spyOn(api, "noteWrite");
  await waitFor(() => expect(write).toHaveBeenCalled());
  expect(write.mock.lastCall![1]).toBe("Ideas:\n![[Drawing 2026-11-03 0900.svg]]");
});

test("Edit drawing on a drawing in the note opens it on the pad", async () => {
  const { path } = await openNote("Sketches", "Ideas:");
  document.querySelector(".cm-content")!.dispatchEvent(
    new CustomEvent("wandika-edit-drawing", { bubbles: true, detail: { target: "Drawing.svg", from: path } }),
  );
  expect(app.drawing).toEqual({ note: path, edit: { target: "Drawing.svg", from: path } });
});

test("an image that can't be saved says which one", async () => {
  const user = userEvent.setup();
  await openNote("Broken", "Text");
  vi.spyOn(api, "attachmentSave").mockRejectedValue(new AppError("The disk is full.", "message"));
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await user.upload(picker, new File(["a"], "big.png", { type: "image/png" }));
  await waitFor(() => expect(app.toast).toBe("Couldn't add big.png: The disk is full."));
  expect(body()).toHaveTextContent("Text");
  expect(body()).not.toHaveTextContent("big.png");
});

test("notes that link here are listed under it and open with a click", async () => {
  const user = userEvent.setup();
  await api.noteCreate("", "Linker", "See [[Target note]] for more.");
  await openNote("Target note", "I am linked");
  const section = await screen.findByRole("region", { name: "Linked from 1 note" });
  await user.click(within(section).getByRole("button", { name: /Linker/ }));
  expect(app.current).toBe("Linker.md");
});

test("clicking a link to a note opens it", async () => {
  const user = userEvent.setup();
  await api.noteCreate("", "Destination", "Here");
  await openNote("Start here", "First line\n\nGo to [[Destination]] now");
  await user.click(body().querySelector(".cm-wikilink")!);
  await waitFor(() => expect(app.current).toBe("Destination.md"));
});

test("clicking a link to a note that doesn't exist yet creates it", async () => {
  const user = userEvent.setup();
  await openNote("Plans", "First line\n\nNext: [[Fresh page]]");
  await user.click(body().querySelector(".cm-wikilink")!);
  await waitFor(() => expect(app.current).toBe("Fresh page.md"));
  expect(app.tree.some((e) => e.path === "Fresh page.md")).toBe(true);
});

test("web and mail links open outside the app; other links don't", async () => {
  const user = userEvent.setup();
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await openNote("Links", "First line\n\n[site](https://example.com) [mail](mailto:a@b.co) [file](file:///etc/hosts)");
  const links = [...body().querySelectorAll<HTMLElement>(".cm-md-link")];
  expect(links).toHaveLength(3);
  for (const l of links) await user.click(l);
  expect(open.mock.calls.map((c) => c[0])).toEqual(["https://example.com", "mailto:a@b.co"]);
});

test("clicking a tag shows every note with it", async () => {
  const user = userEvent.setup();
  await openNote("Tagged", "First line\n\nAbout #garden things");
  await user.click(body().querySelector(".cm-tag")!);
  expect(app.tab).toBe("projects");
  expect(app.tagFilter).toBe("garden");
  expect(app.current).toBeNull();
});

test("a board note shows as columns and switches to Markdown and back", async () => {
  const user = userEvent.setup();
  const board = "---\n\nkanban-plugin: basic\n\n---\n\n## To do\n\n- [ ] Paint the fence\n\n## Done\n\n";
  const path = await api.noteCreate("", "Chores", board);
  await app.refreshFiles();
  app.open(path);
  render(Dialog);
  render(Editor, { path });
  expect(await screen.findByRole("region", { name: "To do" })).toHaveTextContent("Paint the fence");
  expect(screen.getByRole("region", { name: "Done" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Note actions" }));
  expect(screen.queryByRole("menuitem", { name: "Add image" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("menuitem", { name: "Edit as Markdown" }));
  await waitFor(() => expect(body()).toHaveTextContent("kanban-plugin"));
  expect(body()).toHaveTextContent("Paint the fence");
  expect(screen.queryByRole("region", { name: "To do" })).not.toBeInTheDocument();
  await action(user, "Show as board");
  expect(await screen.findByRole("region", { name: "To do" })).toBeInTheDocument();
});

test("a sync that changed the open note shows the new text", async () => {
  const { path } = await openNote("Shared", "Mine");
  await api.noteWrite(path, "Mine and theirs");
  app.changed = { paths: [path], at: Date.now() };
  await waitFor(() => expect(body()).toHaveTextContent("Mine and theirs"));
});

test("a sync doesn't overwrite typing that isn't saved yet", async () => {
  const user = userEvent.setup();
  const { path } = await openNote("Busy", "Mine");
  await user.click(body());
  await user.keyboard("{Control>}{End}{/Control} typing");
  const read = vi.spyOn(api, "noteRead");
  app.changed = { paths: [path], at: Date.now() };
  await new Promise((r) => setTimeout(r, 100));
  expect(read).not.toHaveBeenCalled();
  expect(body()).toHaveTextContent("Mine typing");
});

test("a note deleted on another device closes and says so", async () => {
  const { path } = await openNote("Vanishing", "Here");
  await api.entryTrash(path);
  app.changed = { paths: [path], at: Date.now() };
  await waitFor(() => expect(app.toast).toBe("“Vanishing” was deleted on another device."));
  expect(app.current).toBeNull();
});

test("leaving an empty new note throws it away", async () => {
  const { path, unmount } = await openNote("Untitled", "");
  await waitFor(() => expect(title()).toHaveFocus());
  unmount();
  await waitFor(() => expect(app.tree.some((e) => e.path === path)).toBe(false));
});

test("leaving a note with text keeps it", async () => {
  const discard = vi.spyOn(api, "noteDiscardIfEmpty");
  const { path, unmount } = await openNote("Untitled", "Something");
  unmount();
  await new Promise((r) => setTimeout(r, 100));
  expect(discard).not.toHaveBeenCalled();
  expect(app.tree.some((e) => e.path === path)).toBe(true);
});

test("on a phone, Back returns to the list", async () => {
  const user = userEvent.setup();
  await openNote("Pocket", "Text", "", { compact: true });
  await user.click(screen.getByRole("button", { name: "Back to notes" }));
  expect(app.current).toBeNull();
});

test("on a phone, the writing toolbar shows while typing", async () => {
  const user = userEvent.setup();
  await openNote("Thumbs", "Text", "", { compact: true });
  expect(screen.queryByRole("toolbar", { name: "Writing tools" })).not.toBeInTheDocument();
  await user.click(body());
  expect(screen.getByRole("toolbar", { name: "Writing tools" })).toBeInTheDocument();
  await user.click(title());
  expect(screen.queryByRole("toolbar", { name: "Writing tools" })).not.toBeInTheDocument();
});

test("on a desktop there is no Back button and no writing toolbar", async () => {
  const user = userEvent.setup();
  await openNote("Desk", "Text");
  await user.click(body());
  expect(screen.queryByRole("button", { name: "Back to notes" })).not.toBeInTheDocument();
  expect(screen.queryByRole("toolbar", { name: "Writing tools" })).not.toBeInTheDocument();
});

test("the cursor and scroll come back when a note is opened again", async () => {
  const user = userEvent.setup();
  const { unmount, path } = await openNote("Long", "Line one\nLine two\nLine three");
  await user.click(body());
  await user.keyboard("{Control>}{End}{/Control}");
  unmount();
  render(Editor, { path });
  await waitFor(() => expect(body()).toHaveTextContent("Line three"));
  // Typing lands where the cursor was left, at the end, without clicking to place it.
  body().focus();
  await user.keyboard("!");
  await waitFor(() => expect(api.noteRead(path)).resolves.toMatch(/three!$/));
});
