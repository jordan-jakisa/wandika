import { afterEach, expect, test } from "vitest";
import { duration } from "./motion";

const root = document.documentElement;

afterEach(() => {
  for (const t of ["--dur-instant", "--dur-quick", "--dur-base", "--dur-slow"]) root.style.removeProperty(t);
});

test("reads a duration in milliseconds from CSS", () => {
  root.style.setProperty("--dur-base", "240ms");
  root.style.setProperty("--dur-quick", " 160ms ");
  expect(duration("--dur-base")).toBe(240);
  expect(duration("--dur-quick")).toBe(160);
});

test("a duration written in seconds is turned into milliseconds", () => {
  root.style.setProperty("--dur-slow", "0.36s");
  expect(duration("--dur-slow")).toBe(360);
});

test("reduced motion (0ms) is no time at all", () => {
  root.style.setProperty("--dur-instant", "0ms");
  expect(duration("--dur-instant")).toBe(0);
});

test("a missing or unreadable token is 0", () => {
  expect(duration("--dur-slow")).toBe(0);
  root.style.setProperty("--dur-slow", "fast");
  expect(duration("--dur-slow")).toBe(0);
});
