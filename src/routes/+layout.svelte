<script lang="ts">
  import "@fontsource-variable/literata";
  import "@fontsource-variable/literata/wght-italic.css";
  import "../app.css";
  import "../mobile.css";

  import { followSystemTextSize } from "$lib/platform";

  let { children } = $props();

  $effect(() => {
    followSystemTextSize();
    const onShow = () => document.visibilityState === "visible" && followSystemTextSize();
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  });
</script>

{@render children()}
