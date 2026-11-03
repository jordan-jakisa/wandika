import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ attachmentRead: vi.fn() }));
vi.mock("./api", () => ({ api }));

type Attachments = typeof import("./attachments");

let made = 0;
const create = vi.fn((blob: Blob) => `blob:${++made}:${blob.type}`);
const revoke = vi.fn();

/** A fresh module, so nothing is cached from an earlier test. */
async function fresh(): Promise<Attachments> {
  vi.resetModules();
  return import("./attachments");
}

beforeEach(() => {
  made = 0;
  api.attachmentRead.mockReset();
  api.attachmentRead.mockImplementation(async () => new Uint8Array([1, 2, 3]).buffer);
  create.mockClear();
  revoke.mockClear();
  // jsdom has no blob URLs.
  URL.createObjectURL = create;
  URL.revokeObjectURL = revoke;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isImage", () => {
  test("knows the image types, in any case", async () => {
    const { isImage } = await fresh();
    for (const name of ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.svg", "a.avif", "a.bmp", "IMG_1.HEIC"]) {
      expect(isImage(name), name).toBe(true);
    }
  });

  test("ignores a query or fragment after the name", async () => {
    const { isImage } = await fresh();
    expect(isImage("https://x.com/a.png?size=2")).toBe(true);
    expect(isImage("a.png#crop")).toBe(true);
    expect(isImage("a.md?x=.png")).toBe(false);
  });

  test("other files and names without a type are not images", async () => {
    const { isImage } = await fresh();
    expect(isImage("Note")).toBe(false);
    expect(isImage("Note.md")).toBe(false);
    expect(isImage("report.pdf")).toBe(false);
    expect(isImage("")).toBe(false);
    // A note named like a type, or in a folder with a dot, is still a note.
    expect(isImage("png")).toBe(false);
    expect(isImage("photos.png/Note")).toBe(false);
    expect(isImage(".png")).toBe(false);
    expect(isImage("Café/日本.png")).toBe(true);
  });
});

describe("imageUrl", () => {
  test("web and data images pass straight through", async () => {
    const { imageUrl, readyUrl } = await fresh();
    expect(await imageUrl("https://example.com/a.png", "Note.md")).toBe("https://example.com/a.png");
    expect(await imageUrl("HTTP://example.com/a.png", "Note.md")).toBe("HTTP://example.com/a.png");
    expect(await imageUrl("data:image/png;base64,AAAA", "Note.md")).toBe("data:image/png;base64,AAAA");
    expect(readyUrl("https://example.com/a.png", "Note.md")).toBe("https://example.com/a.png");
    expect(api.attachmentRead).not.toHaveBeenCalled();
  });

  test("a vault image is read once and shown with its type", async () => {
    const { imageUrl, readyUrl } = await fresh();
    expect(readyUrl("pic.png", "Note.md")).toBeUndefined();
    const url = await imageUrl("pic.png", "Note.md");
    expect(url).toBe("blob:1:image/png");
    expect(api.attachmentRead).toHaveBeenCalledWith("pic.png", "Note.md");
    expect(await imageUrl("pic.png", "Note.md")).toBe(url);
    expect(api.attachmentRead).toHaveBeenCalledTimes(1);
    expect(readyUrl("pic.png", "Note.md")).toBe(url);
    expect(await imageUrl("pic.JPG", "Note.md")).toBe("blob:2:image/jpeg");
    expect(await imageUrl("pic.svg", "Note.md")).toBe("blob:3:image/svg+xml");
  });

  test("the same name from another note is read for that note", async () => {
    const { imageUrl } = await fresh();
    await imageUrl("pic.png", "A.md");
    await imageUrl("pic.png", "Folder/B.md");
    expect(api.attachmentRead).toHaveBeenCalledTimes(2);
  });

  test("two requests at once share one read", async () => {
    const { imageUrl } = await fresh();
    const [a, b] = await Promise.all([imageUrl("pic.png", "Note.md"), imageUrl("pic.png", "Note.md")]);
    expect(a).toBe(b);
    expect(api.attachmentRead).toHaveBeenCalledTimes(1);
  });

  test("a failed read is tried again next time", async () => {
    const { imageUrl, readyUrl } = await fresh();
    api.attachmentRead.mockRejectedValueOnce(new Error("pic.png isn't in this vault."));
    await expect(imageUrl("pic.png", "Note.md")).rejects.toThrow("isn't in this vault");
    expect(readyUrl("pic.png", "Note.md")).toBeUndefined();
    expect(await imageUrl("pic.png", "Note.md")).toBe("blob:1:image/png");
    expect(api.attachmentRead).toHaveBeenCalledTimes(2);
  });
});

describe("forgetImages", () => {
  test("drops every image and frees its memory", async () => {
    const { imageUrl, readyUrl, forgetImages } = await fresh();
    const url = await imageUrl("pic.png", "Note.md");
    forgetImages();
    await Promise.resolve();
    expect(revoke).toHaveBeenCalledWith(url);
    expect(readyUrl("pic.png", "Note.md")).toBeUndefined();
    await imageUrl("pic.png", "Note.md");
    expect(api.attachmentRead).toHaveBeenCalledTimes(2);
  });

  test("an image still loading when forgotten isn't kept", async () => {
    const { imageUrl, readyUrl, forgetImages } = await fresh();
    let finish!: (b: ArrayBuffer) => void;
    api.attachmentRead.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const loading = imageUrl("pic.png", "Note.md");
    forgetImages();
    finish(new Uint8Array([1]).buffer);
    const url = await loading;
    await Promise.resolve();
    expect(revoke).toHaveBeenCalledWith(url);
    expect(readyUrl("pic.png", "Note.md")).toBeUndefined();
  });

  test("a failed read after forgetting doesn't drop the newer one", async () => {
    const { imageUrl, forgetImages } = await fresh();
    let fail!: (e: Error) => void;
    api.attachmentRead.mockReturnValueOnce(new Promise((_, r) => (fail = r)));
    const first = imageUrl("pic.png", "Note.md");
    forgetImages();
    const second = await imageUrl("pic.png", "Note.md");
    fail(new Error("gone"));
    await expect(first).rejects.toThrow("gone");
    expect(await imageUrl("pic.png", "Note.md")).toBe(second);
    expect(api.attachmentRead).toHaveBeenCalledTimes(2);
  });

  test("failed reads are forgotten without an error", async () => {
    const { imageUrl, forgetImages } = await fresh();
    api.attachmentRead.mockRejectedValueOnce(new Error("x"));
    await imageUrl("pic.png", "Note.md").catch(() => {});
    expect(() => forgetImages()).not.toThrow();
  });
});

describe("pastedName", () => {
  const file = (name: string, type = "image/png") => new File([new Uint8Array([1])], name, { type });

  test("a named file keeps its name", async () => {
    const { pastedName } = await fresh();
    expect(pastedName(file("Beach day.jpg", "image/jpeg"))).toBe("Beach day.jpg");
    expect(pastedName(file("日本 📷.png"))).toBe("日本 📷.png");
    expect(pastedName(file("images.png"))).toBe("images.png");
  });

  test("a pasted picture gets Obsidian's dated name in local time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 3, 9, 45, 12));
    const { pastedName } = await fresh();
    expect(pastedName(file(""))).toBe("Pasted image 20261103094512.png");
    expect(pastedName(file("image.png"))).toBe("Pasted image 20261103094512.png");
    expect(pastedName(file("IMAGE.JPG", "image/jpeg"))).toBe("Pasted image 20261103094512.jpg");
    expect(pastedName(file("image.gif", "image/gif"))).toBe("Pasted image 20261103094512.gif");
    expect(pastedName(file("image.webp", "image/webp"))).toBe("Pasted image 20261103094512.webp");
  });

  test("single digits are padded, and a year's last second stays in that year", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 59));
    const { pastedName } = await fresh();
    expect(pastedName(file(""))).toBe("Pasted image 20261231235959.png");
    vi.setSystemTime(new Date(2027, 0, 1, 0, 0, 1));
    expect(pastedName(file(""))).toBe("Pasted image 20270101000001.png");
  });

  test("an unknown type is saved as PNG", async () => {
    const { pastedName } = await fresh();
    expect(pastedName(file("", "application/octet-stream"))).toMatch(/^Pasted image \d{14}\.png$/);
    expect(pastedName(file("", ""))).toMatch(/\.png$/);
  });
});
