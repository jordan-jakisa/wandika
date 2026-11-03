import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { resetApp, status } from "../../test/components-workspace";
import { api, AppError } from "../api";
import { app } from "../app.svelte";
import Unlock from "./Unlock.svelte";

const locked = { set_up: true, unlocked: false, folders: ["Private"] };

beforeEach(() => {
  resetApp();
  app.status = status({ encryption: locked });
});

test("a locked note asks for the passphrase", () => {
  render(Unlock);
  expect(screen.getByText("This note is encrypted.")).toBeInTheDocument();
  expect(screen.getByLabelText("Passphrase")).toHaveAttribute("autocomplete", "current-password");
  expect(screen.getByRole("button", { name: "Unlock" })).toBeDisabled();
});

test("in Settings it speaks of every encrypted note", () => {
  render(Unlock, { props: { context: "settings" } });
  expect(screen.getByText("Encrypted notes are locked on this device.")).toBeInTheDocument();
});

test("without encryption set up it offers to set it up", () => {
  app.status = status({ encryption: { set_up: false, unlocked: false, folders: [] } });
  render(Unlock);
  expect(screen.getByText("Set up encryption for this vault.")).toBeInTheDocument();
  expect(screen.getByLabelText("Passphrase")).toHaveAttribute("autocomplete", "new-password");
  expect(screen.getByRole("button", { name: "Set up encryption" })).toBeDisabled();
});

test("the button waits for 8 characters", async () => {
  const user = userEvent.setup();
  render(Unlock);
  await user.type(screen.getByLabelText("Passphrase"), "1234567");
  expect(screen.getByRole("button", { name: "Unlock" })).toBeDisabled();
  await user.type(screen.getByLabelText("Passphrase"), "8");
  expect(screen.getByRole("button", { name: "Unlock" })).toBeEnabled();
});

test("a wrong passphrase is refused and the field stays", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "encryptionUnlock").mockRejectedValue(
    new AppError("Wrong passphrase, or this file was encrypted with another key.", "wrong_passphrase"),
  );
  const onunlocked = vi.fn();
  render(Unlock, { props: { onunlocked } });
  await user.type(screen.getByLabelText("Passphrase"), "not the one");
  await user.click(screen.getByRole("button", { name: "Unlock" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Wrong passphrase");
  expect(screen.getByLabelText("Passphrase")).toHaveValue("not the one");
  expect(screen.getByRole("button", { name: "Unlock" })).toBeEnabled();
  expect(onunlocked).not.toHaveBeenCalled();
});

test("the right passphrase unlocks, refreshes and says so", async () => {
  const user = userEvent.setup();
  let finish!: () => void;
  vi.spyOn(api, "encryptionUnlock").mockImplementation(
    () => new Promise((r) => (finish = () => r({ ...locked, unlocked: true }))),
  );
  vi.spyOn(api, "status").mockResolvedValue(status({ encryption: { ...locked, unlocked: true } }));
  const files = vi.spyOn(app, "refreshFiles").mockResolvedValue();
  const onunlocked = vi.fn();
  render(Unlock, { props: { onunlocked } });
  await user.type(screen.getByLabelText("Passphrase"), "correct horse");
  await user.click(screen.getByRole("button", { name: "Unlock" }));
  expect(screen.getByRole("button", { name: "Unlocking…" })).toBeDisabled();
  finish();
  await waitFor(() => expect(onunlocked).toHaveBeenCalledOnce());
  expect(api.encryptionUnlock).toHaveBeenCalledWith("correct horse");
  expect(files).toHaveBeenCalled();
  expect(app.status?.encryption?.unlocked).toBe(true);
  expect(screen.getByLabelText("Passphrase")).toHaveValue("");
});

test("setting up sends the new passphrase", async () => {
  const user = userEvent.setup();
  app.status = status({ encryption: { set_up: false, unlocked: false, folders: [] } });
  vi.spyOn(api, "encryptionSetup").mockResolvedValue({ set_up: true, unlocked: true, folders: [] });
  vi.spyOn(api, "status").mockResolvedValue(status({ encryption: { set_up: true, unlocked: true, folders: [] } }));
  vi.spyOn(app, "refreshFiles").mockResolvedValue();
  const onunlocked = vi.fn();
  render(Unlock, { props: { onunlocked } });
  await user.type(screen.getByLabelText("Passphrase"), "a new passphrase");
  await user.keyboard("{Enter}");
  await waitFor(() => expect(onunlocked).toHaveBeenCalled());
  expect(api.encryptionSetup).toHaveBeenCalledWith("a new passphrase");
});
