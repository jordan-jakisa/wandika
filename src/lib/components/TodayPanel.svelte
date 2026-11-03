<script lang="ts">
  import { haptic } from "../haptics";
  import { CalendarPlus, CircleCheck, ExternalLink, FileText, ListPlus, MailOpen, Maximize2, NotebookPen } from "@lucide/svelte";
  import { untrack } from "svelte";
  import { api, openUrl } from "../api";
  import { app } from "../app.svelte";
  import { clock } from "../clock.svelte";
  import { mailUrl } from "../mailLinks";
  import { composeTask, emailTask, parseTask } from "../taskText";
  import { focus } from "../focus.svelte";
  import type { CalEvent, MailItem } from "../types";
  import Menu from "./Menu.svelte";
  import TaskRow from "./TaskRow.svelte";

  /** `full`: Today fills the window, in columns. `expandable`: the column offers that. */
  let { full = false, expandable = false }: { full?: boolean; expandable?: boolean } = $props();
  // The day's last task ticked off: the phone says so too, once.
  let celebrated = false;
  $effect(() => {
    if (clearedToday && !celebrated) haptic("success");
    celebrated = clearedToday;
  });
  const data = $derived(app.today);
  let busy = $state<string | null>(null);

  const c = $derived(app.status?.connectors);
  const calendarConnected = $derived(!!c && (!!c.google || !!c.microsoft || c.apple_calendar === "granted"));
  /** Only point to Connections when this build has something there to connect. */
  const canConnect = $derived(!!app.status?.configured && (app.status.configured.google || app.status.configured.microsoft || app.status.configured.apple));
  // Public builds have no Gmail; Google there is Calendar and Tasks.
  const gmail = $derived(app.status?.configured.gmail !== false);
  const mailConnected = $derived(!!c && ((gmail && !!c.google) || !!c.microsoft));
  const isDue = (t: { due: string | null }) => !!t.due && t.due <= clock.today;
  const dueTasks = $derived((data?.tasks ?? []).filter(isDue));
  const remoteDue = $derived((data?.remote_tasks ?? []).filter(isDue));
  // "All done" only after you ticked off the last one here; an empty day just says so plainly.
  let hadDue = $state(false);
  let hadDueOn = "";
  $effect(() => {
    if (dueTasks.length || remoteDue.length) {
      hadDue = true;
      hadDueOn = clock.today;
    } else if (hadDueOn !== clock.today) hadDue = false;
  });
  const clearedToday = $derived(hadDue && !dueTasks.length && !remoteDue.length);
  const hasOverdue = $derived([...dueTasks, ...remoteDue].some((t) => t.due! < clock.today));
  // One line per problem, not per service: Gmail, Calendar and Tasks share one Google sign-in.
  const errors = $derived.by(() => {
    const byMessage = new Map<string, { code: string; message: string }>();
    for (const e of Object.values(data?.errors ?? {})) byMessage.set(e.message, e);
    return [...byMessage.values()];
  });

  async function load(force = false) {
    await app.loadToday(force);
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
  const readMail = (m: MailItem) => (app.reading = { source: m.source, id: m.id, url: m.url });
  async function mailTask(m: MailItem) {
    busy = `task-${m.id}`;
    await app.addTask(emailTask(m.subject, m.from, mailUrl({ source: m.source, id: m.id }, m.url)));
    busy = null;
  }
  const addAgenda = () => run("agenda", () => api.agendaToDaily(data?.events ?? []));

  const heading = $derived(clock.heading);
</script>

{#snippet skeleton(rows: number)}
  <!-- Rows the shape of what is coming, so the section doesn't jump when it arrives. -->
  <ul class="skeleton" aria-hidden="true">
    {#each Array(rows) as _, i (i)}<li></li>{/each}
  </ul>
{/snippet}

<section class="today" class:full aria-labelledby="today-h" aria-busy={!data && !app.todayError}>
  <header>
    <div class="title-row">
      <h2 id="today-h">{heading}</h2>
      {#if expandable}
        <button class="icon-btn" onclick={() => (app.todayFull = true)} aria-label="Full screen" title="Full screen">
          <Maximize2 size={16} />
        </button>
      {/if}
    </div>
    <button
      class="btn primary"
      onclick={() => {
        app.todayFull = false;
        void app.openDaily();
      }}><NotebookPen size={16} /> Open today's note</button>
  </header>

  {#if !data && app.todayError}
    <div class="load-failed" role="alert">
      <p>Today didn't load. {app.todayError}</p>
      <button class="btn" onclick={() => app.loadToday(true)}>Try again</button>
    </div>
  {/if}

  {#if !calendarConnected && !mailConnected && data && canConnect}
    <p class="connect muted">
      See your calendar and inbox here.
      <button class="link-btn" onclick={() => app.openSettings("connections")}>Connect an account</button>
    </p>
  {/if}

  {#if errors.length}
    <ul class="errors" role="status">
      {#each errors as e (e.message)}
        <li>
          <span>{e.message}</span>
          {#if e.code === "provider_auth" || e.code === "provider_forbidden"}
            <button class="link-btn" onclick={() => app.openSettings("connections")}>Reconnect</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if calendarConnected}
  <section class="cal" aria-labelledby="cal-h">
    <div class="section-head">
      <h3 id="cal-h">Calendar</h3>
      {#if data?.events.length}
        <button class="link-btn" onclick={addAgenda} disabled={busy === "agenda"}>
          <CalendarPlus size={14} /> Add to today's note
        </button>
      {/if}
    </div>
    {#if !data}
      {#if !app.todayError}{@render skeleton(3)}{/if}
    {:else if !data.events.length}
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
                <button class="link-btn" onclick={() => meetingNote(e)} disabled={busy === `event-${e.id}`}>
                  <FileText size={14} /> Meeting note
                </button>
                {#if e.url}
                  <button class="link-btn" onclick={() => openUrl(e.url!)}><ExternalLink size={14} /> Open</button>
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

  <section class="due" aria-labelledby="tasks-h">
    <div class="section-head">
      <h3 id="tasks-h">{hasOverdue ? "Due and overdue" : "Due today"}</h3>
      <button class="link-btn" onclick={() => app.showTasks()}>All tasks</button>
    </div>
    {#if dueTasks.length || remoteDue.length}
      <ul class="tasks">
        {#each dueTasks as t (t.path + t.line)}
          <TaskRow
            leaves
            text={t.text}
            done={t.done}
            due={t.due}
            details={t.details}
            where={t.title}
            onOpen={() => app.open(t.path)}
            onEdit={() => (app.editingTask = t)}
            onPin={async () => {
              await api.taskEdit(t.path, t.line, t.text, composeTask(t.text, { pinned: !parseTask(t.text).pinned }), t.details);
              app.edited();
              await load();
            }}
            onFocus={() => focus.start({ text: parseTask(t.text).name, task: t })}
            onArchive={() => app.archiveTask(t)}
            onDelete={() => app.deleteTask(t)}
            onToggle={async () => {
              await api.taskToggle(t.path, t.line, t.text);
              app.edited();
              await load();
            }}
          />
        {/each}
        {#each remoteDue as t (t.source + t.id)}
          <TaskRow
            leaves
            text={t.title}
            done={t.done}
            due={t.due}
            where={t.source === "apple" ? `Reminders, ${t.list}` : `Google Tasks, ${t.list}`}
            onFocus={() => focus.start({ text: t.title, remote: t })}
            onToggle={async () => {
              await api.remoteTaskToggle(t.source, t.list_id, t.id, !t.done);
              await load(true);
            }}
          />
        {/each}
      </ul>
    {:else if !data}
      {#if !app.todayError}{@render skeleton(2)}{/if}
    {:else if clearedToday}
      <p class="all-done" role="status"><CircleCheck size={20} /> All done for today.</p>
    {:else}
      <p class="muted">Nothing due today. Give a task a due date and it shows here.</p>
    {/if}
  </section>

  {#if mailConnected}
  <section class="inbox" aria-labelledby="mail-h">
    <div class="section-head">
      <h3 id="mail-h">Inbox</h3>
    </div>
    {#if !data}
      {#if !app.todayError}{@render skeleton(3)}{/if}
    {:else if !data.mail.length}
      <p class="muted">Your inbox is empty.</p>
    {:else}
      <ul class="mail">
        {#each data.mail as m (m.source + m.id)}
          <li class:unread={m.unread}>
            <div class="mail-top">
              <span class="from">{sender(m.from)}</span>
              <span class="meta">{mailTime(m.date)}</span>
              <span class="row-menu">
                <Menu label={`Actions for ${m.subject || "this email"}`}>
                  <button role="menuitem" onclick={() => readMail(m)}><MailOpen size={18} /> Read</button>
                  <button role="menuitem" onclick={() => mailTask(m)}><ListPlus size={18} /> Add as task</button>
                  <button role="menuitem" onclick={() => saveMail(m)}><FileText size={18} /> Save as note</button>
                  {#if m.url}
                    <button role="menuitem" onclick={() => openUrl(m.url!)}><ExternalLink size={18} /> Open in {m.source === "microsoft" ? "Outlook" : "Gmail"}</button>
                  {/if}
                </Menu>
              </span>
            </div>
            <button class="open-mail" onclick={() => readMail(m)}>
              <span class="subject">{m.subject || "(No subject)"}</span>
              <span class="snippet">{m.snippet}</span>
            </button>
            <span class="row-actions">
              <button class="link-btn" onclick={() => mailTask(m)} disabled={busy === `task-${m.id}`}>
                <ListPlus size={14} /> Add as task
              </button>
              <button class="link-btn" onclick={() => saveMail(m)} disabled={busy === `mail-${m.id}`}>
                <FileText size={14} /> Save as note
              </button>
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
  .title-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-2);
  }
  /* Full screen: the day on the left, the inbox beside it, the whole thing centred. */
  .today.full {
    max-width: 1180px;
    margin: 0 auto;
    padding: var(--space-4) var(--space-8) var(--space-8);
    column-gap: var(--space-8);
  }
  @media (min-width: 960px) {
    .today.full {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
      grid-auto-flow: dense;
    }
    .today.full > :not(.cal, .due, .inbox) {
      grid-column: 1 / -1;
    }
    .today.full > .cal,
    .today.full > .due {
      grid-column: 1;
    }
    .today.full > .inbox {
      grid-column: 2;
      grid-row: span 3;
      align-self: start;
    }
  }
  h2 {
    margin: 0;
    font-size: var(--view-title-size);
    font-weight: var(--view-title-weight);
    letter-spacing: var(--view-title-tracking);
    line-height: var(--view-title-line);
    line-height: 1.2;
  }
  header .btn {
    justify-self: start;
  }
  h3 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
  }
  .connect {
    margin: 0 0 8px;
  }
  .connect .link-btn {
    display: inline;
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
    border-top: 1px solid var(--hairline);
  }
  /* The subject and preview open the email in Wandika. */
  .open-mail {
    display: grid;
    gap: 2px;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    min-width: 0;
  }
  @media (hover: hover) {
    .open-mail:hover .subject {
      color: var(--papyrus);
    }
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
  /* Links beside a heading or on a row are small, below the heading's size. */
  .row-actions .link-btn,
  .section-head .link-btn {
    font-size: var(--small);
    font-weight: 500;
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
  .load-failed {
    display: grid;
    justify-items: start;
    gap: var(--space-3);
  }
  .load-failed p {
    margin: 0;
    color: var(--graphite);
  }
  .skeleton {
    display: grid;
    gap: var(--space-3);
    margin: var(--space-1) 0 var(--space-2);
    padding: 0;
    list-style: none;
  }
  .skeleton li {
    height: 36px;
    border-radius: var(--radius-sm);
    background: var(--press);
  }
  .all-done {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-1) 0;
    color: var(--papyrus);
    font-family: var(--font-note);
    font-size: var(--text-lg);
    animation: pop-in var(--dur-slow) var(--ease-out);
  }
</style>
