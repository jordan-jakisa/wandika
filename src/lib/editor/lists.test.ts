import assert from "node:assert/strict";
import { test } from "vitest";
import { convertLines, cycleHeading, toggleWrap } from "./lists.ts";

const numberedWithDescriptions = [
  "12. Onboarding Emails",
  "    The button now opens the upload page.",
  "13. Sign-In Errors",
  "    Cancel on Google's screen.",
];

test("numbered items become a checklist; their indented descriptions stay put", () => {
  assert.deepEqual(convertLines(numberedWithDescriptions, "task"), [
    "- [ ] Onboarding Emails",
    "    The button now opens the upload page.",
    "- [ ] Sign-In Errors",
    "    Cancel on Google's screen.",
  ]);
});

test("plain lines become bullets and numbers count from one", () => {
  assert.deepEqual(convertLines(["Milk", "", "Eggs"], "bullet"), ["- Milk", "", "- Eggs"]);
  assert.deepEqual(convertLines(["- a", "- b", "  - c", "- d"], "numbered"), ["1. a", "2. b", "  1. c", "3. d"]);
});

test("converting to the same kind turns the list back into text", () => {
  assert.deepEqual(convertLines(["- [x] Done", "- [ ] Next"], "task"), ["Done", "Next"]);
  assert.deepEqual(convertLines(["- a", "- b"], "bullet"), ["a", "b"]);
});

test("ticked tasks stay ticked when converted from a checklist to a checklist with a new item", () => {
  assert.deepEqual(convertLines(["- [x] Done", "New"], "task"), ["- [x] Done", "- [ ] New"]);
});

test("quotes and plain text", () => {
  assert.deepEqual(convertLines(["one", "two"], "quote"), ["> one", "> two"]);
  assert.deepEqual(convertLines(["> one", "1. two"], "plain"), ["one", "two"]);
});

test("wrapping toggles and keeps spaces outside the marks", () => {
  assert.equal(toggleWrap("bold", "**"), "**bold**");
  assert.equal(toggleWrap("**bold**", "**"), "bold");
  assert.equal(toggleWrap(" word ", "*"), " *word* ");
});

test("the heading button cycles a line through three levels and back", () => {
  assert.equal(cycleHeading("Plan"), "# Plan");
  assert.equal(cycleHeading("# Plan"), "## Plan");
  assert.equal(cycleHeading("## Plan"), "### Plan");
  assert.equal(cycleHeading("### Plan"), "Plan");
});

test("an empty selection converts to nothing", () => {
  assert.deepEqual(convertLines([], "bullet"), []);
});

test("blank lines between items stay blank", () => {
  assert.deepEqual(convertLines(["a", "", "   ", "b"], "task"), ["- [ ] a", "", "   ", "- [ ] b"]);
});

test("every bullet style and both number styles are recognised", () => {
  assert.deepEqual(convertLines(["* a", "+ b", "- c"], "numbered"), ["1. a", "2. b", "3. c"]);
  assert.deepEqual(convertLines(["1) a", "2. b"], "bullet"), ["- a", "- b"]);
  assert.deepEqual(convertLines(["* [X] a", "+ [ ] b"], "bullet"), ["- a", "- b"]);
});

test("a capital X counts as ticked", () => {
  assert.deepEqual(convertLines(["- [X] Done", "- [x] Also", "Plain"], "task"), ["- [x] Done", "- [x] Also", "- [ ] Plain"]);
});

test("ticks are dropped when a checklist becomes another kind", () => {
  assert.deepEqual(convertLines(["- [x] Done"], "numbered"), ["1. Done"]);
});

test("indentation is kept, with spaces or tabs", () => {
  assert.deepEqual(convertLines(["a", "  b", "\tc"], "bullet"), ["- a", "  - b", "\t- c"]);
});

test("numbering restarts under each new parent", () => {
  assert.deepEqual(convertLines(["- a", "  - x", "  - y", "- b", "  - z"], "numbered"), [
    "1. a",
    "  1. x",
    "  2. y",
    "2. b",
    "  1. z",
  ]);
});

test("a tab and four spaces are the same level for numbering", () => {
  assert.deepEqual(convertLines(["- a", "\t- b", "    - c"], "numbered"), ["1. a", "\t1. b", "    2. c"]);
});

test("quotes become list items and back", () => {
  assert.deepEqual(convertLines(["> one", ">two", "  > three"], "bullet"), ["- one", "- two", "  - three"]);
  assert.deepEqual(convertLines(["> one", "> two"], "quote"), ["one", "two"]);
});

test("a mixed selection converts to the asked kind, not back to text", () => {
  assert.deepEqual(convertLines(["- a", "b"], "bullet"), ["- a", "- b"]);
});

test("without list items, indented plain lines are converted too", () => {
  assert.deepEqual(convertLines(["a", "    b"], "bullet"), ["- a", "    - b"]);
});

test("unicode text is carried over untouched", () => {
  assert.deepEqual(convertLines(["Kampala 🇺🇬", "naïve café", "日本語"], "task"), [
    "- [ ] Kampala 🇺🇬",
    "- [ ] naïve café",
    "- [ ] 日本語",
  ]);
});

test("wrapping an empty or blank selection leaves it alone", () => {
  assert.equal(toggleWrap("", "**"), "");
  assert.equal(toggleWrap("   ", "*"), "   ");
});

test("unwrapping needs the mark on both ends", () => {
  assert.equal(toggleWrap("**bold", "**"), "****bold**");
  assert.equal(toggleWrap("~~gone~~", "~~"), "gone");
  assert.equal(toggleWrap("`code`", "`"), "code");
  assert.equal(toggleWrap("****", "**"), "");
});

test("wrapping keeps line breaks and unicode inside the marks", () => {
  assert.equal(toggleWrap("one\ntwo", "*"), "*one\ntwo*");
  assert.equal(toggleWrap("\nemoji 🎉\n", "**"), "\n**emoji 🎉**\n");
});

test("the heading button keeps indentation and resets deeper headings", () => {
  assert.equal(cycleHeading("  ## Plan"), "  ### Plan");
  assert.equal(cycleHeading("  ### Plan"), "  Plan");
  assert.equal(cycleHeading("#### Deep"), "Deep");
  assert.equal(cycleHeading("   Indented"), "# Indented");
});

test("the heading button on an empty line starts a heading", () => {
  assert.equal(cycleHeading(""), "# ");
});

test("a hash without a space is text, not a heading", () => {
  assert.equal(cycleHeading("#tag"), "# #tag");
});
