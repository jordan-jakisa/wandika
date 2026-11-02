<script lang="ts">
  import { Maximize, SlidersHorizontal } from "@lucide/svelte";
  import { onDestroy, untrack } from "svelte";
  import { app } from "../app.svelte";
  import { buildGraph, type GLink, type GNode } from "../graph";
  import { ACCENTS, prefs } from "../prefs.svelte";

  let canvas: HTMLCanvasElement;
  let box: HTMLDivElement;
  let filter = $state("");
  // svelte-ignore state_referenced_locally
  let local = $state(app.graphLocal && !!app.graphFocus);
  let ghosts = $state(false);
  let orphans = $state(true);
  let byFolder = $state(true);
  let panel = $state(false);
  /** Display settings, like Obsidian's graph sliders. */
  let dotSize = $state(1);
  let linkDistance = $state(50);
  let repel = $state(110);
  let depth = $state(1);
  /** Folders in colour order, biggest first; the legend and the dots share it. */
  let groups = $state<{ name: string; count: number; color: string }[]>([]);
  let spotlight = $state<string | null>(null);
  let counts = $state({ nodes: 0, links: 0 });
  let loadError = $state<string | null>(null);

  // World-to-screen transform.
  let view = { x: 0, y: 0, k: 1 };
  let nodes: GNode[] = [];
  let links: GLink[] = [];
  let neighbours = new Map<string, Set<string>>();
  let hover: GNode | null = null;
  let sim: { stop(): void; alpha(a: number): any; alphaTarget(a: number): any; restart(): any } | null = null;
  let frame = 0;
  let colors = { node: "", ghost: "", line: "", accent: "", text: "", bg: "", dim: "" };
  let groupColor = new Map<string, string>();
  let hubs = new Set<string>();
  let width = 0;
  let height = 0;
  let fitted = false;
  /** Set once the view is panned or zoomed, so the layout stops re-fitting it. */
  let touched = false;

  function readColors() {
    const css = getComputedStyle(document.documentElement);
    const v = (n: string) => css.getPropertyValue(n).trim();
    colors = { node: v("--graphite"), ghost: v("--rule"), line: v("--rule"), accent: v("--papyrus"), text: v("--ink"), bg: v("--sheet"), dim: v("--rule") };
    colourGroups();
  }

  /** The eight biggest folders get the accent palette plus amber and red; the rest stay grey. */
  function colourGroups() {
    const css = getComputedStyle(document.documentElement);
    const dark = prefs.mode === "dark";
    const palette = [
      ...ACCENTS.filter((a) => a.id !== "graphite").map((a) => (dark ? a.dark : a.light)),
      css.getPropertyValue("--amber").trim(),
      css.getPropertyValue("--alarm").trim(),
    ];
    const counts = new Map<string, number>();
    for (const n of nodes) if (!n.ghost) counts.set(n.group, (counts.get(n.group) ?? 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    groupColor = new Map();
    groups = ranked.slice(0, palette.length).map(([name, count], i) => {
      groupColor.set(name, palette[i]);
      return { name, count, color: palette[i] };
    });
  }

  const radius = (n: GNode) => (3 + Math.sqrt(n.degree) * 1.7) * dotSize;
  const fillOf = (n: GNode) => (byFolder ? (groupColor.get(n.group) ?? colors.node) : colors.node);

  function draw() {
    frame = 0;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);

    const lit = hover ? neighbours.get(hover.id) ?? new Set<string>() : null;
    const q = filter.trim().toLowerCase();
    const matches = (n: GNode) => (!q || n.title.toLowerCase().includes(q)) && (spotlight === null || n.group === spotlight);

    ctx.lineWidth = 1 / view.k;
    for (const l of links) {
      const s = l.source as GNode;
      const t = l.target as GNode;
      if (s.x == null || t.x == null) continue;
      const on = hover && (s === hover || t === hover);
      ctx.strokeStyle = on ? colors.accent : colors.node;
      ctx.globalAlpha = hover && !on ? 0.12 : q && !(matches(s) && matches(t)) ? 0.12 : on ? 1 : 0.45;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y!);
      ctx.lineTo(t.x, t.y!);
      ctx.stroke();
    }

    for (const n of nodes) {
      if (n.x == null) continue;
      const faded = (lit && n !== hover && !lit.has(n.id)) || !matches(n);
      ctx.globalAlpha = faded ? 0.2 : 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y!, radius(n), 0, Math.PI * 2);
      if (n.ghost) {
        ctx.strokeStyle = colors.node;
        ctx.stroke();
      } else {
        const focus = n.id === app.current || n.id === app.graphFocus;
        ctx.fillStyle = n === hover ? colors.accent : fillOf(n);
        ctx.fill();
        if (focus) {
          // The note you came from gets a ring, so it stands out in any colour scheme.
          ctx.lineWidth = 2 / view.k;
          ctx.strokeStyle = colors.text;
          ctx.beginPath();
          ctx.arc(n.x, n.y!, radius(n) + 3 / view.k, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 1 / view.k;
        }
      }
    }

    // Labels: the most-linked notes always, everyone else fading in as you zoom, plus whatever is
    // hovered or matched. A halo in the background colour keeps them readable over lines.
    ctx.font = `${12 / view.k}px ${getComputedStyle(document.documentElement).getPropertyValue("--font-ui")}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    const zoomFade = Math.min(1, Math.max(0, (view.k - 0.9) / 0.6));
    for (const n of nodes) {
      if (n.x == null) continue;
      const pinned = n === hover || lit?.has(n.id) || (q && matches(n)) || nodes.length < 25 || n.id === app.graphFocus;
      const base = pinned ? 1 : hubs.has(n.id) && view.k > 0.45 ? 0.85 : zoomFade;
      if (base <= 0.02) continue;
      const faded = (lit && n !== hover && !lit.has(n.id)) || !matches(n);
      ctx.globalAlpha = faded ? Math.min(base, 0.2) : base;
      const y = n.y! + radius(n) + 3 / view.k;
      ctx.lineWidth = 3 / view.k;
      ctx.strokeStyle = colors.bg;
      ctx.strokeText(n.title, n.x, y);
      ctx.fillStyle = colors.text;
      ctx.fillText(n.title, n.x, y);
    }
    ctx.globalAlpha = 1;
  }

  const redraw = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };

  function fit() {
    const placed = nodes.filter((n) => n.x != null);
    if (!placed.length || !width) return;
    const xs = placed.map((n) => n.x!);
    const ys = placed.map((n) => n.y!);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const k = Math.min(2, 0.85 * Math.min(width / Math.max(x1 - x0, 1), height / Math.max(y1 - y0, 1)));
    view = { k, x: width / 2 - ((x0 + x1) / 2) * k, y: height / 2 - ((y0 + y1) / 2) * k };
    redraw();
  }

  async function rebuild() {
    sim?.stop();
    const focus = local ? app.graphFocus : null;
    const g = buildGraph(app.titles, { ghosts, orphans: local || orphans, focus, depth });
    // Keep positions of notes already on screen so the graph doesn't jump when it changes.
    const old = new Map(nodes.map((n) => [n.id, n]));
    for (const n of g.nodes) {
      const o = old.get(n.id);
      if (o) Object.assign(n, { x: o.x, y: o.y, vx: o.vx, vy: o.vy });
    }
    nodes = g.nodes;
    links = g.links;
    counts = { nodes: nodes.length, links: links.length };
    hubs = new Set([...nodes].sort((a, b) => b.degree - a.degree).slice(0, 12).filter((n) => n.degree > 2).map((n) => n.id));
    colourGroups();
    neighbours = new Map();
    for (const l of links) {
      const [s, t] = [l.source as string, l.target as string];
      (neighbours.get(s) ?? neighbours.set(s, new Set()).get(s)!).add(t);
      (neighbours.get(t) ?? neighbours.set(t, new Set()).get(t)!).add(s);
    }
    let d3: typeof import("d3-force");
    try {
      d3 = await import("d3-force");
      loadError = null;
    } catch (e) {
      loadError = `The graph couldn't load: ${(e as Error).message}`;
      return;
    }
    fitted = false;
    touched = false;
    const simulation = d3
      .forceSimulation(nodes)
      .force("link", d3.forceLink<GNode, GLink>(links).id((d) => d.id).distance(linkDistance).strength(0.6))
      .force("charge", d3.forceManyBody<GNode>().strength(-repel).distanceMax(500))
      .force("center", d3.forceCenter(0, 0).strength(0.05))
      .force("x", d3.forceX<GNode>(0).strength(0.04))
      .force("y", d3.forceY<GNode>(0).strength(0.04))
      .force("collide", d3.forceCollide<GNode>((n) => radius(n) + 3))
      .on("tick", () => {
        // Fit once the layout has opened up, then let it settle in place.
        if (!fitted && simulation.alpha() < 0.5) {
          fitted = true;
          fit();
        }
        redraw();
      })
      .on("end", () => {
        // A final fit once settled, unless the view was already moved by hand.
        if (!touched) fit();
        redraw();
      });
    sim = simulation;
  }

  // Rebuild when the notes or the options change. The simulation stops by itself when it settles.
  $effect(() => {
    void app.titles;
    void local;
    void ghosts;
    void orphans;
    void depth;
    void app.graphFocus;
    untrack(() => void rebuild());
  });

  $effect(() => {
    void filter;
    void spotlight;
    void byFolder;
    void dotSize;
    untrack(redraw);
  });

  // Moving a force slider re-heats the layout instead of rebuilding it.
  $effect(() => {
    const [distance, strength] = [linkDistance, repel];
    untrack(() => {
      const s = sim as unknown as { force(name: string): any; alpha(a: number): { restart(): void } } | null;
      if (!s) return;
      s.force("link")?.distance(distance);
      s.force("charge")?.strength(-strength);
      touched = false;
      s.alpha(0.4).restart();
    });
  });

  $effect(() => {
    readColors();
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => {
      readColors();
      redraw();
    };
    media.addEventListener("change", onTheme);
    window.addEventListener("wandika:theme", onTheme);
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      width = box.clientWidth;
      height = box.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      if (!fitted) fit();
      redraw();
    });
    ro.observe(box);
    return () => {
      media.removeEventListener("change", onTheme);
      window.removeEventListener("wandika:theme", onTheme);
      ro.disconnect();
    };
  });

  // Pointer handling: drag a dot to move it, drag the background to pan, pinch or wheel to zoom.
  const pointers = new Map<number, { x: number; y: number }>();
  let dragging: GNode | null = null;
  let moved = 0;
  let pinch = 0;

  const toWorld = (sx: number, sy: number) => ({ x: (sx - view.x) / view.k, y: (sy - view.y) / view.k });

  function hit(sx: number, sy: number) {
    const p = toWorld(sx, sy);
    let best: GNode | null = null;
    let bestD = Infinity;
    for (const n of nodes) {
      if (n.x == null) continue;
      const d = Math.hypot(n.x - p.x, n.y! - p.y);
      const reach = radius(n) + 6 / view.k;
      if (d < reach && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  function local_(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function down(e: PointerEvent) {
    canvas.setPointerCapture(e.pointerId);
    const p = local_(e);
    pointers.set(e.pointerId, p);
    moved = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
      dragging = null;
      return;
    }
    dragging = hit(p.x, p.y);
    if (dragging) {
      dragging.fx = dragging.x;
      dragging.fy = dragging.y;
      sim?.alphaTarget(0.25).restart();
    }
  }

  function move(e: PointerEvent) {
    const p = local_(e);
    const prev = pointers.get(e.pointerId);
    if (!prev) {
      const h = hit(p.x, p.y);
      if (h !== hover) {
        hover = h;
        canvas.style.cursor = h ? "pointer" : "grab";
        redraw();
      }
      return;
    }
    pointers.set(e.pointerId, p);
    moved += Math.hypot(p.x - prev.x, p.y - prev.y);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch);
      pinch = d;
      return;
    }
    if (dragging) {
      const w = toWorld(p.x, p.y);
      dragging.fx = w.x;
      dragging.fy = w.y;
    } else {
      touched = true;
      view.x += p.x - prev.x;
      view.y += p.y - prev.y;
      redraw();
    }
  }

  function up(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    const node = dragging;
    if (node) {
      node.fx = null;
      node.fy = null;
      sim?.alphaTarget(0);
    }
    dragging = null;
    if (node && moved < 6) {
      if (node.ghost) void app.follow(node.title);
      else app.open(node.id);
    }
  }

  function zoomAt(sx: number, sy: number, factor: number) {
    touched = true;
    const k = Math.min(6, Math.max(0.1, view.k * factor));
    const f = k / view.k;
    view = { k, x: sx - (sx - view.x) * f, y: sy - (sy - view.y) * f };
    redraw();
  }

  function wheel(e: WheelEvent) {
    e.preventDefault();
    const p = { x: e.offsetX, y: e.offsetY };
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
  }

  onDestroy(() => {
    sim?.stop();
    cancelAnimationFrame(frame);
  });
</script>

<section class="graph" aria-labelledby="graph-title">
  <header>
    <h2 id="graph-title">Graph</h2>
    <input class="field" type="search" bind:value={filter} placeholder="Filter notes" aria-label="Filter notes in the graph" />
    <div class="segmented" role="group" aria-label="Which notes to show">
      <button aria-pressed={!local} class:on={!local} onclick={() => (local = false)}>Whole vault</button>
      <button
        aria-pressed={local}
        class:on={local}
        disabled={!app.graphFocus}
        title={app.graphFocus ? undefined : "Open a note first"}
        onclick={() => (local = true)}>Around this note</button
      >
    </div>
    {#if local}
      <label class="opt">
        Depth
        <select bind:value={depth}>
          <option value={1}>1</option>
          <option value={2}>2</option>
          <option value={3}>3</option>
        </select>
      </label>
    {/if}
    <button class="btn small-btn" class:on={panel} aria-expanded={panel} aria-controls="graph-display" onclick={() => (panel = !panel)}>
      <SlidersHorizontal size={15} /> Display
    </button>
    <button class="icon-btn" onclick={() => { touched = false; fit(); }} aria-label="Fit the graph to the window"><Maximize size={17} /></button>
  </header>
  <div class="stage" bind:this={box}>
    <canvas
      bind:this={canvas}
      aria-label={`Graph of ${counts.nodes} notes and ${counts.links} links. Use search to open a note.`}
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={up}
      onpointerleave={() => {
        if (hover && !pointers.size) {
          hover = null;
          redraw();
        }
      }}
      onwheel={wheel}
    ></canvas>
    {#if loadError}
      <p class="empty error" role="alert">{loadError}</p>
    {:else if counts.nodes === 0}
      <p class="empty muted">{local ? "This note has no links yet." : "No notes yet. Link notes with [[ ]] to see them connect here."}</p>
    {/if}
    {#if panel}
      <div class="panel" id="graph-display" role="group" aria-label="Graph display">
        <label class="check"><input type="checkbox" bind:checked={byFolder} /> Colour by folder</label>
        <label class="check"><input type="checkbox" bind:checked={orphans} disabled={local} /> Notes without links</label>
        <label class="check"><input type="checkbox" bind:checked={ghosts} /> Notes not written yet</label>
        <label class="slider">Dot size <input type="range" min="0.5" max="2.5" step="0.1" bind:value={dotSize} /></label>
        <label class="slider">Link distance <input type="range" min="20" max="200" step="5" bind:value={linkDistance} /></label>
        <label class="slider">Spacing <input type="range" min="30" max="400" step="10" bind:value={repel} /></label>
      </div>
    {/if}
    {#if byFolder && groups.length > 1}
      <div class="groups" role="group" aria-label="Folders">
        {#each groups as g (g.name)}
          <button
            class="group"
            class:dim={spotlight !== null && spotlight !== g.name}
            aria-pressed={spotlight === g.name}
            onclick={() => (spotlight = spotlight === g.name ? null : g.name)}
          >
            <span class="dot" style="background: {g.color}"></span>{g.name || "Vault root"}
            <span class="n">{g.count}</span>
          </button>
        {/each}
      </div>
    {/if}
    <p class="legend muted">{counts.nodes} notes, {counts.links} links</p>
  </div>
</section>

<style>
  .graph {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 14px 16px 10px;
  }
  h2 {
    margin: 0 8px 0 0;
    font-size: 1.3rem;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  header .field {
    width: 200px;
    min-height: 36px;
  }
  .segmented {
    display: inline-flex;
    border: 1px solid var(--rule);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .segmented button {
    min-height: 34px;
    padding: 0 12px;
    border: 0;
    background: var(--sheet);
    color: var(--graphite);
    font-size: var(--small);
  }
  .segmented button + button {
    border-left: 1px solid var(--rule);
  }
  .segmented button.on {
    background: var(--papyrus);
    color: var(--on-papyrus);
  }
  .segmented button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .opt {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--small);
    color: var(--graphite);
  }
  .opt select {
    border: 1px solid var(--rule);
    border-radius: var(--radius-sm);
    background: var(--sheet);
    padding: 2px 4px;
  }
  .stage {
    position: relative;
    flex: 1;
    min-height: 240px;
    background: var(--sheet);
    border-top: 1px solid var(--rule);
  }
  canvas {
    display: block;
    touch-action: none;
    cursor: grab;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    margin: 0;
    padding: 24px;
    text-align: center;
    pointer-events: none;
  }
  .small-btn {
    min-height: 34px;
    padding: 0 12px;
    font-size: var(--small);
  }
  .small-btn.on {
    border-color: var(--papyrus);
    color: var(--papyrus);
  }
  .panel {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 2;
    display: grid;
    gap: 10px;
    width: 240px;
    padding: 14px;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: var(--sheet);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.14);
    font-size: var(--small);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .check input,
  .slider input {
    accent-color: var(--papyrus);
  }
  .slider {
    display: grid;
    gap: 4px;
    color: var(--graphite);
  }
  .groups {
    position: absolute;
    left: 12px;
    top: 12px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    max-height: calc(100% - 60px);
    overflow-y: auto;
  }
  .group {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 26px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--sheet) 80%, transparent);
    color: var(--ink);
    font-size: calc(12px * var(--text-scale));
  }
  @media (hover: hover) {
    .group:hover {
      background: var(--papyrus-wash);
    }
  }
  .group.dim {
    opacity: 0.45;
  }
  .group .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
  }
  .group .n {
    color: var(--graphite);
    font-variant-numeric: tabular-nums;
  }
  .legend {
    position: absolute;
    left: 16px;
    bottom: calc(10px + var(--safe-bottom));
    margin: 0;
    font-size: var(--small);
    pointer-events: none;
  }
</style>
