import { expect, test } from "vitest";
import { fold } from "./fold";

test("folds accents and the letters Unicode can't split, as Obsidian's search does", () => {
  expect(fold("Café Łódź Straße Ærø Œuvre Þór İstanbul Tiếng Việt")).toBe("cafe lodz strasse aero oeuvre thor istanbul tieng viet");
  expect(fold("Ὀδυσσεύς")).toBe("οδυσσευς");
});
