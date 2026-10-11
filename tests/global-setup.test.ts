import { expect, test } from "vitest";

test("workers use UTC for local date operations", () => {
  expect(new Date(2026, 0, 1).toISOString()).toBe("2026-01-01T00:00:00.000Z");
});
