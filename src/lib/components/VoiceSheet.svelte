<script lang="ts">
  import { Mic } from "@lucide/svelte";
  import { api, type VoiceEvent } from "../api";
  import { app } from "../app.svelte";
  import { sheetOpened } from "../backstack";
  import { haptic } from "../haptics";
  import { closeSheet } from "../motion";

  /** Speak, see the words appear, tap Done: the words go into the note. Speech becomes text on the
   *  device, so it works offline and no audio leaves it. */
  let dialogEl: HTMLDialogElement;
  let shown = $state<typeof app.voice>(null);
  let release = () => {};
  let text = $state("");
  let error = $state<string | null>(null);
  let phase = $state<"starting" | "listening" | "finishing">("starting");
  let seconds = $state(0);
  let timer: ReturnType<typeof setInterval> | undefined;
  /** Each start gets a number, so a late message from an earlier one is ignored. */
  let run = 0;
  /** What Done does with the final words; Cancel leaves it empty. */
  let finish: ((text: string) => void) | null = null;

  $effect(() => {
    const v = app.voice;
    if (v && !dialogEl.open) {
      shown = v;
      dialogEl.showModal();
      release = sheetOpened(() => void cancel());
      void start();
    } else if (!v && dialogEl.open && !dialogEl.classList.contains("closing")) {
      closeSheet(dialogEl, () => (shown = null));
      release();
      release = () => {};
    }
  });

  async function start() {
    const mine = ++run;
    text = "";
    error = null;
    seconds = 0;
    phase = "starting";
    finish = null;
    const on = (e: VoiceEvent) => {
      if (mine !== run) return;
      if (e.kind === "text") {
        text = e.text;
        phase = phase === "finishing" ? phase : "listening";
      } else if (e.kind === "done") {
        stopClock();
        text = e.text;
        const f = finish;
        finish = null;
        f?.(e.text);
      } else {
        stopClock();
        if (e.text) text = e.text;
        error = e.message;
        phase = "listening";
      }
    };
    try {
      await api.voiceStart(on);
      if (mine !== run || error) return;
      phase = "listening";
      clearInterval(timer);
      timer = setInterval(() => seconds++, 1000);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  function stopClock() {
    clearInterval(timer);
    timer = undefined;
  }

  /** Stops listening; `then` hears the final words. */
  async function stop(then: ((text: string) => void) | null) {
    stopClock();
    finish = then;
    phase = "finishing";
    try {
      await api.voiceStop();
    } catch {
      // Already stopped: what's on screen is what was heard.
      const f = finish;
      finish = null;
      f?.(text);
    }
  }

  async function done() {
    const v = app.voice;
    if (!v) return;
    if (error) {
      // Listening already ended; keep what was heard.
      await deliver(v, text);
      return;
    }
    await stop((words) => void deliver(v, words));
  }

  async function deliver(v: NonNullable<typeof app.voice>, words: string) {
    run++;
    app.voice = null;
    if (!words.trim()) return app.say("Nothing was heard, so nothing was added.");
    haptic("success");
    await v.done(words.trim());
  }

  async function cancel() {
    if (text.trim()) {
      const sure = await app.ask({
        title: "Discard this voice note?",
        message: "What you said won't be kept.",
        confirm: "Discard",
        cancel: "Keep listening",
        danger: true,
      });
      if (sure === null) return;
    }
    run++;
    if (!error) void stop(null);
    app.voice = null;
  }

  const clock = $derived(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
</script>

<dialog
  bind:this={dialogEl}
  class="voice rises"
  aria-labelledby="voice-h"
  oncancel={(e) => {
    e.preventDefault();
    void cancel();
  }}
>
  {#if shown}
    <header class="bar">
      <button class="bar-btn" onclick={cancel}>Cancel</button>
      <h2 id="voice-h">{shown.title}</h2>
      <button class="bar-btn done" onclick={done} disabled={phase === "finishing" || (phase === "starting" && !error)}>Done</button>
    </header>
    <div class="body">
      {#if error}
        <p class="error" role="alert">{error}</p>
        <button class="btn" onclick={start}>Try again</button>
      {:else}
        <p class="status" aria-live="polite">
          <Mic size={16} aria-hidden="true" />
          {phase === "starting" ? "Starting the microphone…" : phase === "finishing" ? "Finishing the last words…" : `Listening, ${clock}`}
        </p>
      {/if}
      {#if text}
        <p class="words">{text}</p>
      {:else if !error}
        <p class="words empty">Start speaking. A pause starts a new line, and Done adds the words.</p>
      {/if}
    </div>
  {/if}
</dialog>

<style>
  .voice[open] {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    width: min(560px, 100vw);
    min-height: 240px;
    max-height: min(70dvh, 560px);
    padding: 0;
    border: 0;
    border-radius: var(--radius-lg);
    background: var(--sheet);
    color: var(--ink);
    box-shadow: var(--shadow-pop);
    animation: fade-in var(--dur-quick) var(--ease-out);
  }
  /* Phones: a sheet from the bottom edge, clear of the home indicator. */
  @media (pointer: coarse) {
    .voice[open] {
      width: 100vw;
      max-width: none;
      /* A steady height, so the sheet doesn't grow with every word. */
      min-height: 40dvh;
      margin: auto 0 0;
      padding-bottom: var(--safe-bottom);
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    }
  }
  .bar {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 4px 8px;
  }
  h2 {
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
  .bar-btn.done {
    justify-self: end;
    font-weight: 600;
  }
  .bar-btn:disabled {
    opacity: 0.4;
  }
  .body {
    overflow: auto;
    padding: var(--space-2) var(--space-5) var(--space-6);
  }
  .status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0 0 var(--space-3);
    color: var(--graphite);
    font-size: var(--small);
    font-variant-numeric: tabular-nums;
  }
  .status :global(svg) {
    color: var(--alarm);
  }
  .words {
    margin: 0;
    font-family: var(--font-note);
    font-size: var(--text-lg);
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .words.empty {
    color: var(--graphite);
    font-size: var(--text-md);
  }
  .error {
    margin: 0 0 var(--space-3);
  }
</style>
