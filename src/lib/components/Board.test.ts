import "@testing-library/jest-dom/vitest";
import { dataTransfer, resetApp } from "../../test/components-views";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api";
import { app } from "../app.svelte";
import { parse } from "../kanban";
import Board from "./Board.svelte";

const SETTINGS = '%% kanban:settings\n```\n{"kanban-plugin":"basic"}\n```\n%%\n';

const BOARD = `---

kanban-plugin: basic

---

## To do

- [ ] Set up OAuth apps #setup
- [ ] Test on the phone #testing 📅 2026-11-03
- [ ] Write [[Reading list]] review


## Doing

- [ ] [[Projects/Wandika]] sync design #design


## Done

**Complete**
- [x] Pick a stack #design


${SETTINGS}`;

beforeEach(resetApp);
afterEach(() => vi.restoreAllMocks());

function setup(text = BOARD, path = "Projects/Launch.md") {
  const onchange = vi.fn();
  const r = render(Board, { path, text, onchange });
  /** The board as last saved: lane titles, then each lane's cards as "[x] text". */
  const saved = () => {
    const b = parse(onchange.mock.lastCall![0]);
    return Object.fromEntries(b.lanes.map((l) => [l.title, l.cards.map((c) => `[${c.done ? "x" : " "}] ${c.text}`)]));
  };
  return { ...r, onchange, saved, user: userEvent.setup() };
}

const lane = (title: string) => screen.getByRole("region", { name: title });
/** The cards shown in a lane, as their visible text. */
const cardsIn = (title: string) => within(lane(title)).queryAllByRole("listitem").map((li) => li.textContent!.replace(/\s+/g, " ").trim());
/** A card's menu button, named after the card. */
const cardMenu = /^Actions for (?!column)/;
const card = (title: string, text: string) => within(lane(title)).getAllByRole("listitem").find((li) => li.textContent!.includes(text))!;

describe("showing a board", () => {
  test("each column is a region with its title and card count", () => {
    setup();
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["To do", "Doing", "Done"]);
    expect(within(lane("To do")).getByRole("heading", { name: "To do" }).nextElementSibling).toHaveTextContent("3");
    expect(within(lane("Done")).getByRole("heading", { name: "Done" }).nextElementSibling).toHaveTextContent("1");
  });

  test("cards show their text without the date, with links and tags as buttons", () => {
    setup();
    expect(cardsIn("To do")).toEqual([
      "Set up OAuth apps #setup",
      "Test on the phone #testing Due today",
      "Write Reading list review",
    ]);
    expect(within(lane("To do")).getByRole("button", { name: "Reading list" })).toBeInTheDocument();
    expect(within(lane("To do")).getByRole("button", { name: "#setup" })).toBeInTheDocument();
  });

  test("a link shows its alias", () => {
    setup("## Ideas\n\n- [ ] Read [[Books/Dune|the book]]\n");
    expect(screen.getByRole("button", { name: "the book" })).toBeInTheDocument();
  });

  test("a column whose cards count as done says so", () => {
    setup();
    expect(within(lane("Done")).getByLabelText("Cards here are marked done")).toBeInTheDocument();
    expect(within(lane("To do")).queryByLabelText("Cards here are marked done")).not.toBeInTheDocument();
  });

  test("done cards are ticked", () => {
    setup();
    expect(within(card("Done", "Pick a stack")).getByRole("checkbox", { name: "Mark as not done" })).toBeChecked();
    expect(within(card("To do", "Set up OAuth")).getByRole("checkbox", { name: "Mark as done" })).not.toBeChecked();
  });

  test("an empty board has an Add a column button and nothing else", () => {
    setup("---\n\nkanban-plugin: basic\n\n---\n");
    expect(screen.queryAllByRole("region")).toHaveLength(0);
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a column" })).toBeInTheDocument();
  });
});

describe("due dates", () => {
  const board = (due: string, done = false) => `## Plan\n\n- [${done ? "x" : " "}] Ship 📅 ${due}\n`;

  test("today", () => {
    setup(board("2026-11-03"));
    expect(screen.getByText("Due today")).toHaveClass("today");
  });

  test("overdue, unless done", () => {
    const { unmount } = setup(board("2026-11-01"));
    expect(screen.getByText("Overdue, 2026-11-01")).toHaveClass("late");
    unmount();
    setup(board("2026-11-01", true));
    expect(screen.getByText("Due 2026-11-01")).not.toHaveClass("late");
  });

  test("later", () => {
    setup(board("2026-12-24"));
    expect(screen.getByText("Due 2026-12-24")).toBeInTheDocument();
  });
});

describe("filtering by tag", () => {
  test("a bar lists every tag once, sorted", () => {
    setup();
    const bar = screen.getByRole("toolbar", { name: "Filter cards by tag" });
    expect(within(bar).getAllByRole("button").map((b) => b.textContent)).toEqual(["All cards", "#design", "#setup", "#testing"]);
  });

  test("no tags, no bar", () => {
    setup("## Plan\n\n- [ ] Plain card\n");
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  test("a tag shows only its cards; a second tap or All cards shows them all", async () => {
    const { user } = setup();
    const bar = screen.getByRole("toolbar", { name: "Filter cards by tag" });
    const design = within(bar).getByRole("button", { name: "#design" });
    await user.click(design);
    expect(design).toHaveAttribute("aria-pressed", "true");
    expect(cardsIn("To do")).toEqual([]);
    expect(cardsIn("Doing")).toHaveLength(1);
    expect(cardsIn("Done")).toHaveLength(1);
    await user.click(design);
    expect(cardsIn("To do")).toHaveLength(3);
    await user.click(design);
    await user.click(within(bar).getByRole("button", { name: "All cards" }));
    expect(cardsIn("To do")).toHaveLength(3);
  });

  test("a tag on a card filters by it", async () => {
    const { user } = setup();
    await user.click(within(lane("To do")).getByRole("button", { name: "#setup" }));
    expect(cardsIn("To do")).toEqual(["Set up OAuth apps #setup"]);
    expect(within(screen.getByRole("toolbar")).getByRole("button", { name: "#setup" })).toHaveAttribute("aria-pressed", "true");
  });

  test("deleting the last card with the picked tag shows every card again", async () => {
    const { user } = setup();
    await user.click(within(screen.getByRole("toolbar")).getByRole("button", { name: "#setup" }));
    await user.click(within(card("To do", "Set up OAuth")).getByRole("button", { name: cardMenu }));
    await user.click(screen.getByRole("menuitem", { name: "Delete card" }));
    expect(cardsIn("To do")).toHaveLength(2);
    expect(cardsIn("Doing")).toHaveLength(1);
    expect(within(screen.getByRole("toolbar")).getByRole("button", { name: "All cards" })).toHaveClass("on");
    // A new card with that tag later doesn't bring the old filter back.
    await user.click(within(lane("Doing")).getByRole("button", { name: "Add a card" }));
    await user.type(within(lane("Doing")).getByRole("textbox", { name: "New card" }), "Rotate keys #setup{Enter}");
    expect(cardsIn("To do")).toHaveLength(2);
  });

  test("filtering saves nothing", async () => {
    const { user, onchange } = setup();
    await user.click(within(screen.getByRole("toolbar")).getByRole("button", { name: "#design" }));
    expect(onchange).not.toHaveBeenCalled();
  });
});

describe("adding cards", () => {
  test("Add a card opens a focused box; Enter adds the card and keeps the box for the next", async () => {
    const { user, saved } = setup();
    await user.click(within(lane("Doing")).getByRole("button", { name: "Add a card" }));
    const box = within(lane("Doing")).getByRole("textbox", { name: "New card" });
    expect(box).toHaveFocus();
    await user.type(box, "Write release notes #docs{Enter}");
    expect(saved().Doing).toEqual(["[ ] [[Projects/Wandika]] sync design #design", "[ ] Write release notes #docs"]);
    expect(within(lane("Doing")).getByRole("textbox", { name: "New card" })).toHaveValue("");
    expect(cardsIn("Doing")).toContain("Write release notes #docs");
  });

  test("the Add card button adds it too", async () => {
    const { user, saved } = setup();
    await user.click(within(lane("To do")).getByRole("button", { name: "Add a card" }));
    await user.type(within(lane("To do")).getByRole("textbox", { name: "New card" }), "Buy domain");
    await user.click(within(lane("To do")).getByRole("button", { name: "Add card" }));
    expect(saved()["To do"].at(-1)).toBe("[ ] Buy domain");
  });

  test("Shift+Enter writes a second line, saved as part of the card", async () => {
    const { user, onchange } = setup("## Plan\n\n");
    await user.click(screen.getByRole("button", { name: "Add a card" }));
    await user.type(screen.getByRole("textbox", { name: "New card" }), "Title{Shift>}{Enter}{/Shift}More detail{Enter}");
    expect(onchange.mock.lastCall![0]).toContain("- [ ] Title\n\tMore detail");
  });

  test("a card added to a done column is ticked", async () => {
    const { user, saved } = setup();
    await user.click(within(lane("Done")).getByRole("button", { name: "Add a card" }));
    await user.type(within(lane("Done")).getByRole("textbox", { name: "New card" }), "Ship v1{Enter}");
    expect(saved().Done.at(-1)).toBe("[x] Ship v1");
  });

  test("an empty card is not added", async () => {
    const { user, onchange } = setup();
    await user.click(within(lane("To do")).getByRole("button", { name: "Add a card" }));
    await user.type(within(lane("To do")).getByRole("textbox", { name: "New card" }), "   {Enter}");
    expect(onchange).not.toHaveBeenCalled();
  });

  test("Escape or the close button stops adding", async () => {
    const { user } = setup();
    await user.click(within(lane("To do")).getByRole("button", { name: "Add a card" }));
    await user.keyboard("{Escape}");
    expect(within(lane("To do")).queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(within(lane("To do")).getByRole("button", { name: "Add a card" }));
    await user.click(within(lane("To do")).getByRole("button", { name: "Stop adding cards" }));
    expect(within(lane("To do")).queryByRole("textbox")).not.toBeInTheDocument();
  });

  test("a new box starts empty after an abandoned one", async () => {
    const { user } = setup();
    await user.click(within(lane("To do")).getByRole("button", { name: "Add a card" }));
    await user.type(within(lane("To do")).getByRole("textbox", { name: "New card" }), "half");
    await user.keyboard("{Escape}");
    await user.click(within(lane("Doing")).getByRole("button", { name: "Add a card" }));
    expect(within(lane("Doing")).getByRole("textbox", { name: "New card" })).toHaveValue("");
  });
});

describe("editing a card", () => {
  test("a tap on the text opens it for editing; Enter saves", async () => {
    const { user, saved } = setup();
    await user.click(within(card("To do", "Set up OAuth")).getByText(/Set up OAuth apps/));
    const box = within(lane("To do")).getByRole("textbox", { name: "Card text" });
    expect(box).toHaveValue("Set up OAuth apps #setup");
    expect(box).toHaveFocus();
    await user.clear(box);
    await user.type(box, "Set up GitHub OAuth #setup{Enter}");
    expect(saved()["To do"][0]).toBe("[ ] Set up GitHub OAuth #setup");
    expect(within(lane("To do")).queryByRole("textbox")).not.toBeInTheDocument();
  });

  test("leaving the box saves too", async () => {
    const { user, saved } = setup();
    await user.click(within(card("To do", "Set up OAuth")).getByText(/Set up OAuth apps/));
    await user.type(within(lane("To do")).getByRole("textbox", { name: "Card text" }), " today");
    await user.click(document.body);
    expect(saved()["To do"][0]).toBe("[ ] Set up OAuth apps #setup today");
  });

  test("the date stays on the card while editing", async () => {
    const { user } = setup();
    await user.click(within(card("To do", "Test on the phone")).getByText(/Test on the phone/));
    expect(within(lane("To do")).getByRole("textbox", { name: "Card text" })).toHaveValue("Test on the phone #testing 📅 2026-11-03");
  });

  test("Escape leaves the card as it was", async () => {
    const { user, onchange } = setup();
    await user.click(within(card("To do", "Set up OAuth")).getByText(/Set up OAuth apps/));
    await user.type(within(lane("To do")).getByRole("textbox", { name: "Card text" }), " changed{Escape}");
    expect(onchange).not.toHaveBeenCalled();
    expect(cardsIn("To do")[0]).toBe("Set up OAuth apps #setup");
  });

  test("clearing the text deletes the card", async () => {
    const { user, saved } = setup();
    await user.click(within(card("To do", "Set up OAuth")).getByText(/Set up OAuth apps/));
    await user.clear(within(lane("To do")).getByRole("textbox", { name: "Card text" }));
    await user.keyboard("{Enter}");
    expect(saved()["To do"]).toHaveLength(2);
  });

  test("Edit card in the menu opens it too", async () => {
    const { user } = setup();
    await user.click(within(card("To do", "Set up OAuth")).getByRole("button", { name: cardMenu }));
    await user.click(screen.getByRole("menuitem", { name: "Edit card" }));
    expect(within(lane("To do")).getByRole("textbox", { name: "Card text" })).toHaveValue("Set up OAuth apps #setup");
  });

  test("a card being edited can't be dragged", async () => {
    const { user } = setup();
    const li = card("To do", "Set up OAuth");
    expect(li).toHaveAttribute("draggable", "true");
    await user.click(within(li).getByText(/Set up OAuth apps/));
    expect(within(lane("To do")).getByRole("textbox").closest("li")).toHaveAttribute("draggable", "false");
  });

  test("a link opens its note instead of editing", async () => {
    const follow = vi.spyOn(app, "follow").mockResolvedValue();
    const { user } = setup();
    await user.click(within(lane("To do")).getByRole("button", { name: "Reading list" }));
    expect(follow).toHaveBeenCalledWith("Reading list");
    expect(within(lane("To do")).queryByRole("textbox")).not.toBeInTheDocument();
  });
});

describe("completing", () => {
  test("ticking a card saves it done, unticking saves it open", async () => {
    const { user, saved } = setup();
    const box = within(card("To do", "Set up OAuth")).getByRole("checkbox", { name: "Mark as done" });
    await user.click(box);
    expect(saved()["To do"][0]).toBe("[x] Set up OAuth apps #setup");
    await user.click(within(card("To do", "Set up OAuth")).getByRole("checkbox", { name: "Mark as not done" }));
    expect(saved()["To do"][0]).toBe("[ ] Set up OAuth apps #setup");
  });
});

describe("card menus", () => {
  test("each card's menu is named after the card, in plain words", () => {
    setup();
    expect(within(card("To do", "Write")).getByRole("button", { name: "Actions for Write Reading list review" })).toBeInTheDocument();
    expect(within(card("To do", "Test on the phone")).getByRole("button", { name: "Actions for Test on the phone #testing" })).toBeInTheDocument();
  });
});

describe("moving cards with the menu", () => {
  test("the menu offers every other column", async () => {
    const { user } = setup();
    await user.click(within(card("To do", "Set up OAuth")).getByRole("button", { name: cardMenu }));
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent!.trim());
    expect(items).toEqual(["Edit card", "Make into a note", "Move down", "Move to Doing", "Move to Done", "Delete card"]);
  });

  test("Move up and Move down reorder a card in its column, without dragging", async () => {
    const { user, saved } = setup();
    await user.click(within(card("To do", "Test on the phone")).getByRole("button", { name: cardMenu }));
    await user.click(screen.getByRole("menuitem", { name: "Move down" }));
    expect(saved()["To do"].map((c) => c.slice(4, 14))).toEqual(["Set up OAu", "Write [[Re", "Test on th"]);
    await user.click(within(card("To do", "Test on the phone")).getByRole("button", { name: cardMenu }));
    await user.click(screen.getByRole("menuitem", { name: "Move up" }));
    await user.click(within(card("To do", "Test on the phone")).getByRole("button", { name: cardMenu }));
    await user.click(screen.getByRole("menuitem", { name: "Move up" }));
    expect(saved()["To do"].map((c) => c.slice(4, 14))).toEqual(["Test on th", "Set up OAu", "Write [[Re"]);
  });

  test("a column moves left or right from its menu", async () => {
    const { user, saved } = setup();
    await user.click(within(lane("Doing")).getByRole("button", { name: /^Actions for column/ }));
    await user.click(screen.getByRole("menuitem", { name: "Move left" }));
    expect(Object.keys(saved())).toEqual(["Doing", "To do", "Done"]);
  });

  test("Move to puts the card at the end of that column", async () => {
    const { user, saved } = setup();
    await user.click(within(card("To do", "Set up OAuth")).getByRole("button", { name: cardMenu }));
    await user.click(screen.getByRole("menuitem", { name: "Move to Doing" }));
    expect(saved()["To do"]).toHaveLength(2);
    expect(saved().Doing).toEqual(["[ ] [[Projects/Wandika]] sync design #design", "[ ] Set up OAuth apps #setup"]);
    expect(cardsIn("Doing")[1]).toBe("Set up OAuth apps #setup");
  });

  test("moving into a done column ticks the card, moving out unticks it", async () => {
    const { user, saved } = setup();
    await user.click(within(card("To do", "Set up OAuth")).getByRole("button", { name: cardMenu }));
    await user.click(screen.getByRole("menuitem", { name: "Move to Done" }));
    expect(saved().Done.at(-1)).toBe("[x] Set up OAuth apps #setup");
    await user.click(within(card("Done", "Pick a stack")).getByRole("button", { name: cardMenu }));
    await user.click(screen.getByRole("menuitem", { name: "Move to To do" }));
    expect(saved()["To do"].at(-1)).toBe("[ ] Pick a stack #design");
  });

  test("Delete card removes it", async () => {
    const { user, saved } = setup();
    await user.click(within(card("To do", "Write")).getByRole("button", { name: cardMenu }));
    await user.click(screen.getByRole("menuitem", { name: "Delete card" }));
    expect(saved()["To do"]).toEqual(["[ ] Set up OAuth apps #setup", "[ ] Test on the phone #testing 📅 2026-11-03"]);
    expect(cardsIn("To do")).toHaveLength(2);
    expect(app.toast).toMatch(/^Deleted “Write/);
    app.toastAction!.run();
    await vi.waitFor(() => expect(cardsIn("To do")).toHaveLength(3));
  });
});

describe("dragging cards", () => {
  /** Lays the lane's cards out 50px apart, 40px tall, as a browser would. */
  function layout(title: string) {
    within(lane(title))
      .getAllByRole("listitem")
      .forEach((li, i) => vi.spyOn(li, "getBoundingClientRect").mockReturnValue(new DOMRect(0, i * 50, 200, 40)));
  }

  test("drops a card where the line shows, in another column", async () => {
    const { saved } = setup();
    const dt = dataTransfer();
    layout("To do");
    await fireEvent.dragStart(card("Doing", "sync design"), { dataTransfer: dt });
    expect(dt.getData("text/plain")).toBe("[[Projects/Wandika]] sync design #design");
    expect(dt.effectAllowed).toBe("move");
    await fireEvent.dragOver(lane("To do"), { clientY: 55, dataTransfer: dt });
    expect(lane("To do")).toHaveClass("target");
    const line = lane("To do").querySelector(".drop-line")!;
    expect(line.nextElementSibling).toHaveTextContent("Test on the phone");
    await fireEvent.drop(lane("To do"), { dataTransfer: dt });
    expect(saved()["To do"]).toEqual([
      "[ ] Set up OAuth apps #setup",
      "[ ] [[Projects/Wandika]] sync design #design",
      "[ ] Test on the phone #testing 📅 2026-11-03",
      "[ ] Write [[Reading list]] review",
    ]);
    expect(saved().Doing).toEqual([]);
    expect(lane("To do").querySelector(".drop-line")).not.toBeInTheDocument();
  });

  test("below the last card drops at the end", async () => {
    const { saved } = setup();
    layout("To do");
    await fireEvent.dragStart(card("Doing", "sync design"), { dataTransfer: dataTransfer() });
    await fireEvent.dragOver(lane("To do"), { clientY: 500 });
    await fireEvent.drop(lane("To do"));
    expect(saved()["To do"].at(-1)).toBe("[ ] [[Projects/Wandika]] sync design #design");
  });

  test("reorders within a column", async () => {
    const { saved } = setup();
    layout("To do");
    await fireEvent.dragStart(card("To do", "Set up OAuth"), { dataTransfer: dataTransfer() });
    await fireEvent.dragOver(lane("To do"), { clientY: 95 });
    await fireEvent.drop(lane("To do"));
    expect(saved()["To do"]).toEqual([
      "[ ] Test on the phone #testing 📅 2026-11-03",
      "[ ] Set up OAuth apps #setup",
      "[ ] Write [[Reading list]] review",
    ]);
  });

  test("dropping into a done column ticks the card", async () => {
    const { saved } = setup();
    await fireEvent.dragStart(card("To do", "Set up OAuth"), { dataTransfer: dataTransfer() });
    await fireEvent.dragOver(lane("Done"), { clientY: 500 });
    await fireEvent.drop(lane("Done"));
    expect(saved().Done.at(-1)).toBe("[x] Set up OAuth apps #setup");
  });

  test("a drag that ends outside a column changes nothing", async () => {
    const { onchange } = setup();
    const li = card("To do", "Set up OAuth");
    await fireEvent.dragStart(li, { dataTransfer: dataTransfer() });
    expect(li).toHaveClass("dragging");
    await fireEvent.dragOver(lane("Doing"), { clientY: 0 });
    await fireEvent.dragLeave(lane("Doing"), { relatedTarget: document.body });
    expect(lane("Doing")).not.toHaveClass("target");
    await fireEvent.dragEnd(li);
    expect(li).not.toHaveClass("dragging");
    expect(onchange).not.toHaveBeenCalled();
  });

  test("dragging something else over the board is ignored", async () => {
    const { onchange } = setup();
    await fireEvent.dragOver(lane("Doing"), { clientY: 0 });
    expect(lane("Doing")).not.toHaveClass("target");
    await fireEvent.drop(lane("Doing"));
    expect(onchange).not.toHaveBeenCalled();
  });
});

describe("making a card into a note", () => {
  test("creates the note beside the board and links the card to it, keeping tags and date", async () => {
    const create = vi.spyOn(api, "noteCreate").mockResolvedValue("Projects/Test on the phone.md");
    const refresh = vi.spyOn(app, "refreshFiles").mockResolvedValue();
    const { user, saved } = setup();
    await user.click(within(card("To do", "Test on the phone")).getByRole("button", { name: cardMenu }));
    await user.click(screen.getByRole("menuitem", { name: "Make into a note" }));
    await vi.waitFor(() => expect(app.toast).toBe("Created “Test on the phone” and linked the card to it."));
    expect(create).toHaveBeenCalledWith("Projects", "Test on the phone", "Board: [[Launch]] #testing\n\n");
    expect(saved()["To do"][1]).toBe("[ ] [[Test on the phone]] #testing 📅 2026-11-03");
    expect(refresh).toHaveBeenCalled();
    expect(within(lane("To do")).getByRole("button", { name: "Test on the phone" })).toBeInTheDocument();
  });

  test("a board at the vault root makes the note at the root", async () => {
    const create = vi.spyOn(api, "noteCreate").mockResolvedValue("Plan.md");
    vi.spyOn(app, "refreshFiles").mockResolvedValue();
    const { user } = setup("## Ideas\n\n- [ ] Write [[Plan|the plan]] up\n", "Board.md");
    await user.click(screen.getByRole("button", { name: cardMenu }));
    await user.click(screen.getByRole("menuitem", { name: "Make into a note" }));
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith("", "Write Plan up", "Board: [[Board]]\n\n"));
  });

  test("a tag with an accent leaves the note title whole", async () => {
    const create = vi.spyOn(api, "noteCreate").mockResolvedValue("Menu.md");
    vi.spyOn(app, "refreshFiles").mockResolvedValue();
    const { user } = setup("## Ideas\n\n- [ ] Menu #café\n", "Board.md");
    await user.click(screen.getByRole("button", { name: cardMenu }));
    await user.click(screen.getByRole("menuitem", { name: "Make into a note" }));
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith("", "Menu", "Board: [[Board]] #café\n\n"));
  });

  test("a card that already starts with a link doesn't offer it", async () => {
    const { user } = setup();
    await user.click(within(card("Doing", "sync design")).getByRole("button", { name: cardMenu }));
    expect(screen.queryByRole("menuitem", { name: "Make into a note" })).not.toBeInTheDocument();
  });

  test("a failure says why and leaves the card alone", async () => {
    vi.spyOn(api, "noteCreate").mockRejectedValue(new Error("A note with that name exists."));
    const { user, onchange } = setup();
    await user.click(within(card("To do", "Set up OAuth")).getByRole("button", { name: cardMenu }));
    await user.click(screen.getByRole("menuitem", { name: "Make into a note" }));
    await vi.waitFor(() => expect(app.toast).toBe("A note with that name exists."));
    expect(onchange).not.toHaveBeenCalled();
  });

  test("a card of only tags has no title, so nothing is made", async () => {
    const create = vi.spyOn(api, "noteCreate");
    const { user } = setup("## Ideas\n\n- [ ] #someday\n");
    await user.click(screen.getByRole("button", { name: cardMenu }));
    await user.click(screen.getByRole("menuitem", { name: "Make into a note" }));
    expect(create).not.toHaveBeenCalled();
  });
});

describe("columns", () => {
  const columnMenu = async (user: ReturnType<typeof userEvent.setup>, title: string) =>
    user.click(screen.getByRole("button", { name: `Actions for column ${title}` }));

  test("Add a column asks for a name and adds it at the end", async () => {
    const { user, saved } = setup();
    await user.click(screen.getByRole("button", { name: "Add a column" }));
    expect(app.dialog).toMatchObject({ title: "New column", confirm: "Add column", input: { label: "Column name", value: "" } });
    app.dialog!.resolve(" Blocked ");
    await vi.waitFor(() => expect(Object.keys(saved())).toEqual(["To do", "Doing", "Done", "Blocked"]));
    expect(lane("Blocked")).toBeInTheDocument();
  });

  test("a cancelled or blank name adds nothing", async () => {
    const { user, onchange } = setup();
    await user.click(screen.getByRole("button", { name: "Add a column" }));
    app.dialog!.resolve(null);
    await user.click(screen.getByRole("button", { name: "Add a column" }));
    app.dialog!.resolve("  ");
    await Promise.resolve();
    expect(onchange).not.toHaveBeenCalled();
  });

  test("Rename column starts from the old name and saves the new one", async () => {
    const { user, saved } = setup();
    await columnMenu(user, "Doing");
    await user.click(screen.getByRole("menuitem", { name: "Rename column" }));
    expect(app.dialog).toMatchObject({ title: "Rename column", input: { value: "Doing" } });
    app.dialog!.resolve("In progress");
    await vi.waitFor(() => expect(Object.keys(saved())).toEqual(["To do", "In progress", "Done"]));
    expect(screen.getByRole("region", { name: "In progress" })).toBeInTheDocument();
  });

  test("Rename cancelled keeps the name", async () => {
    const { user, onchange } = setup();
    await columnMenu(user, "Doing");
    await user.click(screen.getByRole("menuitem", { name: "Rename column" }));
    app.dialog!.resolve(null);
    await Promise.resolve();
    expect(onchange).not.toHaveBeenCalled();
    expect(lane("Doing")).toBeInTheDocument();
  });

  test("Mark cards here as done ticks every card and marks the column", async () => {
    const { user, saved, onchange } = setup();
    await columnMenu(user, "To do");
    await user.click(screen.getByRole("menuitem", { name: "Mark cards here as done" }));
    expect(saved()["To do"].every((c) => c.startsWith("[x]"))).toBe(true);
    expect(onchange.mock.lastCall![0]).toMatch(/## To do\n\n\*\*Complete\*\*\n- \[x\] Set up OAuth/);
    expect(within(lane("To do")).getByLabelText("Cards here are marked done")).toBeInTheDocument();
    await columnMenu(user, "To do");
    await user.click(screen.getByRole("menuitem", { name: "Stop marking cards done" }));
    expect(saved()["To do"].every((c) => c.startsWith("[ ]"))).toBe(true);
  });

  test("deleting a column with cards asks first, as a danger", async () => {
    const { user, saved } = setup();
    await columnMenu(user, "To do");
    await user.click(screen.getByRole("menuitem", { name: "Delete column" }));
    expect(app.dialog).toMatchObject({ title: "Delete “To do” and its 3 cards?", confirm: "Delete column", danger: true });
    app.dialog!.resolve("");
    await vi.waitFor(() => expect(Object.keys(saved())).toEqual(["Doing", "Done"]));
    expect(screen.queryByRole("region", { name: "To do" })).not.toBeInTheDocument();
  });

  test("one card is singular in the question", async () => {
    const { user } = setup();
    await columnMenu(user, "Doing");
    await user.click(screen.getByRole("menuitem", { name: "Delete column" }));
    expect(app.dialog?.title).toBe("Delete “Doing” and its 1 card?");
  });

  test("cancelling keeps the column", async () => {
    const { user, onchange } = setup();
    await columnMenu(user, "To do");
    await user.click(screen.getByRole("menuitem", { name: "Delete column" }));
    app.dialog!.resolve(null);
    await Promise.resolve();
    expect(onchange).not.toHaveBeenCalled();
    expect(lane("To do")).toBeInTheDocument();
  });

  test("an empty column goes without asking", async () => {
    const { user, saved } = setup("## Empty\n\n\n## Full\n\n- [ ] Card\n");
    await columnMenu(user, "Empty");
    await user.click(screen.getByRole("menuitem", { name: "Delete column" }));
    expect(app.dialog).toBeNull();
    expect(Object.keys(saved())).toEqual(["Full"]);
  });
});

test("saving keeps the Kanban plugin's front matter and settings", async () => {
  const { user, onchange } = setup();
  await user.click(within(card("To do", "Set up OAuth")).getByRole("checkbox"));
  const text: string = onchange.mock.lastCall![0];
  expect(text.startsWith("---\n\nkanban-plugin: basic\n\n---\n")).toBe(true);
  expect(text.endsWith(SETTINGS)).toBe(true);
});
