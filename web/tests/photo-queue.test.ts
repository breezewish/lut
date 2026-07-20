import { expect, test } from "vitest";

import {
  INITIAL_QUEUE,
  queueReducer,
  uniqueNewFiles,
} from "../src/lib/photo-queue";

test("applies consecutive imports to the latest committed queue", () => {
  const first = new File(["first"], "first.dng", { lastModified: 1 });
  const second = new File(["second"], "second.dng", { lastModified: 2 });

  const afterFirst = queueReducer(INITIAL_QUEUE, {
    type: "add",
    files: [first],
    thumbUrls: new Map(),
    defaultLutId: "default",
  });
  const afterSecond = queueReducer(afterFirst, {
    type: "add",
    files: [second],
    thumbUrls: new Map(),
    defaultLutId: "default",
  });

  expect(afterSecond.items.map(({ file }) => file.name)).toEqual([
    "first.dng",
    "second.dng",
  ]);
  expect(afterSecond.activeId).toBe("second.dng:6:2");
  expect(afterSecond.selectedIds).toEqual(new Set(["second.dng:6:2"]));
});

test("reports only files that would extend the current queue", () => {
  const existing = new File(["same"], "same.dng", { lastModified: 1 });
  const added = queueReducer(INITIAL_QUEUE, {
    type: "add",
    files: [existing],
    thumbUrls: new Map(),
    defaultLutId: "default",
  });
  const duplicate = new File(["same"], "same.dng", { lastModified: 1 });
  const newFile = new File(["new"], "new.dng", { lastModified: 2 });

  expect(uniqueNewFiles(added.items, [duplicate, newFile, newFile])).toEqual([
    newFile,
  ]);
});
