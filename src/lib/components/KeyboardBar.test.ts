import "@testing-library/jest-dom/vitest";
import "../../test/components-views";
import { history } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { fireEvent, render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import KeyboardBar from "./KeyboardBar.svelte";

let editor: EditorView | null = null;

/** A real note editor with `doc`, the cursor at `at` (default: the end). */
function note(doc: string, at = doc.length) {
  const parent = document.createElement("div");
  document.body.append(parent);
  editor = new EditorView({
    parent,
    state: EditorState.create({ doc, selection: EditorSelection.cursor(at), extensions: [history()] }),
  });
  return editor;
}

function setup(doc = "", at?: number) {
  const view = note(doc, at);
  const onImage = vi.fn();
  render(KeyboardBar, { view: () => view, onImage });
  return { view, onImage, user: userEvent.setup() };
}

const text = () => editor!.state.doc.toString();
const cursor = () => editor!.state.selection.main.head;

afterEach(() => {
  editor?.destroy();
  editor?.dom.parentElement?.remove();
  editor = null;
  delete (window as { visualViewport?: unknown }).visualViewport;
});

test("is a toolbar of named writing tools", () => {
  setup();
  const bar = screen.getByRole("toolbar", { name: "Writing tools" });
  const names = [...bar.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
  expect(names).toEqual([
    "Link to a note",
    "Tag",
    "Add image",
    "Checklist",
    "Heading",
    "Bulleted list",
    "Indent",
    "Outdent",
    "Undo",
    "Redo",
    "Hide keyboard",
  ]);
});

describe("each button writes its Markdown", () => {
  test("Link to a note wraps the cursor in [[ ]]", async () => {
    const { user } = setup("See ");
    await user.click(screen.getByRole("button", { name: "Link to a note" }));
    expect(text()).toBe("See [[]]");
    expect(cursor()).toBe(6);
  });

  test("Link to a note wraps a selection", async () => {
    const { user, view } = setup("See Plan");
    view.dispatch({ selection: EditorSelection.range(4, 8) });
    await user.click(screen.getByRole("button", { name: "Link to a note" }));
    expect(text()).toBe("See [[Plan]]");
  });

  test("Tag adds # after a space", async () => {
    const { user } = setup("Idea ");
    await user.click(screen.getByRole("button", { name: "Tag" }));
    expect(text()).toBe("Idea #");
    expect(cursor()).toBe(6);
  });

  test("Tag adds its own space after a word", async () => {
    const { user } = setup("Idea");
    await user.click(screen.getByRole("button", { name: "Tag" }));
    expect(text()).toBe("Idea #");
  });

  test("Checklist turns the line into a task, cursor at its end", async () => {
    const { user } = setup("Buy milk", 2);
    await user.click(screen.getByRole("button", { name: "Checklist" }));
    expect(text()).toBe("- [ ] Buy milk");
    expect(cursor()).toBe(text().length);
  });

  test("Checklist on a task turns it back into plain text", async () => {
    const { user } = setup("- [ ] Buy milk");
    await user.click(screen.getByRole("button", { name: "Checklist" }));
    expect(text()).toBe("Buy milk");
  });

  test("Bulleted list turns the line into a bullet", async () => {
    const { user } = setup("Eggs");
    await user.click(screen.getByRole("button", { name: "Bulleted list" }));
    expect(text()).toBe("- Eggs");
  });

  test("Heading steps through levels one to three, then back to text", async () => {
    const { user } = setup("Plan");
    const heading = screen.getByRole("button", { name: "Heading" });
    await user.click(heading);
    expect(text()).toBe("# Plan");
    await user.click(heading);
    expect(text()).toBe("## Plan");
    await user.click(heading);
    expect(text()).toBe("### Plan");
    await user.click(heading);
    expect(text()).toBe("Plan");
  });

  test("Indent and Outdent move a list item in and back out", async () => {
    const { user } = setup("- One\n- Two");
    await user.click(screen.getByRole("button", { name: "Indent" }));
    expect(text()).toMatch(/^- One\n\s+- Two$/);
    await user.click(screen.getByRole("button", { name: "Outdent" }));
    expect(text()).toBe("- One\n- Two");
  });

  test("Undo and Redo take back and restore the last change", async () => {
    const { user } = setup("Eggs");
    await user.click(screen.getByRole("button", { name: "Bulleted list" }));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(text()).toBe("Eggs");
    await user.click(screen.getByRole("button", { name: "Redo" }));
    expect(text()).toBe("- Eggs");
  });
});

test("writing buttons keep the note focused so the keyboard stays up", async () => {
  const { user, view } = setup("Eggs");
  view.focus();
  await user.click(screen.getByRole("button", { name: "Bulleted list" }));
  expect(view.hasFocus).toBe(true);
});

test("a press on the bar never takes focus from the note", async () => {
  setup();
  const bar = screen.getByRole("toolbar", { name: "Writing tools" });
  expect(await fireEvent.pointerDown(bar)).toBe(false);
  expect(await fireEvent.mouseDown(screen.getByRole("button", { name: "Tag" }))).toBe(false);
});

test("Add image opens the picker and lets the note give up focus", async () => {
  const { user, onImage, view } = setup("Trip");
  const focus = vi.spyOn(view, "focus");
  await user.click(screen.getByRole("button", { name: "Add image" }));
  expect(onImage).toHaveBeenCalledOnce();
  expect(focus).not.toHaveBeenCalled();
  expect(text()).toBe("Trip");
});

test("Hide keyboard takes focus out of the note", async () => {
  const { user, view } = setup("Trip");
  view.focus();
  expect(view.hasFocus).toBe(true);
  await user.click(screen.getByRole("button", { name: "Hide keyboard" }));
  expect(view.hasFocus).toBe(false);
});

test("does nothing while no note is open", async () => {
  const user = userEvent.setup();
  const onImage = vi.fn();
  render(KeyboardBar, { view: () => null, onImage });
  await user.click(screen.getByRole("button", { name: "Checklist" }));
  await user.click(screen.getByRole("button", { name: "Add image" }));
  await user.click(screen.getByRole("button", { name: "Hide keyboard" }));
  expect(onImage).not.toHaveBeenCalled();
});

describe("keyboard position", () => {
  /** iOS: the page keeps its height and the visible area shrinks above the keyboard. */
  function keyboardUp(height: number) {
    const vv = Object.assign(new EventTarget(), { height, offsetTop: 0 });
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    return vv;
  }

  test("sits at the bottom when nothing covers the page", () => {
    setup();
    const bar = screen.getByRole("toolbar", { name: "Writing tools" });
    expect(bar).not.toHaveClass("lifted");
  });

  test("rides above the iPhone keyboard and follows it", async () => {
    const vv = keyboardUp(window.innerHeight - 300);
    setup();
    const bar = screen.getByRole("toolbar", { name: "Writing tools" });
    expect(bar).toHaveClass("lifted");
    expect(bar.style.getPropertyValue("--lift")).toBe("300px");
    vv.height = window.innerHeight;
    vv.dispatchEvent(new Event("resize"));
    await Promise.resolve();
    expect(bar).not.toHaveClass("lifted");
    expect(bar.style.getPropertyValue("--lift")).toBe("0px");
  });
});
