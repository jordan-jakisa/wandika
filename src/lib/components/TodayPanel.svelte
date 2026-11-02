<script lang="ts">
  import { CalendarPlus, ExternalLink, FileText, Inbox, NotebookPen } from "@lucide/svelte";
  import { api, openUrl } from "../api";
  import { app } from "../app.svelte";
  import type { CalEvent, MailItem, Today } from "../types";
  import TaskRow from "./TaskRow.svelte";

  let data = $state<Today | null>(null);
  let loading = $state(true);
  let busy = $state<string | null>(null);
  const todayIso = new Date().toLocaleDateString("en-CA");

  const c = $derived(app.status?.connectors);
  const calendarConnected = $derived(!!c && (!!c.google || !!c.microsoft || c.apple_calendar === "granted"));
  const mailConnected = $derived(!!c && (!!c.google || !!c.microsoft));
  const isDue = (t: { due: string | null }) => !!t.due && t.due <= todayIso;
  const dueTasks = $derived((data?.tasks ?? []).filter(isDue));
  const remoteDue = $derived((data?.remote_tasks ?? []).filter(isDue));
  const errors = $derived(Object.entries(data?.errors ?? {}));

  async function load() {
    loading = true;
    try {
      data = await api.today();
    } catch (e) {
      app.say((e as Error).message);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void app.status?.connectors;
    void load();
  });

  // Refresh after a sync brings in task changes from another device.
  $effect(() => {
    if (app.changed.at) void load();
  });

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const mailTime = (iso: string) => {
    const d = new Date(iso);
    return d.toDateString() === new Date().toDateString()
      ? time(iso)
      : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  };
  const sender = (from: string) => from.replace(/\s*<[^>]+>/, "").replace(/"/g, "") || from;

  async function run(key: string, fn: () => Promise<string>) {
    busy = key;
    try {
      const path = await fn();
      await app.refreshFiles();
      app.open(path);
      app.edited();
    } catch (e) {
      app.say((e as Error).message);
    } finally {
      busy = null;
    }
  }

  const meetingNote = (e: CalEvent) => run(`event-${e.id}`, () => api.eventToNote(e));
  const saveMail = (m: MailItem) => run(`mail-${m.id}`, () => api.mailToNote(m.source, m.id));
  const addAgenda = () => run("agenda", () => api.agendaToDaily(data?.events ?? []));

  const heading = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
</script>

<section class="today" aria-labelledby="today-h">
  <header>
    <h2 id="today-h">{heading}</h2>
    <button class="btn primary" onclick={() => app.openDaily()}><NotebookPen size={16} /> Open today's note</button>
  </header>

  {#if errors.length}
    <ul class="errors" role="status">
      {#each errors as [source, message] (source)}
        <li><strong>{source}:</strong> {message}</li>
      {/each}
    </ul>
  {/if}

  <section aria-labelledby="cal-h">
    <div class="section-head">
      <h3 id="cal-h">Calendar</h3>
      {#if data?.events.length}
        <button class="link" onclick={addAgenda} disabled={busy === "agenda"}>
          <CalendarPlus size={14} /> Add to today's note
        </button>
      {/if}
    </div>
    {#if loading && !data}
      <p class="muted">Loading your day…</p>
    {:else if !calendarConnected}
      <p class="muted">Connect a calendar to see today's events here.</p>
      <button class="btn" onclick={() => (app.settingsOpen = true)}>Connect a calendar</button>
    {:else if !data?.events.length}
      <p class="muted">Nothing on your calendar today.</p>
    {:else}
      <ul class="events">
        {#each data.events as e (e.source + e.id)}
          <li>
            <span class="when">{e.all_day ? "All day" : time(e.start)}</span>
            <div class="what">
              <span class="title">{e.title}</span>
              <span class="meta">{[e.calendar, e.location].filter(Boolean).join(", ")}</span>
              <span class="row-actions">
                <button class="link" onclick={() => meetingNote(e)} disabled={busy === `event-${e.id}`}>
                  <FileText size={14} /> Meeting note
                </button>
                {#if e.url}
                  <button class="link" onclick={() => openUrl(e.url!)}><ExternalLink size={14} /> Open</button>
                {/if}
              </span>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section aria-labelledby="tasks-h">
    <div class="section-head">
      <h3 id="tasks-h">Due today</h3>
      <button class="link" onclick={() => (app.tab = "tasks")}>All tasks</button>
    </div>
    {#if dueTasks.length || remoteDue.length}
      <ul class="tasks">
        {#each dueTasks as t (t.path + t.line)}
          <TaskRow
            text={t.text}
            done={t.done}
            due={t.due}
            where={t.title}
            onOpen={() => app.open(t.path)}
            onToggle={async () => {
              await api.taskToggle(t.path, t.line, t.text);
              app.edited();
              await load();
            }}
          />
        {/each}
        {#each remoteDue as t (t.source + t.id)}
          <TaskRow
            text={t.title}
            done={t.done}
            due={t.due}
            where={t.source === "apple" ? `Reminders, ${t.list}` : `Google Tasks, ${t.list}`}
            onToggle={async () => {
              await api.remoteTaskToggle(t.source, t.list_id, t.id, !t.done);
              await load();
            }}
          />
        {/each}
      </ul>
    {:else if !loading}
      <p class="muted">Nothing due today. Add 📅 and a date to a task to see it here.</p>
    {/if}
  </section>

  <section aria-labelledby="mail-h">
    <div class="section-head">
      <h3 id="mail-h">Inbox</h3>
    </div>
    {#if !mailConnected}
      <p class="muted">Connect Gmail or Outlook to save emails as notes.</p>
      <button class="btn" onclick={() => (app.settingsOpen = true)}><Inbox size={16} /> Connect email</button>
    {:else if !data?.mail.length && !loading}
      <p class="muted">Your inbox is empty.</p>
    {:else if data}
      <ul class="mail">
        {#each data.mail as m (m.source + m.id)}
          <li class:unread={m.unread}>
            <div class="mail-top">
              <span class="from">{sender(m.from)}</span>
              <span class="meta">{mailTime(m.date)}</span>
            </div>
            <span class="subject">{m.subject || "(No subject)"}</span>
            <span class="snippet">{m.snippet}</span>
            <span class="row-actions">
              <button class="link" onclick={() => saveMail(m)} disabled={busy === `mail-${m.id}`}>
                <FileText size={14} /> Save as note
              </button>
              {#if m.url}
                <button class="link" onclick={() => openUrl(m.url!)}><ExternalLink size={14} /> Open</button>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</section>

<style>
  .today {
    display: grid;
    gap: 28px;
    padding: 20px 20px calc(32px + var(--safe-bottom));
    align-content: start;
  }
  header {
    display: grid;
    gap: 12px;
  }
  h2 {
    margin: 0;
    font-family: var(--font-note);
    font-size: 1.6rem;
    font-weight: 600;
    line-height: 1.2;
  }
  header .btn {
    justify-self: start;
  }
  h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }
  section > p {
    margin: 0 0 10px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .events li {
    display: grid;
    grid-template-columns: 4.2em 1fr;
    gap: 10px;
    padding: 8px 0;
  }
  .when {
    font-variant-numeric: tabular-nums;
    color: var(--graphite);
    font-size: var(--small);
    padding-top: 2px;
  }
  .what,
  .mail li {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .title,
  .subject {
    font-weight: 500;
  }
  .meta,
  .snippet {
    font-size: var(--small);
    color: var(--graphite);
  }
  .snippet {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .mail li {
    padding: 10px 0;
  }
  .mail li + li {
    border-top: 1px solid var(--rule);
  }
  .mail-top {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  .from {
    font-size: var(--small);
    color: var(--graphite);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .unread .from {
    color: var(--ink);
    font-weight: 600;
  }
  .row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    margin-top: 4px;
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 0;
    background: none;
    padding: 2px 0;
    color: var(--papyrus);
    font-size: var(--small);
    font-weight: 500;
  }
  .link:disabled {
    opacity: 0.5;
  }
  @media (pointer: coarse) {
    .link {
      min-height: 36px;
    }
  }
  .errors {
    font-size: var(--small);
    color: var(--alarm);
    display: grid;
    gap: 4px;
  }
</style>
