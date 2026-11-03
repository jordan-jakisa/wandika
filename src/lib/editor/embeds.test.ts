import assert from "node:assert/strict";
import type { EditorView } from "@codemirror/view";
import { beforeEach, test, vi } from "vitest";
import { api } from "../api";
import { imageUrl, readyUrl } from "../attachments";
import { embeds, fileDrops, forgetNoteEmbeds } from "./embeds.ts";
import { decorations, focus, md, mousedown, select, viewOf } from "./testing.ts";

vi.mock("../api", () => ({ api: { resolveLink: vi.fn(), noteRead: vi.fn() } }));
vi.mock("../attachments", async (actual) => ({
  isImage: ((await actual()) as typeof import("../attachments")).isImage,
  readyUrl: vi.fn(),
  imageUrl: vi.fn(),
}));

const notes: Record<string, string> = {
  "Plan.md": "---\ntags: [a]\n---\n# Plan\nIntro **bold**\n## Goals\n- [x] Ship\n## Empty\n",
  "Folder/Deep.md": "Deep text",
};

beforeEach(() => {
  forgetNoteEmbeds();
  vi.mocked(api.resolveLink).mockReset().mockImplementation(async (name: string) => {
    const path = Object.keys(notes).find((p) => p.replace(/\.md$/, "").endsWith(name.split("/").pop()!));
    return path ?? null;
  });
  vi.mocked(api.noteRead).mockReset().mockImplementation(async (path: string) => notes[path]);
  vi.mocked(readyUrl).mockReset().mockReturnValue(undefined);
  vi.mocked(imageUrl).mockReset().mockImplementation(async (target: string) => `blob:${target}`);
});

const setup = (marked: string) => {
  const onOpen = vi.fn();
  const view = viewOf(marked, [md(), embeds(() => "Notes/Here.md", onOpen)]);
  return { view, onOpen };
};

const widgets = (view: EditorView, kind: string) => decorations(view).filter((d) => d.kind === kind);

test("a wiki image embed draws the image while the cursor is elsewhere", async () => {
  const { view } = setup("‸\n![[photo.png]]");
  assert.deepEqual(widgets(view, "ImageEmbed").map((d) => d.text), ["![[photo.png]]"]);
  const img = view.dom.querySelector<HTMLImageElement>(".cm-embed img")!;
  assert.equal(img.alt, "photo.png");
  assert.deepEqual(vi.mocked(imageUrl).mock.calls, [["photo.png", "Notes/Here.md"]]);
  await vi.waitFor(() => assert.equal(img.getAttribute("src"), "blob:photo.png"));
});

test("an image holds its space while loading, until it has loaded", async () => {
  const { view } = setup("‸\n![[photo.png]]");
  const wrap = view.dom.querySelector<HTMLElement>(".cm-embed")!;
  assert.ok(wrap.classList.contains("cm-embed-loading"));
  wrap.querySelector("img")!.dispatchEvent(new Event("load"));
  assert.ok(!wrap.classList.contains("cm-embed-loading"));
});

test("an image already loaded this session shows at once", () => {
  vi.mocked(readyUrl).mockReturnValue("blob:ready");
  const { view } = setup("‸\n![[photo.png]]");
  const wrap = view.dom.querySelector<HTMLElement>(".cm-embed")!;
  assert.equal(wrap.querySelector("img")!.getAttribute("src"), "blob:ready");
  assert.ok(!wrap.classList.contains("cm-embed-loading"));
  assert.equal(vi.mocked(imageUrl).mock.calls.length, 0);
});

test("a size after the bar sets the image's width", () => {
  const { view } = setup("‸\n![[a.png|300]] ![[b.jpg|120x80]] ![[c.gif|wide]]");
  const widths = [...view.dom.querySelectorAll<HTMLImageElement>(".cm-embed img")].map((i) => i.style.width);
  assert.deepEqual(widths, ["300px", "120px", ""]);
});

test("a Markdown image embeds with its alt text, size and decoded path", () => {
  const { view } = setup('‸\n![A cat|200](my%20cat.png "The cat")');
  const img = view.dom.querySelector<HTMLImageElement>(".cm-embed img")!;
  assert.equal(img.alt, "A cat");
  assert.equal(img.style.width, "200px");
  assert.deepEqual(vi.mocked(imageUrl).mock.calls, [["my cat.png", "Notes/Here.md"]]);
});

test("a Markdown image path in angle brackets may hold spaces", () => {
  const { view } = setup("‸\n![x](<my cat.png>) ![y](<plain.png>)");
  assert.deepEqual(vi.mocked(imageUrl).mock.calls.map((c) => c[0]), ["my cat.png", "plain.png"]);
  assert.equal(view.dom.querySelectorAll(".cm-embed").length, 2);
});

test("a path with a broken escape is used as written", () => {
  setup("‸\n![x](bad%E0%A4%A.png)");
  assert.deepEqual(vi.mocked(imageUrl).mock.calls.map((c) => c[0]), ["bad%E0%A4%A.png"]);
});

test("a web image is passed through by address", () => {
  setup("‸\n![logo](https://example.com/logo.png)");
  assert.deepEqual(vi.mocked(imageUrl).mock.calls.map((c) => c[0]), ["https://example.com/logo.png"]);
});

test("a missing image says it isn't in the vault", async () => {
  vi.mocked(imageUrl).mockRejectedValue(new Error("nope"));
  const { view } = setup("‸\n![[gone.png]]");
  const wrap = view.dom.querySelector<HTMLElement>(".cm-embed")!;
  await vi.waitFor(() => assert.equal(wrap.textContent, "gone.png isn't in this vault."));
  assert.ok(wrap.classList.contains("cm-embed-missing"));
  assert.ok(!wrap.classList.contains("cm-embed-loading"));
});

test("an image in a locked folder asks to unlock", async () => {
  vi.mocked(imageUrl).mockRejectedValue({ code: "locked" });
  const { view } = setup("‸\n![[secret.png]]");
  const wrap = view.dom.querySelector<HTMLElement>(".cm-embed")!;
  await vi.waitFor(() => assert.equal(wrap.textContent, "Unlock encrypted notes to see this image."));
});

test("on the cursor's line an embed shows its Markdown", async () => {
  const { view } = setup("![[photo.png]]‸\n![[Plan]]");
  await focus(view);
  assert.deepEqual(widgets(view, "ImageEmbed"), []);
  assert.equal(widgets(view, "NoteEmbed").length, 1);
  select(view, "![[photo.png]]\n![[Plan]]‸");
  assert.equal(widgets(view, "ImageEmbed").length, 1);
  assert.deepEqual(widgets(view, "NoteEmbed"), []);
});

test("an unfocused editor draws embeds on every line", () => {
  const { view } = setup("![[photo.png]]‸");
  assert.equal(widgets(view, "ImageEmbed").length, 1);
});

test("embeds in code stay as text", () => {
  const { view } = setup("‸\n```\n![[photo.png]]\n```\n\n    ![[Plan]]\n");
  assert.deepEqual(decorations(view), []);
});

test("plain links and text are not embeds", () => {
  const { view } = setup("‸\n[[Plan]] [x](a.png) ! [[b.png]]");
  assert.deepEqual(decorations(view), []);
});

test("a note embed shows the note's title and its text, without frontmatter", async () => {
  const { view } = setup("‸\n![[Plan]]");
  const box = view.dom.querySelector<HTMLElement>(".cm-note-embed")!;
  assert.equal(box.querySelector(".cm-note-embed-title")!.textContent, "Plan");
  const body = box.querySelector<HTMLElement>(".cm-note-embed-body")!;
  await vi.waitFor(() => assert.ok(body.innerHTML.includes("<strong>bold</strong>")));
  assert.ok(!body.textContent!.includes("tags"));
  assert.deepEqual(vi.mocked(api.noteRead).mock.calls, [["Plan.md"]]);
});

test("a note embed shows a placeholder while the note loads", () => {
  const { view } = setup("‸\n![[Plan]]");
  assert.equal(view.dom.querySelector(".cm-note-embed-body")!.innerHTML, '<p class="more">…</p>');
});

test("a heading embed shows that section and names it in the title", async () => {
  const { view } = setup("‸\n![[Plan#Goals]]");
  const box = view.dom.querySelector<HTMLElement>(".cm-note-embed")!;
  assert.equal(box.querySelector(".cm-note-embed-title")!.textContent, "Plan › Goals");
  const body = box.querySelector<HTMLElement>(".cm-note-embed-body")!;
  await vi.waitFor(() => assert.ok(body.textContent!.includes("☑ Ship")));
  assert.ok(!body.textContent!.includes("Intro"));
});

test("a block embed's title drops the caret", () => {
  const { view } = setup("‸\n![[Plan#^r1]]");
  assert.equal(view.dom.querySelector(".cm-note-embed-title")!.textContent, "Plan › r1");
});

test("a note in a folder is titled by its own name", () => {
  const { view } = setup("‸\n![[Folder/Deep|Shown]]");
  assert.equal(view.dom.querySelector(".cm-note-embed-title")!.textContent, "Deep");
});

test("a long note embed says there is more", async () => {
  notes["Long.md"] = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  try {
    const { view } = setup("‸\n![[Long]]");
    const body = view.dom.querySelector<HTMLElement>(".cm-note-embed-body")!;
    await vi.waitFor(() => assert.ok(body.textContent!.includes("line 39")));
    assert.ok(body.innerHTML.endsWith('<p class="more">…</p>'));
    assert.ok(!body.textContent!.includes("line 40"));
  } finally {
    delete notes["Long.md"];
  }
});

test("a missing note says it isn't in the vault yet", async () => {
  const { view } = setup("‸\n![[Nowhere]]");
  const box = view.dom.querySelector<HTMLElement>(".cm-note-embed")!;
  await vi.waitFor(() => assert.ok(box.classList.contains("cm-embed-missing")));
  assert.equal(box.querySelector(".cm-note-embed-body")!.textContent, "Nowhere isn't in this vault yet.");
});

test("a heading with nothing under it says so", async () => {
  const { view } = setup("‸\n![[Plan#Missing]]");
  const body = view.dom.querySelector<HTMLElement>(".cm-note-embed-body")!;
  await vi.waitFor(() => assert.equal(body.textContent, "Nothing under “Missing” in Plan."));
});

test("a note read error says the note isn't in the vault yet", async () => {
  vi.mocked(api.noteRead).mockRejectedValue(new Error("io"));
  const { view } = setup("‸\n![[Plan]]");
  const body = view.dom.querySelector<HTMLElement>(".cm-note-embed-body")!;
  await vi.waitFor(() => assert.equal(body.textContent, "Plan isn't in this vault yet."));
});

test("a rendered note embed is remembered until notes change", async () => {
  const first = setup("‸\n![[Plan]]");
  const body = first.view.dom.querySelector<HTMLElement>(".cm-note-embed-body")!;
  await vi.waitFor(() => assert.ok(body.textContent!.includes("Intro")));
  const second = setup("‸\n![[Plan]]");
  assert.ok(second.view.dom.querySelector(".cm-note-embed-body")!.textContent!.includes("Intro"));
  assert.equal(vi.mocked(api.noteRead).mock.calls.length, 1);
  forgetNoteEmbeds();
  setup("‸\n![[Plan]]");
  assert.equal(vi.mocked(api.resolveLink).mock.calls.length, 2);
});

test("tapping a note embed's title opens the note", () => {
  const { view, onOpen } = setup("‸\n![[Plan#Goals]]");
  const title = view.dom.querySelector<HTMLButtonElement>(".cm-note-embed-title")!;
  assert.ok(mousedown(title).defaultPrevented);
  title.click();
  assert.deepEqual(onOpen.mock.calls, [["Plan#Goals"]]);
});

test("several embeds on one line each draw", () => {
  const { view } = setup("‸\n![[a.png]] and ![[Plan]] and ![b](c.png)");
  assert.deepEqual(
    decorations(view).map((d) => d.kind),
    ["ImageEmbed", "NoteEmbed", "ImageEmbed"],
  );
});

test("unicode names embed as written", () => {
  const { view } = setup("‸\n![[café ☕.png]]");
  assert.equal(view.dom.querySelector<HTMLImageElement>(".cm-embed img")!.alt, "café ☕.png");
});

test("editing the line updates the embed", () => {
  const { view } = setup("‸\n![[a.png]]");
  view.dispatch({ changes: { from: 4, to: 5, insert: "b" } });
  assert.equal(view.dom.querySelector<HTMLImageElement>(".cm-embed img")!.alt, "b.png");
});

function filesEvent(type: "paste" | "drop", files: File[]) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const data = { files, getData: () => "", types: [] };
  Object.defineProperty(e, type === "paste" ? "clipboardData" : "dataTransfer", { value: data });
  Object.assign(e, { clientX: 0, clientY: 0 });
  return e;
}

test("pasted files are handed over at the cursor", () => {
  const onFiles = vi.fn();
  const view = viewOf("ab‸c", [fileDrops(onFiles)]);
  const file = new File(["x"], "shot.png", { type: "image/png" });
  const e = filesEvent("paste", [file]);
  view.contentDOM.dispatchEvent(e);
  assert.ok(e.defaultPrevented);
  assert.deepEqual(onFiles.mock.calls, [[[file], view, 2]]);
});

test("a paste without files is left to the editor", () => {
  const onFiles = vi.fn();
  const view = viewOf("‸", [fileDrops(onFiles)]);
  view.contentDOM.dispatchEvent(filesEvent("paste", []));
  assert.equal(onFiles.mock.calls.length, 0);
});

test("dropped files are handed over at the drop point, or the cursor when it can't be found", () => {
  const onFiles = vi.fn();
  const view = viewOf("abc‸", [fileDrops(onFiles)]);
  const file = new File(["x"], "a.pdf");
  const at = vi.spyOn(view, "posAtCoords").mockReturnValueOnce(1).mockReturnValueOnce(null);
  const e = filesEvent("drop", [file]);
  view.contentDOM.dispatchEvent(e);
  assert.ok(e.defaultPrevented);
  view.contentDOM.dispatchEvent(filesEvent("drop", [file]));
  assert.deepEqual(
    onFiles.mock.calls.map((c) => c[2]),
    [1, 3],
  );
  assert.equal(at.mock.calls.length, 2);
});

test("a drop without files is left to the editor", () => {
  const onFiles = vi.fn();
  const view = viewOf("‸", [fileDrops(onFiles)]);
  view.contentDOM.dispatchEvent(filesEvent("drop", []));
  assert.equal(onFiles.mock.calls.length, 0);
});
