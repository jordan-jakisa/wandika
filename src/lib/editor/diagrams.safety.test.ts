import assert from "node:assert/strict";
import { test } from "vitest";

// The real renderer, not the stand-in diagrams.test.ts uses: notes must never run code (App Store
// Review Guideline 2.5.2), and a diagram's labels are text from the note.
test("a diagram can't carry script into the note: labels and links come out as text", async () => {
  const { renderAsync } = await import("pele/lazy");
  const { svg } = await renderAsync('graph TD\n  A["<img src=x onerror=alert(1)>"] --> B["<script>alert(2)</script>"]\n  click A "javascript:alert(3)"', {});
  assert.ok(svg.includes("<svg"), "it did render");
  assert.ok(!/<img[^>]*onerror/i.test(svg));
  assert.ok(!/<script/i.test(svg));
  assert.ok(!/javascript:/i.test(svg));
});
