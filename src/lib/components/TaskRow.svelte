<script lang="ts">
  import { Mail, Pencil, Pin, PinOff, Timer } from "@lucide/svelte";
  import { app } from "../app.svelte";
  import { mailRef } from "../mailLinks";
  import { parseTask, PRIORITIES } from "../taskText";
  import Menu from "./Menu.svelte";
  import { clock } from "../clock.svelte";
  import { duration } from "../motion";
  let {
    text,
    done,
    due = null,
    where,
    onToggle,
    onOpen,
    onEdit,
    onPin,
    onFocus,
    details = "",
    leaves = false,
  }: {
    text: string;
    done: boolean;
    due?: string | null;
    where: string;
    onToggle: () => Promise<void>;
    onOpen?: () => void;
    /** Opens the task editor (vault tasks). */
    onEdit?: () => void;
    /** Pins or unpins the task (vault tasks). */
    onPin?: () => Promise<void>;
    /** Starts a focus session on the task. */
    onFocus?: () => void;
    /** The notes under the task; the first line shows under it. */
    details?: string;
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
  const parts = $derived(parseTask(text));
  const urgent = $derived(parts.priority === "highest" || parts.priority === "high");
  const priorityLabel = $derived(PRIORITIES.find((p) => p.value === parts.priority)?.label);
  const firstNote = $derived(details.split("\n")[0] ?? "");
  /** A task made from an email links back to it; the email opens in Wandika. */
  const email = $derived([...text.matchAll(/\]\((https?:[^)\s]+)\)/g)].map((m) => m[1]).find((u) => mailRef(u)));
  // Plain words for the list: markers move to the meta line, the email link to "Open email", Markdown marks go.
  const label = $derived(
    parts.name
      .replace(/\s*\[[^\]]*\]\((https?:[^)\s]+)\)/g, (all, url: string) => (mailRef(url) ? "" : all))
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

<li class="task" class:done={checked} class:leaving class:pinned={parts.pinned}>
  <label class="box"><input type="checkbox" {checked} disabled={busy} onchange={toggle} aria-label={label} /></label>
  <div class="body">
    {#if onEdit}
      <button class="text edit" onclick={onEdit}>{#if parts.pinned}<Pin size={14} aria-label="Pinned" />{/if}{label}</button>
    {:else}
      <span class="text">{#if parts.pinned}<Pin size={14} aria-label="Pinned" />{/if}{label}</span>
    {/if}
    {#if firstNote}<span class="note">{firstNote}</span>{/if}
    <span class="meta">
      {#if priorityLabel}<span class:urgent>{priorityLabel} priority</span>{/if}
      {#if email}<button class="where" onclick={() => app.openLink(email)}>Open email</button>{/if}
      {#if due}<span class:overdue class:due-today={due === today}>{due === today ? "Today" : overdue ? `Overdue, ${due}` : due}</span>{/if}
      {#if onOpen}
        <button class="where" onclick={onOpen}>{where}</button>
      {:else}
        <span>{where}</span>
      {/if}
    </span>
  </div>
  {#if onEdit || onPin || onFocus}
    <span class="actions">
      <Menu label={`Actions for ${label}`} size={16}>
        {#if onEdit}<button role="menuitem" onclick={onEdit}><Pencil size={18} /> Edit</button>{/if}
        {#if onPin}
          <button role="menuitem" onclick={() => onPin().catch((e) => app.say((e as Error).message))}>
            {#if parts.pinned}<PinOff size={18} /> Unpin{:else}<Pin size={18} /> Pin to top{/if}
          </button>
        {/if}
        {#if onFocus && !checked}<button role="menuitem" onclick={onFocus}><Timer size={18} /> Focus on this</button>{/if}
        {#if email}<button role="menuitem" onclick={() => app.openLink(email)}><Mail size={18} /> Open email</button>{/if}
      </Menu>
    </span>
  {/if}
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
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 1px;
    overflow-wrap: anywhere;
  }
  .text {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
  }
  .text :global(svg) {
    flex: none;
    align-self: center;
    color: var(--papyrus);
  }
  .edit {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    overflow-wrap: anywhere;
  }
  @media (hover: hover) {
    .edit:hover {
      color: var(--papyrus);
    }
  }
  .note {
    font-size: var(--small);
    color: var(--graphite);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .urgent {
    color: var(--alarm);
  }
  .actions {
    margin-left: auto;
    flex: none;
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
