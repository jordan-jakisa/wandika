import { afterEach, expect, test, vi } from "vitest";
import { api } from "./api";
import * as attachments from "./attachments";
import { exportPdf, layOut } from "./exportPdf";

afterEach(() => {
  vi.restoreAllMocks();
  document.getElementById("print-root")?.remove();
});

test("the print page holds the title and the note, with vault pictures loaded", async () => {
  vi.spyOn(attachments, "imageUrl").mockResolvedValue("blob:pic");
  HTMLImageElement.prototype.decode ??= () => Promise.resolve();
  const root = await layOut("Trips/Rome.md", "Rome <2026>", "# Days\n\n![[map.png]]\n\n- [ ] Pack");
  expect(root.querySelector("h1")!.textContent).toBe("Rome <2026>");
  expect(root.querySelector("h2")!.textContent).toBe("Days");
  expect(root.querySelector("img")!.getAttribute("src")).toBe("blob:pic");
  expect(attachments.imageUrl).toHaveBeenCalledWith("map.png", "Trips/Rome.md");
});

test("a picture that isn't on this device prints as its name", async () => {
  vi.spyOn(attachments, "imageUrl").mockRejectedValue(new Error("missing"));
  const root = await layOut("A.md", "A", "![[gone.png]]");
  expect(root.querySelector("img")).toBeNull();
  expect(root.textContent).toContain("gone.png");
});

test("exporting lays the page out, then hands it to the system under the note's name", async () => {
  const print = vi.spyOn(api, "notePrint").mockResolvedValue();
  await exportPdf("A.md", "Packing list", "- socks");
  expect(document.getElementById("print-root")!.textContent).toContain("socks");
  expect(print).toHaveBeenCalledWith("Packing list");
  expect(document.title).toBe("Packing list");
});
