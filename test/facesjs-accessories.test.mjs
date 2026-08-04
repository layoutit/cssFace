import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { svgsIndex } from "facesjs";

import {
  validateFacesJsComponentCatalog,
  validateFacesJsComponentManifest,
} from "../.build/prepare/src/adapters/facesjs/model-package/componentPackage.js";
import {
  FACES_JS_ACCESSORY_COMPONENT_SCHEMA,
  FACES_JS_HAT_ACCESSORY_IDS,
} from "../src/adapters/facesjs/scripts/accessoryComponentCompiler.mjs";

const compatibility = JSON.parse(await readFile(
  new URL("../src/adapters/facesjs/compatibility.json", import.meta.url),
));
const catalogDocument = JSON.parse(await readFile(
  new URL("../src/adapters/facesjs/component-catalog.json", import.meta.url),
));
const hairStrategyDocument = JSON.parse(await readFile(
  new URL("../src/adapters/facesjs/hairStrategies.json", import.meta.url),
));
const sourceIndex = Object.fromEntries(Object.entries(compatibility.families).map(([family, row]) => [
  family,
  Object.fromEntries(row.ids.map((entry) => [entry.id, entry.sourceSha256])),
]));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function loadAccessory(sourceId) {
  const packageRoot = new URL(
    `../public/facesjs-components/components/accessories/${sourceId}/`,
    import.meta.url,
  );
  const manifestBytes = await readFile(new URL("manifest.json", packageRoot));
  const manifest = await validateFacesJsComponentManifest(
    JSON.parse(manifestBytes),
    sourceIndex,
  );
  const geometryBytes = await readFile(new URL(manifest.assets.geometry.path, packageRoot));
  const row = catalogDocument.components.find((entry) =>
    entry.family === "accessories" && entry.sourceId === sourceId);
  assert.equal(sha256(manifestBytes), row.manifestSha256);
  assert.equal(sha256(geometryBytes), manifest.assets.geometry.sha256);
  return { geometry: JSON.parse(gunzipSync(geometryBytes)), manifest };
}

test("all eight accessories have explicit source-bound outcomes above hair and glasses", async () => {
  const catalog = await validateFacesJsComponentCatalog(catalogDocument, sourceIndex);
  const rows = catalog.components.filter(({ family }) => family === "accessories");
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.map(({ sourceId }) => sourceId).sort(), [...svgsIndex.accessories].sort());
  assert.ok(catalog.components.filter(({ family }) => family !== "accessories")
    .every(({ layer }) => layer < 15));
  for (const row of rows) {
    const { geometry, manifest } = await loadAccessory(row.sourceId);
    assert.equal(manifest.layer, 15);
    assert.deepEqual(manifest.dependencies, []);
    assert.equal(geometry.schema, FACES_JS_ACCESSORY_COMPONENT_SCHEMA);
    assert.equal(geometry.family, "accessories");
    assert.equal(geometry.sourceId, row.sourceId);
    assert.equal(geometry.sourceSha256, sourceIndex.accessories[row.sourceId]);
    assert.deepEqual(manifest.materialRoles, geometry.materialRoles);
    const { contentHash, ...payload } = geometry;
    assert.equal(contentHash, sha256(JSON.stringify(payload)));
  }
});

test("projected eye-black remains source-shaped and raised without invented volume", async () => {
  const { geometry, manifest } = await loadAccessory("eye-black");
  assert.equal(geometry.kind, "projected");
  assert.equal(manifest.attachment, "raised");
  assert.deepEqual(geometry.materialRoles, ["ink"]);
  assert.equal(geometry.metrics.triangleCount, geometry.frontPaint.length);
  assert.equal(geometry.mesh.triangles.length, 0);
  assert.ok(geometry.frontPaint.length >= 4);
  assert.ok(geometry.attachmentProfile.minimumFrontClearanceCssPx >= 2.6);
  assert.ok(geometry.frontPaint.every((triangle) =>
    triangle.vertices.every((vertex) => Object.keys(vertex.states).join() === "fatness")));
});

test("headbands and hats use closed swept shells with exact paint roles", async () => {
  const expectedKinds = {
    hat: "hat",
    hat2: "hat",
    hat3: "hat",
    "headband-high": "headband",
    headband: "headband",
    "santa-hat": "hat",
  };
  for (const [sourceId, kind] of Object.entries(expectedKinds)) {
    const { geometry, manifest } = await loadAccessory(sourceId);
    assert.equal(geometry.kind, kind);
    assert.equal(manifest.attachment, "head-shell");
    assert.equal(geometry.metrics.boundaryEdgeCount, 0);
    assert.equal(geometry.metrics.nonManifoldEdgeCount, 0);
    assert.equal(geometry.metrics.connected, true);
    assert.ok(geometry.metrics.minimumTriangleArea > 0);
    assert.ok(geometry.metrics.signedVolume > 0);
    const frontClosure = geometry.mesh.triangles
      .filter(({ surface }) => surface === "front-closure");
    assert.ok(frontClosure.length > 0);
    assert.ok(frontClosure.every(({ render }) => render === false));
    assert.ok(geometry.mesh.triangles.some(({ surface }) => surface === "rear"));
    assert.ok(geometry.frontPaint.length > 0);
    assert.ok(geometry.attachmentProfile.minimumOverlapPoints > 0);
    assert.ok(geometry.attachmentProfile.minimumFrontClearanceCssPx >= 2.6);
    assert.deepEqual(geometry.stateIds, ["fatness"]);
    assert.ok(geometry.mesh.vertices.every((vertex) =>
      Object.keys(vertex.states).join() === "fatness"));
  }
  assert.deepEqual((await loadAccessory("hat")).geometry.materialRoles, [
    "ink",
    "team-secondary",
  ]);
  assert.deepEqual((await loadAccessory("hat3")).geometry.materialRoles, [
    "ink",
    "team-accent",
    "team-primary",
    "team-secondary",
  ]);
  assert.deepEqual((await loadAccessory("santa-hat")).geometry.materialRoles, [
    "accessory-red",
    "accessory-translucent-ink",
    "accessory-white",
    "ink",
  ]);
});

test("all four hats reproduce the exact upstream hair substitution partition", async () => {
  const hairRows = hairStrategyDocument.entries.filter(({ family }) => family === "hair");
  const expected = {
    hide: hairRows.filter((row) => row.accessorySubstitution.action === "hide")
      .map(({ sourceId }) => sourceId).sort(),
    substituteShort: hairRows.filter((row) =>
      row.accessorySubstitution.replacementSourceId === "short")
      .map(({ sourceId }) => sourceId).sort(),
    substituteShortFade: hairRows.filter((row) =>
      row.accessorySubstitution.replacementSourceId === "short-fade")
      .map(({ sourceId }) => sourceId).sort(),
  };
  assert.equal(Object.values(expected).flat().length, svgsIndex.hair.length);
  for (const sourceId of FACES_JS_HAT_ACCESSORY_IDS) {
    const { geometry } = await loadAccessory(sourceId);
    assert.equal(geometry.hairInteraction.applies, true);
    assert.equal(geometry.hairInteraction.source, "facesjs-display");
    assert.deepEqual(geometry.hairInteraction.rules, expected);
  }
  for (const sourceId of ["eye-black", "headband", "headband-high", "none"]) {
    const { geometry } = await loadAccessory(sourceId);
    assert.equal(geometry.hairInteraction.applies, false);
    assert.equal(geometry.hairInteraction.rules, null);
  }
});

test("the empty accessory stays explicit and accessory support is package-backed", async () => {
  const { geometry, manifest } = await loadAccessory("none");
  assert.equal(geometry.empty, true);
  assert.equal(geometry.metrics.triangleCount, 0);
  assert.deepEqual(manifest.materialRoles, []);
  for (const row of compatibility.families.accessories.ids) {
    assert.equal(row.support, "supported");
    assert.deepEqual(row.evidence, [
      "contract:cssface.facesjs-accessory-component@1",
      "test:facesjs-accessories",
    ]);
  }
});
