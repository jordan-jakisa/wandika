import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { resetApp, status } from "../../test/components-workspace";
import { api, AppError } from "../api";
import { app } from "../app.svelte";
import type { Repo, SyncReport } from "../types";
import RepoPicker from "./RepoPicker.svelte";

const repo = (name: string, patch: Partial<Repo> = {}): Repo => ({
  name,
  full_name: `jordan-jakisa/${name}`,
  owner: { login: "jordan-jakisa" },
  private: true,
  default_branch: "main",
  description: null,
  pushed_at: null,
  ...patch,
});

const repos = [
  repo("notes", { description: "Everything I write down", pushed_at: new Date(Date.now() - 36e5).toISOString() }),
  repo("wandika", { private: false }),
  repo("rowpin"),
];

const report: SyncReport = {
  pulled: [],
  pushed: [],
  removed: [],
  merged: [],
  conflicts: [],
  too_big: [],
  held_deletions: [],
  vault_bytes: 0,
  head: "abc",
  at: 1,
};

beforeEach(() => {
  resetApp();
  app.status = status({ vault: null });
});

test("says it is loading, then lists your repositories", async () => {
  let answer!: (r: Repo[]) => void;
  vi.spyOn(api, "reposList").mockImplementation(() => new Promise((r) => (answer = r)));
  render(RepoPicker);
  expect(screen.getByRole("status")).toHaveTextContent("Loading your repositories…");
  answer(repos);
  const list = await screen.findByRole("list", { name: "Repositories" });
  expect(within(list).getAllByRole("button")).toHaveLength(3);
  expect(within(list).getByRole("button", { name: /jordan-jakisa\/notes/ })).toHaveTextContent("Everything I write down");
  expect(within(list).getByRole("button", { name: /jordan-jakisa\/notes/ })).toHaveTextContent("Updated 1 h ago");
});

test("marks private and public repositories, and warns about public ones", async () => {
  vi.spyOn(api, "reposList").mockResolvedValue(repos);
  render(RepoPicker);
  const pub = await screen.findByRole("button", { name: /jordan-jakisa\/wandika/ });
  expect(within(pub).getByLabelText("Public")).toBeInTheDocument();
  expect(pub).toHaveTextContent("Public: anyone can read notes kept here.");
  const priv = screen.getByRole("button", { name: /jordan-jakisa\/rowpin/ });
  expect(within(priv).getByLabelText("Private")).toBeInTheDocument();
  expect(priv).not.toHaveTextContent("Public:");
});

test("the filter narrows the list and says when nothing matches", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "reposList").mockResolvedValue(repos);
  render(RepoPicker);
  await screen.findByRole("list", { name: "Repositories" });
  const filter = screen.getByLabelText("Filter repositories");
  await user.type(filter, "ROW");
  expect(within(screen.getByRole("list", { name: "Repositories" })).getAllByRole("button")).toHaveLength(1);
  expect(screen.getByRole("button", { name: /rowpin/ })).toBeInTheDocument();
  await user.clear(filter);
  await user.type(filter, "zzz");
  expect(screen.getByText("No repositories match “zzz”.")).toBeInTheDocument();
});

test("with no repositories it points to creating one or giving access", async () => {
  vi.spyOn(api, "reposList").mockResolvedValue([]);
  render(RepoPicker);
  expect(
    await screen.findByText("Wandika can't use any of your repositories yet. Create one above, or give it access to one you have."),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Repository name")).toHaveValue("notes");
});

test("a failed load shows why, and Try again loads again", async () => {
  const user = userEvent.setup();
  const list = vi
    .spyOn(api, "reposList")
    .mockRejectedValueOnce(new AppError("GitHub didn't answer.", "network"))
    .mockResolvedValue(repos);
  render(RepoPicker);
  expect(await screen.findByRole("alert")).toHaveTextContent("GitHub didn't answer.");
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("button", { name: /jordan-jakisa\/notes/ })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(list).toHaveBeenCalledTimes(2);
});

test("suggests a new repository name that isn't taken", async () => {
  vi.spyOn(api, "reposList").mockResolvedValue([repo("notes"), repo("notes-2")]);
  render(RepoPicker);
  await waitFor(() => expect(screen.getByLabelText("Repository name")).toHaveValue("notes-3"));
  expect(screen.getByRole("button", { name: "Create it on GitHub" })).toBeEnabled();
});

test("a name you already have can't be created again", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "reposList").mockResolvedValue(repos);
  render(RepoPicker);
  await screen.findByRole("list", { name: "Repositories" });
  const name = screen.getByLabelText("Repository name");
  const create = screen.getByRole("button", { name: "Create it on GitHub" });
  await user.clear(name);
  await user.type(name, "Rowpin");
  expect(screen.getByText(/You already have “Rowpin”/)).toBeInTheDocument();
  expect(create).toBeDisabled();
  await user.clear(name);
  expect(create).toBeDisabled();
  await user.type(name, "my notes");
  expect(screen.getByText("Use letters, numbers, dashes, dots or underscores.")).toBeInTheDocument();
  expect(create).toBeDisabled();
});

test("picking a repository opens it as the vault", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "reposList").mockResolvedValue(repos);
  let finish!: (r: SyncReport) => void;
  const open = vi.spyOn(api, "vaultOpen").mockImplementation(() => new Promise((r) => (finish = r)));
  const enter = vi.spyOn(app, "enterVault").mockResolvedValue();
  const ondone = vi.fn();
  render(RepoPicker, { props: { ondone } });
  await user.click(await screen.findByRole("button", { name: /jordan-jakisa\/rowpin/ }));
  expect(screen.getByText("Opening jordan-jakisa/rowpin")).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "Comparing your notes with GitHub…" })).toBeInTheDocument();
  expect(app.syncing).toBe(true);
  finish(report);
  await waitFor(() => expect(ondone).toHaveBeenCalledOnce());
  expect(open).toHaveBeenCalledWith("jordan-jakisa", "rowpin");
  expect(enter).toHaveBeenCalledWith(report);
  expect(app.syncing).toBe(false);
});

test("shows how far the first download is", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "reposList").mockResolvedValue(repos);
  vi.spyOn(api, "vaultOpen").mockReturnValue(new Promise(() => {}));
  render(RepoPicker);
  await user.click(await screen.findByRole("button", { name: /jordan-jakisa\/notes/ }));
  app.syncProgress = { phase: "downloading", done: 312, total: 2597 };
  const bar = await screen.findByRole("progressbar", { name: "Downloading 312 of 2,597 files" });
  expect(bar).toHaveAttribute("aria-valuenow", "12");
  expect(screen.getByRole("status")).toHaveTextContent("Downloading 312 of 2,597 files");
});

test("Stop cancels the running sync", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "reposList").mockResolvedValue(repos);
  vi.spyOn(api, "vaultOpen").mockReturnValue(new Promise(() => {}));
  const cancel = vi.spyOn(api, "syncCancel").mockResolvedValue();
  render(RepoPicker);
  await user.click(await screen.findByRole("button", { name: /jordan-jakisa\/notes/ }));
  await user.click(screen.getByRole("button", { name: "Stop" }));
  expect(cancel).toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("Stopping…");
  expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
});

test("a failed open shows why and goes back to the list", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "reposList").mockResolvedValue(repos);
  vi.spyOn(api, "vaultOpen").mockRejectedValue(new AppError("Sync stopped. Nothing on GitHub changed.", "cancelled"));
  const refresh = vi.spyOn(app, "refreshStatus").mockResolvedValue();
  const ondone = vi.fn();
  render(RepoPicker, { props: { ondone } });
  await user.click(await screen.findByRole("button", { name: /jordan-jakisa\/notes/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Sync stopped. Nothing on GitHub changed.");
  expect(screen.getByRole("button", { name: /jordan-jakisa\/notes/ })).toBeInTheDocument();
  expect(refresh).toHaveBeenCalled();
  expect(ondone).not.toHaveBeenCalled();
  expect(app.syncing).toBe(false);
});

test("Create it on GitHub opens GitHub's page, then opens the repository once Wandika can see it", async () => {
  const user = userEvent.setup();
  const winOpen = vi.spyOn(window, "open").mockReturnValue(null);
  const list = vi.spyOn(api, "reposList").mockResolvedValueOnce(repos).mockResolvedValueOnce(repos).mockResolvedValue([...repos, repo("journal")]);
  const open = vi.spyOn(api, "vaultOpen").mockResolvedValue(report);
  vi.spyOn(app, "enterVault").mockResolvedValue();
  const ondone = vi.fn();
  render(RepoPicker, { props: { ondone } });
  await screen.findByRole("list", { name: "Repositories" });
  const name = screen.getByLabelText("Repository name");
  await user.clear(name);
  await user.type(name, "journal");
  await user.click(screen.getByRole("button", { name: "Create it on GitHub" }));
  const url = new URL(winOpen.mock.calls[0][0] as string);
  expect(url.origin + url.pathname).toBe("https://github.com/new");
  expect(Object.fromEntries(url.searchParams)).toEqual({ name: "journal", visibility: "private", description: "Notes kept with Wandika" });
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for “journal”.");
  expect(name).toBeDisabled();

  // Back from GitHub before the repository exists: still waiting.
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  expect(open).not.toHaveBeenCalled();
  // Back again once Wandika has access: it opens.
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(ondone).toHaveBeenCalled());
  expect(open).toHaveBeenCalledWith("jordan-jakisa", "journal");
});

test("waiting for a new repository can be cancelled", async () => {
  const user = userEvent.setup();
  vi.spyOn(window, "open").mockReturnValue(null);
  vi.spyOn(api, "reposList").mockResolvedValue(repos);
  render(RepoPicker);
  await screen.findByRole("list", { name: "Repositories" });
  await user.click(screen.getByRole("button", { name: "Create it on GitHub" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText(/Waiting for/)).not.toBeInTheDocument();
  expect(screen.getByLabelText("Repository name")).toBeEnabled();
});

test("Give Wandika access opens the app's page on GitHub", async () => {
  const user = userEvent.setup();
  const winOpen = vi.spyOn(window, "open").mockReturnValue(null);
  vi.spyOn(api, "reposList").mockResolvedValue(repos);
  render(RepoPicker);
  await screen.findByRole("list", { name: "Repositories" });
  await user.click(screen.getByRole("button", { name: "Give Wandika access" }));
  expect(winOpen).toHaveBeenLastCalledWith("https://github.com/apps/wandika/installations/new", "_blank", "noopener");
  await user.click(screen.getByRole("button", { name: "Give Wandika access to it on GitHub" }));
  expect(winOpen).toHaveBeenCalledTimes(2);

  app.status = status({ vault: null, configured: { ...status().configured, github_app: null } });
  await user.click(screen.getByRole("button", { name: "Give Wandika access" }));
  expect(winOpen).toHaveBeenLastCalledWith("https://github.com/settings/installations", "_blank", "noopener");
});

test("Refresh looks for repositories again", async () => {
  const user = userEvent.setup();
  const list = vi.spyOn(api, "reposList").mockResolvedValueOnce([]).mockResolvedValue(repos);
  render(RepoPicker);
  await screen.findByText(/can't use any of your repositories yet/);
  await user.click(screen.getByRole("button", { name: "Refresh the list" }));
  expect(await screen.findByRole("button", { name: /jordan-jakisa\/notes/ })).toBeInTheDocument();
  expect(list).toHaveBeenCalledTimes(2);
});

test("connect mode syncs the open vault with the repository and says so", async () => {
  const user = userEvent.setup();
  app.status = status();
  vi.spyOn(api, "reposList").mockResolvedValue(repos);
  const connect = vi.spyOn(api, "vaultConnectRemote").mockResolvedValue(report);
  const open = vi.spyOn(api, "vaultOpen");
  vi.spyOn(app, "enterVault").mockResolvedValue();
  const ondone = vi.fn();
  render(RepoPicker, { props: { mode: "connect", ondone } });
  expect(screen.getByText(/merged on the first sync/)).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Create it on GitHub" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /jordan-jakisa\/notes/ }));
  await waitFor(() => expect(ondone).toHaveBeenCalled());
  expect(connect).toHaveBeenCalledWith("jordan-jakisa", "notes");
  expect(open).not.toHaveBeenCalled();
  expect(app.toast).toBe("Synced with jordan-jakisa/notes.");
});

test("connect mode explains that nothing is deleted while it runs", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "reposList").mockResolvedValue(repos);
  vi.spyOn(api, "vaultConnectRemote").mockReturnValue(new Promise(() => {}));
  render(RepoPicker, { props: { mode: "connect" } });
  await user.click(await screen.findByRole("button", { name: /jordan-jakisa\/notes/ }));
  expect(screen.getByText("Connecting to jordan-jakisa/notes")).toBeInTheDocument();
  expect(screen.getByText(/both are kept\. Nothing is deleted\./)).toBeInTheDocument();
});

test("works against the in-browser core", async () => {
  render(RepoPicker);
  expect(await screen.findByRole("button", { name: /jordan-jakisa\/notes/ }, { timeout: 2000 })).toBeInTheDocument();
  expect(screen.getByLabelText("Repository name")).toHaveValue("notes-2");
});

test("shows the seven most recently updated; typing finds the rest", async () => {
  const many = Array.from({ length: 10 }, (_, i) => repo(`repo-${i + 1}`));
  vi.spyOn(api, "reposList").mockResolvedValue(many);
  const user = userEvent.setup();
  render(RepoPicker);
  await screen.findByText("jordan-jakisa/repo-1");
  const names = () => within(screen.getByRole("list", { name: "Repositories" })).getAllByRole("listitem").map((li) => li.querySelector(".name")?.textContent?.trim());
  expect(names()).toEqual(["repo-1", "repo-2", "repo-3", "repo-4", "repo-5", "repo-6", "repo-7"].map((n) => `jordan-jakisa/${n}`));
  expect(screen.getByText(/3 more repositories\. Type its name above to find it\./)).toBeInTheDocument();
  await user.type(screen.getByLabelText("Filter repositories"), "repo-9");
  expect(names()).toEqual(["jordan-jakisa/repo-9"]);
  expect(screen.queryByText(/more repositor/)).not.toBeInTheDocument();
});

test("one hidden repository is singular", async () => {
  vi.spyOn(api, "reposList").mockResolvedValue(Array.from({ length: 8 }, (_, i) => repo(`r${i}`)));
  render(RepoPicker);
  expect(await screen.findByText(/^1 more repository\./)).toBeInTheDocument();
});
