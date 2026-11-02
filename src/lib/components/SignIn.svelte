<script lang="ts">
  import { api, openUrl } from "../api";
  import { app } from "../app.svelte";
  import type { DeviceCode } from "../types";

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
      code = await api.githubStartLogin();
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
    try {
      const r = await api.githubPollLogin(code.device_code);
      if (r?.user) {
        code = null;
        await app.refreshStatus();
        return;
      }
      if (r?.slow_down) interval += 5;
      timer = setTimeout(poll, interval * 1000);
    } catch (e) {
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

  $effect(() => () => clearTimeout(timer));
</script>

<main class="onboarding">
  <div class="column">
    <h1 class="wordmark">Wandika</h1>

    {#if !code}
      <p class="lead">Your notes, as Markdown files in a GitHub repository you choose. Every device you sign in on stays in sync.</p>
      <button class="btn primary big" onclick={start} disabled={starting}>
        {starting ? "Contacting GitHub…" : "Sign in with GitHub"}
      </button>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <p class="muted small">Wandika asks GitHub for access to your repositories so it can read and save your notes. Your notes go only to GitHub.</p>
    {:else}
      <p class="lead">Enter this code on GitHub to finish signing in.</p>
      <p class="code" aria-label={`Code ${code.user_code.split("").join(" ")}`}>{code.user_code}</p>
      <button class="btn primary big" onclick={copyAndOpen}>
        {copied ? "Code copied. Open GitHub again" : "Copy code and open GitHub"}
      </button>
      <p class="muted small waiting" role="status">Waiting for GitHub. This page moves on by itself once you approve.</p>
      <button class="btn quiet" onclick={cancel}>Cancel</button>
    {/if}
  </div>
</main>

<style>
  .onboarding {
    min-height: 100dvh;
    display: grid;
    align-items: center;
    padding: calc(32px + var(--safe-top)) max(24px, var(--safe-right)) calc(32px + var(--safe-bottom))
      max(24px, var(--safe-left));
  }
  .column {
    width: 100%;
    max-width: 440px;
    margin: 0 auto;
    display: grid;
    gap: 18px;
    justify-items: start;
  }
  .wordmark {
    margin: 0 0 8px;
    font-family: var(--font-note);
    font-size: clamp(3rem, 12vw, 4.5rem);
    font-weight: 640;
    letter-spacing: -0.02em;
    line-height: 1;
  }
  .lead {
    margin: 0;
    font-family: var(--font-note);
    font-size: 1.2rem;
    line-height: 1.55;
  }
  .big {
    min-height: 50px;
    padding: 0 22px;
    font-size: 1rem;
  }
  .small {
    font-size: var(--small);
    margin: 0;
    max-width: 38ch;
  }
  .code {
    margin: 0;
    font-family: var(--font-note);
    font-size: clamp(2.2rem, 10vw, 3rem);
    font-weight: 600;
    letter-spacing: 0.1em;
    user-select: all;
  }
  .quiet {
    border-color: transparent;
    background: none;
    padding: 0;
    color: var(--graphite);
  }
  .error {
    margin: 0;
  }
</style>
