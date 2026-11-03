import "@testing-library/jest-dom/vitest";
import { isModal, resetApp } from "../../test/components-views";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { flushSync } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../api";
import { app } from "../app.svelte";
import { forgetImages } from "../attachments";
import ImageViewer from "./ImageViewer.svelte";

beforeEach(() => {
  resetApp();
  forgetImages();
  URL.createObjectURL = vi.fn(() => "blob:image");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(api, "attachmentRead").mockResolvedValue(new ArrayBuffer(8));
});
afterEach(() => vi.restoreAllMocks());

function view(path: string) {
  app.viewing = path;
  flushSync();
}

test("stays closed while no image is picked", () => {
  render(ImageViewer);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("opens full screen as a modal named after the file", async () => {
  render(ImageViewer);
  view("attachments/Sync sketch.svg");
  const dialog = screen.getByRole("dialog", { name: "Sync sketch.svg" });
  expect(isModal(dialog)).toBe(true);
  expect(screen.getByText("Sync sketch.svg")).toBeInTheDocument();
  expect(api.attachmentRead).toHaveBeenCalledWith("attachments/Sync sketch.svg", "");
  const img = await screen.findByRole("img", { name: "Sync sketch.svg" });
  expect(img).toHaveAttribute("src", "blob:image");
});

test("the picture fades in only once it has loaded", async () => {
  render(ImageViewer);
  view("attachments/Photo.jpg");
  const img = await screen.findByRole("img", { name: "Photo.jpg" });
  expect(img).not.toHaveClass("shown");
  await fireEvent.load(img);
  expect(img).toHaveClass("shown");
});

test("an encrypted image is named without its .age ending", () => {
  render(ImageViewer);
  view("Private/Passport.png.age");
  expect(screen.getByRole("dialog", { name: "Passport.png" })).toBeInTheDocument();
});

test("says so when the image can't be read", async () => {
  vi.mocked(api.attachmentRead).mockRejectedValue(new Error("gone"));
  render(ImageViewer);
  view("attachments/Missing.png");
  expect(await screen.findByText("This image couldn't be opened.")).toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});

test("Close shuts the viewer", async () => {
  const user = userEvent.setup();
  render(ImageViewer);
  view("attachments/Photo.jpg");
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(app.viewing).toBeNull();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("Escape shuts the viewer", async () => {
  const user = userEvent.setup();
  render(ImageViewer);
  view("attachments/Photo.jpg");
  await user.keyboard("{Escape}");
  expect(app.viewing).toBeNull();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("a tap on the dark backdrop shuts it, a tap on the picture doesn't", async () => {
  const user = userEvent.setup();
  render(ImageViewer);
  view("attachments/Photo.jpg");
  await user.click(await screen.findByRole("img"));
  expect(app.viewing).toBe("attachments/Photo.jpg");
  await user.click(screen.getByRole("dialog"));
  expect(app.viewing).toBeNull();
});

test("opening again shows the new image, not the last one's error", async () => {
  vi.mocked(api.attachmentRead).mockRejectedValueOnce(new Error("gone"));
  render(ImageViewer);
  view("attachments/Missing.png");
  await screen.findByText("This image couldn't be opened.");
  view(null as unknown as string);
  view("attachments/Photo.jpg");
  await waitFor(() => expect(screen.getByRole("img", { name: "Photo.jpg" })).toBeInTheDocument());
  expect(screen.queryByText("This image couldn't be opened.")).not.toBeInTheDocument();
});

test("a slow failure for an image already closed doesn't spoil the next one", async () => {
  let fail!: (e: Error) => void;
  vi.mocked(api.attachmentRead).mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
  render(ImageViewer);
  view("attachments/Slow.png");
  view(null as unknown as string);
  view("attachments/Photo.jpg");
  await screen.findByRole("img", { name: "Photo.jpg" });
  fail(new Error("timed out"));
  await new Promise((r) => setTimeout(r));
  expect(screen.getByRole("img", { name: "Photo.jpg" })).toBeInTheDocument();
  expect(screen.queryByText("This image couldn't be opened.")).not.toBeInTheDocument();
});

test("a drawing made in Wandika offers Edit drawing, which opens it on the pad", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "attachmentRead").mockResolvedValue(new TextEncoder().encode('<svg data-wandika-drawing="1"></svg>').slice().buffer as ArrayBuffer);
  render(ImageViewer);
  view("attachments/Drawing.svg");
  await user.click(await screen.findByRole("button", { name: "Edit drawing" }));
  expect(app.viewing).toBeNull();
  expect(app.drawing).toEqual({ note: "", edit: { target: "attachments/Drawing.svg", from: "" } });
});

test("any other picture has no Edit drawing", async () => {
  vi.spyOn(api, "attachmentRead").mockResolvedValue(new TextEncoder().encode("<svg><circle/></svg>").slice().buffer as ArrayBuffer);
  render(ImageViewer);
  view("attachments/Logo.svg");
  await waitFor(() => expect(api.attachmentRead).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("button", { name: "Edit drawing" })).not.toBeInTheDocument();
  view("photo.png");
});
