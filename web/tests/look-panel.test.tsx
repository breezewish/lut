import { render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { LookPanel } from "../src/components/look-panel";

test("composites worker-created thumbnails without synchronous pixel painting", async () => {
  const bitmap = { width: 1, height: 1 } as ImageBitmap;
  const drawImage = vi.fn();
  const putImageData = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
    putImageData,
  } as unknown as GPUCanvasContext);

  const { unmount } = render(
    <LookPanel
      looks={[
        {
          id: "look",
          group: "Test",
          name: "Look",
          file: "look.ralut",
          sha256: "00",
        },
      ]}
      activeId="look"
      onChoose={() => {}}
      thumbs={new Map([["look", { bitmap, width: 1, height: 1 }]])}
      query=""
      onQuery={() => {}}
    />,
  );

  await waitFor(() => expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0));
  expect(putImageData).not.toHaveBeenCalled();
  unmount();
});

test("keeps portrait geometry while Look thumbnails replace placeholders", () => {
  const look = {
    id: "look",
    group: "Test",
    name: "Look",
    file: "look.ralut",
    sha256: "00",
  };
  const { container, rerender } = render(
    <LookPanel
      looks={[look]}
      activeId="look"
      onChoose={() => {}}
      thumbs={new Map()}
      query=""
      onQuery={() => {}}
      thumbnailAspect={3 / 4}
    />,
  );

  const catalog = container.querySelector(".looks__catalog");
  const placeholder = container.querySelector(".look__thumb");
  expect(catalog).toHaveAttribute("data-orientation", "portrait");
  expect(catalog).toHaveStyle({ "--preview-aspect": String(3 / 4) });

  rerender(
    <LookPanel
      looks={[look]}
      activeId="look"
      onChoose={() => {}}
      thumbs={
        new Map([
          [
            "look",
            {
              bitmap: { width: 99, height: 132 } as ImageBitmap,
              width: 99,
              height: 132,
            },
          ],
        ])
      }
      query=""
      onQuery={() => {}}
      thumbnailAspect={3 / 4}
    />,
  );

  expect(container.querySelector(".look__thumb")).toBe(placeholder);
  expect(catalog).toHaveStyle({ "--preview-aspect": String(3 / 4) });
});

test("groups interleaved looks by camera family without changing their order", () => {
  const { unmount } = render(
    <LookPanel
      looks={[
        {
          id: "fuji-classic-negative",
          group: "Fujifilm",
          name: "NC | Classic Neg.",
          file: "classic-negative.ralut",
          sha256: "00",
        },
        {
          id: "leica-natural",
          group: "Leica",
          name: "Natural",
          file: "natural.ralut",
          sha256: "00",
        },
        {
          id: "fuji-provia",
          group: "Fujifilm",
          name: "STD | Provia",
          file: "provia.ralut",
          sha256: "00",
        },
      ]}
      activeId="fuji-classic-negative"
      onChoose={() => {}}
      thumbs={new Map()}
      query=""
      onQuery={() => {}}
    />,
  );

  const fujifilm = screen.getByRole("group", { name: "Fujifilm" });
  const leica = screen.getByRole("group", { name: "Leica" });
  expect(
    fujifilm.compareDocumentPosition(leica) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    within(fujifilm)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["NC | Classic Neg.", "STD | Provia"]);
  expect(
    within(leica).getByRole("button", { name: "Natural" }),
  ).toBeInTheDocument();
  unmount();
});

test("filters strictly by camera family or Look name", () => {
  const looks = [
    {
      id: "fuji-classic-negative",
      group: "Fujifilm",
      name: "NC | Classic Neg.",
      file: "classic-negative.ralut",
      sha256: "00",
    },
    {
      id: "nikon-nlog",
      group: "Nikon",
      name: "N-Log BT.1886",
      file: "nlog.ralut",
      sha256: "00",
    },
  ];
  const { container, rerender } = render(
    <LookPanel
      looks={looks}
      activeId="fuji-classic-negative"
      onChoose={() => {}}
      thumbs={new Map()}
      query="Nikon"
      onQuery={() => {}}
    />,
  );

  expect(
    within(container).getByRole("group", { name: "Nikon" }),
  ).toBeInTheDocument();
  expect(
    within(container).queryByRole("group", { name: "Fujifilm" }),
  ).not.toBeInTheDocument();

  rerender(
    <LookPanel
      looks={looks}
      activeId="fuji-classic-negative"
      onChoose={() => {}}
      thumbs={new Map()}
      query="NC"
      onQuery={() => {}}
    />,
  );
  expect(
    within(container).getByRole("button", { name: "NC | Classic Neg." }),
  ).toBeInTheDocument();
  expect(
    within(container).queryByRole("group", { name: "Nikon" }),
  ).not.toBeInTheDocument();

  rerender(
    <LookPanel
      looks={looks}
      activeId="fuji-classic-negative"
      onChoose={() => {}}
      thumbs={new Map()}
      query="missing"
      onQuery={() => {}}
    />,
  );
  expect(within(container).getByRole("status")).toHaveTextContent(
    "No looks match “missing”.",
  );
});
