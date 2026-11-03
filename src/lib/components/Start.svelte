<script lang="ts">
  import { Cloud, FolderOpen, HardDrive, Trash2 } from "@lucide/svelte";
  import { api, canPickFolder, pickFolder } from "../api";
  import { app } from "../app.svelte";
  import type { VaultConfig } from "../types";
  import GitHubSignIn from "./GitHubSignIn.svelte";
  import Mark from "./Mark.svelte";
  import Menu from "./Menu.svelte";
  import RepoPicker from "./RepoPicker.svelte";

  let name = $state("Notes");
  let busy = $state(false);
  let error = $state<string | null>(null);
  const known = $derived(app.status?.known ?? []);

  async function run(fn: () => Promise<void>) {
    busy = true;
    error = null;
    try {
      await fn();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  const createLocal = (e: SubmitEvent) => {
    e.preventDefault();
    return run(async () => {
      await api.vaultCreateLocal(name);
      await app.enterVault();
    });
  };

  const useFolder = () =>
    run(async () => {
      const folder = await pickFolder();
      if (!folder) return;
      await api.vaultCreateLocal("", folder);
      await app.enterVault();
    });

  const reopen = (v: VaultConfig) =>
    run(async () => {
      await api.vaultSwitch(v.id);
      await app.enterVault();
      void app.sync();
    });

  async function forget(v: VaultConfig) {
    const ok = await app.ask({
      title: `Remove “${v.name}” from this list?`,
      message: v.folder
        ? `The folder ${v.folder} and its notes stay where they are.`
        : "Its notes stay on this device and on GitHub; open it again any time.",
      confirm: "Remove from list",
    });
    if (ok === null) return;
    await run(async () => {
      await api.vaultForget(v.id);
      await app.refreshStatus();
    });
  }

  const where = (v: VaultConfig) =>
    v.remote ? `Syncs with ${v.remote.owner}/${v.remote.repo}` : v.folder ? v.folder : "On this device only";
</script>

<main class="start">
  <div class="column">
    <h1 class="wordmark"><Mark size={44} /> Wandika</h1>
    <p class="lead">Notes as plain Markdown files. Keep them on this device, or sync them through a GitHub repository.</p>

    {#if known.length}
      <section aria-labelledby="known-h">
        <h2 id="known-h">Your vaults</h2>
        <ul class="known">
          {#each known as v (v.id)}
            <li>
              <button class="vault-row" onclick={() => reopen(v)} disabled={busy}>
                {#if v.remote}<Cloud size={16} />{:else if v.folder}<FolderOpen size={16} />{:else}<HardDrive size={16} />{/if}
                <span class="grow">
                  <span class="name">{v.name}</span>
                  <span class="meta">{where(v)}</span>
                </span>
              </button>
              <Menu label={`Actions for ${v.name}`} size={16}>
                <button role="menuitem" onclick={() => forget(v)}><Trash2 size={16} /> Remove from list</button>
              </Menu>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <section aria-labelledby="gh-h">
      <h2 id="gh-h">Sync with GitHub</h2>
      {#if !app.status?.user}
        <p class="muted">Every device you sign in on stays in sync through a repository you choose.</p>
        <GitHubSignIn />
      {:else}
        <RepoPicker mode="open" />
        <button class="btn quiet" onclick={() => run(() => app.signOut())} disabled={busy}>Sign out of GitHub ({app.status.user.login})</button>
      {/if}
    </section>

    <section aria-labelledby="local-h">
      <h2 id="local-h">Keep notes on this device</h2>
      <p class="muted">No account needed. You can connect the vault to GitHub later in Settings.</p>
      <form class="create" onsubmit={createLocal}>
        <label class="sr-only" for="vault-name">Vault name</label>
        <input id="vault-name" class="field" bind:value={name} placeholder="Vault name" />
        <button class="btn" disabled={busy || !name.trim()}>Create vault</button>
      </form>
      {#if canPickFolder}
        <button class="btn quiet" onclick={useFolder} disabled={busy}>
          <FolderOpen size={16} /> Open a folder, such as an Obsidian vault or a local git repository
        </button>
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </section>
  </div>
</main>

<style>
  .start {
    min-height: 100dvh;
    padding: calc(48px + var(--safe-top)) max(20px, var(--safe-right)) calc(40px + var(--safe-bottom))
      max(20px, var(--safe-left));
  }
  .column {
    max-width: 560px;
    margin: 0 auto;
    display: grid;
    gap: 32px;
  }
  .wordmark {
    display: flex;
    align-items: center;
    gap: 14px;
    margin: 0 0 -16px;
    font-family: var(--font-ui);
    font-size: clamp(2.2rem, 9vw, 2.75rem);
    font-weight: 650;
    letter-spacing: -0.03em;
    line-height: 1;
  }
  .lead {
    margin: 0;
    font-size: var(--text-lg);
    line-height: 1.55;
    color: var(--graphite);
  }
  section {
    display: grid;
    gap: 12px;
    justify-items: start;
  }
  section > :global(*) {
    width: 100%;
  }
  section > :global(.btn) {
    width: auto;
  }
  h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 650;
  }
  p {
    margin: 0;
  }
  .create {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .create .field {
    flex: 1 1 200px;
  }
  .known {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .known li {
    display: flex;
    align-items: center;
  }
  .known li + li {
    border-top: 1px solid var(--rule);
  }
  .vault-row {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--graphite);
    text-align: left;
  }
  @media (hover: hover) {
    .vault-row:hover {
      background: var(--papyrus-wash);
    }
  }
  .grow {
    flex: 1;
    min-width: 0;
    display: grid;
  }
  .name {
    color: var(--ink);
    font-weight: 600;
  }
  .meta {
    font-size: var(--small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .quiet {
    padding: 0;
    white-space: normal;
    text-align: left;
  }
</style>
