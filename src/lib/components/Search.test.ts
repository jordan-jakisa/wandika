import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { resetApp, status } from "../../test/components-workspace";
import { api, AppError } from "../api";
import { app } from "../app.svelte";
import type { SearchHit } from "../types";
import Search from "./Search.svelte";

const hit = (path: string, snippet = ""): SearchHit => ({
  path,
  title: path.split("/").pop()!.replace(/\.md$/, ""),
  snippet,
  encrypted: false,
});

beforeEach(async () => {
  resetApp();
  app.status = status();
  await app.refreshFiles();
});

const options = () => within(screen.getByRole("listbox")).queryAllByRole("option");

test("the field is ready to type in", async () => {
  render(Search);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Search notes" })).toHaveFocus());
});

test("before typing it lists recent notes", () => {
  render(Search);
  const list = screen.getByRole("listbox", { name: "Recent notes" });
  expect(within(list).getByText("Recent")).toBeInTheDocument();
  expect(options()).toHaveLength(Math.min(8, app.titles.length));
  expect(options()[0]).toHaveAttribute("aria-selected", "true");
});

test("with no notes it says how to make one", () => {
  app.titles = [];
  render(Search);
  expect(screen.getByText("No notes yet. Type a title and press Return to create one.")).toBeInTheDocument();
  expect(options()).toHaveLength(0);
});

test("typing shows matching notes with a snippet and folder", async () => {
  const user = userEvent.setup();
  render(Search);
  await user.type(screen.getByRole("combobox"), "three-way");
  // Recent notes stay until the first results arrive.
  const list = await screen.findByRole("listbox", { name: "Results" });
  const found = within(list).getByRole("option", { name: /Sync design/ });
  expect(found).toHaveTextContent("Three-way merge");
  expect(found).toHaveTextContent("Projects");
  expect(screen.getByRole("listbox", { name: "Results" })).toBeInTheDocument();
});

test("clicking a result opens the note and closes the palette", async () => {
  const user = userEvent.setup();
  app.switcherOpen = true;
  app.tab = "tasks";
  render(Search);
  await user.type(screen.getByRole("combobox"), "reading");
  await user.click(await screen.findByRole("option", { name: /^Reading list/ }));
  expect(app.current).toBe("Reading list.md");
  expect(app.switcherOpen).toBe(false);
  expect(app.tab).toBe("notes");
});

test("arrow keys move the selection and Return opens it", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "search").mockResolvedValue([hit("A.md"), hit("B.md"), hit("C.md")]);
  render(Search);
  const box = screen.getByRole("combobox");
  await user.type(box, "x");
  await screen.findByRole("option", { name: "A" });
  expect(box).toHaveAttribute("aria-activedescendant", "hit-0");
  await user.keyboard("{ArrowDown}{ArrowDown}");
  expect(screen.getByRole("option", { name: "C" })).toHaveAttribute("aria-selected", "true");
  expect(box).toHaveAttribute("aria-activedescendant", "hit-2");
  await user.keyboard("{ArrowDown}");
  // Past the last result comes "Create", then back to the top.
  expect(screen.getByRole("option", { name: "Create “x”" })).toHaveAttribute("aria-selected", "true");
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("option", { name: "A" })).toHaveAttribute("aria-selected", "true");
  await user.keyboard("{ArrowUp}{ArrowUp}");
  expect(screen.getByRole("option", { name: "C" })).toHaveAttribute("aria-selected", "true");
  await user.keyboard("{Enter}");
  expect(app.current).toBe("C.md");
});

test("a title with no note offers to create it, and creating opens it", async () => {
  const user = userEvent.setup();
  render(Search);
  await user.type(screen.getByRole("combobox"), "Groceries");
  await user.click(await screen.findByRole("option", { name: "Create “Groceries”" }));
  await waitFor(() => expect(app.current).toBe("Groceries.md"));
  expect(app.titles.some((t) => t.path === "Groceries.md")).toBe(true);
});

test("creating goes where new notes go", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "search").mockResolvedValue([]);
  vi.spyOn(api, "newNoteFolder").mockResolvedValue("Inbox");
  const create = vi.spyOn(api, "noteCreate").mockResolvedValue("Inbox/Idea.md");
  render(Search);
  await user.type(screen.getByRole("combobox"), "  Idea  ");
  await screen.findByRole("option", { name: "Create “Idea”" });
  await user.keyboard("{Enter}");
  await waitFor(() => expect(app.current).toBe("Inbox/Idea.md"));
  expect(create).toHaveBeenCalledWith("Inbox", "Idea");
});

test("a note with exactly that title isn't offered again", async () => {
  const user = userEvent.setup();
  render(Search);
  await user.type(screen.getByRole("combobox"), "reading list");
  await screen.findByRole("option", { name: /^Reading list/ });
  expect(screen.queryByRole("option", { name: /^Create/ })).not.toBeInTheDocument();
});

test("a failed create says why", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "search").mockResolvedValue([]);
  vi.spyOn(api, "noteCreate").mockRejectedValue(new AppError("The disk is full.", "message"));
  render(Search);
  await user.type(screen.getByRole("combobox"), "Plan");
  await user.click(await screen.findByRole("option", { name: "Create “Plan”" }));
  await waitFor(() => expect(app.toast).toBe("The disk is full."));
  expect(app.current).toBeNull();
});

test("a failed search says so", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "search").mockRejectedValue(new AppError("The search index is busy.", "message"));
  render(Search);
  await user.type(screen.getByRole("combobox"), "sync");
  expect(await screen.findByText("Search didn't finish. The search index is busy.")).toBeInTheDocument();
});

test("a slow answer to an older query doesn't replace newer results", async () => {
  const user = userEvent.setup();
  const answers: Record<string, (h: SearchHit[]) => void> = {};
  vi.spyOn(api, "search").mockImplementation((q) => new Promise((r) => (answers[q] = r)));
  render(Search);
  const box = screen.getByRole("combobox");
  await user.type(box, "a");
  await waitFor(() => expect(answers.a).toBeDefined());
  await user.type(box, "b");
  await waitFor(() => expect(answers.ab).toBeDefined());
  answers.ab([hit("New.md")]);
  await screen.findByRole("option", { name: "New" });
  answers.a([hit("Old.md")]);
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByRole("option", { name: "Old" })).not.toBeInTheDocument();
});

test("clearing the field goes back to recent notes", async () => {
  const user = userEvent.setup();
  render(Search);
  const box = screen.getByRole("combobox");
  await user.type(box, "zzzz");
  await screen.findByRole("option", { name: "Create “zzzz”" });
  await user.clear(box);
  expect(screen.getByRole("listbox", { name: "Recent notes" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /^Create/ })).not.toBeInTheDocument();
});

test("Escape closes the palette", async () => {
  const user = userEvent.setup();
  app.switcherOpen = true;
  render(Search, { props: { mode: "palette" } });
  await user.type(screen.getByRole("combobox"), "{Escape}");
  expect(app.switcherOpen).toBe(false);
});

test("Escape leaves the Search tab alone", async () => {
  const user = userEvent.setup();
  app.switcherOpen = true;
  render(Search, { props: { mode: "page" } });
  await user.type(screen.getByRole("combobox"), "{Escape}");
  expect(app.switcherOpen).toBe(true);
});

test("on the Search page, the back arrow empties the field and leaves", async () => {
  const user = userEvent.setup();
  const onExit = vi.fn();
  render(Search, { mode: "page", onExit });
  const field = screen.getByRole("combobox", { name: "Search notes" });
  await user.type(field, "plan");
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(onExit).toHaveBeenCalledTimes(1);
  expect(field).toHaveValue("");
  expect(field).not.toHaveFocus();
});

test("the clear button shows once there's text, and clears it", async () => {
  const user = userEvent.setup();
  render(Search, { mode: "page", onExit: vi.fn() });
  expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
  const field = screen.getByRole("combobox", { name: "Search notes" });
  await user.type(field, "plan");
  await user.click(screen.getByRole("button", { name: "Clear search" }));
  expect(field).toHaveValue("");
  expect(field).toHaveFocus();
});

test("Escape leaves the Search page too", async () => {
  const user = userEvent.setup();
  const onExit = vi.fn();
  render(Search, { mode: "page", onExit });
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Search notes" })).toHaveFocus());
  await user.keyboard("{Escape}");
  expect(onExit).toHaveBeenCalled();
});

test("the ⌘K palette has no back arrow; Escape closes it as before", () => {
  render(Search);
  expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
});
