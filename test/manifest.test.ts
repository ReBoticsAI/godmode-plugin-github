import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  KERNEL_CLIENT_API_VERSION,
  parseGodmodePluginManifest,
} from "@godmode/plugin-api";

test("manifest negotiates kernel client API version 1", () => {
  const manifestPath = path.resolve("godmode.plugin.json");
  const manifest = parseGodmodePluginManifest(
    JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  );

  assert.equal(manifest.kernelApiVersion, KERNEL_CLIENT_API_VERSION);
  assert.equal(manifest.kernelApiVersion, 1);
});

test("manifest negotiation rejects a mismatched kernel API version", () => {
  assert.throws(
    () =>
      parseGodmodePluginManifest({
        id: "godmode-plugin-github",
        version: "0.1.0",
        name: "GitHub",
        kernelApiVersion: KERNEL_CLIENT_API_VERSION + 1,
      }),
    /unsupported kernelApiVersion 2; host supports 1/
  );
});
