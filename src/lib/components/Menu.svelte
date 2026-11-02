<script lang="ts">
  import { Ellipsis } from "@lucide/svelte";
  import type { Snippet } from "svelte";

  let { label, children, size = 18 }: { label: string; children: Snippet; size?: number } = $props();
  let open = $state(false);
  let root: HTMLDivElement;

  function onWindowPointer(e: PointerEvent) {
    if (open && !root.contains(e.target as Node)) open = false;
  }

  function onKey(e: KeyboardEvent) {
    if (!open) return;
    const items = [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      open = false;
      root.querySelector<HTMLElement>(".trigger")?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    }
  }

  $effect(() => {
    if (open) queueMicrotask(() => root.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
  });
</script>

<svelte:window onpointerdown={onWindowPointer} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="menu" bind:this={root} onkeydown={onKey}>
  <button
    class="icon-btn trigger"
    aria-label={label}
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={(e) => {
      e.stopPropagation();
      open = !open;
    }}
  >
    <Ellipsis {size} />
  </button>
  {#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="list" role="menu" tabindex="-1" onclick={() => (open = false)}>
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .menu {
    position: relative;
  }
  .list {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    min-width: 200px;
    padding: 6px;
    background: var(--sheet);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.12);
    z-index: 30;
  }
  .list :global([role="menuitem"]) {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 38px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    text-align: left;
    white-space: nowrap;
  }
  .list :global([role="menuitem"]:hover),
  .list :global([role="menuitem"]:focus) {
    background: var(--papyrus-wash);
    outline: none;
  }
  .list :global(.danger) {
    color: var(--alarm);
  }
  @media (pointer: coarse) {
    .list :global([role="menuitem"]) {
      min-height: var(--target);
    }
  }
</style>
