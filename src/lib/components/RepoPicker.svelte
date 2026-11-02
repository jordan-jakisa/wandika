<script lang="ts">
  import { Lock, Globe, Plus } from "@lucide/svelte";
  import { api } from "../api";
  import { ago, app } from "../app.svelte";
  import type { Repo } from "../types";

  let repos = $state<Repo[] | null>(null);
  let filter = $state("");
  let error = $state<string | null>(null);
  let opening = $state<string | null>(null);
  let newName = $state("notes");
  let creating = $state(false);

  $effect(() => {
    api
      .reposList()
      .then((r) => (repos = r))
      .catch((e) => (error = (e as Error).message));
  });

  const shown = $derived(
    (repos ?? []).filter((r) => r.full_name.toLowerCase().includes(filter.trim().toLowerCase())),
  );

  async function open(owner: string, repo: string) {
    opening = `${owner}/${repo}`;
    error = null;
    try {
      await app.enterVault(await api.vaultOpen(owner, repo));
    } catch (e) {
      error = (e as Error).message;
      opening = null;
    }
  }

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

<main class="picker">
  <div class="column">
    {#if opening}
      <h1>Opening {opening}</h1>
      <p class="muted" role="status">Downloading your notes. Large vaults take a minute the first time.</p>
    {:else}
      <h1>Choose a repository for your notes</h1>
      <p class="muted">Wandika keeps every note as a Markdown file in this repository. A private one is best.</p>

      <form class="create" onsubmit={create}>
        <label for="new-repo">New private repository</label>
        <div class="create-row">
          <input id="new-repo" class="field" bind:value={newName} autocapitalize="off" spellcheck="false" />
          <button class="btn primary" disabled={creating || !newName.trim()}>
            <Plus size={16} />
            {creating ? "Creating…" : "Create and open"}
          </button>
        </div>
      </form>

      <label class="sr-only" for="repo-filter">Filter repositories</label>
      <input id="repo-filter" class="field" type="search" bind:value={filter} placeholder="Filter your repositories" />

      {#if error}<p class="error" role="alert">{error}</p>{/if}

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
            <li class="muted none">No repositories match “{filter}”.</li>
          {/each}
        </ul>
      {/if}

      <button class="btn quiet" onclick={() => app.signOut()}>Sign out of GitHub</button>
    {/if}
  </div>
</main>

<style>
  .picker {
    min-height: 100dvh;
    padding: calc(40px + var(--safe-top)) max(20px, var(--safe-right)) calc(32px + var(--safe-bottom))
      max(20px, var(--safe-left));
  }
  .column {
    max-width: 560px;
    margin: 0 auto;
    display: grid;
    gap: 14px;
  }
  h1 {
    margin: 0;
    font-family: var(--font-note);
    font-size: clamp(1.6rem, 6vw, 2.1rem);
    font-weight: 620;
    line-height: 1.2;
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
    border-top: 1px solid var(--rule);
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
  li button:hover {
    background: var(--papyrus-wash);
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
  .quiet {
    justify-self: start;
    border-color: transparent;
    background: none;
    padding: 0;
    color: var(--graphite);
  }
</style>
