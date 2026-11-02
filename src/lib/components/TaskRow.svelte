<script lang="ts">
  import { app } from "../app.svelte";
  import { clock } from "../clock.svelte";
  import { duration } from "../motion";
  let {
    text,
    done,
    due = null,
    where,
    onToggle,
    onOpen,
    leaves = false,
  }: {
    text: string;
    done: boolean;
    due?: string | null;
    where: string;
    onToggle: () => Promise<void>;
    onOpen?: () => void;
    /** The list hides done tasks: a ticked one shows its strike-through, then folds away. */
    leaves?: boolean;
  } = $props();
  let leaving = $state(false);

  let busy = $state(false);
  /** Ticks at once; a failed change puts the box back and says why. */
  let shown = $state<boolean | null>(null);
  const checked = $derived(shown ?? done);
  const today = $derived(clock.today);
  const overdue = $derived(!!due && due < today && !done);
  // Plain words for the list: dates move to the meta line, Markdown marks go.
  const label = $derived(
    text
      .replace(/\s*📅\s?\d{4}-\d{2}-\d{2}/, "")
      .replace(/\s*✅ \d{4}-\d{2}-\d{2}/, "")
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|\*|_|~~|`)(.+?)\1/g, "$2")
      .trim(),
  );

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function toggle() {
    busy = true;
    shown = !checked;
    if (shown) (navigator as { vibrate?: (ms: number) => boolean }).vibrate?.(10);
    try {
      if (shown && leaves) {
        // A moment to see it done; a pause, not motion, so it stays with reduced motion too.
        await wait(600);
        leaving = true;
        await wait(duration("--dur-base"));
      }
      await onToggle();
    } catch (e) {
      shown = null;
      leaving = false;
      app.say(`Couldn't update that task. ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  }
  // Once the list reloads with the new state, the row follows it again.
  $effect(() => {
    void done;
    shown = null;
  });
</script>

<li class="task" class:done={checked} class:leaving>
  <label class="box"><input type="checkbox" {checked} disabled={busy} onchange={toggle} aria-label={label} /></label>
  <div class="body">
    <span class="text">{label}</span>
    <span class="meta">
      {#if due}<span class:overdue class:due-today={due === today}>{due === today ? "Today" : overdue ? `Overdue, ${due}` : due}</span>{/if}
      {#if onOpen}
        <button class="where" onclick={onOpen}>{where}</button>
      {:else}
        <span>{where}</span>
      {/if}
    </span>
  </div>
</li>

<style>
  .task {
    max-height: 12em;
    transition:
      max-height var(--dur-base) var(--ease-in),
      opacity var(--dur-base) var(--ease-in),
      padding var(--dur-base) var(--ease-in);
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 8px 0;
  }
  input {
    width: 18px;
    height: 18px;
    margin: 2px 0 0;
    accent-color: var(--papyrus);
    flex: none;
  }
  .box {
    position: relative;
    display: flex;
    flex: none;
  }
  @media (pointer: coarse) {
    input {
      width: 22px;
      height: 22px;
    }
    /* A 44px tap area around the box, the box itself stays small. */
    .box::after {
      content: "";
      position: absolute;
      inset: -11px;
    }
  }
  .body {
    min-width: 0;
    display: grid;
    gap: 1px;
    overflow-wrap: anywhere;
  }
  .done .text {
    color: var(--graphite);
    text-decoration: line-through;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0 10px;
    font-size: var(--small);
    color: var(--graphite);
  }
  .where {
    border: 0;
    background: none;
    padding: 0;
    color: var(--graphite);
    font-size: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  @media (hover: hover) {
    .where:hover {
      color: var(--papyrus);
    }
  }
  .overdue {
    color: var(--alarm);
  }
  .due-today {
    color: var(--amber);
    font-weight: 600;
  }
  .leaving {
    max-height: 0;
    padding-block: 0;
    opacity: 0;
    overflow: hidden;
  }
  .text {
    transition: color var(--dur-quick) var(--ease-out);
  }
</style>
