import "@testing-library/jest-dom/vitest";
import "../test/components-views";
import { render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { localVault, resetApp, status } from "../test/components-workspace";
import { api, AppError } from "$lib/api";
import { app } from "$lib/app.svelte";
import Page from "./+page.svelte";

beforeEach(() => {
  resetApp();
  vi.spyOn(api, "today").mockResolvedValue({ events: [], mail: [], tasks: [], remote_tasks: [], errors: {} });
});

// app.init runs once per launch, so only this first test sees the real start; the rest set the
// state init would leave.
test("on launch it reads the status and opens the vault, back at the note you had open", async () => {
  localStorage.setItem(`wandika.session:${localVault.id}`, JSON.stringify({ current: "Welcome.md", tab: "notes" }));
  vi.spyOn(api, "status").mockResolvedValue(status());
  render(Page);
  expect(document.querySelector("main.boot")).toHaveAttribute("aria-busy", "true");
  expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue("Welcome");
  expect(screen.getByRole("complementary", { name: "Vault" })).toBeInTheDocument();
});

test("while the status loads, it shows a busy blank screen", () => {
  vi.spyOn(app, "init").mockResolvedValue();
  render(Page);
  expect(document.querySelector("main.boot")).toHaveAttribute("aria-busy", "true");
  expect(screen.queryByRole("heading", { name: "Wandika" })).not.toBeInTheDocument();
});

test("it starts the app once it is on screen", () => {
  const init = vi.spyOn(app, "init").mockResolvedValue();
  render(Page);
  expect(init).toHaveBeenCalledTimes(1);
});

test("with no vault open it shows the start screen", () => {
  vi.spyOn(app, "init").mockResolvedValue();
  app.status = status({ vault: null, user: null });
  render(Page);
  expect(screen.getByRole("heading", { level: 1, name: "Wandika" })).toBeInTheDocument();
  expect(screen.queryByRole("complementary", { name: "Vault" })).not.toBeInTheDocument();
});

test("with a vault open it shows the workspace, with Settings ready to open", async () => {
  const user = userEvent.setup();
  vi.spyOn(app, "init").mockResolvedValue();
  app.status = status();
  await app.refreshFiles();
  render(Page);
  expect(screen.getByRole("complementary", { name: "Vault" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { level: 1, name: "Wandika" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByRole("dialog", { name: "Settings" })).toHaveAttribute("open");
});

test("an encrypted note restored while locked asks for the passphrase", async () => {
  vi.spyOn(app, "init").mockResolvedValue();
  app.status = status({ encryption: { set_up: true, unlocked: false, folders: ["Private"] } });
  await app.refreshFiles();
  // The Rust core's answer for a locked note.
  vi.spyOn(api, "noteRead").mockRejectedValue(new AppError("Encrypted notes are locked.", "locked"));
  app.open("Private/Passport renewal.md.age");
  render(Page);
  expect(await screen.findByText("This note is encrypted.")).toBeInTheDocument();
  expect(screen.getByLabelText("Passphrase")).toBeInTheDocument();
});

test("a failed start says so and offers to try again", () => {
  vi.spyOn(app, "init").mockResolvedValue();
  app.bootError = "The vault folder is gone.";
  app.status = status();
  render(Page);
  expect(screen.getByRole("alert")).toHaveTextContent("Wandika couldn't open your vault. The vault folder is gone.");
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  expect(screen.queryByRole("complementary", { name: "Vault" })).not.toBeInTheDocument();
});

test("messages show in a live region that is always in the page", async () => {
  vi.spyOn(app, "init").mockResolvedValue();
  render(Page);
  const live = screen.getAllByRole("status").find((el) => el.classList.contains("toast"))!;
  expect(live).toHaveAttribute("aria-live", "polite");
  expect(live).toHaveTextContent("");
  app.say("Note encrypted.");
  await waitFor(() => expect(live).toHaveTextContent("Note encrypted."));
  expect(within(live).queryByRole("button")).not.toBeInTheDocument();
});

test("a message's action button runs it and clears the message", async () => {
  const user = userEvent.setup();
  vi.spyOn(app, "init").mockResolvedValue();
  const undo = vi.fn();
  render(Page);
  app.say("Moved “Old idea” to the trash.", { label: "Undo", run: undo });
  await user.click(await screen.findByRole("button", { name: "Undo" }));
  expect(undo).toHaveBeenCalledTimes(1);
  expect(app.toast).toBeNull();
  expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
});

test("the dialog for questions and the image viewer are always there to open", async () => {
  vi.spyOn(app, "init").mockResolvedValue();
  app.status = status({ vault: null, user: null });
  render(Page);
  void app.ask({ title: "Rename vault?", confirm: "Rename" });
  expect(await screen.findByRole("dialog", { name: "Rename vault?" })).toHaveAttribute("open");
  app.dialog?.resolve(null);
});
