import { expect, test } from "vitest";

import { formatDownloadProgress } from "./download-progress.js";

test("progress shows bytes, total, percentage, and average speed", () => {
  expect(
    formatDownloadProgress({ bytesWritten: 1048576, totalBytes: 2097152, elapsedMs: 2000 }),
  ).toBe("Downloading 1.0 MiB / 2.0 MiB (50%) · 512.0 KiB/s");
});

test("unknown lengths do not invent a total or percentage", () => {
  expect(formatDownloadProgress({ bytesWritten: 512, elapsedMs: 1000 })).toBe(
    "Downloading 512 B · 512 B/s",
  );
});

test("initial and empty transfers never show invalid speed or percentage", () => {
  expect(formatDownloadProgress({ bytesWritten: 0, totalBytes: 0, elapsedMs: 0 })).toBe(
    "Downloading 0 B / 0 B · 0 B/s",
  );
});
