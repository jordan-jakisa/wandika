import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { settle } from "../test/lib";
import type { CalEvent, Entry, MailBody, MailItem, NoteMeta, RemoteTask, SearchHit, Snippet, Status, SyncReport, Today, VaultTask } from "./types";

// types.ts has no code of its own; these tests hold the browser mock to its shapes. Each key list
// is checked by TypeScript against the interface, so adding a field there fails here until the
// mock sends it too.
const keys = <T>(k: Record<keyof T, true>) => Object.keys(k).sort();

const STATUS = keys<Status>({ configured: true, user: true, vault: true, known: true, last_sync: true, encryption: true, connectors: true });
const REPORT = keys<SyncReport>({ pulled: true, pushed: true, removed: true, merged: true, conflicts: true, too_big: true, held_deletions: true, vault_bytes: true, head: true, at: true });
const ENTRY = keys<Entry>({ path: true, name: true, kind: true, encrypted: true, modified: true });
const META = keys<NoteMeta>({ path: true, title: true, links: true, tags: true, encrypted: true, locked: true, board: true, modified: true });
const HIT = keys<SearchHit>({ path: true, title: true, snippet: true, encrypted: true });
const TASK = keys<VaultTask>({ path: true, title: true, line: true, text: true, done: true, due: true, details: true });
const BODY = keys<MailBody>({ subject: true, from: true, to: true, date: true, text: true, html: true, url: true });
const EVENT = keys<CalEvent>({ id: true, source: true, calendar: true, title: true, start: true, end: true, all_day: true, location: true, url: true, attendees: true });
const MAIL = keys<MailItem>({ id: true, source: true, subject: true, from: true, date: true, snippet: true, url: true, unread: true });
const REMOTE = keys<RemoteTask>({ id: true, source: true, list_id: true, list: true, title: true, done: true, due: true });
const TODAY = keys<Today>({ events: true, mail: true, tasks: true, remote_tasks: true, errors: true });
const SNIPPET = keys<Snippet>({ name: true, css: true, enabled: true });

async function mock() {
  history.replaceState(null, "", "/?mock=vault");
  vi.resetModules();
  const { invoke } = await import("./mock");
  return <T>(cmd: string, args?: Record<string, unknown>) => settle(invoke(cmd, args) as Promise<T>);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  history.replaceState(null, "", "/");
});

test("status has every field", async () => {
  const run = await mock();
  const s = await run<Status>("status");
  expect(Object.keys(s).sort()).toEqual(STATUS);
  expect(Object.keys(s.vault!).sort()).toEqual(["folder", "id", "name", "remote"]);
  expect(Object.keys(s.vault!.remote!).sort()).toEqual(["branch", "owner", "repo"]);
  expect(Object.keys(s.encryption!).sort()).toEqual(["folders", "set_up", "unlocked"]);
  expect(Object.keys(s.connectors).sort()).toEqual(["apple_calendar", "apple_reminders", "google", "microsoft"]);
});

test("sync reports have every field", async () => {
  const run = await mock();
  expect(Object.keys(await run<SyncReport>("sync_now")).sort()).toEqual(REPORT);
  expect(Object.keys(await run<SyncReport>("vault_open", { owner: "a", repo: "b" })).sort()).toEqual(REPORT);
  expect(Object.keys(await run<SyncReport>("vault_connect_remote", { owner: "a", repo: "b" })).sort()).toEqual(REPORT);
});

test("tree entries, note titles, search hits and tasks have every field", async () => {
  const run = await mock();
  for (const e of await run<Entry[]>("tree")) expect(Object.keys(e).sort()).toEqual(ENTRY);
  for (const m of await run<NoteMeta[]>("note_titles")) expect(Object.keys(m).sort()).toEqual(META);
  for (const h of await run<SearchHit[]>("search", { query: "wandika" })) expect(Object.keys(h).sort()).toEqual(HIT);
  for (const h of await run<SearchHit[]>("backlinks", { path: "Projects/Wandika.md" })) expect(Object.keys(h).sort()).toEqual(HIT);
  for (const t of await run<VaultTask[]>("tasks_vault")) expect(Object.keys(t).sort()).toEqual(TASK);
  for (const s of await run<Snippet[]>("snippets_list")) expect(Object.keys(s).sort()).toEqual(SNIPPET);
});

test("Today and everything in it have every field", async () => {
  const run = await mock();
  const t = await run<Today>("today");
  expect(Object.keys(t).sort()).toEqual(TODAY);
  for (const e of t.events) expect(Object.keys(e).sort()).toEqual(EVENT);
  for (const m of t.mail) expect(Object.keys(m).sort()).toEqual(MAIL);
  for (const r of t.remote_tasks) expect(Object.keys(r).sort()).toEqual(REMOTE);
  for (const r of t.tasks) expect(Object.keys(r).sort()).toEqual(TASK);
});

test("a whole email has every field", async () => {
  const run = await mock();
  const body = await run<MailBody>("mail_read", { source: "google", id: "18c2f0a1b2c3d4e5" });
  expect(Object.keys(body).sort()).toEqual(BODY);
});
