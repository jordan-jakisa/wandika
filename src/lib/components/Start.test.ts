import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { githubVault, resetApp, status } from "../../test/components-workspace";
import { api, AppError } from "../api";
import { app } from "../app.svelte";
import type { VaultConfig } from "../types";
import Dialog from "./Dialog.svelte";
import Start from "./Start.svelte";

// The folder picker is only offered on the Mac; each test says whether this is one.
const mac = vi.hoisted(() => ({ value: false }));
vi.mock("../api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api")>();
  return {
    ...real,
    get canPickFolder() {
      return mac.value;
    },
  };
});

const folderVault: VaultConfig = { id: "local/2", name: "Obsidian", folder: "/Users/jordan/Obsidian", remote: null };
const deviceVault: VaultConfig = { id: "local/1", name: "Notes", folder: null, remote: null };

beforeEach(() => {
  resetApp();
  mac.value = false;
  app.status = status({ user: null, vault: null, known: [] });
});

function renderStart() {
  render(Dialog);
  return render(Start);
}

test("shows the wordmark and both ways to keep notes", () => {
  renderStart();
  expect(screen.getByRole("heading", { level: 1, name: "Wandika" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Sync with GitHub" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Keep notes on this device" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Your vaults" })).not.toBeInTheDocument();
});

test("says it's a beta, and that the notes stay the person's own files", () => {
  renderStart();
  expect(screen.getByText("Wandika is in beta. Your notes are always plain files you keep.")).toBeInTheDocument();
});

test("signed out, it offers GitHub sign-in", () => {
  renderStart();
  expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Sign out/ })).not.toBeInTheDocument();
});

test("signed in, it lists repositories and offers to sign out", async () => {
  const user = userEvent.setup();
  app.status = status({ vault: null, known: [] });
  vi.spyOn(api, "reposList").mockResolvedValue([]);
  const signOut = vi.spyOn(app, "signOut").mockResolvedValue();
  renderStart();
  expect(await screen.findByLabelText("New private repository")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Sign out of GitHub (jordan-jakisa)" }));
  expect(signOut).toHaveBeenCalled();
});

test("lists the vaults you had, with where each one lives", () => {
  app.status = status({ user: null, vault: null, known: [githubVault, folderVault, deviceVault] });
  renderStart();
  const list = within(screen.getByRole("region", { name: "Your vaults" }));
  expect(list.getByRole("button", { name: /notes Syncs with jordan-jakisa\/notes/ })).toBeInTheDocument();
  expect(list.getByRole("button", { name: /Obsidian \/Users\/jordan\/Obsidian/ })).toBeInTheDocument();
  expect(list.getByRole("button", { name: /Notes On this device only/ })).toBeInTheDocument();
});

test("picking a vault you had opens it again and syncs it", async () => {
  const user = userEvent.setup();
  app.status = status({ user: null, vault: null, known: [githubVault] });
  const sw = vi.spyOn(api, "vaultSwitch").mockResolvedValue();
  const enter = vi.spyOn(app, "enterVault").mockResolvedValue();
  const sync = vi.spyOn(app, "sync").mockResolvedValue();
  renderStart();
  await user.click(screen.getByRole("button", { name: /Syncs with jordan-jakisa\/notes/ }));
  await waitFor(() => expect(sync).toHaveBeenCalled());
  expect(sw).toHaveBeenCalledWith(githubVault.id);
  expect(enter).toHaveBeenCalled();
});

test("a vault that fails to open says why", async () => {
  const user = userEvent.setup();
  app.status = status({ user: null, vault: null, known: [folderVault] });
  vi.spyOn(api, "vaultSwitch").mockRejectedValue(new AppError("That folder no longer exists.", "message"));
  renderStart();
  await user.click(screen.getByRole("button", { name: /^Obsidian/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("That folder no longer exists.");
  expect(screen.getByRole("button", { name: /^Obsidian/ })).toBeEnabled();
});

test("remove from list asks first, then forgets the vault", async () => {
  const user = userEvent.setup();
  app.status = status({ user: null, vault: null, known: [folderVault, deviceVault] });
  const forget = vi.spyOn(api, "vaultForget").mockResolvedValue();
  vi.spyOn(api, "status").mockResolvedValue(status({ user: null, vault: null, known: [deviceVault] }));
  renderStart();
  await user.click(screen.getByRole("button", { name: "Actions for Obsidian" }));
  await user.click(screen.getByRole("menuitem", { name: "Remove from list" }));
  const dialog = screen.getByRole("dialog", { name: "Remove “Obsidian” from this list?" });
  expect(dialog).toHaveTextContent("The folder /Users/jordan/Obsidian and its notes stay where they are.");
  await user.click(within(dialog).getByRole("button", { name: "Remove from list" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Obsidian/ })).not.toBeInTheDocument());
  expect(forget).toHaveBeenCalledWith(folderVault.id);
  expect(screen.getByRole("button", { name: /Notes On this device only/ })).toBeInTheDocument();
});

test("a GitHub vault is removed with the promise that GitHub keeps it", async () => {
  const user = userEvent.setup();
  app.status = status({ user: null, vault: null, known: [githubVault] });
  renderStart();
  await user.click(screen.getByRole("button", { name: "Actions for notes" }));
  await user.click(screen.getByRole("menuitem", { name: "Remove from list" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Its notes stay on this device and on GitHub");
});

test("cancelling remove keeps the vault", async () => {
  const user = userEvent.setup();
  app.status = status({ user: null, vault: null, known: [folderVault] });
  const forget = vi.spyOn(api, "vaultForget");
  renderStart();
  await user.click(screen.getByRole("button", { name: "Actions for Obsidian" }));
  await user.click(screen.getByRole("menuitem", { name: "Remove from list" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(forget).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /^Obsidian/ })).toBeInTheDocument();
});

test("create vault makes a vault on this device and opens it", async () => {
  const user = userEvent.setup();
  renderStart();
  const name = screen.getByLabelText("Vault name");
  expect(name).toHaveValue("Notes");
  await user.clear(name);
  await user.type(name, "Journal");
  await user.click(screen.getByRole("button", { name: "Create vault" }));
  await waitFor(() => expect(app.status?.vault?.name).toBe("Journal"));
  expect(app.status?.vault?.remote).toBeNull();
  expect(app.tree.length).toBeGreaterThan(0);
});

test("create vault needs a name", async () => {
  const user = userEvent.setup();
  renderStart();
  await user.clear(screen.getByLabelText("Vault name"));
  await user.type(screen.getByLabelText("Vault name"), "   ");
  expect(screen.getByRole("button", { name: "Create vault" })).toBeDisabled();
});

test("create vault waits, then shows a failure", async () => {
  const user = userEvent.setup();
  let fail!: (e: Error) => void;
  vi.spyOn(api, "vaultCreateLocal").mockImplementation(() => new Promise((_, r) => (fail = r)));
  renderStart();
  await user.click(screen.getByRole("button", { name: "Create vault" }));
  expect(screen.getByRole("button", { name: "Create vault" })).toBeDisabled();
  fail(new AppError("Couldn't make the folder.", "message"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't make the folder.");
  expect(screen.getByRole("button", { name: "Create vault" })).toBeEnabled();
});

test("on a Mac, a folder such as an Obsidian vault can be opened", async () => {
  const user = userEvent.setup();
  mac.value = true;
  const create = vi.spyOn(api, "vaultCreateLocal").mockResolvedValue();
  const enter = vi.spyOn(app, "enterVault").mockResolvedValue();
  renderStart();
  await user.click(screen.getByRole("button", { name: /Open a folder/ }));
  await waitFor(() => expect(enter).toHaveBeenCalled());
  expect(create).toHaveBeenCalledWith("", "/Users/jordan/Documents/Obsidian");
});

test("elsewhere there is no folder button", () => {
  renderStart();
  expect(screen.queryByRole("button", { name: /Open a folder/ })).not.toBeInTheDocument();
});

test("a failed remove says why and keeps the vault", async () => {
  const user = userEvent.setup();
  app.status = status({ user: null, vault: null, known: [folderVault] });
  vi.spyOn(api, "vaultForget").mockRejectedValue(new AppError("Couldn't update the vault list.", "message"));
  renderStart();
  await user.click(screen.getByRole("button", { name: "Actions for Obsidian" }));
  await user.click(screen.getByRole("menuitem", { name: "Remove from list" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove from list" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't update the vault list.");
  expect(screen.getByRole("button", { name: /^Obsidian/ })).toBeInTheDocument();
});

test("a failed sign-out says why", async () => {
  const user = userEvent.setup();
  app.status = status({ vault: null, known: [] });
  vi.spyOn(api, "reposList").mockResolvedValue([]);
  vi.spyOn(api, "githubSignOut").mockRejectedValue(new AppError("The keychain is locked.", "message"));
  renderStart();
  await user.click(screen.getByRole("button", { name: "Sign out of GitHub (jordan-jakisa)" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The keychain is locked.");
});
