<script lang="ts">
  import { Ellipsis } from "@lucide/svelte";
  import type { Snippet } from "svelte";

  /** `open` is bindable so a long press on the row can open the same menu. */
  let {
    label,
    children,
    size = 18,
    open = $bindable(false),
  }: { label: string; children: Snippet; size?: number; open?: boolean } = $props();
  let root: HTMLDivElement;

  // Only an open menu listens for taps outside it; a long list of closed menus costs nothing.
  $effect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.contains(e.target as Node)) open = false;
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  });

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

  /** Opened from the keyboard (Enter or Space): the first item takes focus, as menus do. A tap or
   * click leaves focus alone, so nothing looks pressed before you choose. */
  let fromKeyboard = false;
  $effect(() => {
    if (open && fromKeyboard) queueMicrotask(() => root.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="menu"
  bind:this={root}
  onkeydown={onKey}
  onfocusout={(e) => {
    // Tab out of the menu closes it; focus leaving the window (no new target) doesn't.
    if (open && e.relatedTarget && !root.contains(e.relatedTarget as Node)) open = false;
  }}
>
  <button
    class="icon-btn trigger"
    aria-label={label}
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={(e) => {
      e.stopPropagation();
      fromKeyboard = e.detail === 0;
      open = !open;
    }}
  >
    <Ellipsis {size} />
  </button>
  {#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="list"
      role="menu"
      tabindex="-1"
      onclick={() => {
        open = false;
        // Focus goes back to the ⋯ button, unless the choice moved it (a dialog, a field).
        setTimeout(() => {
          const at = document.activeElement;
          if (!at || at === document.body || root?.contains(at)) root?.querySelector<HTMLElement>(".trigger")?.focus();
        });
      }}
    >
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
    box-shadow: var(--shadow-pop);
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
  .list :global([role="menuitem"]:focus-visible) {
    background: var(--papyrus-wash);
    outline: none;
  }
  @media (hover: hover) {
    .list :global([role="menuitem"]:hover) {
      background: var(--papyrus-wash);
    }
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
