import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { resetApp, status } from "../../test/components-workspace";
import { app } from "../app.svelte";
import Search from "./Search.svelte";

// On iPhone the way out is Cancel beside the field, as in iOS search.
vi.mock("../platform", async (real) => ({ ...(await real<typeof import("../platform")>()), isIOS: true }));

beforeEach(async () => {
  resetApp();
  app.status = status();
  await app.refreshFiles();
});

test("Cancel shows while typing and leaves search; there's no back arrow", async () => {
  const user = userEvent.setup();
  const onExit = vi.fn();
  render(Search, { mode: "page", onExit });
  const field = screen.getByRole("combobox", { name: "Search notes" });
  await waitFor(() => expect(field).toHaveFocus());
  expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  await user.type(field, "plan");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onExit).toHaveBeenCalledTimes(1);
  expect(field).toHaveValue("");
  expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
});
