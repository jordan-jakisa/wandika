import assert from "node:assert/strict";
import { test } from "vitest";
import { mailRef, mailUrl } from "./mailLinks";

test("Gmail and Outlook links point at their email", () => {
  assert.deepEqual(mailRef("https://mail.google.com/mail/u/0/#inbox/18c2f0a1b2c3d4e5"), { source: "google", id: "18c2f0a1b2c3d4e5" });
  assert.deepEqual(mailRef("https://mail.google.com/mail/u/1/#all/18c2f0a1b2c3"), { source: "google", id: "18c2f0a1b2c3" });
  assert.deepEqual(
    mailRef("https://outlook.office365.com/owa/?ItemID=AAMkAD%2Fx%3D&exvsurl=1&viewmodel=ReadMessageItem"),
    { source: "microsoft", id: "AAMkAD/x=" },
  );
  assert.deepEqual(mailRef("https://outlook.live.com/owa/?ItemID=AQMk&viewmodel=ReadMessageItem"), { source: "microsoft", id: "AQMk" });
});

test("other links, and mail pages that aren't one email, stay links", () => {
  for (const url of [
    "https://mail.google.com/mail/u/0/#inbox",
    "https://mail.google.com/mail/u/0/#search/rent",
    "https://outlook.office365.com/mail/",
    "https://example.com/#inbox/18c2f0a1b2c3d4e5",
    "not a url",
  ]) {
    assert.equal(mailRef(url), null, url);
  }
});

test("a saved Gmail link names the message, not the thread", () => {
  assert.equal(mailUrl({ source: "google", id: "abc123" }, "https://mail.google.com/mail/u/0/#inbox/thread"), "https://mail.google.com/mail/u/0/#all/abc123");
  assert.equal(mailUrl({ source: "microsoft", id: "x" }, "https://outlook/web"), "https://outlook/web");
});
