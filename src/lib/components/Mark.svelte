<script lang="ts">
  /** The Wandika mark: a single-stroke w on the accent colour. */
  let { size = 40 }: { size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
  <rect width="1024" height="1024" rx="230" fill="var(--papyrus)" />
  <polyline
    points="272,356 397,676 512,440 627,676 752,356"
    fill="none"
    stroke="var(--on-papyrus)"
    stroke-width="96"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>
