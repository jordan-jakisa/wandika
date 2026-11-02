<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../api";
  import { app } from "../app.svelte";
  import type { RemoteTask, VaultTask } from "../types";
  import TaskRow from "./TaskRow.svelte";

  let tasks = $state<VaultTask[]>([]);
  const remote = $derived<RemoteTask[]>(app.today?.remote_tasks ?? []);
  let showDone = $state(false);
  let loading = $state(true);

  async function load() {
    loading = true;
    try {
      const [vaultTasks] = await Promise.all([api.tasksVault(), app.loadToday()]);
      tasks = vaultTasks;
    } catch (e) {
      app.say((e as Error).message);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void app.changed.at;
    untrack(() => load());
  });

  const visible = $derived(tasks.filter((t) => showDone || !t.done));
  const byNote = $derived.by(() => {
    const groups = new Map<string, VaultTask[]>();
    for (const t of visible) {
      if (!groups.has(t.path)) groups.set(t.path, []);
      groups.get(t.path)!.push(t);
    }
    return [...groups.entries()];
  });
  const byList = $derived.by(() => {
    const groups = new Map<string, RemoteTask[]>();
    for (const t of remote) {
      const key = `${t.source === "apple" ? "Reminders" : "Google Tasks"}: ${t.list}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }
    return [...groups.entries()];
  });
  const open = $derived(tasks.filter((t) => !t.done).length);
</script>

<section class="tasks" aria-labelledby="tasks-title">
  <header>
    <h2 id="tasks-title">Tasks</h2>
    <label class="toggle"><input type="checkbox" bind:checked={showDone} /> Show done</label>
  </header>
  <p class="muted summary">
    {loading && !tasks.length ? "Gathering tasks from your notes…" : `${open} open in your notes. Write - [ ] in any note to add one.`}
  </p>

  {#each byNote as [path, items] (path)}
    <section class="group">
      <h3><button onclick={() => app.open(path)}>{items[0].title}</button></h3>
      <ul>
        {#each items as t (t.line)}
          <TaskRow
            text={t.text}
            done={t.done}
            due={t.due}
            where={path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "Vault"}
            onToggle={async () => {
              await api.taskToggle(t.path, t.line, t.text);
              app.edited();
              app.changed = { paths: [t.path], at: Date.now() };
            }}
          />
        {/each}
      </ul>
    </section>
  {/each}

  {#each byList as [list, items] (list)}
    <section class="group">
      <h3>{list}</h3>
      <ul>
        {#each items as t (t.id)}
          <TaskRow
            text={t.title}
            done={t.done}
            due={t.due}
            where={t.list}
            onToggle={async () => {
              await api.remoteTaskToggle(t.source, t.list_id, t.id, !t.done);
              await app.loadToday(true);
            }}
          />
        {/each}
      </ul>
    </section>
  {/each}
</section>

<style>
  .tasks {
    padding: 20px 20px calc(32px + var(--safe-bottom));
    max-width: 72ch;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  h2 {
    margin: 0;
    font-family: var(--font-note);
    font-size: 1.6rem;
    font-weight: 600;
  }
  .summary {
    margin: 6px 0 20px;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--small);
    color: var(--graphite);
  }
  .toggle input {
    accent-color: var(--papyrus);
  }
  .group {
    margin-bottom: 22px;
  }
  h3 {
    margin: 0 0 4px;
    font-size: 1rem;
    font-weight: 600;
  }
  h3 button {
    border: 0;
    background: none;
    padding: 0;
    font-weight: 600;
    color: var(--ink);
  }
  h3 button:hover {
    color: var(--papyrus);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
</style>
