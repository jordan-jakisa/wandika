<script lang="ts">
  /**
   * A drag handle on a column's edge. Drag, or focus it and use the arrow keys; double-click resets.
   * `edge` is the side of the column it sits on; dragging away from the column makes it wider.
   */
  let {
    edge,
    value,
    min,
    max,
    initial,
    label,
    onchange,
  }: {
    edge: "left" | "right";
    value: number;
    min: number;
    max: number;
    initial: number;
    label: string;
    onchange: (width: number) => void;
  } = $props();

  let startX = 0;
  let startW = 0;
  let dragging = $state(false);
  // While a column edge follows the pointer, the layout's own easing stays out of the way.
  $effect(() => {
    document.documentElement.classList.toggle("resizing", dragging);
    return () => document.documentElement.classList.remove("resizing");
  });

  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));

  function down(e: PointerEvent) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    startX = e.clientX;
    startW = value;
    dragging = true;
  }

  /** The edge moves once per screen frame however fast the pointer reports, so the app lays out
   *  at most once a frame while you drag. */
  let frame = 0;
  let lastX = 0;
  function move(e: PointerEvent) {
    if (!dragging) return;
    lastX = e.clientX;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!dragging) return;
      const dx = lastX - startX;
      onchange(clamp(startW + (edge === "right" ? dx : -dx)));
    });
  }

  function up(e: PointerEvent) {
    if (!dragging) return;
    // The last position counts, even if its frame hadn't come yet.
    cancelAnimationFrame(frame);
    frame = 0;
    const dx = e.clientX - startX;
    if (e.type === "pointerup" && dx) onchange(clamp(startW + (edge === "right" ? dx : -dx)));
    dragging = false;
  }

  function key(e: KeyboardEvent) {
    const step = e.shiftKey ? 48 : 16;
    const grow = edge === "right" ? "ArrowRight" : "ArrowLeft";
    const shrink = edge === "right" ? "ArrowLeft" : "ArrowRight";
    if (e.key === grow) onchange(clamp(value + step));
    else if (e.key === shrink) onchange(clamp(value - step));
    else if (e.key === "Home") onchange(min);
    else if (e.key === "End") onchange(max);
    // Return puts it back, as a double-click does.
    else if (e.key === "Enter") onchange(initial);
    else return;
    e.preventDefault();
  }
</script>

<!-- A focusable separator is an ARIA widget; Svelte's lint treats it as static. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="resizer {edge}"
  class:dragging
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuenow={value}
  aria-valuemin={min}
  aria-valuemax={max}
  tabindex="0"
  title="Drag to resize. Double-click to reset."
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  ondblclick={() => onchange(initial)}
  onkeydown={key}
></div>

<style>
  .resizer {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 9px;
    z-index: 5;
    cursor: col-resize;
    touch-action: none;
  }
  .resizer.right {
    right: -5px;
  }
  .resizer.left {
    left: -5px;
  }
  .resizer::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 4px;
    width: 1px;
    background: transparent;
    transition: background var(--dur-instant);
  }
  .resizer:focus-visible::after,
  .resizer.dragging::after {
    background: var(--papyrus);
    width: 2px;
    left: 3.5px;
  }
  .resizer:focus-visible {
    outline: none;
  }
  @media (hover: hover) {
    .resizer:hover::after {
      background: var(--papyrus);
      width: 2px;
      left: 3.5px;
    }
  }
</style>
