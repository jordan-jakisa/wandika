import { expect, test } from "vitest";
import { plainText } from "./plain";

test("links show their words and marks go, for one-line excerpts", () => {
  expect(plainText("The dashboard is [[Welcome]]. Open that.")).toBe("The dashboard is Welcome. Open that.");
  expect(plainText("See [[Projects/Wandika#Plan|the plan]] and [[Daily/2026-11-03]]")).toBe("See the plan and 2026-11-03");
  expect(plainText("Read [the docs](https://example.com) **now** and `code`")).toBe("Read the docs now and code");
  expect(plainText("![[Drawing.svg]] sketch")).toBe("Drawing.svg sketch");
});
