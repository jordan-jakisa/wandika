<script lang="ts">
  import { Link2, Lock, TriangleAlert } from "@lucide/svelte";
  import { app, titleOf } from "../app.svelte";
  import SyncStatus from "./SyncStatus.svelte";

  const stats = $derived(app.current ? app.noteStats : null);
  const n = (x: number) => x.toLocaleString();
</script>

<footer class="status" aria-label="Status">
  <div class="left">
    <SyncStatus />
    {#if app.conflicts.length}
      <button class="item warn" onclick={() => app.open(app.conflicts[0])} title={app.conflicts.map(titleOf).join(", ")}>
        <TriangleAlert size={12} />
        {app.conflicts.length} {app.conflicts.length === 1 ? "conflict" : "conflicts"}
      </button>
    {/if}
  </div>
  {#if stats}
    <div class="right">
      {#if app.vimMode}<span class="item vim" aria-label={`Vim: ${app.vimMode} mode`}>{app.vimMode.toUpperCase()}</span>{/if}
      {#if stats.encrypted}<span class="item"><Lock size={12} /> Encrypted</span>{/if}
      {#if stats.backlinks}<span class="item"><Link2 size={12} /> Linked from {n(stats.backlinks)}</span>{/if}
      {#if stats.cards !== null}
        <span class="item">{n(stats.cards)} {stats.cards === 1 ? "card" : "cards"}</span>
      {:else}
        <span class="item">{n(stats.words)} {stats.words === 1 ? "word" : "words"}</span>
        <span class="item">{n(stats.chars)} characters</span>
      {/if}
    </div>
  {/if}
</footer>

<style>
  .status {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    height: 26px;
    padding: 0 12px;
    border-top: 1px solid var(--rule);
    background: var(--paper);
    font-size: var(--text-xs);
    color: var(--graphite);
    white-space: nowrap;
    overflow: hidden;
  }
  .left,
  .right {
    display: flex;
    align-items: center;
    gap: 16px;
    min-width: 0;
  }
  /* Vim's mode, as a Vim user looks for it: short, in capitals. */
  .vim {
    font-family: var(--font-code);
    color: var(--ink);
  }
  .status :global(.sync) {
    font-size: var(--text-xs);
  }
  .item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-variant-numeric: tabular-nums;
  }
  button.item {
    border: 0;
    background: none;
    padding: 0;
    font-size: inherit;
  }
  /* Conflicts need attention: alarm, as DESIGN.md says. Amber is for waiting and offline. */
  .warn {
    color: var(--alarm);
  }
  @media (hover: hover) {
    .warn:hover {
      color: var(--ink);
    }
  }
</style>
