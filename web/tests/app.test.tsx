import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import App from "../src/App";

afterEach(() => {
  vi.restoreAllMocks();
});

test("teaches the private local workflow before files are selected", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        version: 1,
        contract: { outputStatus: "unverified" },
        luts: [
          {
            id: "fuji-classic-negative",
            group: "Fujifilm",
            name: "Classic Negative",
            file: "look.cube",
            sha256: "00",
          },
        ],
      }),
      { status: 200 },
    ),
  );

  render(<App />);
  expect(
    screen.getByRole("heading", { name: "Start with a camera RAW" }),
  ).toBeVisible();
  expect(screen.getByText("Files stay on this device")).toBeVisible();
  expect(screen.getByRole("button", { name: "Add RAW files" })).toBeEnabled();
  expect(
    screen.queryByRole("region", { name: "Processing controls" }),
  ).not.toBeInTheDocument();
});
