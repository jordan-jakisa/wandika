import "@testing-library/jest-dom/vitest";
import { isModal, resetApp } from "../../test/components-views";
import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { flushSync } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../api";
import { app } from "../app.svelte";
import type { MailBody } from "../types";
import MailReader from "./MailReader.svelte";

const body = (over: Partial<MailBody> = {}): MailBody => ({
  subject: "Your flight is confirmed",
  from: "Uganda Airlines <noreply@ua.com>",
  to: "me@example.com",
  date: "2026-11-03T07:12:00Z",
  text: "Booking UR8K2. Check in at https://ua.com/checkin today.",
  html: '<h1>Nairobi</h1><p><a href="https://ua.com/checkin">Check in</a></p><img src="https://track.ua.com/p.gif">',
  url: "https://mail.google.com/mail/u/0/#inbox/t1",
  ...over,
});

beforeEach(() => {
  resetApp();
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(() => vi.restoreAllMocks());

async function read(mail: MailBody | Error, id = "18c2f0a1") {
  const spy = mail instanceof Error ? vi.spyOn(api, "mailRead").mockRejectedValue(mail) : vi.spyOn(api, "mailRead").mockResolvedValue(mail);
  const user = userEvent.setup();
  render(MailReader);
  app.reading = { source: "google", id, url: "https://mail.google.com/mail/u/0/#inbox/t1" };
  flushSync();
  return { user, spy };
}

test("stays closed until an email is picked", () => {
  render(MailReader);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("opens as a modal and shows who sent it and when", async () => {
  const { spy } = await read(body());
  expect(spy).toHaveBeenCalledWith("google", "18c2f0a1");
  const dialog = await screen.findByRole("dialog", { name: "Your flight is confirmed" });
  expect(isModal(dialog)).toBe(true);
  expect(screen.getByRole("heading", { name: "Your flight is confirmed" })).toBeInTheDocument();
  expect(screen.getByText("Uganda Airlines")).toBeInTheDocument();
  expect(screen.getByText("noreply@ua.com")).toBeInTheDocument();
});

test("HTML shows in a frame that runs no scripts and loads no web images until asked", async () => {
  const { user } = await read(body());
  const frame = await screen.findByTitle("Email from Uganda Airlines");
  expect(frame).toHaveAttribute("sandbox", "allow-same-origin");
  expect(frame.getAttribute("srcdoc")).toContain("img-src data: cid:;");
  expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
  expect(screen.getByText(/the sender can't tell you opened this/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Show images" }));
  expect(screen.getByTitle("Email from Uganda Airlines").getAttribute("srcdoc")).toContain("img-src data: cid: https: http:");
  expect(screen.queryByRole("button", { name: "Show images" })).not.toBeInTheDocument();
});

test("an email with no web images asks nothing about images", async () => {
  await read(body({ html: "<p>Just words</p>" }));
  await screen.findByTitle("Email from Uganda Airlines");
  expect(screen.queryByRole("button", { name: "Show images" })).not.toBeInTheDocument();
});

test("a plain-text email shows its words, with its addresses as links", async () => {
  const open = vi.spyOn(app, "openLink").mockImplementation(() => {});
  const { user } = await read(body({ html: null }));
  expect(await screen.findByText(/Booking UR8K2\. Check in at/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "https://ua.com/checkin" }));
  expect(open).toHaveBeenCalledWith("https://ua.com/checkin");
});

test("Add as task links back to this message, not its thread", async () => {
  const add = vi.spyOn(app, "addTask").mockResolvedValue();
  const { user } = await read(body());
  await user.click(await screen.findByRole("button", { name: "Add as task" }));
  expect(add).toHaveBeenCalledWith("Your flight is confirmed [email from Uganda Airlines](https://mail.google.com/mail/u/0/#all/18c2f0a1)");
});

test("Save as note saves it, closes the reader and opens the note", async () => {
  vi.spyOn(api, "mailToNote").mockResolvedValue("Mail/Your flight is confirmed.md");
  vi.spyOn(app, "refreshFiles").mockResolvedValue();
  const { user } = await read(body());
  await user.click(await screen.findByRole("button", { name: "Save as note" }));
  await waitFor(() => expect(app.current).toBe("Mail/Your flight is confirmed.md"));
  expect(app.reading).toBeNull();
});

test("Open in Gmail goes to the web; Close puts the reader away", async () => {
  const { user } = await read(body());
  await user.click(await screen.findByRole("button", { name: "Open in Gmail" }));
  expect(window.open).toHaveBeenCalledWith("https://mail.google.com/mail/u/0/#inbox/t1", "_blank", "noopener");
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(app.reading).toBeNull();
  flushSync();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("an email that can't be fetched says why and still offers the web", async () => {
  const { user } = await read(new Error("Google needs you to sign in again. Reconnect it in Settings, under Connections."));
  expect(await screen.findByRole("alert")).toHaveTextContent("Reconnect it in Settings");
  expect(screen.getByRole("heading", { name: "Couldn't open this email" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Open in Gmail" }));
  expect(window.open).toHaveBeenCalled();
});
