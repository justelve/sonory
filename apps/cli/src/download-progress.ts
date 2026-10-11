import type { DownloadProgress } from "@sonory/core";

function bytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index =
    value <= 0 ? 0 : Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDownloadProgress(progress: DownloadProgress): string {
  const amount =
    progress.totalBytes === undefined
      ? bytes(progress.bytesWritten)
      : `${bytes(progress.bytesWritten)} / ${bytes(progress.totalBytes)}${progress.totalBytes === 0 ? "" : ` (${Math.min(100, Math.floor((progress.bytesWritten / progress.totalBytes) * 100))}%)`}`;
  const rate = progress.elapsedMs <= 0 ? 0 : (progress.bytesWritten * 1000) / progress.elapsedMs;
  return `Downloading ${amount} · ${bytes(rate)}/s`;
}
