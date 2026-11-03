import { expect, test } from "vitest";
import * as layout from "./+layout";

test("the app is a single page with no server rendering, as Tauri needs", () => {
  expect(layout.ssr).toBe(false);
  expect(Object.keys(layout)).toEqual(["ssr"]);
});
