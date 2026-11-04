<script lang="ts">
  import { touch } from "../tips";
  import { Eraser, Trash2, Undo2 } from "@lucide/svelte";
  import { api } from "../api";
  import { sheetOpened } from "../backstack";
  import { app } from "../app.svelte";
  import { forgetImages } from "../attachments";
  import { closeSheet } from "../motion";
  import { forgetNoteEmbeds } from "../editor/embeds";
  import { INKS, MUTED, PAPER, WIDTHS, drawingName, fromSvg, hits, pathOf, strokeWidth, toSvg, type Point, type Stroke } from "../sketch";

  /** The drawing pad: a pen, a finger or a mouse draws; Done saves the drawing as an SVG file. */
  let dialogEl: HTMLDialogElement;
  /** The drawing on screen; it stays while the pad leaves. */
  let shown = $state<typeof app.drawing>(null);
  /** Gives back the pad's place in history when it closes (phones). */
  let release = () => {};
  let padEl = $state<SVGSVGElement>();
  let strokes = $state<Stroke[]>([]);
  /** Earlier states of the drawing, for Undo. */
  let history = $state<Stroke[][]>([]);
  let live = $state<Stroke | null>(null);
  let ink = $state<string>(INKS[0].color);
  let width = $state<number>(WIDTHS[0].value);
  let erasing = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let loading = $state(false);
  /** Once a pen has touched the pad, fingers are a resting palm, not a brush. */
  let penSeen = false;
  let drawingWith: number | null = null;

  const changed = $derived(history.length > 0);

  $effect(() => {
    const d = app.drawing;
    if (d && !dialogEl.open) {
      shown = d;
      strokes = [];
      history = [];
      live = null;
      erasing = false;
      error = null;
      penSeen = false;
      dialogEl.showModal();
      release = sheetOpened(() => void cancel());
      if (d.edit) void load(d.edit.target, d.edit.from);
    } else if (!d && dialogEl.open && !dialogEl.classList.contains("closing")) {
      closeSheet(dialogEl, () => (shown = null));
      release();
      release = () => {};
    }
  });

  async function load(target: string, from: string) {
    loading = true;
    try {
      const text = new TextDecoder().decode(await api.attachmentRead(target, from));
      const found = fromSvg(text);
      if (!found) throw new Error("Only drawings made in Wandika can be changed here.");
      strokes = found;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  function at(e: PointerEvent): Point {
    const r = padEl!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top, e.pointerType === "pen" ? e.pressure || 0.5 : 0.5];
  }

  function remember() {
    history = [...history, strokes];
  }

  function eraseAt([x, y]: Point) {
    const kept = strokes.filter((s) => !hits(s, x, y, 10));
    if (kept.length !== strokes.length) strokes = kept;
  }

  function down(e: PointerEvent) {
    if (e.pointerType === "pen") penSeen = true;
    else if (e.pointerType === "touch" && penSeen) return;
    if (drawingWith !== null || e.button > 0) return;
    e.preventDefault();
    drawingWith = e.pointerId;
    padEl?.setPointerCapture?.(e.pointerId);
    remember();
    if (erasing) eraseAt(at(e));
    else live = { color: ink, width, points: [at(e)] };
  }

  function move(e: PointerEvent) {
    if (e.pointerId !== drawingWith) return;
    const events = (e.getCoalescedEvents?.() ?? []).length ? e.getCoalescedEvents() : [e];
    if (erasing) {
      for (const ev of events) eraseAt(at(ev));
    } else if (live) {
      live = { ...live, points: [...live.points, ...events.map(at)] };
    }
  }

  function up(e: PointerEvent) {
    if (e.pointerId !== drawingWith) return;
    drawingWith = null;
    if (live) {
      strokes = [...strokes, live];
      live = null;
    } else if (history.at(-1) === strokes) {
      // An eraser pass that touched nothing leaves no step to undo.
      history = history.slice(0, -1);
    }
  }

  function undo() {
    const last = history.at(-1);
    if (!last) return;
    strokes = last;
    history = history.slice(0, -1);
  }

  function clear() {
    if (!strokes.length) return;
    remember();
    strokes = [];
  }

  async function cancel() {
    if (changed) {
      const sure = await app.ask({
        title: "Discard this drawing?",
        message: "Your strokes will be lost.",
        confirm: "Discard",
        cancel: "Keep drawing",
        danger: true,
      });
      if (sure === null) return;
    }
    app.drawing = null;
  }

  async function done() {
    const d = app.drawing;
    if (!d) return;
    if (!changed) {
      app.drawing = null;
      return;
    }
    if (!strokes.length && !d.edit) {
      app.drawing = null;
      return;
    }
    saving = true;
    error = null;
    try {
      const svg = toSvg(strokes);
      if (d.edit) {
        await api.drawingWrite(d.edit.target, d.edit.from, svg);
        forgetImages();
        forgetNoteEmbeds();
        app.changed = { paths: d.edit.from ? [d.edit.from] : [], at: Date.now() };
      } else {
        const path = await api.attachmentSave(d.note, drawingName(), new Blob([svg], { type: "image/svg+xml" }));
        d.saved?.(path);
      }
      app.edited();
      void app.refreshFiles();
      app.drawing = null;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      saving = false;
    }
  }
</script>

<dialog
  bind:this={dialogEl}
  class="sketch rises"
  onkeydown={(e) => {
    // ⌘Z takes back the last stroke, as Undo does.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    }
  }}
  aria-labelledby="sketch-h"
  oncancel={(e) => {
    e.preventDefault();
    void cancel();
  }}
>
  {#if shown}
    <header class="bar">
      <button class="bar-btn" onclick={cancel}>Cancel</button>
      <h2 id="sketch-h">{shown.edit ? "Edit drawing" : "Drawing"}</h2>
      <span class="bar-end">
        <button class="tool" aria-label="Undo" disabled={!history.length} onclick={undo}><Undo2 size={20} /></button>
        <button class="bar-btn done" onclick={done} disabled={saving || loading}>Done</button>
      </span>
    </header>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <svg
      bind:this={padEl}
      class="pad"
      class:erasing
      style:background={PAPER}
      role="img"
      aria-label={strokes.length ? `Drawing with ${strokes.length} ${strokes.length === 1 ? "stroke" : "strokes"}` : "Empty drawing"}
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={up}
    >
      <g fill="none" stroke-linecap="round" stroke-linejoin="round">
        {#each strokes as s, i (i)}
          <path d={pathOf(s.points)} stroke={s.color} stroke-width={strokeWidth(s)} />
        {/each}
        {#if live}<path d={pathOf(live.points)} stroke={live.color} stroke-width={strokeWidth(live)} />{/if}
      </g>
    </svg>
    {#if !strokes.length && !live && !loading}
      <p class="hint" style:color={MUTED} aria-hidden="true">{touch ? "Draw with your pen or finger" : "Draw with your trackpad, mouse or pen"}</p>
    {/if}
    <div class="tools" role="toolbar" aria-label="Drawing tools">
      <div class="inks" role="radiogroup" aria-label="Ink">
        {#each INKS as i (i.color)}
          <button
            role="radio"
            class="ink"
            aria-label={i.label}
            aria-checked={!erasing && ink === i.color}
            style:--swatch={i.color}
            onclick={() => {
              ink = i.color;
              erasing = false;
            }}
          ></button>
        {/each}
      </div>
      <div class="segmented" role="radiogroup" aria-label="Line">
        {#each WIDTHS as w (w.value)}
          <button role="radio" aria-checked={width === w.value} class:on={width === w.value} onclick={() => (width = w.value)}>{w.label}</button>
        {/each}
      </div>
      <button class="tool" aria-label="Eraser" aria-pressed={erasing} class:on={erasing} onclick={() => (erasing = !erasing)}><Eraser size={20} /></button>
      <button class="tool" aria-label="Clear" disabled={!strokes.length} onclick={clear}><Trash2 size={20} /></button>
    </div>
  {/if}
</dialog>

<style>
  /* Full screen: the page is the drawing's paper, the bars sit at the edges. */
  .sketch[open] {
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr) auto;
    grid-template-columns: minmax(0, 1fr);
    width: 100vw;
    height: 100dvh;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
    border: 0;
    background: var(--paper);
    color: var(--ink);
    /* The Mac fades it in; phones raise it as a sheet (app.css). */
    animation: fade-in var(--dur-quick) var(--ease-out);

  }
  .bar {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 4px 8px;
  }
  h2 {
    grid-column: 2;
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
  }
  .bar-btn {
    justify-self: start;
    min-height: var(--target);
    padding: 0 var(--space-3);
    border: 0;
    background: none;
    color: var(--papyrus);
    font-size: var(--text-md);
  }
  .bar-end {
    grid-column: 3;
    justify-self: end;
    display: flex;
    align-items: center;
  }
  .bar-btn.done {
    font-weight: 600;
  }
  .bar-btn:disabled {
    opacity: 0.4;
  }
  .error {
    grid-row: 2;
    margin: 0 var(--space-4);
  }
  /* The drawing always shows on its paper colour, as the saved file does in every app. */
  .pad {
    grid-area: 3 / 1;
    width: calc(100% - 2 * var(--space-3));
    height: 100%;
    margin: 0 var(--space-3);
    border-radius: var(--radius-lg);
    touch-action: none;
    cursor: crosshair;
  }
  .pad.erasing {
    cursor: cell;
  }
  .hint {
    grid-area: 3 / 1;
    place-self: center;
    margin: 0;
    pointer-events: none;
  }
  .tools {
    grid-row: 4;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
  }
  .inks {
    display: flex;
    gap: var(--space-2);
  }
  .ink {
    position: relative;
    width: 30px;
    height: 30px;
    border: 2px solid var(--paper);
    border-radius: 50%;
    background: var(--swatch);
    /* A ring, so the black ink still shows on the dark theme's page. */
    box-shadow: 0 0 0 1.5px var(--graphite);
  }
  .ink[aria-checked="true"] {
    box-shadow: 0 0 0 2px var(--ink);
  }
  .ink::after {
    content: "";
    position: absolute;
    inset: -7px;
  }
  .tool {
    display: grid;
    place-items: center;
    width: var(--target);
    height: var(--target);
    border: 0;
    border-radius: var(--radius-md);
    background: none;
    color: var(--ink);
  }
  .tool.on {
    background: var(--press);
    color: var(--papyrus);
  }
  .tool:disabled {
    opacity: 0.35;
  }
  @media (prefers-reduced-motion: reduce) {
    .sketch[open] {
      animation: none;
    }
  }
</style>
