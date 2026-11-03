import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetApp, status } from "../../test/components-workspace";
import { api, AppError } from "../api";
import { app } from "../app.svelte";
import GitHubSignIn from "./GitHubSignIn.svelte";

const device = {
  device_code: "d",
  user_code: "WDKA-2611",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 0,
};

beforeEach(() => {
  resetApp();
  app.status = status({ user: null, vault: null });
});

afterEach(() => vi.useRealTimers());

test("signed out, it offers to sign in and says why", () => {
  render(GitHubSignIn);
  expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeEnabled();
  expect(screen.getByText(/asks GitHub for access to your repositories/)).toBeInTheDocument();
});

test("signing in shows the device code to enter on GitHub", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "githubStartLogin").mockResolvedValue(device);
  vi.spyOn(api, "githubPollLogin").mockResolvedValue(null);
  render(GitHubSignIn);
  await user.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
  expect(await screen.findByText("WDKA-2611")).toBeInTheDocument();
  // Read out one character at a time.
  expect(screen.getByLabelText("Code W D K A - 2 6 1 1")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for GitHub");
});

test("the button says it is contacting GitHub while it starts", async () => {
  const user = userEvent.setup();
  let answer!: (d: typeof device) => void;
  vi.spyOn(api, "githubStartLogin").mockImplementation(() => new Promise((r) => (answer = r)));
  vi.spyOn(api, "githubPollLogin").mockResolvedValue(null);
  render(GitHubSignIn);
  await user.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
  expect(screen.getByRole("button", { name: "Contacting GitHub…" })).toBeDisabled();
  answer(device);
  expect(await screen.findByText("WDKA-2611")).toBeInTheDocument();
});

test("a failed start shows the reason and lets you try again", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "githubStartLogin").mockRejectedValue(new AppError("You're offline.", "offline"));
  render(GitHubSignIn);
  await user.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("You're offline.");
  expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeEnabled();
});

test("copy code and open GitHub copies the code and opens the sign-in page", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "githubStartLogin").mockResolvedValue(device);
  vi.spyOn(api, "githubPollLogin").mockResolvedValue(null);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  render(GitHubSignIn);
  await user.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
  await user.click(await screen.findByRole("button", { name: "Copy code and open GitHub" }));
  expect(await navigator.clipboard.readText()).toBe("WDKA-2611");
  expect(open).toHaveBeenCalledWith("https://github.com/login/device", "_blank", "noopener");
  expect(screen.getByRole("button", { name: "Code copied. Open GitHub again" })).toBeInTheDocument();
});

test("approving on GitHub signs in and tells the parent", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "githubStartLogin").mockResolvedValue(device);
  vi.spyOn(api, "githubPollLogin")
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ user: { login: "jordan-jakisa", name: "Jordan", avatar_url: "" } });
  vi.spyOn(api, "status").mockResolvedValue(status({ vault: null }));
  const onsignedin = vi.fn();
  render(GitHubSignIn, { props: { onsignedin } });
  await user.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
  await waitFor(() => expect(onsignedin).toHaveBeenCalledOnce());
  expect(api.githubPollLogin).toHaveBeenCalledWith("d");
  expect(app.status?.user?.login).toBe("jordan-jakisa");
  expect(screen.queryByText("WDKA-2611")).not.toBeInTheDocument();
});

test("an expired code says so and offers to start again", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "githubStartLogin").mockResolvedValue(device);
  vi.spyOn(api, "githubPollLogin").mockRejectedValue(new AppError("The code expired. Start sign-in again.", "message"));
  render(GitHubSignIn);
  await user.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The code expired. Start sign-in again.");
  expect(screen.queryByText("WDKA-2611")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeEnabled();
});

test("cancelling on GitHub shows that sign-in was cancelled", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "githubStartLogin").mockResolvedValue(device);
  vi.spyOn(api, "githubPollLogin").mockRejectedValue(new AppError("Sign-in was cancelled on GitHub.", "message"));
  render(GitHubSignIn);
  await user.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Sign-in was cancelled on GitHub.");
});

test("a dropped connection while waiting keeps waiting", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "githubStartLogin").mockResolvedValue(device);
  const poll = vi
    .spyOn(api, "githubPollLogin")
    .mockRejectedValueOnce(new AppError("You're offline.", "offline"))
    .mockResolvedValue(null);
  render(GitHubSignIn);
  await user.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
  await waitFor(() => expect(poll.mock.calls.length).toBeGreaterThanOrEqual(2));
  expect(screen.getByText("WDKA-2611")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("GitHub asking to slow down adds five seconds between checks", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(api, "githubStartLogin").mockResolvedValue({ ...device, interval: 1 });
  const poll = vi.spyOn(api, "githubPollLogin").mockResolvedValueOnce({ slow_down: true }).mockResolvedValue(null);
  render(GitHubSignIn);
  screen.getByRole("button", { name: "Sign in with GitHub" }).click();
  await vi.advanceTimersByTimeAsync(1000);
  expect(poll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(poll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(poll).toHaveBeenCalledTimes(2);
});

test("cancel stops waiting and goes back to the sign-in button", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(api, "githubStartLogin").mockResolvedValue({ ...device, interval: 5 });
  const poll = vi.spyOn(api, "githubPollLogin").mockResolvedValue(null);
  render(GitHubSignIn);
  screen.getByRole("button", { name: "Sign in with GitHub" }).click();
  await vi.advanceTimersByTimeAsync(0);
  screen.getByRole("button", { name: "Cancel" }).click();
  await vi.advanceTimersByTimeAsync(0);
  expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(poll).not.toHaveBeenCalled();
});

test("closing the screen stops the checks", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(api, "githubStartLogin").mockResolvedValue({ ...device, interval: 5 });
  const poll = vi.spyOn(api, "githubPollLogin").mockResolvedValue(null);
  const { unmount } = render(GitHubSignIn);
  screen.getByRole("button", { name: "Sign in with GitHub" }).click();
  await vi.advanceTimersByTimeAsync(0);
  expect(screen.getByText("WDKA-2611")).toBeInTheDocument();
  unmount();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(poll).not.toHaveBeenCalled();
});

test("closing the screen during a check doesn't start another", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(api, "githubStartLogin").mockResolvedValue({ ...device, interval: 1 });
  let answer!: (v: null) => void;
  const poll = vi.spyOn(api, "githubPollLogin").mockImplementation(() => new Promise((r) => (answer = r)));
  const { unmount } = render(GitHubSignIn);
  screen.getByRole("button", { name: "Sign in with GitHub" }).click();
  await vi.advanceTimersByTimeAsync(1000);
  expect(poll).toHaveBeenCalledTimes(1);
  unmount();
  answer(null);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(poll).toHaveBeenCalledTimes(1);
});

test("cancelling during a check ignores its answer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(api, "githubStartLogin").mockResolvedValue({ ...device, interval: 1 });
  let answer!: (v: { user: { login: string; name: string; avatar_url: string } }) => void;
  vi.spyOn(api, "githubPollLogin").mockImplementation(() => new Promise((r) => (answer = r)));
  const refresh = vi.spyOn(app, "refreshStatus").mockResolvedValue();
  const onsignedin = vi.fn();
  render(GitHubSignIn, { props: { onsignedin } });
  screen.getByRole("button", { name: "Sign in with GitHub" }).click();
  await vi.advanceTimersByTimeAsync(1000);
  screen.getByRole("button", { name: "Cancel" }).click();
  answer({ user: { login: "jordan-jakisa", name: "Jordan", avatar_url: "" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(onsignedin).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeInTheDocument();
});

test("closing the screen while sign-in starts doesn't start checking", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let answer!: (d: typeof device) => void;
  vi.spyOn(api, "githubStartLogin").mockImplementation(() => new Promise((r) => (answer = r)));
  const poll = vi.spyOn(api, "githubPollLogin").mockResolvedValue(null);
  const { unmount } = render(GitHubSignIn);
  screen.getByRole("button", { name: "Sign in with GitHub" }).click();
  unmount();
  answer({ ...device, interval: 1 });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(poll).not.toHaveBeenCalled();
});
