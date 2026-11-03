<script lang="ts">
  import { api, codeOf, openUrl } from "../api";
  import { app } from "../app.svelte";
  import type { DeviceCode } from "../types";

  let { onsignedin }: { onsignedin?: () => void } = $props();

  let code = $state<DeviceCode | null>(null);
  let error = $state<string | null>(null);
  let starting = $state(false);
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interval = 5;

  async function start() {
    error = null;
    starting = true;
    try {
      const started = await api.githubStartLogin();
      if (gone) return;
      code = started;
      interval = code.interval;
      timer = setTimeout(poll, interval * 1000);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      starting = false;
    }
  }

  async function poll() {
    if (!code) return;
    // Cancel, or leaving the screen, ends this sign-in; an answer that arrives later is ignored.
    const mine = code;
    try {
      const r = await api.githubPollLogin(mine.device_code);
      if (code !== mine || gone) return;
      if (r?.user) {
        code = null;
        await app.refreshStatus();
        onsignedin?.();
        return;
      }
      if (r?.slow_down) interval += 5;
      timer = setTimeout(poll, interval * 1000);
    } catch (e) {
      if (code !== mine || gone) return;
      // A dropped connection while you approve on GitHub isn't a failure; keep waiting.
      if (codeOf(e) === "offline") {
        timer = setTimeout(poll, interval * 1000);
        return;
      }
      code = null;
      error = (e as Error).message;
    }
  }

  async function copyAndOpen() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.user_code);
      copied = true;
    } catch {
      copied = false;
    }
    await openUrl(code.verification_uri);
  }

  function cancel() {
    clearTimeout(timer);
    code = null;
  }

  let gone = false;
  $effect(() => () => {
    gone = true;
    clearTimeout(timer);
  });
</script>

<div class="signin">
  {#if !code}
    <button class="btn primary big" onclick={start} disabled={starting}>
      {starting ? "Contacting GitHub…" : "Sign in with GitHub"}
    </button>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <p class="muted small">Wandika asks GitHub for access to your repositories so it can read and save your notes there.</p>
  {:else}
    <p>Enter this code on GitHub to finish signing in.</p>
    <p class="code" aria-label={`Code ${code.user_code.split("").join(" ")}`}>{code.user_code}</p>
    <button class="btn primary big" onclick={copyAndOpen}>
      {copied ? "Code copied. Open GitHub again" : "Copy code and open GitHub"}
    </button>
    <p class="muted small" role="status">Waiting for GitHub. This moves on by itself once you approve.</p>
    <button class="btn quiet" onclick={cancel}>Cancel</button>
  {/if}
</div>

<style>
  .signin {
    display: grid;
    gap: 14px;
    justify-items: start;
  }
  p {
    margin: 0;
  }
  .big {
    min-height: 50px;
    padding: 0 20px;
  }
  .small {
    font-size: var(--small);
    max-width: 44ch;
  }
  .code {
    font-family: var(--font-note);
    font-size: clamp(2.2rem, 10vw, 3rem);
    font-weight: 600;
    letter-spacing: 0.1em;
    user-select: all;
  }
  .quiet {
    padding: 0;
  }
</style>
