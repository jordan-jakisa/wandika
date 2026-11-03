<script lang="ts">
  import { Pause, Play } from "@lucide/svelte";
  import { api } from "../api";
  import { app } from "../app.svelte";
  import { BREAK_MINUTES, LENGTHS, clockText, focus } from "../focus.svelte";

  /** A quiet room for one task: the time left, a slow breathing ring, and nothing else. */
  let dialogEl: HTMLDialogElement;
  let marking = $state(false);

  const R = 46;
  const C = 2 * Math.PI * R;
  const progress = $derived(focus.total ? 1 - focus.left / focus.total : 0);
  const onBreak = $derived(focus.phase === "break");
  // The task's words without its #tags: one quiet line to hold on to.
  const title = $derived((focus.active?.text ?? "").replace(/(^|\s)#[\p{L}\p{N}_\-/]+/gu, "").replace(/\s+/g, " ").trim() || focus.active?.text || "");

  $effect(() => {
    if (focus.active && !dialogEl.open) dialogEl.showModal();
    else if (!focus.active && dialogEl.open) dialogEl.close();
  });

  // A soft two-note bell when a round ends; nothing when sound isn't available.
  focus.onEnd = () => {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      for (const [i, f] of [523.25, 783.99].entries()) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const at = ctx.currentTime + i * 0.35;
        osc.type = "sine";
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.12, at + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 2.4);
        osc.connect(gain).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + 2.5);
      }
      setTimeout(() => void ctx.close(), 3500);
    } catch {
      // A missing chime is fine; the screen still says the round is done.
    }
  };

  async function markDone() {
    const a = focus.active;
    if (!a) return;
    marking = true;
    try {
      if (a.task) {
        await api.taskToggle(a.task.path, a.task.line, a.task.text);
        app.edited();
        app.changed = { paths: [a.task.path], at: Date.now() };
      } else if (a.remote) {
        await api.remoteTaskToggle(a.remote.source, a.remote.list_id, a.remote.id, true);
        await app.loadToday(true);
      }
      const rounds = focus.rounds;
      focus.stop();
      app.say(rounds > 1 ? `Done, after ${rounds} rounds. Well spent.` : "Done. Well spent.");
    } catch (e) {
      app.say(`Couldn't tick that task. ${(e as Error).message}`);
    } finally {
      marking = false;
    }
  }

  // Space pauses and resumes, wherever the focus is, except on a button (Space presses it).
  function onKey(e: KeyboardEvent) {
    if (!focus.active || e.key !== " " || focus.finished || (e.target as HTMLElement).closest?.("button, input, textarea")) return;
    e.preventDefault();
    if (focus.paused) focus.resume();
    else focus.pause();
  }
</script>

<svelte:window onkeydown={onKey} />

<dialog
  bind:this={dialogEl}
  class="focus"
  class:on-break={onBreak}
  aria-labelledby="focus-task"
  oncancel={(e) => {
    e.preventDefault();
    focus.stop();
  }}
>
  {#if focus.active}
    <div class="room">
      <h2 id="focus-task">{title}</h2>

      <div class="ring" class:breathing={!focus.paused && !focus.finished}>
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle class="track" cx="50" cy="50" r={R} />
          <circle class="done" cx="50" cy="50" r={R} stroke-dasharray={C} stroke-dashoffset={C * (1 - progress)} />
        </svg>
        <span class="glow" aria-hidden="true"></span>
        <p class="time" role="timer" aria-live="off" aria-label="{clockText(focus.left)} left">{clockText(focus.left)}</p>
      </div>

      {#if !focus.finished}
        <p class="state">{onBreak ? "Breathe. Stretch. Look far away." : focus.paused ? "Paused." : "One thing at a time."}</p>
        <div class="controls">
          {#if focus.paused}
            <button class="btn primary" onclick={() => focus.resume()}><Play size={16} /> Resume</button>
          {:else}
            <button class="btn" onclick={() => focus.pause()}><Pause size={16} /> Pause</button>
          {/if}
          <button class="btn quiet" onclick={() => focus.stop()}>End</button>
        </div>
        {#if !onBreak}
          <div class="segmented lengths" role="group" aria-label="Length">
            {#each LENGTHS as m (m)}
              <button class:on={focus.minutes === m} aria-pressed={focus.minutes === m} onclick={() => focus.setLength(m)}>{m} min</button>
            {/each}
          </div>
        {/if}
      {:else if onBreak}
        <p class="state" role="status">Break's over.</p>
        <div class="controls">
          <button class="btn primary" onclick={() => focus.again()}>Another round</button>
          <button class="btn quiet" onclick={() => focus.stop()}>Finish</button>
        </div>
      {:else}
        <p class="state" role="status">
          {focus.rounds === 1 ? "Round done." : `${focus.rounds} rounds done.`}
        </p>
        <div class="controls">
          <button class="btn primary" onclick={() => focus.takeBreak()}>Take a {BREAK_MINUTES}-minute break</button>
          {#if focus.active.task || focus.active.remote}
            <button class="btn" onclick={markDone} disabled={marking}>Mark task done</button>
          {/if}
          <button class="btn quiet" onclick={() => focus.again()}>Another round</button>
          <button class="btn quiet" onclick={() => focus.stop()}>Finish</button>
        </div>
      {/if}
    </div>
  {/if}
</dialog>

<style>
  .focus {
    width: 100vw;
    height: 100dvh;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
    border: 0;
    background: var(--paper);
    color: var(--ink);
  }
  .focus[open] {
    display: grid;
    place-items: center;
    animation: fade-in var(--dur-slow) var(--ease-out);
  }
  .focus::backdrop {
    background: var(--paper);
  }
  .room {
    display: grid;
    justify-items: center;
    gap: var(--space-5);
    width: min(520px, calc(100vw - 32px));
    text-align: center;
  }
  h2 {
    margin: 0;
    font-family: var(--font-note);
    font-size: var(--text-xl);
    font-weight: 500;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .ring {
    position: relative;
    width: min(260px, 62vw);
    aspect-ratio: 1;
  }
  svg {
    position: absolute;
    inset: 0;
    transform: rotate(-90deg);
  }
  circle {
    fill: none;
    stroke-width: 1.5;
  }
  .track {
    stroke: var(--rule);
  }
  .done {
    stroke: var(--papyrus);
    stroke-linecap: round;
    transition: stroke-dashoffset 250ms linear;
  }
  .on-break .done {
    stroke: var(--amber);
  }
  /* The breathing light: in for four seconds, out for four. */
  .glow {
    position: absolute;
    inset: 18%;
    border-radius: 50%;
    background: var(--papyrus-wash);
    transform: scale(0.82);
  }
  .breathing .glow {
    animation: breathe 8s ease-in-out infinite;
  }
  @keyframes breathe {
    0%,
    100% {
      transform: scale(0.82);
    }
    50% {
      transform: scale(1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .breathing .glow {
      animation: none;
    }
    .done {
      transition: none;
    }
  }
  .time {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    margin: 0;
    font-size: calc(var(--text-2xl) * 1.5);
    font-weight: 300;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
  }
  .state {
    margin: 0;
    color: var(--graphite);
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2);
  }
</style>
