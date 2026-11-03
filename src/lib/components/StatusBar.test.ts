import "@testing-library/jest-dom/vitest";
import { localStatus, resetApp, statusFixture } from "../../test/components-views";
import { render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { app } from "../app.svelte";
import StatusBar from "./StatusBar.svelte";

beforeEach(() => {
  resetApp();
  app.status = statusFixture();
  app.lastSync = Date.now();
  vi.spyOn(app, "sync").mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

const bar = () => screen.getByRole("contentinfo", { name: "Status" });
const stats = (s: Partial<typeof app.noteStats>) => {
  app.noteStats = { words: 0, chars: 0, cards: null, backlinks: 0, encrypted: false, ...s };
  flushSync();
};

test("shows the sync line on the left", () => {
  render(StatusBar);
  expect(within(bar()).getByRole("button", { name: "Synced just now. Sync now" })).toBeInTheDocument();
});

test("shows the sync line for a vault on this device only", () => {
  app.status = localStatus();
  render(StatusBar);
  expect(within(bar()).getByRole("button", { name: "On this device only" })).toBeInTheDocument();
});

describe("conflicts", () => {
  test("none: nothing asks for attention", () => {
    render(StatusBar);
    expect(screen.queryByText(/conflict/)).not.toBeInTheDocument();
  });

  test("one conflict, named on hover, opens that note", async () => {
    const user = userEvent.setup();
    app.conflicts = ["Projects/Plan (conflict 2026-11-03).md"];
    render(StatusBar);
    const button = screen.getByRole("button", { name: "1 conflict" });
    expect(button).toHaveClass("warn");
    expect(button).toHaveAttribute("title", "Plan (conflict 2026-11-03)");
    await user.click(button);
    expect(app.current).toBe("Projects/Plan (conflict 2026-11-03).md");
    expect(app.tab).toBe("notes");
  });

  test("several: counted, all named, the first opens", async () => {
    const user = userEvent.setup();
    app.conflicts = ["A (conflict).md", "Daily/B (conflict).md"];
    render(StatusBar);
    const button = screen.getByRole("button", { name: "2 conflicts" });
    expect(button).toHaveAttribute("title", "A (conflict), B (conflict)");
    await user.click(button);
    expect(app.current).toBe("A (conflict).md");
  });
});

describe("the open note's counts", () => {
  test("hidden while no note is open", () => {
    app.noteStats = { words: 12, chars: 60, cards: null, backlinks: 2, encrypted: true };
    render(StatusBar);
    expect(screen.queryByText(/words/)).not.toBeInTheDocument();
    expect(screen.queryByText("Encrypted")).not.toBeInTheDocument();
  });

  test("words and characters, with thousands separated", () => {
    app.current = "Plan.md";
    render(StatusBar);
    stats({ words: 1234, chars: 7890 });
    expect(bar()).toHaveTextContent("1,234 words");
    expect(bar()).toHaveTextContent("7,890 characters");
  });

  test("one word is singular", () => {
    app.current = "Plan.md";
    render(StatusBar);
    stats({ words: 1, chars: 4 });
    expect(screen.getByText("1 word")).toBeInTheDocument();
  });

  test("a board counts cards instead of words", () => {
    app.current = "Projects/Launch.md";
    render(StatusBar);
    stats({ words: 50, chars: 300, cards: 7 });
    expect(screen.getByText("7 cards")).toBeInTheDocument();
    expect(screen.queryByText(/words/)).not.toBeInTheDocument();
    stats({ cards: 1 });
    expect(screen.getByText("1 card")).toBeInTheDocument();
    stats({ cards: 0 });
    expect(screen.getByText("0 cards")).toBeInTheDocument();
  });

  test("says when the note is encrypted and how many notes link to it", () => {
    app.current = "Private/Passport.md.age";
    render(StatusBar);
    stats({ words: 3, chars: 20, encrypted: true, backlinks: 3 });
    expect(screen.getByText("Encrypted")).toBeInTheDocument();
    expect(screen.getByText("Linked from 3")).toBeInTheDocument();
  });

  test("no backlinks, no line about them", () => {
    app.current = "Plan.md";
    render(StatusBar);
    stats({ words: 3, chars: 20 });
    expect(screen.queryByText(/Linked from/)).not.toBeInTheDocument();
    expect(screen.queryByText("Encrypted")).not.toBeInTheDocument();
  });
});
