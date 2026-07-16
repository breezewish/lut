import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import App from "../src/App";

afterEach(() => {
  cleanup();
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

test("deduplicates one input batch and accepts drops after the queue is populated", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    () => new Promise<Response>(() => {}),
  );

  const { container } = render(<App />);
  const input = container.querySelector('input[type="file"]');
  expect(input).not.toBeNull();
  const first = new File(["first"], "first.dng", { lastModified: 1 });
  fireEvent.change(input!, { target: { files: [first, first] } });
  expect(screen.getByText("1 local file")).toBeVisible();

  const second = new File(["second"], "second.dng", { lastModified: 2 });
  fireEvent.drop(screen.getByLabelText("RAW queue"), {
    dataTransfer: { files: [second] },
  });
  expect(screen.getByText("2 local files")).toBeVisible();
});
