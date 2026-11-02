<script lang="ts">
  import { CalendarPlus, ExternalLink, FileText, NotebookPen } from "@lucide/svelte";
  import { untrack } from "svelte";
  import { api, openUrl } from "../api";
  import { app } from "../app.svelte";
  import { clock } from "../clock.svelte";
  import type { CalEvent, MailItem } from "../types";
  import Menu from "./Menu.svelte";
  import TaskRow from "./TaskRow.svelte";

  const data = $derived(app.today);
  let loading = $state(!app.today);
  let busy = $state<string | null>(null);

  const c = $derived(app.status?.connectors);
  const calendarConnected = $derived(!!c && (!!c.google || !!c.microsoft || c.apple_calendar === "granted"));
  const mailConnected = $derived(!!c && (!!c.google || !!c.microsoft));
  const isDue = (t: { due: string | null }) => !!t.due && t.due <= clock.today;
  const dueTasks = $derived((data?.tasks ?? []).filter(isDue));
  const remoteDue = $derived((data?.remote_tasks ?? []).filter(isDue));
  const hasOverdue = $derived([...dueTasks, ...remoteDue].some((t) => t.due! < clock.today));
  // One line per problem, not per service: Gmail, Calendar and Tasks share one Google sign-in.
  const errors = $derived.by(() => {
    const byMessage = new Map<string, { code: string; message: string }>();
    for (const e of Object.values(data?.errors ?? {})) byMessage.set(e.message, e);
    return [...byMessage.values()];
  });

  async function load(force = false) {
    loading = true;
    await app.loadToday(force);
    loading = false;
  }

  // A new connection always fetches; otherwise the shared two-minute cache applies.
  let lastConnectors = "";
  $effect(() => {
    const key = JSON.stringify(app.status?.connectors ?? {});
    const force = lastConnectors !== "" && key !== lastConnectors;
    lastConnectors = key;
    untrack(() => load(force));
  });

  // After a sync brings in changes, tasks update; mail and calendars wait for their cache.
  $effect(() => {
    if (app.changed.at) untrack(() => load());
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

  const heading = $derived(clock.heading);
</script>

<section class="today" aria-labelledby="today-h">
  <header>
    <h2 id="today-h">{heading}</h2>
    <button class="btn primary" onclick={() => app.openDaily()}><NotebookPen size={16} /> Open today's note</button>
  </header>

  {#if !calendarConnected && !mailConnected && !loading}
    <p class="connect muted">
      See your calendar and inbox here.
      <button class="link" onclick={() => app.openSettings("connections")}>Connect an account</button>
    </p>
  {/if}

  {#if errors.length}
    <ul class="errors" role="status">
      {#each errors as e (e.message)}
        <li>
          <span>{e.message}</span>
          {#if e.code === "provider_auth" || e.code === "provider_forbidden"}
            <button class="link" onclick={() => app.openSettings("connections")}>Reconnect</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if calendarConnected}
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
            <span class="row-menu">
              <Menu label={`Actions for ${e.title}`}>
                <button role="menuitem" onclick={() => meetingNote(e)}><FileText size={18} /> Meeting note</button>
                {#if e.url}
                  <button role="menuitem" onclick={() => openUrl(e.url!)}><ExternalLink size={18} /> Open in calendar</button>
                {/if}
              </Menu>
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
  {/if}

  <section aria-labelledby="tasks-h">
    <div class="section-head">
      <h3 id="tasks-h">{hasOverdue ? "Due and overdue" : "Due today"}</h3>
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
              await load(true);
            }}
          />
        {/each}
      </ul>
    {:else if !loading}
      <p class="muted">Nothing due today. Add 📅 and a date to a task to see it here.</p>
    {/if}
  </section>

  {#if mailConnected}
  <section aria-labelledby="mail-h">
    <div class="section-head">
      <h3 id="mail-h">Inbox</h3>
    </div>
    {#if !data?.mail.length && !loading}
      <p class="muted">Your inbox is empty.</p>
    {:else if data}
      <ul class="mail">
        {#each data.mail as m (m.source + m.id)}
          <li class:unread={m.unread}>
            <div class="mail-top">
              <span class="from">{sender(m.from)}</span>
              <span class="meta">{mailTime(m.date)}</span>
              <span class="row-menu">
                <Menu label={`Actions for ${m.subject || "this email"}`}>
                  <button role="menuitem" onclick={() => saveMail(m)}><FileText size={18} /> Save as note</button>
                  {#if m.url}
                    <button role="menuitem" onclick={() => openUrl(m.url!)}><ExternalLink size={18} /> Open in mail</button>
                  {/if}
                </Menu>
              </span>
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
  {/if}
</section>

<style>
  .today {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
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
    font-size: var(--view-title-size);
    font-weight: var(--view-title-weight);
    letter-spacing: var(--view-title-tracking);
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
  .connect {
    margin: 0 0 8px;
  }
  .connect .link {
    display: inline;
    padding: 0;
  }
  .section-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 4px 12px;
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
    grid-template-columns: 4.2em minmax(0, 1fr);
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
    overflow-wrap: anywhere;
  }
  .meta,
  .snippet {
    font-size: var(--small);
    color: var(--graphite);
    overflow-wrap: anywhere;
  }
  /* Calendar and account details can be long lists; keep them to one line. */
  .events .meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  /* Phones keep each row quiet: its actions sit behind one ⋯ button. */
  .row-menu {
    display: none;
  }
  @media (max-width: 899px) {
    .row-actions {
      display: none !important;
    }
    .row-menu {
      display: block;
      margin: -8px -8px 0 0;
    }
    .events li {
      grid-template-columns: 4.2em minmax(0, 1fr) auto;
    }
    .mail-top {
      align-items: center;
    }
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
    list-style: none;
    margin: 0 0 16px;
    padding: 0;
    font-size: var(--small);
    color: var(--alarm);
    display: grid;
    gap: 4px;
  }
  .errors li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
  }
</style>
