import "@testing-library/jest-dom/vitest";
import { resetApp, statusFixture, task, todayFixture } from "../../test/components-views";
import { render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api";
import { app } from "../app.svelte";
import { clock } from "../clock.svelte";
import type { CalEvent, MailItem, RemoteTask, Status, Today } from "../types";
import TodayPanel from "./TodayPanel.svelte";

const at = (h: number, m = 0) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const event = (over: Partial<CalEvent> = {}): CalEvent => ({
  id: "e1",
  source: "google",
  calendar: "Work",
  title: "Design review",
  start: at(16),
  end: at(17),
  all_day: false,
  location: null,
  url: null,
  attendees: [],
  ...over,
});

const mail = (over: Partial<MailItem> = {}): MailItem => ({
  id: "m1",
  source: "google",
  subject: "Your flight is confirmed",
  from: '"Uganda Airlines" <noreply@ugandaairlines.com>',
  date: at(7, 12),
  snippet: "Booking reference UR8K2.",
  url: null,
  unread: true,
  ...over,
});

const remote = (over: Partial<RemoteTask> = {}): RemoteTask => ({
  id: "r1",
  source: "google",
  list_id: "l1",
  list: "My Tasks",
  title: "Renew domain",
  done: false,
  due: "2026-11-03",
  ...over,
});

const connected = (c: Partial<Status["connectors"]> = { google: "jordan@example.com" }) =>
  statusFixture({ connectors: { google: null, microsoft: null, apple_calendar: "not_asked", apple_reminders: "not_asked", ...c } });

beforeEach(() => {
  resetApp();
  app.status = connected();
  vi.spyOn(api, "today").mockResolvedValue(todayFixture());
  vi.spyOn(api, "tasksVault").mockResolvedValue([]);
  vi.spyOn(app, "refreshFiles").mockResolvedValue();
  vi.spyOn(window, "open").mockReturnValue(null);
});
/** A Today load that hasn't answered yet. The app shares one load at a time, so each is answered after its test. */
let waiting: (() => void)[] = [];
const pending = () => new Promise<Today>((r) => waiting.push(() => r(todayFixture())));
afterEach(async () => {
  for (const answer of waiting) answer();
  waiting = [];
  await new Promise((r) => setTimeout(r));
  vi.restoreAllMocks();
});

/** Renders with `today` as what the services return, and waits for it to arrive. */
async function setup(today = todayFixture()) {
  vi.mocked(api.today).mockResolvedValue(today);
  const r = render(TodayPanel);
  await vi.waitFor(() => expect(screen.getByRole("region", { name: clock.heading })).toHaveAttribute("aria-busy", "false"));
  return { ...r, user: userEvent.setup() };
}
const section = (name: string) => screen.getByRole("heading", { name }).closest("section")!;

test("is headed with today's date", async () => {
  await setup();
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(clock.heading);
});

test("Open today's note opens the daily note", async () => {
  vi.spyOn(api, "dailyNote").mockResolvedValue("Daily/2026-11-03.md");
  const { user } = await setup();
  await user.click(screen.getByRole("button", { name: "Open today's note" }));
  await vi.waitFor(() => expect(app.current).toBe("Daily/2026-11-03.md"));
});

describe("loading", () => {
  test("shows rows the shape of what's coming, and says it is busy", () => {
    vi.mocked(api.today).mockReturnValue(pending());
    app.status = connected({ google: "j@example.com" });
    render(TodayPanel);
    expect(screen.getByRole("region", { name: clock.heading })).toHaveAttribute("aria-busy", "true");
    expect(section("Calendar").querySelector(".skeleton")).toBeInTheDocument();
    expect(section("Due today").querySelector(".skeleton")).toBeInTheDocument();
    expect(section("Inbox").querySelector(".skeleton")).toBeInTheDocument();
    expect(screen.queryByText("Connect an account")).not.toBeInTheDocument();
  });

  test("uses what was already loaded instead of a blank panel", () => {
    vi.mocked(api.today).mockReturnValue(pending());
    app.today = todayFixture({ events: [event()] });
    render(TodayPanel);
    expect(screen.getByText("Design review")).toBeInTheDocument();
  });
});

describe("no accounts connected", () => {
  test("offers to connect one and hides calendar and inbox", async () => {
    app.status = connected({});
    const { user } = await setup();
    expect(screen.getByText(/See your calendar and inbox here/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Calendar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Inbox" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Due today" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect an account" }));
    expect(app.settingsOpen).toBe(true);
    expect(app.settingsSection).toBe("connections");
  });

  test("Apple Calendar alone shows the calendar but no inbox", async () => {
    app.status = connected({ apple_calendar: "granted" });
    await setup();
    expect(screen.getByRole("heading", { name: "Calendar" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Inbox" })).not.toBeInTheDocument();
    expect(screen.queryByText("Connect an account")).not.toBeInTheDocument();
  });

  test("Outlook alone shows calendar and inbox", async () => {
    app.status = connected({ microsoft: "j@outlook.com" });
    await setup();
    expect(screen.getByRole("heading", { name: "Calendar" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
  });
});

describe("problems with a service", () => {
  test("one line per problem, with Reconnect when signing in again fixes it", async () => {
    const { user } = await setup(
      todayFixture({
        errors: {
          "Outlook Mail": { code: "provider_auth", message: "Outlook needs you to sign in again." },
          "Outlook Calendar": { code: "provider_auth", message: "Outlook needs you to sign in again." },
          Gmail: { code: "provider_down", message: "Gmail isn't answering." },
        },
      }),
    );
    const list = screen.getByRole("status");
    const lines = within(list).getAllByRole("listitem");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent("Outlook needs you to sign in again.");
    expect(within(lines[1]).queryByRole("button")).not.toBeInTheDocument();
    await user.click(within(lines[0]).getByRole("button", { name: "Reconnect" }));
    expect(app.settingsSection).toBe("connections");
    expect(app.settingsOpen).toBe(true);
  });

  test("a revoked permission offers Reconnect too", async () => {
    await setup(todayFixture({ errors: { Gmail: { code: "provider_forbidden", message: "Gmail access was removed." } } }));
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  test("none: no problem list", async () => {
    await setup();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("calendar", () => {
  test("an empty day says so, with nothing to add", async () => {
    await setup();
    expect(within(section("Calendar")).getByText("Nothing on your calendar today.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to today's note" })).not.toBeInTheDocument();
  });

  test("lists events with time or All day, calendar and place", async () => {
    await setup(
      todayFixture({
        events: [
          event({ id: "1", title: "Gym", all_day: true, calendar: "Personal" }),
          event({ id: "2", title: "Call with the landlord", start: at(13), calendar: "Home", location: "Kampala" }),
        ],
      }),
    );
    const rows = within(section("Calendar")).getAllByRole("listitem").filter((li) => li.parentElement?.classList.contains("events"));
    expect(rows[0]).toHaveTextContent("All day");
    expect(rows[0]).toHaveTextContent("Gym");
    expect(rows[0]).toHaveTextContent("Personal");
    expect(rows[1]).toHaveTextContent(time(at(13)));
    expect(rows[1]).toHaveTextContent("Home, Kampala");
  });

  test("Meeting note creates the note and opens it", async () => {
    const make = vi.spyOn(api, "eventToNote").mockResolvedValue("Meetings/2026-11-03 Design review.md");
    const e = event();
    const { user } = await setup(todayFixture({ events: [e] }));
    await user.click(within(section("Calendar")).getAllByRole("button", { name: "Meeting note" })[0]);
    expect(make).toHaveBeenCalledWith(e);
    await vi.waitFor(() => expect(app.current).toBe("Meetings/2026-11-03 Design review.md"));
    expect(app.refreshFiles).toHaveBeenCalled();
  });

  test("Meeting note is disabled while it is being made", async () => {
    let done!: (p: string) => void;
    vi.spyOn(api, "eventToNote").mockReturnValue(new Promise((r) => (done = r)));
    const { user } = await setup(todayFixture({ events: [event()] }));
    const button = within(section("Calendar")).getAllByRole("button", { name: "Meeting note" })[0];
    await user.click(button);
    expect(button).toBeDisabled();
    done("Meetings/x.md");
    await vi.waitFor(() => expect(button).toBeEnabled());
  });

  test("a failure says why and opens nothing", async () => {
    vi.spyOn(api, "eventToNote").mockRejectedValue(new Error("The Meetings folder is read-only."));
    const { user } = await setup(todayFixture({ events: [event()] }));
    await user.click(within(section("Calendar")).getAllByRole("button", { name: "Meeting note" })[0]);
    await vi.waitFor(() => expect(app.toast).toBe("The Meetings folder is read-only."));
    expect(app.current).toBeNull();
  });

  test("Open goes to the event's link; no link, no button", async () => {
    const { user } = await setup(
      todayFixture({ events: [event({ id: "1", url: "https://meet.google.com/abc" }), event({ id: "2", title: "Lunch" })] }),
    );
    const opens = within(section("Calendar")).getAllByRole("button", { name: "Open" });
    expect(opens).toHaveLength(1);
    await user.click(opens[0]);
    expect(window.open).toHaveBeenCalledWith("https://meet.google.com/abc", "_blank", "noopener");
  });

  test("each event has a menu with the same actions", async () => {
    vi.spyOn(api, "eventToNote").mockResolvedValue("Meetings/x.md");
    const { user } = await setup(todayFixture({ events: [event({ url: "https://meet.google.com/abc" })] }));
    await user.click(screen.getByRole("button", { name: "Actions for Design review" }));
    await user.click(screen.getByRole("menuitem", { name: "Open in calendar" }));
    expect(window.open).toHaveBeenCalledWith("https://meet.google.com/abc", "_blank", "noopener");
    await user.click(screen.getByRole("button", { name: "Actions for Design review" }));
    await user.click(screen.getByRole("menuitem", { name: "Meeting note" }));
    await vi.waitFor(() => expect(app.current).toBe("Meetings/x.md"));
  });

  test("Add to today's note writes the agenda and opens the daily note", async () => {
    const add = vi.spyOn(api, "agendaToDaily").mockResolvedValue("Daily/2026-11-03.md");
    const events = [event()];
    const { user } = await setup(todayFixture({ events }));
    await user.click(screen.getByRole("button", { name: "Add to today's note" }));
    expect(add).toHaveBeenCalledWith(events);
    await vi.waitFor(() => expect(app.current).toBe("Daily/2026-11-03.md"));
  });
});

describe("tasks", () => {
  test("nothing due says how to give a task a date", async () => {
    await setup();
    expect(within(section("Due today")).getByText("Nothing due today. Add 📅 and a date to a task to see it here.")).toBeInTheDocument();
  });

  test("shows tasks due today and earlier, not later ones", async () => {
    await setup(
      todayFixture({
        tasks: [
          task("Launch.md", 1, "Ship it", { due: "2026-11-03" }),
          task("Launch.md", 2, "Later", { due: "2026-11-10" }),
          task("Launch.md", 3, "No date"),
        ],
      }),
    );
    expect(screen.getByRole("checkbox", { name: "Ship it" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Later" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "No date" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Due today" })).toBeInTheDocument();
  });

  test("an overdue task changes the heading", async () => {
    await setup(todayFixture({ tasks: [task("Launch.md", 1, "Late", { due: "2026-11-01" })] }));
    expect(screen.getByRole("heading", { name: "Due and overdue" })).toBeInTheDocument();
    expect(screen.getByText("Overdue, 2026-11-01")).toBeInTheDocument();
  });

  test("a task's note name opens the note", async () => {
    const { user } = await setup(todayFixture({ tasks: [task("Projects/Launch.md", 1, "Ship it", { due: "2026-11-03" })] }));
    await user.click(screen.getByRole("button", { name: "Launch" }));
    expect(app.current).toBe("Projects/Launch.md");
  });

  test("All tasks goes to Tasks", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "All tasks" }));
    expect(app.tab).toBe("tasks");
  });

  test("ticking the last task saves it, folds it away and celebrates", async () => {
    const t = task("Launch.md", 1, "Ship it", { due: "2026-11-03" });
    const toggle = vi.spyOn(api, "taskToggle").mockResolvedValue(true);
    const { user } = await setup(todayFixture({ tasks: [t] }));
    vi.mocked(api.tasksVault).mockResolvedValue([{ ...t, done: true }]);
    await user.click(screen.getByRole("checkbox", { name: "Ship it" }));
    await vi.waitFor(() => expect(toggle).toHaveBeenCalledWith("Launch.md", 1, "Ship it"), { timeout: 2000 });
    expect(await screen.findByText("All done for today.")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Ship it" })).not.toBeInTheDocument();
  });

  test("tasks from Google Tasks and Reminders, ticked in their app", async () => {
    const toggle = vi.spyOn(api, "remoteTaskToggle").mockResolvedValue();
    const { user } = await setup(
      todayFixture({ remote_tasks: [remote(), remote({ id: "a1", source: "apple", list: "Home", title: "Water plants" })] }),
    );
    expect(screen.getByText("Google Tasks, My Tasks")).toBeInTheDocument();
    expect(screen.getByText("Reminders, Home")).toBeInTheDocument();
    const calls = vi.mocked(api.today).mock.calls.length;
    vi.mocked(api.today).mockResolvedValue(todayFixture({ remote_tasks: [remote({ id: "a1", source: "apple", list: "Home", title: "Water plants" })] }));
    await user.click(screen.getByRole("checkbox", { name: "Renew domain" }));
    await vi.waitFor(() => expect(toggle).toHaveBeenCalledWith("google", "l1", "r1", true), { timeout: 2000 });
    await vi.waitFor(() => expect(vi.mocked(api.today).mock.calls.length).toBe(calls + 1));
    await vi.waitFor(() => expect(screen.queryByRole("checkbox", { name: "Renew domain" })).not.toBeInTheDocument());
    expect(screen.queryByText("All done for today.")).not.toBeInTheDocument();
  });
});

describe("inbox", () => {
  test("empty says so", async () => {
    await setup();
    expect(within(section("Inbox")).getByText("Your inbox is empty.")).toBeInTheDocument();
  });

  test("shows sender, time, subject and preview, unread marked", async () => {
    const yesterday = new Date(Date.now() - 86_400_000 * 2).toISOString();
    await setup(
      todayFixture({ mail: [mail(), mail({ id: "m2", subject: "", from: "Amina Okello", date: yesterday, unread: false })] }),
    );
    const items = within(section("Inbox")).getAllByRole("listitem").filter((li) => li.parentElement?.classList.contains("mail"));
    expect(items[0]).toHaveClass("unread");
    expect(items[0]).toHaveTextContent("Uganda Airlines");
    expect(items[0]).not.toHaveTextContent("noreply@");
    expect(items[0]).toHaveTextContent(time(at(7, 12)));
    expect(items[0]).toHaveTextContent("Your flight is confirmed");
    expect(items[0]).toHaveTextContent("Booking reference UR8K2.");
    expect(items[1]).not.toHaveClass("unread");
    expect(items[1]).toHaveTextContent("(No subject)");
    expect(items[1]).toHaveTextContent(new Date(yesterday).toLocaleDateString(undefined, { day: "numeric", month: "short" }));
  });

  test("Save as note saves the email and opens the note", async () => {
    const save = vi.spyOn(api, "mailToNote").mockResolvedValue("Mail/Your flight is confirmed.md");
    const { user } = await setup(todayFixture({ mail: [mail()] }));
    await user.click(within(section("Inbox")).getAllByRole("button", { name: "Save as note" })[0]);
    expect(save).toHaveBeenCalledWith("google", "m1");
    await vi.waitFor(() => expect(app.current).toBe("Mail/Your flight is confirmed.md"));
  });

  test("the email's menu saves and opens it too", async () => {
    vi.spyOn(api, "mailToNote").mockResolvedValue("Mail/x.md");
    const { user } = await setup(todayFixture({ mail: [mail({ url: "https://mail.google.com/x" })] }));
    await user.click(screen.getByRole("button", { name: "Actions for Your flight is confirmed" }));
    await user.click(screen.getByRole("menuitem", { name: "Open in mail" }));
    expect(window.open).toHaveBeenCalledWith("https://mail.google.com/x", "_blank", "noopener");
    await user.click(screen.getByRole("button", { name: "Actions for Your flight is confirmed" }));
    await user.click(screen.getByRole("menuitem", { name: "Save as note" }));
    await vi.waitFor(() => expect(app.current).toBe("Mail/x.md"));
  });

  test("an email without a subject still has a named menu", async () => {
    await setup(todayFixture({ mail: [mail({ subject: "" })] }));
    expect(screen.getByRole("button", { name: "Actions for this email" })).toBeInTheDocument();
  });
});

describe("refreshing", () => {
  test("a new connection fetches at once", async () => {
    await setup();
    const calls = vi.mocked(api.today).mock.calls.length;
    app.status = connected({ google: "jordan@example.com", microsoft: "j@outlook.com" });
    flushSync();
    await vi.waitFor(() => expect(vi.mocked(api.today).mock.calls.length).toBe(calls + 1));
  });

  test("a sync re-reads the vault's tasks without refetching mail and calendars", async () => {
    await setup();
    const calls = vi.mocked(api.today).mock.calls.length;
    vi.mocked(api.tasksVault).mockResolvedValue([task("New.md", 0, "From the phone", { due: "2026-11-03" })]);
    app.changed = { paths: ["New.md"], at: Date.now() };
    expect(await screen.findByRole("checkbox", { name: "From the phone" })).toBeInTheDocument();
    expect(vi.mocked(api.today).mock.calls.length).toBe(calls);
  });

  test("when Today fails, says why", async () => {
    vi.mocked(api.today).mockRejectedValue(new Error("No connection."));
    render(TodayPanel);
    await vi.waitFor(() => expect(app.toast).toBe("No connection."));
  });
});
