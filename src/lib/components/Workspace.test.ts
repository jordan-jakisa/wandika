import "@testing-library/jest-dom/vitest";
import { recordCanvas } from "../../test/components-views";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { githubVault, resetApp, setWidth, status } from "../../test/components-workspace";
import { noTouch } from "../../test/lib";
import { api } from "../api";
import { app } from "../app.svelte";
import type { NoteMeta } from "../types";
import Dialog from "./Dialog.svelte";
import ImageViewer from "./ImageViewer.svelte";
import Workspace from "./Workspace.svelte";

const synced = () => status({ vault: githubVault, known: [githubVault] });
let canvas: ReturnType<typeof recordCanvas>;

beforeEach(async () => {
  resetApp();
  canvas = recordCanvas();
  app.status = status();
  await app.refreshFiles();
  vi.spyOn(api, "today").mockResolvedValue({ events: [], mail: [], tasks: [], remote_tasks: [], errors: {} });
  setWidth(1200);
});

afterEach(() => {
  canvas.restore();
  if (history.state?.wandika) history.replaceState(null, "");
});

function renderWorkspace() {
  render(Dialog);
  return render(Workspace);
}

const sidebar = () => screen.getByRole("complementary", { name: "Vault" });
const views = () => within(screen.getByRole("navigation", { name: "Views" }));
const main = () => within(document.querySelector<HTMLElement>("main.main")!);
/** A new note's title: "Untitled", or "Untitled 2" once one exists. */
const untitled = /^Untitled( \d+)?$/;
const valueOf = (el: HTMLElement) => (el as HTMLInputElement).value;
const mod = (key: string) => fireEvent.keyDown(window, { key, ctrlKey: true });

/** Puts the vault's notes in a fixed order of last change, newest first. */
function byAge(paths: string[]) {
  const now = Date.now();
  app.titles = paths.map((p, i) => ({ ...app.titles.find((t) => t.path === p)!, modified: now - i * 1000 }) as NoteMeta);
}

describe("on a desktop", () => {
  test("the sidebar has the vault's name, search, new note, the views and the files", () => {
    renderWorkspace();
    expect(within(sidebar()).getByText("Notes")).toBeInTheDocument();
    expect(within(sidebar()).getByRole("button", { name: /Search/ })).toBeInTheDocument();
    expect(within(sidebar()).getByRole("button", { name: "New note" })).toBeInTheDocument();
    // Today has its own column at this width, so it isn't a view here.
    expect(views().getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["Today's note", "Tasks", "Projects", "Graph"]);
    expect(within(sidebar()).getByRole("tree", { name: "Notes" })).toBeInTheDocument();
    expect(screen.getByRole("contentinfo", { name: "Status" })).toBeInTheDocument();
  });

  test("Settings opens Settings", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(within(sidebar()).getByRole("button", { name: "Settings" }));
    expect(app.settingsOpen).toBe(true);
    expect(app.settingsDirect).toBe(false);
  });

  test("the sidebar hides and comes back, and stays as you left it", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWorkspace();
    await user.click(screen.getByRole("button", { name: "Hide the sidebar" }));
    expect(screen.queryByRole("complementary", { name: "Vault" })).not.toBeInTheDocument();
    unmount();
    renderWorkspace();
    expect(screen.queryByRole("complementary", { name: "Vault" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show the sidebar" }));
    expect(sidebar()).toBeVisible();
    expect(screen.queryByRole("button", { name: "Show the sidebar" })).not.toBeInTheDocument();
  });

  test("the sidebar's width is set from the keyboard and kept", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWorkspace();
    const edge = screen.getByRole("separator", { name: "Resize the sidebar" });
    expect(edge).toHaveAttribute("aria-valuenow", "268");
    edge.focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(edge).toHaveAttribute("aria-valuenow", "300");
    unmount();
    renderWorkspace();
    expect(screen.getByRole("separator", { name: "Resize the sidebar" })).toHaveAttribute("aria-valuenow", "300");
  });

  test("Search opens the switcher; picking a note opens it and closes the switcher", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(within(sidebar()).getByRole("button", { name: /Search/ }));
    const switcher = document.querySelector<HTMLDialogElement>("dialog.switcher")!;
    expect(switcher).toHaveAttribute("open");
    await user.type(within(switcher).getByRole("combobox", { name: "Search notes" }), "reading");
    await user.click(await within(switcher).findByRole("option", { name: /^Reading list/ }));
    expect(app.current).toBe("Reading list.md");
    expect(switcher).not.toHaveAttribute("open");
    expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue("Reading list");
  });

  test("Escape or a click outside closes the switcher", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const switcher = document.querySelector<HTMLDialogElement>("dialog.switcher")!;
    await user.click(within(sidebar()).getByRole("button", { name: /Search/ }));
    await user.keyboard("{Escape}");
    expect(app.switcherOpen).toBe(false);
    expect(switcher).not.toHaveAttribute("open");
    await user.click(within(sidebar()).getByRole("button", { name: /Search/ }));
    await user.click(switcher);
    expect(app.switcherOpen).toBe(false);
    expect(switcher).not.toHaveAttribute("open");
  });

  test("New note makes an untitled note and opens it, ready to name", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(within(sidebar()).getByRole("button", { name: "New note" }));
    const title = await screen.findByRole("textbox", { name: "Note title" });
    expect(valueOf(title)).toMatch(untitled);
    await waitFor(() => expect(title).toHaveFocus());
    expect(app.current).toMatch(/^Untitled( \d+)?\.md$/);
  });

  test("Today's note opens today's daily note", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(views().getByRole("button", { name: "Today's note" }));
    const path = await api.dailyNote();
    await waitFor(() => expect(app.current).toBe(path));
    expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue(path.split("/").pop()!.replace(/\.md$/, ""));
  });

  test("Tasks, Projects and Graph each fill the main area and show as the current view", async () => {
    const user = userEvent.setup();
    app.open("Welcome.md");
    renderWorkspace();
    for (const name of ["Tasks", "Projects", "Graph"]) {
      await user.click(views().getByRole("button", { name }));
      expect(main().getByRole("heading", { level: 2, name })).toBeInTheDocument();
      expect(app.current).toBeNull();
      expect(views().getByRole("button", { name })).toHaveClass("active");
      expect(views().getAllByRole("button").filter((b) => b.classList.contains("active"))).toHaveLength(1);
    }
  });

  test("with room, Today has its own column that can be hidden and shown", async () => {
    const user = userEvent.setup();
    setWidth(1600);
    renderWorkspace();
    const column = screen.getByRole("complementary", { name: "Today" });
    expect(within(column).getByRole("button", { name: "Open today's note" })).toBeInTheDocument();
    expect(views().queryByRole("button", { name: "Today" })).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Hide Today" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    expect(screen.queryByRole("complementary", { name: "Today" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show Today" })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "Show Today" }));
    expect(screen.getByRole("complementary", { name: "Today" })).toBeInTheDocument();
  });

  test("Today can fill the window, in columns, and Escape or the button brings the notes back", async () => {
    const user = userEvent.setup();
    setWidth(1600);
    renderWorkspace();
    await user.click(within(screen.getByRole("complementary", { name: "Today" })).getByRole("button", { name: "Full screen" }));
    expect(app.todayFull).toBe(true);
    expect(screen.queryByRole("complementary", { name: "Vault" })).not.toBeInTheDocument();
    expect(document.querySelector(".today.full")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Full screen" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Exit full screen" }));
    expect(app.todayFull).toBe(false);
    expect(sidebar()).toBeInTheDocument();
    app.todayFull = true;
    await user.keyboard("{Escape}");
    expect(app.todayFull).toBe(false);
  });

  test("in full-screen Today, Escape closes an open dialog first", async () => {
    setWidth(1600);
    renderWorkspace();
    app.todayFull = true;
    const d = document.createElement("dialog");
    document.body.append(d);
    d.setAttribute("open", "");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(app.todayFull).toBe(true);
    d.remove();
  });

  test("Open today's note leaves full screen for the note", async () => {
    const user = userEvent.setup();
    const daily = vi.spyOn(app, "openDaily").mockResolvedValue();
    setWidth(1600);
    app.todayFull = true;
    renderWorkspace();
    await user.click(await screen.findByRole("button", { name: "Open today's note" }));
    expect(app.todayFull).toBe(false);
    expect(daily).toHaveBeenCalled();
  });

  test("without room, Today is a view in the sidebar instead of a column", async () => {
    const user = userEvent.setup();
    setWidth(1000);
    renderWorkspace();
    expect(screen.queryByRole("complementary", { name: "Today" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hide Today" })).not.toBeInTheDocument();
    await user.click(views().getByRole("button", { name: "Today" }));
    expect(main().getByRole("button", { name: "Open today's note" })).toBeInTheDocument();
    expect(views().getByRole("button", { name: "Today" })).toHaveClass("active");
  });

  test("the Today column steps aside when the window narrows, and comes back", async () => {
    setWidth(1600);
    renderWorkspace();
    expect(screen.getByRole("complementary", { name: "Today" })).toBeInTheDocument();
    setWidth(1000);
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Today" })).not.toBeInTheDocument());
    setWidth(1600);
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Today" })).toBeInTheDocument());
  });

  test("a board and the graph overview take the Today column's room", async () => {
    const user = userEvent.setup();
    setWidth(1600);
    renderWorkspace();
    app.open("Projects/Wandika launch.md");
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Today" })).not.toBeInTheDocument());
    app.current = null;
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Today" })).toBeInTheDocument());
    await user.click(views().getByRole("button", { name: "Graph" }));
    expect(screen.queryByRole("complementary", { name: "Today" })).not.toBeInTheDocument();
  });

  test("with nothing open it lists the six latest notes, and one click opens one", async () => {
    const user = userEvent.setup();
    byAge(["Reading list.md", "Projects/Wandika.md", "Welcome.md", "START_HERE.md", "Templates/Meeting.md", "Projects/Sync design.md", "Projects/Wandika launch.md"]);
    renderWorkspace();
    expect(main().getByRole("heading", { name: "Recent notes" })).toBeInTheDocument();
    const items = main().getAllByRole("listitem");
    expect(items.map((li) => li.textContent?.trim())).toEqual([
      "Reading list",
      "Wandika Projects",
      "Welcome",
      "START_HERE",
      "Meeting Templates",
      "Sync design Projects",
    ]);
    await user.click(main().getByRole("button", { name: /^Wandika Projects$/ }));
    expect(app.current).toBe("Projects/Wandika.md");
    expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue("Wandika");
  });

  test("an empty vault invites the first note", async () => {
    const user = userEvent.setup();
    app.titles = [];
    renderWorkspace();
    expect(main().getByRole("heading", { name: "Start your first note" })).toBeInTheDocument();
    await user.click(main().getByRole("button", { name: "New note" }));
    expect(valueOf(await screen.findByRole("textbox", { name: "Note title" }))).toMatch(untitled);
  });

  test("elsewhere the shortcuts line is left out", () => {
    renderWorkspace();
    expect(main().queryByText(/Search with ⌘K/)).not.toBeInTheDocument();
  });

  test("the open note fills the main area, and opening another replaces it", async () => {
    renderWorkspace();
    app.open("Welcome.md");
    expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue("Welcome");
    app.open("Reading list.md");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Reading list"));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note text" })).toHaveTextContent("Elements of Typographic Style"));
    expect(screen.getAllByRole("textbox", { name: "Note title" })).toHaveLength(1);
  });

  test("closing a note while it is still loading leaves nothing behind", async () => {
    let answer!: (text: string) => void;
    vi.spyOn(api, "noteRead").mockReturnValueOnce(new Promise((r) => (answer = r)));
    renderWorkspace();
    app.open("Welcome.md");
    await screen.findByRole("textbox", { name: "Note title" });
    app.current = null;
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Note title" })).not.toBeInTheDocument());
    answer("Late text");
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector(".cm-editor")).toBeNull();
    expect(main().getByRole("heading", { name: "Recent notes" })).toBeInTheDocument();
  });
});

describe("keyboard shortcuts", () => {
  test("⌘K and ⌘O open and close the switcher", async () => {
    renderWorkspace();
    await mod("k");
    expect(app.switcherOpen).toBe(true);
    expect(document.querySelector("dialog.switcher")).toHaveAttribute("open");
    await mod("k");
    expect(app.switcherOpen).toBe(false);
    await fireEvent.keyDown(window, { key: "o", metaKey: true });
    expect(app.switcherOpen).toBe(true);
  });

  test("⌘N makes a new note; ⌘⇧N doesn't", async () => {
    renderWorkspace();
    await fireEvent.keyDown(window, { key: "N", ctrlKey: true, shiftKey: true });
    await new Promise((r) => setTimeout(r, 150));
    expect(app.current).toBeNull();
    await mod("n");
    expect(valueOf(await screen.findByRole("textbox", { name: "Note title" }))).toMatch(untitled);
  });

  test("⌘S syncs now and says what happened", async () => {
    app.status = synced();
    const sync = vi.spyOn(app, "sync").mockResolvedValue();
    renderWorkspace();
    await mod("s");
    expect(sync).toHaveBeenCalledWith(true);
  });

  test("⌘D opens today's note", async () => {
    renderWorkspace();
    await mod("d");
    const path = await api.dailyNote();
    await waitFor(() => expect(app.current).toBe(path));
  });

  test("⌘\\ hides and shows the sidebar", async () => {
    renderWorkspace();
    await mod("\\");
    expect(screen.queryByRole("complementary", { name: "Vault" })).not.toBeInTheDocument();
    await mod("\\");
    expect(sidebar()).toBeInTheDocument();
  });

  test("⌘, opens Settings", async () => {
    renderWorkspace();
    await mod(",");
    expect(app.settingsOpen).toBe(true);
  });

  test("the same keys without ⌘ or Ctrl are just typing", async () => {
    renderWorkspace();
    for (const key of ["k", "n", "s", "d", "\\", ","]) await fireEvent.keyDown(window, { key });
    await new Promise((r) => setTimeout(r, 150));
    expect(app.switcherOpen).toBe(false);
    expect(app.settingsOpen).toBe(false);
    expect(app.current).toBeNull();
    expect(sidebar()).toBeInTheDocument();
  });
});

describe("banners", () => {
  test("a conflict names the note; clicking it opens it, and Dismiss hides the banner", async () => {
    const user = userEvent.setup();
    app.conflicts = ["Welcome.md"];
    renderWorkspace();
    const banner = screen.getAllByRole("status").find((el) => el.textContent?.includes("two devices"))!;
    expect(banner).toHaveTextContent("A note was edited on two devices at once. Both versions are kept: Welcome.");
    await user.click(within(banner).getByRole("button", { name: "Welcome" }));
    expect(app.current).toBe("Welcome.md");
    await user.click(within(banner).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/two devices/)).not.toBeInTheDocument();
    expect(app.conflicts).toEqual([]);
  });

  test("several conflicts are listed together", () => {
    app.conflicts = ["Welcome.md", "Projects/Wandika.md"];
    renderWorkspace();
    expect(screen.getByText(/2 notes were edited on two devices at once/).closest("[role=status]")).toHaveTextContent(
      "Both versions are kept: Welcome, Wandika.",
    );
  });

  test("files held back from deletion can be brought back", async () => {
    const user = userEvent.setup();
    app.heldDeletions = ["a.md", "b.md", "c.md"];
    const held = vi.spyOn(api, "syncHeldDeletions").mockResolvedValue();
    renderWorkspace();
    expect(screen.getByText(/3 files are missing on this device/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Bring them back" }));
    await waitFor(() => expect(app.toast).toBe("3 files are back."));
    expect(held).toHaveBeenCalledWith(false, ["a.md", "b.md", "c.md"]);
    expect(screen.queryByText(/missing on this device/)).not.toBeInTheDocument();
  });

  test("one file held back is spoken of as one", () => {
    app.heldDeletions = ["a.md"];
    renderWorkspace();
    expect(screen.getByText(/missing on this device/)).toHaveTextContent(
      "One file is missing on this device, so sync kept it on GitHub instead of deleting it everywhere.",
    );
    expect(screen.getByRole("button", { name: "Bring it back" })).toBeInTheDocument();
  });

  test("files held back from deletion can be deleted everywhere, after a question", async () => {
    const user = userEvent.setup();
    app.status = synced();
    app.heldDeletions = ["a.md", "b.md"];
    const held = vi.spyOn(api, "syncHeldDeletions").mockResolvedValue();
    const sync = vi.spyOn(app, "sync").mockResolvedValue();
    renderWorkspace();
    await user.click(screen.getByRole("button", { name: "Delete everywhere" }));
    const dialog = screen.getByRole("dialog", { name: "Delete 2 files everywhere?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete everywhere" }));
    await waitFor(() => expect(held).toHaveBeenCalledWith(true, ["a.md", "b.md"]));
    expect(sync).toHaveBeenCalledWith(true);
    expect(screen.queryByText(/missing on this device/)).not.toBeInTheDocument();
  });

  test("several files too big to sync are named together", () => {
    app.tooBig = ["Videos/Talk.mp4", "Videos/Demo.mov"];
    renderWorkspace();
    expect(screen.getByText(/over 50 MB/)).toHaveTextContent("2 files are over 50 MB and stay on this device only: Talk.mp4, Demo.mov.");
  });

  test("files too big to sync are named, and Dismiss hides them", async () => {
    const user = userEvent.setup();
    app.tooBig = ["Videos/Talk.mp4"];
    renderWorkspace();
    const banner = screen.getByText(/over 50 MB/).closest<HTMLElement>("[role=status]")!;
    expect(banner).toHaveTextContent("One file is over 50 MB and stays on this device only: Talk.mp4.");
    await user.click(within(banner).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/over 50 MB/)).not.toBeInTheDocument();
  });
});

describe("leaving and coming back to the app", () => {
  let state: DocumentVisibilityState = "visible";
  beforeEach(() => {
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
  });

  test("hiding the app saves the open note; showing it again syncs", async () => {
    app.status = synced();
    const flush = vi.fn(async () => {});
    const sync = vi.spyOn(app, "sync").mockResolvedValue();
    renderWorkspace();
    app.flush = flush;
    state = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(flush).toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sync).toHaveBeenCalledWith();
  });
});

describe("on a phone", () => {
  beforeEach(() => setWidth(400));

  const tabs = () => within(screen.getByRole("navigation", { name: "Sections" }));
  // jsdom has no inert attribute support, so Svelte sets it as a property.
  const inert = (el: Element) => !!(el as HTMLElement).inert || el.hasAttribute("inert");

  test("four tabs and a new note button, starting on Notes", () => {
    renderWorkspace();
    expect(tabs().getAllByRole("button").map((b) => b.textContent?.trim() || b.getAttribute("aria-label"))).toEqual([
      "Notes",
      "Today",
      "Search",
      "Settings",
      "New note",
    ]);
    expect(tabs().getByRole("button", { name: "Notes" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { level: 1, name: "Notes" })).toBeInTheDocument();
    expect(screen.getByRole("tree", { name: "Notes" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Vault" })).not.toBeInTheDocument();
  });

  test("Today and Search tabs switch the screen", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(tabs().getByRole("button", { name: "Today" }));
    expect(screen.getByRole("button", { name: "Open today's note" })).toBeInTheDocument();
    expect(tabs().getByRole("button", { name: "Today" })).toHaveAttribute("aria-current", "page");
    expect(tabs().getByRole("button", { name: "Notes" })).not.toHaveAttribute("aria-current");
    await user.click(tabs().getByRole("button", { name: "Search" }));
    expect(screen.getByRole("combobox", { name: "Search notes" })).toBeInTheDocument();
    await user.click(tabs().getByRole("button", { name: "Notes" }));
    expect(screen.getByRole("tree", { name: "Notes" })).toBeInTheDocument();
  });

  test("the More menu offers the graph, projects, a new drawing and a new voice note; New folder is a button beside it", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    expect(within(document.querySelector<HTMLElement>(".phone-head")!).getByRole("button", { name: "New folder" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent?.trim())).toEqual(["Graph", "Projects", "New drawing", "New voice note"]);
  });

  test("a synced vault's More menu also syncs now", async () => {
    const user = userEvent.setup();
    app.status = synced();
    const sync = vi.spyOn(app, "sync").mockResolvedValue();
    renderWorkspace();
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Sync now" }));
    expect(sync).toHaveBeenCalledWith(true);
  });

  test("Projects opens inside Notes, with a back button to Notes", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Projects" }));
    expect(screen.getByRole("heading", { level: 2, name: "Projects" })).toBeInTheDocument();
    expect(tabs().getByRole("button", { name: "Notes" })).toHaveAttribute("aria-current", "page");
    const back = document.querySelector<HTMLElement>("button.back.up")!;
    expect(back).toHaveTextContent("Notes");
    await user.click(back);
    expect(screen.getByRole("tree", { name: "Notes" })).toBeInTheDocument();
  });

  test("Graph opens inside Notes", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Graph" }));
    expect(screen.getByRole("heading", { level: 2, name: "Graph" })).toBeInTheDocument();
    expect(tabs().getByRole("button", { name: "Notes" })).toHaveAttribute("aria-current", "page");
  });

  test("New folder asks for a name and starts a note in it", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "folderCreate").mockResolvedValue();
    renderWorkspace();
    await user.click(within(document.querySelector<HTMLElement>(".phone-head")!).getByRole("button", { name: "New folder" }));
    await user.type(screen.getByRole("textbox", { name: "Folder name" }), "Trips{Enter}");
    await waitFor(() => expect(app.current).toBe("Trips/Untitled.md"));
    expect(app.toast).toBe("Made “Trips”.");
  });

  test("back steps out of Tasks to Today, and closes a sheet before the screen under it", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(tabs().getByRole("button", { name: "Today" }));
    app.tab = "tasks";
    await waitFor(() => expect(history.state?.wandika).toBe("sub"));
    app.viewing = "attachments/Sync sketch.svg";
    render(ImageViewer);
    await waitFor(() => expect(history.state?.wandika).toBe("sheet"));
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(app.viewing).toBeNull());
    expect(app.tab).toBe("tasks");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(app.tab).toBe("today"));
  });

  test("the Settings tab shows Settings in place; a page in it steps back with system back", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(tabs().getByRole("button", { name: "Settings" }));
    expect(tabs().getByRole("button", { name: "Settings" })).toHaveAttribute("aria-current", "page");
    expect(app.settingsOpen).toBe(false);
    await user.click(screen.getByRole("button", { name: /^Connections/ }));
    expect(document.querySelector(".pane h3")).toHaveTextContent("Connections");
    expect(history.state?.wandika).toBe("settings");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(app.settingsPage).toBeNull());
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument();
  });

  test("a link to Settings opens its page in the tab", async () => {
    renderWorkspace();
    app.openSettings("connections");
    await waitFor(() => expect(document.querySelector(".pane h3")).toHaveTextContent("Connections"));
    expect(app.tab).toBe("settings");
    expect(app.settingsOpen).toBe(false);
  });

  test("Tasks shows inside Today, with a back button to Today", async () => {
    const user = userEvent.setup();
    app.tab = "tasks";
    renderWorkspace();
    expect(screen.getByRole("heading", { level: 2, name: "Tasks" })).toBeInTheDocument();
    expect(tabs().getByRole("button", { name: "Today" })).toHaveAttribute("aria-current", "page");
    const back = document.querySelector<HTMLElement>("button.back.up")!;
    expect(back).toHaveTextContent("Today");
    await user.click(back);
    expect(app.tab).toBe("today");
    expect(screen.getByRole("button", { name: "Open today's note" })).toBeInTheDocument();
  });

  test("the new note button opens a note over the list, and Back returns to it", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(tabs().getByRole("button", { name: "New note" }));
    expect(valueOf(await screen.findByRole("textbox", { name: "Note title" }))).toMatch(untitled);
    expect(inert(document.querySelector(".phone-list")!)).toBe(true);
    expect(history.state).toEqual({ wandika: "note" });
    await user.click(screen.getByRole("button", { name: "Back to notes" }));
    expect(app.current).toBeNull();
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Note title" })).not.toBeInTheDocument());
    expect(inert(document.querySelector(".phone-list")!)).toBe(false);
  });

  test("the system back gesture closes the open note", async () => {
    renderWorkspace();
    app.open("Welcome.md");
    await screen.findByRole("textbox", { name: "Note title" });
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    expect(app.current).toBeNull();
  });

  test("Search has a way out: the back arrow and the system back gesture return to the last tab", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(tabs().getByRole("button", { name: "Today" }));
    await user.click(tabs().getByRole("button", { name: "Search" }));
    expect(history.state).toEqual({ wandika: "search" });
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(app.tab).toBe("today");
    await user.click(tabs().getByRole("button", { name: "Search" }));
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    expect(app.tab).toBe("today");
  });

  test("opening a note from Search swaps the history entry, so Back closes the note", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(tabs().getByRole("button", { name: "Search" }));
    expect(history.state).toEqual({ wandika: "search" });
    app.open("Welcome.md");
    await screen.findByRole("textbox", { name: "Note title" });
    expect(history.state).toEqual({ wandika: "note" });
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    expect(app.current).toBeNull();
  });

  test("while Settings is open, the back gesture is left to Settings", async () => {
    renderWorkspace();
    app.open("Welcome.md");
    await screen.findByRole("textbox", { name: "Note title" });
    app.settingsOpen = true;
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    expect(app.current).toBe("Welcome.md");
  });

  test("pulling the list down syncs a synced vault", async () => {
    app.status = synced();
    let done!: () => void;
    const sync = vi.spyOn(app, "sync").mockReturnValue(new Promise<void>((r) => (done = r)));
    renderWorkspace();
    const list = screen.getByRole("tree", { name: "Notes" });
    await fireEvent.touchStart(list, { touches: [{ clientX: 100, clientY: 100 }] });
    await fireEvent.touchMove(list, { touches: [{ clientX: 100, clientY: 160 }] });
    expect(screen.getByText("Pull to sync")).toBeInTheDocument();
    await fireEvent.touchMove(list, { touches: [{ clientX: 100, clientY: 240 }] });
    expect(screen.getByText("Release to sync")).toBeInTheDocument();
    await fireEvent.touchEnd(list, { touches: [] });
    expect(sync).toHaveBeenCalledWith(true);
    expect(screen.getByText("Syncing…")).toBeInTheDocument();
    done();
    await waitFor(() => expect(screen.queryByText("Syncing…")).not.toBeInTheDocument());
  });

  test("a short pull springs back without syncing", async () => {
    app.status = synced();
    const sync = vi.spyOn(app, "sync").mockResolvedValue();
    renderWorkspace();
    const list = screen.getByRole("tree", { name: "Notes" });
    await fireEvent.touchStart(list, { touches: [{ clientX: 100, clientY: 100 }] });
    await fireEvent.touchMove(list, { touches: [{ clientX: 100, clientY: 160 }] });
    await fireEvent.touchEnd(list, { touches: [] });
    expect(sync).not.toHaveBeenCalled();
    // The row eases away, then it's gone.
    await waitFor(() => expect(screen.queryByText("Pull to sync")).not.toBeInTheDocument());
  });

  test("a vault on this device only has nothing to pull", async () => {
    const sync = vi.spyOn(app, "sync").mockResolvedValue();
    renderWorkspace();
    const list = screen.getByRole("tree", { name: "Notes" });
    await fireEvent.touchStart(list, { touches: [{ clientX: 100, clientY: 100 }] });
    await fireEvent.touchMove(list, { touches: [{ clientX: 100, clientY: 300 }] });
    expect(screen.queryByText(/to sync/)).not.toBeInTheDocument();
    await fireEvent.touchEnd(list, { touches: [] });
    expect(sync).not.toHaveBeenCalled();
  });

  test("the first look at a synced vault mentions pull to sync, once", async () => {
    app.status = synced();
    vi.spyOn(app, "sync").mockResolvedValue();
    const { unmount } = renderWorkspace();
    expect(app.toast).toBe("Tip: pull the list down to sync now.");
    unmount();
    app.toast = null;
    renderWorkspace();
    expect(app.toast).toBeNull();
  });
});
