<script lang="ts">
  import { Lock, Globe, Plus } from "@lucide/svelte";
  import { api } from "../api";
  import { ago, app, progressText } from "../app.svelte";
  import type { Repo } from "../types";

  /** `open`: use a repository as a vault. `connect`: sync the open local vault with one. */
  let { mode = "open", ondone }: { mode?: "open" | "connect"; ondone?: () => void } = $props();

  let repos = $state<Repo[] | null>(null);
  let filter = $state("");
  let error = $state<string | null>(null);
  let opening = $state<string | null>(null);
  let newName = $state("notes");
  let creating = $state(false);

  function loadRepos() {
    error = null;
    api
      .reposList()
      .then((r) => {
        repos = r;
        // Suggest a name that isn't taken yet: notes, notes-2, notes-3…
        const taken = new Set(r.map((x) => x.name.toLowerCase()));
        if (taken.has(newName.toLowerCase())) {
          let n = 2;
          while (taken.has(`notes-${n}`)) n++;
          newName = `notes-${n}`;
        }
      })
      .catch((e) => (error = (e as Error).message));
  }
  $effect(() => loadRepos());

  const nameTaken = $derived(!!repos?.some((r) => r.name.toLowerCase() === newName.trim().toLowerCase()));

  /** The seven most recently updated; typing finds the rest. */
  const TOP = 7;
  const matches = $derived(
    (repos ?? []).filter((r) => r.full_name.toLowerCase().includes(filter.trim().toLowerCase())),
  );
  const shown = $derived(matches.slice(0, TOP));
  const hidden = $derived(matches.length - shown.length);

  async function open(owner: string, repo: string) {
    opening = `${owner}/${repo}`;
    error = null;
    stopping = false;
    // The whole app shows this sync: the status bar carries on if Settings is closed.
    app.syncing = true;
    app.syncProgress = null;
    try {
      if (mode === "open") {
        await app.enterVault(await api.vaultOpen(owner, repo));
      } else {
        await app.enterVault(await api.vaultConnectRemote(owner, repo));
        app.say(`Synced with ${owner}/${repo}.`);
      }
      opening = null;
      ondone?.();
    } catch (e) {
      error = (e as Error).message;
      opening = null;
      await app.refreshStatus();
    } finally {
      app.syncing = false;
      app.syncProgress = null;
    }
  }

  let stopping = $state(false);
  async function stop() {
    stopping = true;
    await api.syncCancel().catch(() => {});
  }

  const p = $derived(app.syncProgress);
  const fraction = $derived(p && p.total ? p.done / p.total : null);

  async function create(e: SubmitEvent) {
    e.preventDefault();
    creating = true;
    error = null;
    try {
      const repo = await api.repoCreate(newName);
      await open(repo.owner.login, repo.name);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      creating = false;
    }
  }
</script>

<div class="picker">
  {#if opening}
    <p class="lead">{mode === "open" ? `Opening ${opening}` : `Connecting to ${opening}`}</p>
    <div class="progress" role="progressbar" aria-label={progressText(p)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}>
      <span class:indeterminate={fraction === null} style={fraction === null ? undefined : `width: ${Math.max(2, fraction * 100)}%`}></span>
    </div>
    <p class="status" role="status">{stopping ? "Stopping…" : progressText(p)}</p>
    <p class="muted">
      {mode === "open"
        ? "The first download of a large vault takes a few minutes. Your notes open when it's done."
        : "Where both sides have a different file with the same name, both are kept. Nothing is deleted. You can close Settings; syncing carries on, and the status bar shows how far it is."}
    </p>
    <div>
      <button class="btn quiet" onclick={stop} disabled={stopping}>Stop</button>
    </div>
  {:else}
    <p class="muted">
      {mode === "open"
        ? "Wandika keeps every note as a Markdown file in the repository. A private one is best."
        : "Your notes and the repository's files are merged on the first sync. Nothing is deleted on either side."}
    </p>

    <form class="create" onsubmit={create}>
      <label for="new-repo">New private repository</label>
      <div class="create-row">
        <input id="new-repo" class="field" bind:value={newName} autocapitalize="off" spellcheck="false" />
        <button class="btn primary" disabled={creating || !newName.trim() || nameTaken}>
          <Plus size={16} />
          {creating ? "Creating…" : mode === "open" ? "Create and open" : "Create and connect"}
        </button>
      </div>
      {#if nameTaken}<p class="muted taken">You already have “{newName.trim()}”. Pick it from the list below, or choose another name.</p>{/if}
    </form>

    <label class="sr-only" for="repo-filter">Filter repositories</label>
    <input id="repo-filter" class="field" type="search" bind:value={filter} placeholder="Or pick one of your repositories" />

    {#if error}
      <p class="error" role="alert">{error}</p>
      {#if repos === null}<button class="btn" onclick={loadRepos}>Try again</button>{/if}
    {/if}

    {#if repos === null && !error}
      <p class="muted" role="status">Loading your repositories…</p>
    {:else if repos}
      <ul>
        {#each shown as r (r.full_name)}
          <li>
            <button onclick={() => open(r.owner.login, r.name)}>
              <span class="name">
                {#if r.private}<Lock size={14} aria-label="Private" />{:else}<Globe size={14} aria-label="Public" />{/if}
                {r.full_name}
              </span>
              {#if r.description}<span class="desc">{r.description}</span>{/if}
              {#if !r.private}<span class="warn">Public: anyone can read notes kept here.</span>{/if}
              {#if r.pushed_at}<span class="when">Updated {ago(Date.parse(r.pushed_at))}</span>{/if}
            </button>
          </li>
        {:else}
          <li class="muted none">
            {filter.trim() ? `No repositories match “${filter.trim()}”.` : "You don't have any repositories yet. Create one above."}
          </li>
        {/each}
      </ul>
      {#if hidden > 0}
        <p class="muted more">
          {hidden === 1 ? "1 more repository." : `${hidden} more repositories.`} Type its name above to find it.
        </p>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .more {
    margin: var(--space-3) 0 0;
    font-size: var(--small);
  }
  .progress {
    position: relative;
    height: 6px;
    border-radius: 999px;
    background: var(--press);
    overflow: hidden;
  }
  .progress span {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: inherit;
    background: var(--papyrus);
    transition: width var(--dur-base) var(--ease-out);
  }
  /* Before the totals are known: a short bar that moves along (it stands still under reduced motion). */
  .progress .indeterminate {
    width: 30%;
    animation: slide 1.4s var(--ease-out) infinite;
  }
  @keyframes slide {
    from {
      left: -30%;
    }
    to {
      left: 100%;
    }
  }
  .status {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  .taken {
    margin-top: 6px;
    font-size: var(--small);
  }
  .picker {
    display: grid;
    gap: 14px;
  }
  .lead {
    font-weight: 600;
  }
  p {
    margin: 0;
  }
  .create {
    display: grid;
    gap: 6px;
    padding: 16px;
    border-radius: var(--radius);
    background: var(--sheet);
    border: 1px solid var(--rule);
  }
  .create label {
    font-weight: 600;
  }
  .create-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .create-row .field {
    flex: 1 1 180px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li + li {
    border-top: 1px solid var(--hairline);
  }
  li button {
    display: grid;
    gap: 2px;
    width: 100%;
    text-align: left;
    padding: 12px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
  }
  @media (hover: hover) {
    li button:hover {
      background: var(--papyrus-wash);
    }
  }
  .name {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
  }
  .desc,
  .when {
    font-size: var(--small);
    color: var(--graphite);
  }
  .warn {
    font-size: var(--small);
    color: var(--amber);
  }
  .none {
    padding: 12px 8px;
  }
</style>
