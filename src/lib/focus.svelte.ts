// A focus session on one task: a quiet timer, then a short break. The time left comes from the
// clock, not from counting ticks, so it stays right when the app sleeps in the background.

import type { RemoteTask, VaultTask } from "./types";
import { readView, saveView } from "./viewPrefs";

export interface FocusTask {
  /** The task's words, as shown. */
  text: string;
  task?: VaultTask;
  remote?: RemoteTask;
}

export const LENGTHS = [15, 25, 50] as const;
export const BREAK_MINUTES = 5;

type Phase = "focus" | "break";

class Focus {
  active = $state<FocusTask | null>(null);
  phase = $state<Phase>("focus");
  /** The length picked for focus rounds, kept on this device. */
  minutes = $state<number>(readView("focus", { minutes: 25 }).minutes);
  /** Milliseconds left in this round. */
  left = $state(0);
  total = $state(0);
  paused = $state(false);
  /** The round ran to the end; the screen offers what comes next. */
  finished = $state(false);
  /** Focus rounds finished on this task. */
  rounds = $state(0);
  #endsAt = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  /** Called once when a round ends on its own, for the chime. */
  onEnd: ((phase: Phase) => void) | null = null;

  start(task: FocusTask, minutes = this.minutes) {
    if (!LENGTHS.includes(minutes as (typeof LENGTHS)[number])) minutes = 25;
    if (this.active?.task?.path !== task.task?.path || this.active?.text !== task.text) this.rounds = 0;
    this.active = task;
    this.minutes = minutes;
    saveView("focus", { minutes });
    this.#run("focus", minutes);
  }

  /** Changes the length of the round that hasn't started counting much yet: starts it again. */
  setLength(minutes: number) {
    if (!this.active) return;
    this.start(this.active, minutes);
  }

  takeBreak() {
    if (this.active) this.#run("break", BREAK_MINUTES);
  }

  again() {
    if (this.active) this.#run("focus", this.minutes);
  }

  pause() {
    if (this.paused || this.finished || !this.active) return;
    this.#tick();
    this.paused = true;
    clearInterval(this.#timer);
  }

  resume() {
    if (!this.paused || !this.active) return;
    this.paused = false;
    this.#endsAt = Date.now() + this.left;
    this.#timer = setInterval(() => this.#tick(), 250);
  }

  stop() {
    clearInterval(this.#timer);
    this.active = null;
    this.paused = false;
    this.finished = false;
    this.rounds = 0;
  }

  #run(phase: Phase, minutes: number) {
    clearInterval(this.#timer);
    this.phase = phase;
    this.total = minutes * 60_000;
    this.left = this.total;
    this.paused = false;
    this.finished = false;
    this.#endsAt = Date.now() + this.total;
    this.#timer = setInterval(() => this.#tick(), 250);
  }

  #tick() {
    this.left = Math.max(0, this.#endsAt - Date.now());
    if (this.left > 0 || this.finished) return;
    clearInterval(this.#timer);
    this.finished = true;
    if (this.phase === "focus") this.rounds += 1;
    this.onEnd?.(this.phase);
  }
}

export const focus = new Focus();

/** "24:59", or "1:02:00" past an hour. */
export function clockText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
