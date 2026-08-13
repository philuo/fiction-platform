import { expect, test } from "bun:test";
import { assetContentVersion } from "../server/asset-version";

test("production asset version changes with bundle content and remains stable for identical content", () => {
  const a = ["client-js-a", "client-css"];
  const same = ["client-js-a", "client-css"];
  const changed = ["client-js-b", "client-css"];

  expect(assetContentVersion(a)).toBe(assetContentVersion(same));
  expect(assetContentVersion(changed)).not.toBe(assetContentVersion(a));
});
