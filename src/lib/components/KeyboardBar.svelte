<script lang="ts">
  import type { EditorView } from "@codemirror/view";
  import {
    Hash,
    Heading,
    ImagePlus,
    KeyboardOff,
    Link,
    List,
    ListChecks,
    ListIndentDecrease,
    ListIndentIncrease,
    PenLine,
    Redo2,
    Undo2,
  } from "@lucide/svelte";
  import type { Component } from "svelte";
  import * as w from "../editor/writing";

  /** The writing toolbar that sits on top of the phone keyboard while a note is being edited. */
  let { view, onImage, onDrawing }: { view: () => EditorView | null; onImage: () => void; onDrawing?: () => void } = $props();

  /** `picker` buttons open a system picker, so the note gives up focus for it. */
  type Button = { label: string; icon: Component<any>; run: (v: EditorView) => boolean; picker?: boolean };
  const BUTTONS = $derived<Button[]>([
    { label: "Link to a note", icon: Link, run: w.link },
    { label: "Tag", icon: Hash, run: w.tag },
    { label: "Add image", icon: ImagePlus, run: () => (onImage(), true), picker: true },
    ...(onDrawing ? [{ label: "Add drawing", icon: PenLine, run: () => (onDrawing(), true), picker: true }] : []),
    { label: "Checklist", icon: ListChecks, run: (v) => w.lines(v, "task") },
    { label: "Heading", icon: Heading, run: w.heading },
    { label: "Bulleted list", icon: List, run: (v) => w.lines(v, "bullet") },
    { label: "Indent", icon: ListIndentIncrease, run: w.indentItem },
    { label: "Outdent", icon: ListIndentDecrease, run: w.outdentItem },
    { label: "Undo", icon: Undo2, run: w.undo },
    { label: "Redo", icon: Redo2, run: w.redo },
  ]);

  // iOS keeps the page height when the keyboard opens, so the bar follows the visible viewport.
  // Android resizes the page (interactive-widget=resizes-content) and the offset stays 0.
  let lift = $state(0);
  $effect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const place = () => (lift = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    place();
    vv.addEventListener("resize", place);
    vv.addEventListener("scroll", place);
    return () => {
      vv.removeEventListener("resize", place);
      vv.removeEventListener("scroll", place);
    };
  });

  function press(e: Event, b: (typeof BUTTONS)[number]) {
    const v = view();
    if (!v) return;
    b.run(v);
    if (!b.picker) v.focus();
    e.preventDefault();
  }
</script>

<!-- pointerdown is cancelled so a tap never takes focus from the note and the keyboard stays up. -->
<div
  class="kbar"
  class:lifted={lift > 0}
  role="toolbar"
  aria-label="Writing tools"
  tabindex="-1"
  style="--lift: {lift}px"
  onpointerdown={(e) => e.preventDefault()}
  onmousedown={(e) => e.preventDefault()}
>
  <div class="tools">
    {#each BUTTONS as b (b.label)}
      <button aria-label={b.label} title={b.label} onclick={(e) => press(e, b)}><b.icon size={21} /></button>
    {/each}
  </div>
  <button class="hide" aria-label="Hide keyboard" title="Hide keyboard" onclick={() => view()?.contentDOM.blur()}>
    <KeyboardOff size={21} />
  </button>
</div>

<style>
  .kbar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    transform: translateY(calc(-1 * var(--lift)));
    z-index: 20;
    display: flex;
    align-items: center;
    height: calc(48px + var(--safe-bottom));
    padding: 0 max(4px, var(--safe-right)) var(--safe-bottom) max(4px, var(--safe-left));
    border-top: 1px solid var(--hairline);
    background: var(--paper);
  }
  .kbar.lifted {
    height: 48px;
    padding-bottom: 0;
  }
  .tools {
    flex: 1;
    display: flex;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tools::-webkit-scrollbar {
    display: none;
  }
  button {
    flex: none;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--ink);
  }
  button:active {
    background: var(--press);
  }
  .hide {
    border-left: 1px solid var(--hairline);
    border-radius: 0;
    width: 52px;
    color: var(--graphite);
  }
</style>
