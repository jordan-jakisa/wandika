import assert from "node:assert/strict";
import { test } from "vitest";
import { composeTask, emailTask, matchesTask, parseTask, tagsOf, taskOrder } from "./taskText";

test("a task line splits into its name, tags, pin, priority and due date", () => {
  assert.deepEqual(parseTask("Call Amina #home #Work/admin 📌 ⏫ 📅 2026-11-05"), {
    name: "Call Amina #home #Work/admin",
    tags: ["home", "work/admin"],
    pinned: true,
    priority: "high",
    due: "2026-11-05",
  });
  assert.deepEqual(parseTask("Plain task"), { name: "Plain task", tags: [], pinned: false, priority: null, due: null });
  assert.equal(parseTask("Done ✅ 2026-01-01").name, "Done", "other markers are not part of the name");
  assert.equal(parseTask("Low 🔽️").priority, "low", "an emoji variation selector doesn't hide the priority");
});

test("tags are words after #, not headings, numbers or anchors", () => {
  assert.deepEqual(tagsOf("#idea and #idea, #2026 issue#3 #a-b_c #ünïcode"), ["idea", "a-b_c", "ünïcode"]);
});

test("changing one part keeps the others and the markers Wandika doesn't own", () => {
  const text = "Pay rent #home 🔁 every month ⏳ 2026-11-01 📅 2026-11-03";
  assert.equal(composeTask(text, { pinned: true }), "Pay rent #home 📌 📅 2026-11-03 🔁 every month ⏳ 2026-11-01");
  assert.equal(composeTask(text, { due: null }), "Pay rent #home 🔁 every month ⏳ 2026-11-01");
  assert.equal(composeTask("Pay rent 📌 ⏫", { pinned: false, priority: "lowest" }), "Pay rent ⏬");
  assert.equal(composeTask("Pay rent", { name: "  Pay   the rent ", priority: "medium", due: "2026-12-01" }), "Pay the rent 🔼 📅 2026-12-01");
  assert.equal(composeTask("Done ✅ 2026-01-01", { due: "2026-01-02" }), "Done 📅 2026-01-02 ✅ 2026-01-01");
});

test("search needs every word, matches tags as tags, and ignores case and accents", () => {
  const task = { text: "Call Amina about the café #home/rent", details: "bring the lease", title: "Errands", path: "Life/Errands.md" };
  for (const q of ["", "amina", "AMINA cafe", "lease", "errands", "#home", "#home/rent", "#HOME amina", "life/"]) {
    assert.ok(matchesTask(task, q), q);
  }
  for (const q of ["bob", "amina bob", "#hom", "#rent", "#work"]) assert.ok(!matchesTask(task, q), q);
  assert.ok(matchesTask({ text: "Ship #release" }, "#"), "a lone # is still being typed");
});

test("pinned tasks come first, then priority, then the nearest due date", () => {
  const tasks = ["No date", "Later 📅 2026-12-01", "Soon 📅 2026-11-04", "Low 🔽", "Urgent 🔺", "Pinned 📌", "Pinned high 📌 ⏫"];
  assert.deepEqual([...tasks].sort(taskOrder), [
    "Pinned high 📌 ⏫",
    "Pinned 📌",
    "Urgent 🔺",
    "Soon 📅 2026-11-04",
    "Later 📅 2026-12-01",
    "No date",
    "Low 🔽",
  ]);
});

test("an email becomes a task named after its subject with a link back", () => {
  assert.equal(
    emailTask("Re: [Lease] keys", '"Amina K" <amina@x.com>', "https://mail.google.com/mail/u/0/#all/abc"),
    "Re: Lease keys [email from Amina K](https://mail.google.com/mail/u/0/#all/abc)",
  );
  assert.equal(emailTask("  ", "amina@x.com", null), "Email (from amina@x.com)");
  assert.equal(emailTask("Hi", "", "https://x"), "Hi [email](https://x)");
});
