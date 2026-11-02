import assert from "node:assert/strict";
import { test } from "node:test";
import { convertLines, toggleWrap } from "./lists.ts";

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
