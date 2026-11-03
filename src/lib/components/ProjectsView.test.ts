import "@testing-library/jest-dom/vitest";
import { note, resetApp } from "../../test/components-views";
import { render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api";
import { app } from "../app.svelte";
import { TEMPLATE } from "../kanban";
import ProjectsView from "./ProjectsView.svelte";

beforeEach(resetApp);
afterEach(() => vi.restoreAllMocks());

const vault = () => [
  note("Projects/Launch.md", { board: true, tags: ["design"] }),
  note("Roadmap.md", { board: true }),
  note("Welcome.md", { tags: ["idea", "design"] }),
  note("Ideas/Garden.md", { tags: ["idea"] }),
  note("Reading.md", { tags: ["reading", "idea"] }),
];

test("is a titled view", () => {
  render(ProjectsView);
  expect(screen.getByRole("region", { name: "Projects" })).toBeInTheDocument();
});

describe("boards", () => {
  test("empty: explains what a board is", () => {
    render(ProjectsView);
    const boards = screen.getByRole("region", { name: "Boards" });
    expect(within(boards).getByText(/A board is a note with columns of cards/)).toBeInTheDocument();
    expect(within(boards).queryByRole("list")).not.toBeInTheDocument();
  });

  test("lists every board with its folder", () => {
    app.titles = vault();
    render(ProjectsView);
    const boards = within(screen.getByRole("region", { name: "Boards" })).getAllByRole("button");
    expect(boards.map((b) => b.textContent?.trim())).toEqual(["Launch Projects", "Roadmap"]);
  });

  test("a board opens in the editor", async () => {
    const user = userEvent.setup();
    app.titles = vault();
    render(ProjectsView);
    await user.click(screen.getByRole("button", { name: /Launch/ }));
    expect(app.current).toBe("Projects/Launch.md");
    expect(app.tab).toBe("notes");
  });

  test("New board asks for a name, creates it in Projects and opens it", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "noteCreate").mockResolvedValue("Projects/Garden.md");
    vi.spyOn(app, "refreshFiles").mockResolvedValue();
    render(ProjectsView);
    await user.click(screen.getByRole("button", { name: "New board" }));
    expect(app.dialog?.title).toBe("New board");
    expect(app.dialog?.input?.label).toBe("Board name");
    app.dialog!.resolve("  Garden ");
    await vi.waitFor(() => expect(app.current).toBe("Projects/Garden.md"));
    expect(api.noteCreate).toHaveBeenCalledWith("Projects", "Garden", TEMPLATE);
    expect(app.refreshFiles).toHaveBeenCalled();
  });

  test("New board does nothing when cancelled", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, "noteCreate");
    render(ProjectsView);
    await user.click(screen.getByRole("button", { name: "New board" }));
    app.dialog!.resolve(null);
    await Promise.resolve();
    expect(create).not.toHaveBeenCalled();
    expect(app.current).toBeNull();
  });
});

describe("tags", () => {
  test("empty: says how to add one", () => {
    render(ProjectsView);
    const tags = screen.getByRole("region", { name: "Tags" });
    expect(within(tags).getByText(/Write #tag in a note or on a card/)).toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "Tags" })).not.toBeInTheDocument();
  });

  test("most used first, then by name, each with its count", () => {
    app.titles = vault();
    render(ProjectsView);
    const chips = within(screen.getByRole("toolbar", { name: "Tags" })).getAllByRole("button");
    expect(chips.map((c) => c.textContent?.replace(/\s+/g, " ").trim())).toEqual(["#idea 3", "#design 2", "#reading 1"]);
    for (const c of chips) expect(c).toHaveAttribute("aria-pressed", "false");
  });

  test("picking a tag lists its notes, a second tap clears it", async () => {
    const user = userEvent.setup();
    app.titles = vault();
    render(ProjectsView);
    const design = screen.getByRole("button", { name: /#design/ });
    await user.click(design);
    expect(design).toHaveAttribute("aria-pressed", "true");
    expect(app.tagFilter).toBe("design");
    const list = screen.getByRole("list", { name: "Notes tagged design" });
    expect(within(list).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["Launch Projects", "Welcome"]);
    await user.click(design);
    expect(app.tagFilter).toBeNull();
    expect(screen.queryByRole("list", { name: /Notes tagged/ })).not.toBeInTheDocument();
  });

  test("picking another tag switches the list", async () => {
    const user = userEvent.setup();
    app.titles = vault();
    render(ProjectsView);
    await user.click(screen.getByRole("button", { name: /#design/ }));
    await user.click(screen.getByRole("button", { name: /#reading/ }));
    expect(screen.getByRole("button", { name: /#design/ })).toHaveAttribute("aria-pressed", "false");
    const list = screen.getByRole("list", { name: "Notes tagged reading" });
    expect(within(list).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["Reading"]);
  });

  test("a tagged note opens", async () => {
    const user = userEvent.setup();
    app.titles = vault();
    render(ProjectsView);
    await user.click(screen.getByRole("button", { name: /#idea/ }));
    await user.click(within(screen.getByRole("list", { name: "Notes tagged idea" })).getByRole("button", { name: /Garden/ }));
    expect(app.current).toBe("Ideas/Garden.md");
  });

  test("opens on a tag picked elsewhere, from a card or a note", () => {
    app.titles = vault();
    app.showTag("reading");
    render(ProjectsView);
    expect(screen.getByRole("button", { name: /#reading/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("list", { name: "Notes tagged reading" })).toBeInTheDocument();
  });
});
