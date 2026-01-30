import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { sanitizeFilename, uniqueName } from "../server.js";

test("sanitizeFilename strips path traversal and unsafe chars", () => {
  const name = sanitizeFilename("../evil/..//secret?.png");
  assert.equal(name, "secret_.png");
});

test("uniqueName adds numeric suffix when file exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pembroider-test-"));
  const first = path.join(dir, "layer.png");
  fs.writeFileSync(first, "x");
  const next = uniqueName(dir, "layer.png");
  assert.equal(next, "layer-1.png");
});
