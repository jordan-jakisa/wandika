import "@testing-library/jest-dom/vitest";
import "../../test/components-views";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { githubVault, resetApp, setWidth, status } from "../../test/components-workspace";
import { api, AppError } from "../api";
import { app } from "../app.svelte";
import { prefs } from "../prefs.svelte";
import type { Status } from "../types";
import Dialog from "./Dialog.svelte";
import Settings from "./Settings.svelte";

// Events from the Rust core, captured so a test can send one as the core would.
const events = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
vi.mock("../api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api")>();
  return {
    ...real,
    listen: async (event: string, fn: (payload: unknown) => void) => {
      events.set(event, fn);
      return () => events.get(event) === fn && events.delete(event);
    },
  };
});

const synced = (patch: Partial<Status> = {}) => status({ vault: githubVault, known: [githubVault], ...patch });
const connectors = (patch: Partial<Status["connectors"]>) =>
  ({ google: null, microsoft: null, apple_calendar: "not_asked", apple_reminders: "not_asked", ...patch }) as Status["connectors"];

beforeEach(() => {
  resetApp();
  prefs.reset();
  localStorage.clear();
  app.status = status();
  setWidth(1200);
});

afterEach(() => {
  vi.useRealTimers();
  if (history.state?.wandika) history.replaceState(null, "");
});

/** Renders Settings and opens it, at `section` when given. */
async function open(section?: Parameters<typeof app.openSettings>[0]) {
  render(Dialog);
  const view = render(Settings);
  app.openSettings(section);
  await tick();
  return view;
}

const dialog = () => screen.getByRole("dialog", { name: "Settings" });
const sections = () => within(screen.getByRole("navigation", { name: "Settings sections" }));
const pane = () => within(document.querySelector<HTMLElement>(".pane")!);
const paneTitle = () => document.querySelector(".pane h3")?.textContent;
/** One settings row, found by its label. */
const row = (label: string | RegExp) => within(pane().getByText(label).closest<HTMLElement>(".row")!);

describe("on a desktop", () => {
  test("opens on the last section, with every section listed", async () => {
    await open();
    await waitFor(() => expect(dialog()).toHaveAttribute("open"));
    expect(sections().getAllByRole("button").map((b) => b.textContent?.trim())).toEqual([
      "Vault",
      "Appearance",
      "Editor",
      "Encryption",
      "Connections",
      "Account",
      "About",
    ]);
    expect(sections().getByRole("button", { name: "Vault" })).toHaveAttribute("aria-current", "page");
    expect(paneTitle()).toBe("Vault");
  });

  test("a section button shows that section and is remembered", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(sections().getByRole("button", { name: "Appearance" }));
    expect(paneTitle()).toBe("Appearance");
    expect(sections().getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-current", "page");
    expect(sections().getByRole("button", { name: "Vault" })).not.toHaveAttribute("aria-current");
    expect(app.settingsSection).toBe("appearance");
  });

  test("opened for one section, it shows that section", async () => {
    await open("connections");
    expect(paneTitle()).toBe("Connections");
  });

  test("the close button and Escape close it", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    expect(app.settingsOpen).toBe(false);
    await waitFor(() => expect(document.querySelector("dialog.settings")).not.toHaveAttribute("open"));
    app.openSettings();
    await waitFor(() => expect(dialog()).toHaveAttribute("open"));
    await user.keyboard("{Escape}");
    expect(app.settingsOpen).toBe(false);
    await waitFor(() => expect(document.querySelector("dialog.settings")).not.toHaveAttribute("open"));
  });

  test("there is no section list screen, Back or Done on a desktop", async () => {
    await open();
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Settings$/ })).not.toBeInTheDocument();
    expect(sections().queryByText("Theme, accent colour, CSS snippets")).not.toBeInTheDocument();
  });
});

describe("Vault", () => {
  test("New notes go in: the top, the open note's folder or a folder, saved in Obsidian's settings", async () => {
    const user = userEvent.setup();
    await app.refreshFiles();
    const set = vi.spyOn(api, "newNoteLocationSet");
    await open("vault");
    const place = await pane().findByRole("combobox", { name: "New notes go in" });
    expect(place).toHaveValue("current");
    const options = [...place.querySelectorAll("option")].map((o) => o.textContent);
    expect(options.slice(0, 2)).toEqual(["The top of the vault", "The open note's folder"]);
    expect(options).toContain("Projects");
    await user.selectOptions(place, "folder:Projects");
    expect(set).toHaveBeenCalledWith("folder", "Projects");
    expect(await api.newNoteFolder(null)).toBe("Projects");
    await user.selectOptions(place, "root");
    expect(set).toHaveBeenLastCalledWith("root", "");
    expect(await api.newNoteFolder("Projects/Plan.md")).toBe("");
    expect(pane().getByText(/Obsidian and your other devices use it too/)).toBeInTheDocument();
  });

  test("names the vault and where it lives", async () => {
    await open("vault");
    expect(row("Notes").getByText("In Wandika's storage on this device")).toBeInTheDocument();
  });

  test("a folder vault shows its folder", async () => {
    app.status = status({ vault: { id: "local/2", name: "Obsidian", folder: "/Users/jordan/Obsidian", remote: null } });
    await open("vault");
    expect(row("Obsidian").getByText("/Users/jordan/Obsidian")).toBeInTheDocument();
  });

  test("Switch vault closes the vault and Settings", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "vaultClose").mockResolvedValue();
    vi.spyOn(api, "status").mockResolvedValue(status({ vault: null }));
    await open("vault");
    await user.click(pane().getByRole("button", { name: "Switch vault" }));
    await waitFor(() => expect(app.status?.vault).toBeNull());
    expect(app.settingsOpen).toBe(false);
  });

  test("a vault on this device offers to connect GitHub, and Cancel steps back", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "reposList").mockResolvedValue([]);
    await open("vault");
    expect(row("Only on this device").getByText("Connect a GitHub repository to sync this vault to your other devices.")).toBeInTheDocument();
    await user.click(pane().getByRole("button", { name: "Connect to GitHub" }));
    expect(await pane().findByLabelText("New private repository")).toBeInTheDocument();
    await user.click(pane().getByRole("button", { name: "Cancel" }));
    expect(pane().getByRole("button", { name: "Connect to GitHub" })).toBeInTheDocument();
    expect(pane().queryByLabelText("New private repository")).not.toBeInTheDocument();
  });

  test("signed out, connecting starts with GitHub sign-in", async () => {
    const user = userEvent.setup();
    app.status = status({ user: null });
    await open("vault");
    await user.click(pane().getByRole("button", { name: "Connect to GitHub" }));
    expect(pane().getByText("Sign in with GitHub, then choose the repository to sync this vault with.")).toBeInTheDocument();
    expect(pane().getByRole("button", { name: "Sign in with GitHub" })).toBeInTheDocument();
  });

  test("a synced vault names its repository and when it last synced", async () => {
    app.status = synced();
    await open("vault");
    expect(row("jordan-jakisa/notes").getByText("Synced not yet. Changes sync about 20 seconds after you stop typing.")).toBeInTheDocument();
    expect(pane().queryByRole("button", { name: "Connect to GitHub" })).not.toBeInTheDocument();
  });

  test("Sync now syncs, and says Syncing… while it runs", async () => {
    const user = userEvent.setup();
    app.status = synced();
    app.lastSync = Date.now();
    const sync = vi.spyOn(app, "sync").mockResolvedValue();
    await open("vault");
    expect(pane().getByText(/Synced just now/)).toBeInTheDocument();
    await user.click(pane().getByRole("button", { name: "Sync now" }));
    expect(sync).toHaveBeenCalledWith(true);
    app.syncing = true;
    await waitFor(() => expect(pane().getByRole("button", { name: "Syncing…" })).toBeDisabled());
  });

  test("the last sync's failure is shown", async () => {
    app.status = synced();
    app.syncError = { code: "offline", message: "You're offline." };
    await open("vault");
    expect(pane().getByText("Last sync: You're offline.")).toBeInTheDocument();
  });

  test("the vault's size is shown, with a warning past 1 GB", async () => {
    app.status = synced();
    app.vaultBytes = 12e6;
    const { unmount } = await open("vault");
    expect(pane().getByText(/MB synced/)).toHaveTextContent("12 MB synced. Files over 50 MB stay on the device they were added on.");
    expect(pane().getByText(/MB synced/)).not.toHaveClass("error");
    unmount();
    app.settingsOpen = false;
    app.vaultBytes = 1.5e9;
    await open("vault");
    const big = pane().getByText(/MB synced/);
    expect(big).toHaveTextContent(`${(1500).toLocaleString()} MB synced. GitHub recommends keeping a repository under 1 GB`);
    expect(big).toHaveClass("error");
  });

  test("Disconnect asks, then leaves the vault on this device only", async () => {
    const user = userEvent.setup();
    app.status = synced();
    const disconnect = vi.spyOn(api, "vaultDisconnectRemote").mockResolvedValue();
    const enter = vi.spyOn(app, "enterVault").mockResolvedValue();
    await open("vault");
    await user.click(row("Disconnect from GitHub").getByRole("button", { name: "Disconnect" }));
    const ask = screen.getByRole("dialog", { name: "Stop syncing with jordan-jakisa/notes?" });
    expect(ask).toHaveTextContent("Your notes stay on this device and on GitHub. You can connect again later.");
    await user.click(within(ask).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(app.toast).toBe("This vault is now only on this device."));
    expect(disconnect).toHaveBeenCalled();
    expect(enter).toHaveBeenCalled();
  });

  test("Cancel on the disconnect question keeps syncing", async () => {
    const user = userEvent.setup();
    app.status = synced();
    const disconnect = vi.spyOn(api, "vaultDisconnectRemote");
    await open("vault");
    await user.click(row("Disconnect from GitHub").getByRole("button", { name: "Disconnect" }));
    await user.click(within(screen.getByRole("dialog", { name: /Stop syncing/ })).getByRole("button", { name: "Cancel" }));
    expect(disconnect).not.toHaveBeenCalled();
  });
});

describe("Appearance", () => {
  const stored = () => JSON.parse(localStorage.getItem("wandika.appearance") ?? "{}");

  test("theme and accent are picked from radios and kept on this device", async () => {
    const user = userEvent.setup();
    await open("appearance");
    const theme = within(pane().getByRole("radiogroup", { name: "Theme" }));
    expect(theme.getAllByRole("radio").map((r) => r.textContent)).toEqual(["System", "Light", "Dark"]);
    expect(theme.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    await user.click(theme.getByRole("radio", { name: "Dark" }));
    expect(theme.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    expect(theme.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "false");
    expect(stored().theme).toBe("dark");

    const accent = within(pane().getByRole("radiogroup", { name: "Accent" }));
    expect(accent.getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual(["Papyrus", "Lake", "Indigo", "Plum", "Rose", "Graphite"]);
    await user.click(accent.getByRole("radio", { name: "Plum" }));
    expect(accent.getByRole("radio", { name: "Plum" })).toHaveAttribute("aria-checked", "true");
    expect(stored().accent).toBe("plum");
  });

  test("Reset puts appearance and editor back as they came", async () => {
    const user = userEvent.setup();
    prefs.set({ theme: "dark", accent: "rose", font: "mono", size: 22, width: "full" });
    await open("appearance");
    await user.click(pane().getByRole("button", { name: "Reset appearance and editor" }));
    expect(within(pane().getByRole("radiogroup", { name: "Theme" })).getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    expect(stored()).toMatchObject({ theme: "system", accent: "papyrus", font: "serif", size: null, width: "normal" });
  });

  test("with no snippets it says where to add them", async () => {
    await open("appearance");
    expect(pane().getByText("No snippets yet. Add .css files to the vault's .obsidian/snippets folder.")).toBeInTheDocument();
  });

  test("each snippet has a switch that turns it on or off", async () => {
    const user = userEvent.setup();
    app.snippets = [
      { name: "wide-tables", css: "table{width:100%}", enabled: false },
      { name: "quiet", css: "h1{color:gray}", enabled: true },
    ];
    const toggle = vi.spyOn(api, "snippetToggle").mockResolvedValue();
    vi.spyOn(api, "snippetsList").mockResolvedValue([
      { name: "wide-tables", css: "table{width:100%}", enabled: true },
      { name: "quiet", css: "h1{color:gray}", enabled: true },
    ]);
    await open("appearance");
    expect(pane().getByRole("checkbox", { name: "quiet" })).toBeChecked();
    const wide = pane().getByRole("checkbox", { name: "wide-tables" });
    expect(wide).not.toBeChecked();
    await user.click(wide);
    expect(toggle).toHaveBeenCalledWith("wide-tables", true);
    await waitFor(() => expect(document.getElementById("wandika-snippets")?.textContent).toContain("table{width:100%}"));
    expect(pane().getByRole("checkbox", { name: "wide-tables" })).toBeChecked();
  });

  test("a snippet that can't be switched says why", async () => {
    const user = userEvent.setup();
    app.snippets = [{ name: "broken", css: "", enabled: false }];
    vi.spyOn(api, "snippetToggle").mockRejectedValue(new AppError("The vault is read-only.", "message"));
    await open("appearance");
    await user.click(pane().getByRole("checkbox", { name: "broken" }));
    await waitFor(() => expect(app.toast).toBe("The vault is read-only."));
  });

  test("Reload snippets reads them from the vault again", async () => {
    const user = userEvent.setup();
    const list = vi.spyOn(api, "snippetsList").mockResolvedValue([{ name: "new-one", css: "", enabled: false }]);
    await open("appearance");
    await user.click(pane().getByRole("button", { name: "Reload snippets" }));
    expect(list).toHaveBeenCalled();
    expect(await pane().findByRole("checkbox", { name: "new-one" })).toBeInTheDocument();
  });
});

describe("Editor", () => {
  const stored = () => JSON.parse(localStorage.getItem("wandika.appearance") ?? "{}");

  test("font and line width are picked from radios and kept", async () => {
    const user = userEvent.setup();
    await open("editor");
    const font = within(pane().getByRole("radiogroup", { name: "Font" }));
    expect(font.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Serif", "Sans", "Mono"]);
    await user.click(font.getByRole("radio", { name: "Mono" }));
    expect(font.getByRole("radio", { name: "Mono" })).toHaveAttribute("aria-checked", "true");
    expect(stored().font).toBe("mono");
    const width = within(pane().getByRole("radiogroup", { name: "Line width" }));
    expect(width.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Narrow", "Normal", "Wide", "Full"]);
    expect(width.getByRole("radio", { name: "Normal" })).toHaveAttribute("aria-checked", "true");
    await user.click(width.getByRole("radio", { name: "Wide" }));
    expect(width.getByRole("radio", { name: "Wide" })).toHaveAttribute("aria-checked", "true");
    expect(stored().width).toBe("wide");
  });

  test("the size slider sets the text size, and the default can be brought back", async () => {
    const user = userEvent.setup();
    await open("editor");
    const size = pane().getByRole("slider", { name: "Size" });
    expect(size).toHaveValue("18");
    expect(pane().getByText("18 px")).toBeInTheDocument();
    expect(pane().queryByRole("button", { name: "Use the default size" })).not.toBeInTheDocument();
    await fireEvent.input(size, { target: { value: "21" } });
    expect(pane().getByText("21 px")).toBeInTheDocument();
    expect(stored().size).toBe(21);
    await user.click(pane().getByRole("button", { name: "Use the default size" }));
    expect(pane().getByText("18 px")).toBeInTheDocument();
    expect(stored().size).toBeNull();
    expect(pane().queryByRole("button", { name: "Use the default size" })).not.toBeInTheDocument();
  });

  test("the slider runs from 14 to 24", async () => {
    await open("editor");
    const size = pane().getByRole("slider", { name: "Size" });
    expect(size).toHaveAttribute("min", "14");
    expect(size).toHaveAttribute("max", "24");
  });
});

describe("Encryption", () => {
  test("unlocked, it lists the encrypted folders and offers Lock", async () => {
    await open("encryption");
    expect(row("Unlocked on this device").getByText("Encrypted folders: Private.")).toBeInTheDocument();
    expect(pane().getByRole("button", { name: "Lock" })).toBeInTheDocument();
  });

  test("with no encrypted folders it says how to encrypt one", async () => {
    app.status = status({ encryption: { set_up: true, unlocked: true, folders: [] } });
    await open("encryption");
    expect(pane().getByText("Encrypt a note or folder from its menu.")).toBeInTheDocument();
  });

  test("Lock locks encrypted notes, closes an open one and says so", async () => {
    const user = userEvent.setup();
    const lock = vi.spyOn(api, "encryptionLock").mockResolvedValue({ set_up: true, unlocked: false, folders: [] });
    vi.spyOn(api, "status").mockResolvedValue(status({ encryption: { set_up: true, unlocked: false, folders: ["Private"] } }));
    app.current = "Private/Passport renewal.md.age";
    await open("encryption");
    await user.click(pane().getByRole("button", { name: "Lock" }));
    await waitFor(() => expect(app.toast).toBe("Encrypted notes are locked on this device."));
    expect(lock).toHaveBeenCalled();
    expect(app.current).toBeNull();
    expect(pane().getByText("Encrypted notes are locked on this device.")).toBeInTheDocument();
    expect(pane().getByLabelText("Passphrase")).toBeInTheDocument();
  });

  test("Lock leaves a plain open note open", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "encryptionLock").mockResolvedValue({ set_up: true, unlocked: false, folders: [] });
    vi.spyOn(api, "status").mockResolvedValue(status({ encryption: { set_up: true, unlocked: false, folders: [] } }));
    app.current = "Welcome.md";
    await open("encryption");
    await user.click(pane().getByRole("button", { name: "Lock" }));
    await waitFor(() => expect(app.toast).toBe("Encrypted notes are locked on this device."));
    expect(app.current).toBe("Welcome.md");
  });

  test("a failed lock says why", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "encryptionLock").mockRejectedValue(new AppError("The keychain is unavailable.", "message"));
    await open("encryption");
    await user.click(pane().getByRole("button", { name: "Lock" }));
    await waitFor(() => expect(app.toast).toBe("The keychain is unavailable."));
  });

  test("locked, it asks for the passphrase", async () => {
    app.status = status({ encryption: { set_up: true, unlocked: false, folders: [] } });
    await open("encryption");
    expect(pane().getByText("Encrypted notes are locked on this device.")).toBeInTheDocument();
    expect(pane().getByRole("button", { name: "Unlock" })).toBeInTheDocument();
  });

  test("not set up, it offers to set it up", async () => {
    app.status = status({ encryption: { set_up: false, unlocked: false, folders: [] } });
    await open("encryption");
    expect(pane().getByText("Set up encryption for this vault.")).toBeInTheDocument();
    expect(pane().getByRole("button", { name: "Set up encryption" })).toBeInTheDocument();
  });
});

describe("Connections", () => {
  test("a public build waits for Google's review without a row or a line about Google", async () => {
    app.status = { ...app.status!, configured: { ...app.status!.configured, google: false, gmail: false } };
    await open("connections");
    expect(pane().queryByText(/Google/)).not.toBeInTheDocument();
    expect(pane().getByText(/you connect appear in Today/)).toBeInTheDocument();
  });

  test("the note on what connecting means sits last, and names mail only when mail can connect", async () => {
    await open("connections");
    const about = pane().getByRole("contentinfo");
    expect(about).toHaveTextContent("Mail, calendars and tasks you connect appear in Today. Wandika only reads them, except when you tick off a task.");
    expect(about.parentElement!.lastElementChild).toBe(about);
  });

  test("a public build's Google is Calendar and Tasks, no Gmail", async () => {
    app.status = { ...app.status!, configured: { ...app.status!.configured, gmail: false } };
    await open("connections");
    expect(row("Google").getByText("Calendar and Tasks")).toBeInTheDocument();
  });

  test("each provider not connected yet offers Connect", async () => {
    await open("connections");
    expect(row("Google").getByText("Gmail, Calendar and Tasks")).toBeInTheDocument();
    expect(row("Google").getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(row("Outlook").getByText("Outlook mail and calendar")).toBeInTheDocument();
    expect(row("Outlook").getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(row("Apple Calendar").getByText("Not connected")).toBeInTheDocument();
    expect(row("Apple Calendar").getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(row("Apple Reminders").getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  test("Google connects in the browser: Waiting… until it is back, then the account and Disconnect", async () => {
    const user = userEvent.setup();
    const connect = vi.spyOn(api, "connectorConnect").mockResolvedValue({ kind: "browser" });
    await open("connections");
    await user.click(row("Google").getByRole("button", { name: "Connect" }));
    expect(connect).toHaveBeenCalledWith("google");
    expect(row("Google").getByRole("button", { name: "Waiting…" })).toBeDisabled();
    expect(row("Outlook").getByRole("button", { name: "Connect" })).toBeEnabled();
    app.status = status({ connectors: connectors({ google: "jordan@gmail.com" }) });
    await waitFor(() => expect(row("Google").getByText("jordan@gmail.com")).toBeInTheDocument());
    expect(row("Google").getByRole("button", { name: "Disconnect" })).toBeEnabled();
    expect(row("Google").queryByRole("button", { name: /Waiting|Connect/ })).not.toBeInTheDocument();
  });

  test("a Google sign-in that fails in the browser ends the wait, so Connect works again", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "connectorConnect").mockResolvedValue({ kind: "browser" });
    await open("connections");
    await user.click(row("Google").getByRole("button", { name: "Connect" }));
    expect(row("Google").getByRole("button", { name: "Waiting…" })).toBeDisabled();
    events.get("connectors-changed")!({ provider: "google", error: "Google sign-in was cancelled." });
    await waitFor(() => expect(row("Google").getByRole("button", { name: "Connect" })).toBeEnabled());
  });

  test("Settings stops listening for sign-ins once it is gone", async () => {
    const { unmount } = await open("connections");
    expect(events.has("connectors-changed")).toBe(true);
    unmount();
    expect(events.has("connectors-changed")).toBe(false);
  });

  test("Disconnect forgets the account and says so", async () => {
    const user = userEvent.setup();
    app.status = status({ connectors: connectors({ google: "jordan@gmail.com", microsoft: "jordan@outlook.com" }) });
    const disconnect = vi.spyOn(api, "connectorDisconnect").mockResolvedValue();
    vi.spyOn(api, "status").mockResolvedValue(status({ connectors: connectors({ microsoft: "jordan@outlook.com" }) }));
    await open("connections");
    await user.click(row("Google").getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(app.toast).toBe("Google is disconnected."));
    expect(disconnect).toHaveBeenCalledWith("google");
    expect(row("Google").getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(row("Outlook").getByText("jordan@outlook.com")).toBeInTheDocument();
  });

  test("Outlook's Disconnect names Outlook", async () => {
    const user = userEvent.setup();
    app.status = status({ connectors: connectors({ microsoft: "jordan@outlook.com" }) });
    vi.spyOn(api, "connectorDisconnect").mockResolvedValue();
    vi.spyOn(api, "status").mockResolvedValue(status());
    await open("connections");
    await user.click(row("Outlook").getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(app.toast).toBe("Outlook is disconnected."));
  });

  test("a failed disconnect says why and keeps the account", async () => {
    const user = userEvent.setup();
    app.status = status({ connectors: connectors({ google: "jordan@gmail.com" }) });
    vi.spyOn(api, "connectorDisconnect").mockRejectedValue(new AppError("You're offline.", "offline"));
    await open("connections");
    await user.click(row("Google").getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(app.toast).toBe("You're offline."));
    expect(row("Google").getByText("jordan@gmail.com")).toBeInTheDocument();
  });

  test("a failed connect says why and offers Connect again", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "connectorConnect").mockRejectedValue(new AppError("You're offline.", "offline"));
    await open("connections");
    await user.click(row("Google").getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(app.toast).toBe("You're offline."));
    expect(row("Google").getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  test("Outlook shows a code to enter; the button copies it and opens Microsoft", async () => {
    const user = userEvent.setup();
    const open_ = vi.spyOn(window, "open").mockReturnValue(null);
    vi.spyOn(api, "connectorConnect").mockResolvedValue({
      kind: "device",
      device_code: "m",
      user_code: "F4K3C0DE",
      verification_uri: "https://microsoft.com/devicelogin",
      interval: 60,
    });
    await open("connections");
    await user.click(row("Outlook").getByRole("button", { name: "Connect" }));
    const panel = await pane().findByText("Enter this code on Microsoft's sign-in page:");
    const box = within(panel.closest<HTMLElement>("[role=status]")!);
    expect(box.getByText("F4K3C0DE")).toBeInTheDocument();
    expect(row("Outlook").getByRole("button", { name: "Waiting…" })).toBeDisabled();
    await user.click(box.getByRole("button", { name: "Copy code and open Microsoft" }));
    expect(await navigator.clipboard.readText()).toBe("F4K3C0DE");
    expect(open_).toHaveBeenCalledWith("https://microsoft.com/devicelogin", "_blank", "noopener");
  });

  test("Cancel stops waiting for Microsoft", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const poll = vi.spyOn(api, "connectorPoll").mockResolvedValue(false);
    vi.spyOn(api, "connectorConnect").mockResolvedValue({ kind: "device", device_code: "m", user_code: "ABC", verification_uri: "https://x", interval: 5 });
    await open("connections");
    await user.click(row("Outlook").getByRole("button", { name: "Connect" }));
    await pane().findByText("ABC");
    await user.click(pane().getByRole("button", { name: "Cancel" }));
    expect(pane().queryByText("ABC")).not.toBeInTheDocument();
    expect(row("Outlook").getByRole("button", { name: "Connect" })).toBeEnabled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).not.toHaveBeenCalled();
  });

  test("once Microsoft approves, Outlook shows as connected", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "connectorConnect").mockResolvedValue({ kind: "device", device_code: "dc", user_code: "ABC", verification_uri: "https://x", interval: 0 });
    const poll = vi.spyOn(api, "connectorPoll").mockResolvedValue(true);
    vi.spyOn(api, "status").mockResolvedValue(status({ connectors: connectors({ microsoft: "jordan@outlook.com" }) }));
    await open("connections");
    await user.click(row("Outlook").getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(app.toast).toBe("Outlook is connected."));
    expect(poll).toHaveBeenCalledWith("dc");
    expect(row("Outlook").getByText("jordan@outlook.com")).toBeInTheDocument();
    expect(pane().queryByText("ABC")).not.toBeInTheDocument();
  });

  test("Microsoft is asked again until it answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.spyOn(api, "connectorConnect").mockResolvedValue({ kind: "device", device_code: "dc", user_code: "ABC", verification_uri: "https://x", interval: 1 });
    const poll = vi.spyOn(api, "connectorPoll").mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    vi.spyOn(api, "status").mockResolvedValue(status({ connectors: connectors({ microsoft: "jordan@outlook.com" }) }));
    await open("connections");
    await user.click(row("Outlook").getByRole("button", { name: "Connect" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);
    // Then no faster than every 2 seconds.
    await vi.advanceTimersByTimeAsync(1900);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4200);
    expect(poll).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(app.toast).toBe("Outlook is connected."));
  });

  test("a failed sign-in with Microsoft says why and ends the wait", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "connectorConnect").mockResolvedValue({ kind: "device", device_code: "dc", user_code: "ABC", verification_uri: "https://x", interval: 0 });
    vi.spyOn(api, "connectorPoll").mockRejectedValue(new AppError("The code expired. Connect again.", "message"));
    await open("connections");
    await user.click(row("Outlook").getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(app.toast).toBe("The code expired. Connect again."));
    expect(pane().queryByText("ABC")).not.toBeInTheDocument();
    expect(row("Outlook").getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  test("closing Settings stops waiting for Microsoft", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const poll = vi.spyOn(api, "connectorPoll").mockResolvedValue(false);
    vi.spyOn(api, "connectorConnect").mockResolvedValue({ kind: "device", device_code: "m", user_code: "ABC", verification_uri: "https://x", interval: 5 });
    await open("connections");
    await user.click(row("Outlook").getByRole("button", { name: "Connect" }));
    await pane().findByText("ABC");
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).not.toHaveBeenCalled();
    app.openSettings("connections");
    await vi.advanceTimersByTimeAsync(50);
    expect(pane().queryByText("ABC")).not.toBeInTheDocument();
    expect(row("Outlook").getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  test("Apple Calendar asks the system, then shows it is allowed", async () => {
    const user = userEvent.setup();
    const connect = vi.spyOn(api, "connectorConnect").mockResolvedValue({ kind: "done", access: "granted" });
    vi.spyOn(api, "status").mockResolvedValue(status({ connectors: connectors({ apple_calendar: "granted" }) }));
    await open("connections");
    await user.click(row("Apple Calendar").getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(row("Apple Calendar").getByText("Allowed on this device")).toBeInTheDocument());
    expect(connect).toHaveBeenCalledWith("apple_calendar");
    expect(row("Apple Calendar").queryByRole("button")).not.toBeInTheDocument();
    expect(row("Apple Reminders").getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  test("Apple access turned off or not on this device says so, with no button", async () => {
    app.status = status({ connectors: connectors({ apple_calendar: "denied", apple_reminders: "unsupported" }) });
    await open("connections");
    expect(row("Apple Calendar").getByText("Turned off. Allow it in System Settings, under Privacy & Security")).toBeInTheDocument();
    expect(row("Apple Calendar").queryByRole("button")).not.toBeInTheDocument();
    expect(row("Apple Reminders").getByText("Only on iPhone and Mac")).toBeInTheDocument();
    expect(row("Apple Reminders").queryByRole("button")).not.toBeInTheDocument();
  });

  test("a provider this build can't use isn't listed at all", async () => {
    app.status = status({ configured: { github: true, google: false, microsoft: true, apple: true, gmail: true } });
    await open("connections");
    expect(pane().queryByText("Google")).not.toBeInTheDocument();
    expect(row("Outlook").getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(row("Apple Calendar")).toBeTruthy();
  });

  test("a connected provider stays listed so it can be disconnected", async () => {
    app.status = status({
      configured: { github: true, google: false, microsoft: false, apple: false, gmail: true },
      connectors: connectors({ google: "jordan@example.com" }),
    });
    await open("connections");
    expect(row("Google").getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(pane().queryByText("Outlook")).not.toBeInTheDocument();
  });

  test("an Android public build has nothing to connect yet, and says only that", async () => {
    app.status = status({ configured: { github: true, google: false, microsoft: false, apple: false, gmail: false } });
    await open("connections");
    expect(pane().getByText("There's nothing to connect in this version yet.")).toBeInTheDocument();
    expect(pane().queryByText(/Google/)).not.toBeInTheDocument();
    expect(pane().queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    expect(pane().queryByText(/appear in Today/)).not.toBeInTheDocument();
  });
});

describe("Account", () => {
  test("signed in, it shows the GitHub account", async () => {
    await open("account");
    expect(row("Jordan").getByText("GitHub: jordan-jakisa")).toBeInTheDocument();
  });

  test("Sign out asks first; a synced vault closes with it", async () => {
    const user = userEvent.setup();
    app.status = synced();
    const signOut = vi.spyOn(app, "signOut").mockResolvedValue();
    await open("account");
    await user.click(pane().getByRole("button", { name: "Sign out" }));
    const ask = screen.getByRole("dialog", { name: "Sign out of GitHub?" });
    expect(ask).toHaveTextContent("This vault syncs with GitHub, so it closes. Your notes stay on this device and on GitHub.");
    await user.click(within(ask).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(signOut).toHaveBeenCalled());
  });

  test("signing out keeps a vault on this device open", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "githubSignOut").mockResolvedValue();
    vi.spyOn(api, "status").mockResolvedValue(status({ user: null }));
    await open("account");
    await user.click(pane().getByRole("button", { name: "Sign out" }));
    const ask = screen.getByRole("dialog", { name: "Sign out of GitHub?" });
    expect(ask).toHaveTextContent("Your vault stays open on this device.");
    await user.click(within(ask).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(app.status?.user).toBeNull());
    expect(app.status?.vault).not.toBeNull();
    expect(app.settingsOpen).toBe(false);
  });

  test("Cancel keeps you signed in", async () => {
    const user = userEvent.setup();
    const signOut = vi.spyOn(app, "signOut");
    await open("account");
    await user.click(pane().getByRole("button", { name: "Sign out" }));
    await user.click(within(screen.getByRole("dialog", { name: "Sign out of GitHub?" })).getByRole("button", { name: "Cancel" }));
    expect(signOut).not.toHaveBeenCalled();
  });

  test("signed out, it offers GitHub sign-in", async () => {
    app.status = status({ user: null });
    await open("account");
    expect(pane().getByText("Not signed in. Sign in to sync vaults through GitHub.")).toBeInTheDocument();
    expect(pane().getByRole("button", { name: "Sign in with GitHub" })).toBeInTheDocument();
  });
});

describe("About", () => {
  test("shows the version and opens the source on GitHub", async () => {
    const user = userEvent.setup();
    const open_ = vi.spyOn(window, "open").mockReturnValue(null);
    await open("about");
    expect(row("Wandika").getByText("Version 0.1.0 beta")).toBeInTheDocument();
    await user.click(pane().getByRole("button", { name: "github.com/jordan-jakisa/wandika" }));
    expect(open_).toHaveBeenCalledWith("https://github.com/jordan-jakisa/wandika", "_blank", "noopener");
  });

  test("links the privacy policy, as the stores require", async () => {
    const user = userEvent.setup();
    const open_ = vi.spyOn(window, "open").mockReturnValue(null);
    await open("about");
    await user.click(pane().getByRole("button", { name: "Privacy policy" }));
    expect(open_).toHaveBeenCalledWith("https://github.com/jordan-jakisa/wandika/blob/main/PRIVACY.md", "_blank", "noopener");
  });

  test("says it's a beta and takes feedback by email", async () => {
    const user = userEvent.setup();
    const open_ = vi.spyOn(window, "open").mockReturnValue(null);
    await open("about");
    expect(row("This is a beta").getByText(/Your notes stay plain Markdown files/)).toBeInTheDocument();
    await user.click(pane().getByRole("button", { name: "Send feedback" }));
    expect(open_).toHaveBeenCalledWith("mailto:jordan.timutic@gmail.com?subject=Wandika%20beta%20feedback", "_blank", "noopener");
  });

  test("lists the keyboard shortcuts", async () => {
    await open("about");
    const keys = [...document.querySelectorAll(".pane kbd")].map((k) => [k.closest(".row")!.querySelector(".row-label")!.textContent, k.textContent]);
    expect(keys).toEqual([
      ["Search or create a note", "⌘K or ⌘O"],
      ["New note", "⌘N"],
      ["Today's note", "⌘D"],
      ["Sync now", "⌘S"],
      ["Settings", "⌘,"],
      ["Show or hide the sidebar", "⌘\\"],
      ["Find in note", "⌘F"],
      ["Link a note", "[["],
    ]);
  });
});

describe("on a phone, as the Settings tab", () => {
  beforeEach(() => setWidth(400));
  async function openTab(section?: Parameters<typeof app.openSettings>[0]) {
    render(Dialog);
    const view = render(Settings, { embedded: true });
    app.openSettings(section);
    await tick();
    return view;
  }

  test("the section list says when there's nothing to connect", async () => {
    app.status = status({ configured: { github: true, google: false, microsoft: false, apple: false, gmail: false } });
    await openTab();
    expect(screen.getByText("Nothing to connect yet")).toBeInTheDocument();
  });

  test("opens on the list of sections, each with what is inside, as a page and not a dialog", async () => {
    await openTab();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Settings" })).toBeInTheDocument();
    expect(document.querySelector(".pane")).toBeNull();
    const details = [...screen.getByRole("navigation", { name: "Settings sections" }).querySelectorAll("li button")]
      .map((b) => [b.querySelector(".sec-text > span")!.textContent, b.querySelector(".sec-detail")!.textContent]);
    expect(details).toEqual([
      ["Vault", "Notes, on this device"],
      ["Appearance", "Theme, accent colour, CSS snippets"],
      ["Editor", "Font, text size, line width"],
      ["Encryption", "Unlocked on this device"],
      ["Connections", "Mail, calendars and reminders"],
      ["Account", "GitHub: jordan-jakisa"],
      ["About", "Version 0.1.0 beta, feedback, keyboard shortcuts"],
    ]);
    expect(sections().getByRole("button", { name: /Vault/ })).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
  });

  test("the list's details follow the vault, encryption, connections and account", async () => {
    app.status = synced({
      user: null,
      encryption: { set_up: true, unlocked: false, folders: [] },
      connectors: connectors({ google: "a@gmail.com", apple_calendar: "granted", apple_reminders: "denied" }),
    });
    await openTab();
    const detail = (name: string) => sections().getByRole("button", { name: new RegExp(`^${name}`) }).querySelector(".sec-detail")!.textContent;
    expect(detail("Vault")).toBe("notes, syncs with GitHub");
    expect(detail("Encryption")).toBe("Locked");
    expect(detail("Connections")).toBe("2 connected");
    expect(detail("Account")).toBe("Not signed in");
  });

  test("encryption not set up reads Not set up", async () => {
    app.status = status({ encryption: { set_up: false, unlocked: false, folders: [] } });
    await openTab();
    expect(sections().getByRole("button", { name: /^Encryption/ })).toHaveTextContent("Not set up");
  });

  test("a section opens as its own page, and its back button returns to the list", async () => {
    const user = userEvent.setup();
    await openTab();
    await user.click(sections().getByRole("button", { name: /^Appearance/ }));
    expect(paneTitle()).toBe("Appearance");
    expect(app.settingsPage).toBe("appearance");
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument());
    expect(app.settingsPage).toBeNull();
  });

  test("opened for one section, it goes straight to it", async () => {
    await openTab("encryption");
    expect(paneTitle()).toBe("Encryption");
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });
});
