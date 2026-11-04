import "@testing-library/jest-dom/vitest";
import { resetApp } from "../../test/components-views";
import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { flushSync } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, type VoiceEvent } from "../api";
import { app, voiceTitle } from "../app.svelte";
import Dialog from "./Dialog.svelte";
import VoiceSheet from "./VoiceSheet.svelte";

beforeEach(resetApp);
afterEach(() => vi.restoreAllMocks());

/** Opens the sheet with a fake recognizer; `send` plays its messages. */
function open() {
  let on: (e: VoiceEvent) => void = () => {};
  vi.spyOn(api, "voiceStart").mockImplementation(async (cb) => {
    on = cb;
  });
  const stop = vi.spyOn(api, "voiceStop").mockImplementation(async () => on({ kind: "done", text: "Buy milk.\nCall Ana." }));
  render(Dialog);
  render(VoiceSheet);
  const done = vi.fn();
  app.voice = { title: "Voice note", done };
  flushSync();
  return { user: userEvent.setup(), done, stop, send: (e: VoiceEvent) => on(e) };
}

test("the words appear as you speak, and Done hands over the final words", async () => {
  const { user, done, stop, send } = open();
  expect(screen.getByRole("dialog", { name: "Voice note" })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText(/Listening, 0:00/)).toBeInTheDocument());
  send({ kind: "text", text: "Buy milk" });
  expect(await screen.findByText("Buy milk")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(stop).toHaveBeenCalled();
  await waitFor(() => expect(done).toHaveBeenCalledWith("Buy milk.\nCall Ana."));
  expect(app.voice).toBeNull();
});

test("a microphone that's off says how to turn it on, and Try again starts over", async () => {
  const { user, send } = open();
  await waitFor(() => expect(api.voiceStart).toHaveBeenCalledTimes(1));
  send({ kind: "failed", code: "voice_denied", message: "Wandika can't use the microphone. Turn it on in Settings, Wandika, Microphone." });
  expect(await screen.findByRole("alert")).toHaveTextContent("Turn it on in Settings, Wandika, Microphone.");
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(api.voiceStart).toHaveBeenCalledTimes(2);
});

test("Cancel after speaking asks first, then keeps nothing", async () => {
  const { user, done, send } = open();
  await waitFor(() => expect(api.voiceStart).toHaveBeenCalled());
  send({ kind: "text", text: "Something private" });
  await user.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(await screen.findByRole("dialog", { name: "Discard this voice note?" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(app.voice).toBeNull());
  expect(done).not.toHaveBeenCalled();
});

test("nothing heard adds nothing and says so", async () => {
  const { user, done, stop } = open();
  stop.mockImplementation(async () => {});
  await waitFor(() => expect(screen.getByText(/Listening/)).toBeInTheDocument());
  vi.mocked(api.voiceStop).mockRejectedValue(new Error("stopped"));
  await user.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(app.toast).toBe("Nothing was heard, so nothing was added."));
  expect(done).not.toHaveBeenCalled();
});

test("a voice note's name is its first words, cut at a word, without characters files can't hold", () => {
  expect(voiceTitle("Pick up the parcel before six.\nCall Ana.")).toBe("Pick up the parcel before six");
  expect(voiceTitle("Plan: Q3/Q4 #ideas?")).toBe("Plan Q3Q4 ideas");
  expect(voiceTitle("word ".repeat(30))).toBe("word word word word word word word word word word word word");
  expect(voiceTitle("  ", new Date(2026, 10, 4, 9, 5))).toBe("Voice note 2026-11-04 0905");
});
