<script lang="ts">
  import { Lock, Globe, ExternalLink, RefreshCw } from "@lucide/svelte";
  import { untrack } from "svelte";
  import { api, openUrl } from "../api";
  import { ago, app, progressText } from "../app.svelte";
  import type { Repo } from "../types";

  /** `open`: use a repository as a vault. `connect`: sync the open local vault with one. */
  let { mode = "open", ondone }: { mode?: "open" | "connect"; ondone?: () => void } = $props();

  let repos = $state<Repo[] | null>(null);
  let filter = $state("");
  let error = $state<string | null>(null);
  let opening = $state<string | null>(null);
  let newName = $state("notes");
  let loading = $state(false);
  /** The name of a repository being made on GitHub: it opens as soon as Wandika can see it. */
  let waitingFor = $state<string | null>(null);

  function loadRepos() {
    if (loading) return;
    loading = true;
    error = null;
    api
      .reposList()
      .then((r) => {
        repos = r;
        const made = waitingFor && r.find((x) => x.name.toLowerCase() === waitingFor!.toLowerCase());
        if (made) {
          waitingFor = null;
          void open(made.owner.login, made.name);
          return;
        }
        if (waitingFor) return;
        // Suggest a name that isn't taken yet: notes, notes-2, notes-3…
        const taken = new Set(r.map((x) => x.name.toLowerCase()));
        if (taken.has(newName.toLowerCase())) {
          let n = 2;
          while (taken.has(`notes-${n}`)) n++;
          newName = `notes-${n}`;
        }
      })
      .catch((e) => (error = (e as Error).message))
      .finally(() => (loading = false));
  }
  // Once, when the picker opens (loadRepos reads state that must not make this run again).
  $effect(() => untrack(loadRepos));

  // Coming back from GitHub in the browser: look again, so a repository just made or shared shows up.
  $effect(() => {
    const back = () => {
      if (document.visibilityState === "visible" && !untrack(() => opening)) loadRepos();
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  });

  const nameOk = $derived(/^[A-Za-z0-9._-]+$/.test(newName.trim()));
  const nameTaken = $derived(!!repos?.some((r) => r.name.toLowerCase() === newName.trim().toLowerCase()));

  /** Where people choose which repositories the Wandika GitHub App may use. */
  const accessUrl = $derived.by(() => {
    const slug = app.status?.configured.github_app;
    return slug ? `https://github.com/apps/${slug}/installations/new` : "https://github.com/settings/installations";
  });

  /** GitHub can't let an app make a repository in a personal account, so GitHub's own page does it. */
  function createOnGitHub() {
    const name = newName.trim();
    const q = new URLSearchParams({ name, visibility: "private", description: "Notes kept with Wandika" });
    waitingFor = name;
    void openUrl(`https://github.com/new?${q}`);
  }

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

    <section class="create" aria-labelledby="new-repo-title">
      <h3 id="new-repo-title">New private repository</h3>
      <label for="new-repo">Repository name</label>
      <input id="new-repo" class="field" bind:value={newName} autocapitalize="off" spellcheck="false" disabled={!!waitingFor} />
      {#if nameTaken && !waitingFor}
        <p class="muted small">You already have “{newName.trim()}”. Pick it from the list below, or choose another name.</p>
      {:else if newName.trim() && !nameOk}
        <p class="muted small">Use letters, numbers, dashes, dots or underscores.</p>
      {/if}
      <ol class="steps">
        <li>
          <button class="btn primary" onclick={createOnGitHub} disabled={!nameOk || nameTaken || !!waitingFor}>
            <ExternalLink size={16} /> Create it on GitHub
          </button>
          <span class="muted small">GitHub opens with the name filled in. Press Create repository there.</span>
        </li>
        <li>
          <button class="btn" onclick={() => openUrl(accessUrl)}>
            <ExternalLink size={16} /> Give Wandika access
          </button>
          <span class="muted small">Choose “Only select repositories” and pick the new one. Wandika sees nothing else.</span>
        </li>
      </ol>
      {#if waitingFor}
        <p class="muted small" role="status">
          Waiting for “{waitingFor}”. It opens here as soon as Wandika has access.
          <button class="link" onclick={() => (waitingFor = null)}>Cancel</button>
        </p>
      {/if}
    </section>

    <div class="list-head">
      <label class="sr-only" for="repo-filter">Filter repositories</label>
      <input id="repo-filter" class="field" type="search" bind:value={filter} placeholder="Or pick a repository" />
      <button class="icon-btn" onclick={loadRepos} disabled={loading} aria-label="Refresh the list">
        <RefreshCw size={16} />
      </button>
    </div>

    {#if error}
      <p class="error" role="alert">{error}</p>
      {#if repos === null}<button class="btn" onclick={loadRepos}>Try again</button>{/if}
    {/if}

    {#if repos === null && !error}
      <p class="muted" role="status">Loading your repositories…</p>
    {:else if repos}
      <ul aria-label="Repositories">
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
            {filter.trim() ? `No repositories match “${filter.trim()}”.` : "Wandika can't use any of your repositories yet. Create one above, or give it access to one you have."}
          </li>
        {/each}
      </ul>
      {#if hidden > 0}
        <p class="muted more">
          {hidden === 1 ? "1 more repository." : `${hidden} more repositories.`} Type its name above to find it.
        </p>
      {/if}
      <p class="muted more">
        Not listed? <button class="link" onclick={() => openUrl(accessUrl)}>Give Wandika access to it on GitHub</button>, then come back.
      </p>
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
  .small {
    font-size: var(--small);
  }
  h3 {
    margin: 0;
    font-size: inherit;
  }
  .steps {
    display: grid;
    gap: 10px;
    margin: 6px 0 0;
    padding-left: 1.4em;
  }
  .steps li {
    display: grid;
    justify-items: start;
    gap: 4px;
  }
  .list-head {
    display: flex;
    gap: 8px;
  }
  .list-head .field {
    flex: 1;
  }
  .link {
    border: 0;
    padding: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
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
    font-size: var(--small);
    color: var(--graphite);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  ul li + li {
    border-top: 1px solid var(--hairline);
  }
  ul li button {
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
    ul li button:hover {
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
