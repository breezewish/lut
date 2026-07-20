import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { Filmstrip } from "../src/components/filmstrip";
import type { QueueItem } from "../src/types";

test("uses each photo's stable portrait or landscape thumbnail ratio", () => {
  const items: QueueItem[] = [
    {
      id: "portrait",
      file: new File(["portrait"], "portrait.dng"),
      status: "ready",
      ev: 0,
      temperature: 0,
      tint: 0,
      lutId: "look",
      thumbnailAspect: 2 / 3,
    },
    {
      id: "landscape",
      file: new File(["landscape"], "landscape.dng"),
      status: "ready",
      ev: 0,
      temperature: 0,
      tint: 0,
      lutId: "look",
      thumbnailAspect: 3 / 2,
    },
  ];

  render(
    <Filmstrip
      items={items}
      activeId="portrait"
      selectedIds={new Set(["portrait"])}
      exporting={false}
      onSelect={() => {}}
      onRemove={() => {}}
      onAdd={() => {}}
    />,
  );

  const portrait = screen
    .getByRole("button", { name: "portrait.dng — Ready" })
    .closest(".photo-wrap");
  const landscape = screen
    .getByRole("button", { name: "landscape.dng — Ready" })
    .closest(".photo-wrap");
  expect(portrait).toHaveAttribute("data-orientation", "portrait");
  expect(portrait).toHaveStyle({ "--preview-aspect": String(2 / 3) });
  expect(landscape).not.toHaveAttribute("data-orientation");
  expect(landscape).toHaveStyle({ "--preview-aspect": String(3 / 2) });
});
