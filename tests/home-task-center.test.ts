import { describe, expect, test } from "bun:test";
import { advanceTaskIsBusy } from "../src/pages/Home";

describe("Home task center snapshot recovery", () => {
  test("shows a restored single-chapter task after refresh", () => {
    // A reload clears the local busy flag, but the system snapshot restores
    // the running phase used by the bottom control lock.
    expect(advanceTaskIsBusy(false, false, "审查中…")).toBe(true);
  });

  test("does not expose a single-chapter task while auto-serializing", () => {
    expect(advanceTaskIsBusy(true, true, "写作中…")).toBe(false);
  });

  test("keeps a local in-flight task visible before its first snapshot", () => {
    expect(advanceTaskIsBusy(true, false, "")).toBe(true);
  });
});
