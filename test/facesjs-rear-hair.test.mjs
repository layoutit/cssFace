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
  FACES_JS_HAIR_COMPONENT_SCHEMA,
} from "../src/adapters/facesjs/scripts/hairComponentCompiler.mjs";

const compatibility = JSON.parse(await readFile(
  new URL("../src/adapters/facesjs/compatibility.json", import.meta.url),
));
const catalogDocument = JSON.parse(await readFile(
  new URL("../src/adapters/facesjs/component-catalog.json", import.meta.url),
));
const strategyDocument = JSON.parse(await readFile(
  new URL("../src/adapters/facesjs/hairStrategies.json", import.meta.url),
));
const sourceIndex = Object.fromEntries(Object.entries(compatibility.families).map(([family, row]) => [
  family,
  Object.fromEntries(row.ids.map((entry) => [entry.id, entry.sourceSha256])),
]));
const remainingRows = strategyDocument.entries.filter((entry) =>
  entry.strategy === "background-coupled"
  || entry.strategy === "rear-long"
  || (entry.family === "hairBg" && entry.strategy === "empty-bald"));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function loadGeometry(family, sourceId) {
  const packageRoot = new URL(
    `../public/facesjs-components/components/${family}/${sourceId}/`,
    import.meta.url,
  );
  const manifestBytes = await readFile(new URL("manifest.json", packageRoot));
  const manifest = await validateFacesJsComponentManifest(
    JSON.parse(manifestBytes),
    sourceIndex,
  );
  const geometryBytes = await readFile(new URL(manifest.assets.geometry.path, packageRoot));
  const catalogRow = catalogDocument.components.find((row) =>
    row.family === family && row.sourceId === sourceId);
  assert.equal(sha256(manifestBytes), catalogRow.manifestSha256);
  assert.equal(sha256(geometryBytes), manifest.assets.geometry.sha256);
  return { geometry: JSON.parse(gunzipSync(geometryBytes)), manifest };
}

test("all remaining front and background hair ids have one reusable package", async () => {
  const catalog = await validateFacesJsComponentCatalog(catalogDocument, sourceIndex);
  const hairRows = catalog.components.filter(({ family }) => family === "hair");
  const backgroundRows = catalog.components.filter(({ family }) => family === "hairBg");
  assert.equal(hairRows.length, svgsIndex.hair.length);
  assert.equal(backgroundRows.length, svgsIndex.hairBg.length);
  assert.equal(remainingRows.length, 23);
  assert.deepEqual(hairRows.map(({ sourceId }) => sourceId).sort(), [...svgsIndex.hair].sort());
  assert.deepEqual(backgroundRows.map(({ sourceId }) => sourceId).sort(), [...svgsIndex.hairBg].sort());
  assert.equal(catalog.components.some(({ sourceId }) => sourceId.includes("+")), false);

  for (const row of remainingRows) {
    const { geometry, manifest } = await loadGeometry(row.family, row.sourceId);
    assert.equal(geometry.schema, FACES_JS_HAIR_COMPONENT_SCHEMA);
    assert.equal(geometry.family, row.family);
    assert.equal(geometry.sourceId, row.sourceId);
    assert.equal(geometry.sourceSha256, row.sourceSha256);
    assert.equal(geometry.strategy, row.strategy);
    assert.equal(geometry.geometryContract, row.geometryContract);
    assert.equal(manifest.layer, row.family === "hairBg" ? 0 : 13);
    assert.equal(manifest.attachment, row.family === "hairBg" ? "rear-layer" : "head-shell");
    assert.deepEqual(manifest.dependencies, row.family === "hair"
      ? row.compatibleBackgroundSourceIds.map((sourceId) => ({ family: "hairBg", sourceId }))
      : []);
    assert.deepEqual(geometry.dependencies, manifest.dependencies);
    assert.deepEqual(geometry.attachmentProfile.compatibleSourceIds.sort(), [...svgsIndex.head].sort());
    const { contentHash, ...payload } = geometry;
    assert.equal(contentHash, sha256(JSON.stringify(payload)));
  }
});

test("coupled front/background rows retain exact upstream pairing and display groups", async () => {
  const backgroundById = new Map(strategyDocument.entries
    .filter(({ family }) => family === "hairBg")
    .map((row) => [row.sourceId, row]));
  for (const row of remainingRows.filter(({ family, strategy }) =>
    family === "hair" && strategy === "background-coupled")) {
    const { geometry } = await loadGeometry("hair", row.sourceId);
    assert.deepEqual(geometry.displayGroups.behindHead.sourceIds, row.compatibleBackgroundSourceIds);
    assert.equal(geometry.displayGroups.frontHair.component, "self");
    for (const backgroundId of row.compatibleBackgroundSourceIds) {
      assert.ok(backgroundById.get(backgroundId).compatibleFrontSourceIds.includes(row.sourceId));
      const background = await loadGeometry("hairBg", backgroundId);
      assert.equal(background.geometry.displayGroups.behindHead.component, "self");
      assert.equal(background.geometry.displayGroups.frontHair, null);
    }
  }
});

test("non-empty rear layers are closed, behind the head, and clear intersecting shoulders", async () => {
  for (const row of remainingRows.filter(({ family, sourceEmpty }) =>
    family === "hairBg" && !sourceEmpty)) {
    const { geometry } = await loadGeometry(row.family, row.sourceId);
    assert.equal(geometry.empty, false);
    assert.equal(geometry.provenance.frontSilhouette, "facesjs-svg-behind-layer-contours");
    assert.equal(geometry.provenance.rearClosure, "adapter-authored-behind-head-and-shoulder-shell");
    assert.equal(geometry.metrics.boundaryEdgeCount, 0);
    assert.equal(geometry.metrics.nonManifoldEdgeCount, 0);
    assert.equal(geometry.metrics.connected, true);
    assert.ok(geometry.metrics.minimumTriangleArea > 0);
    assert.ok(geometry.metrics.signedVolume > 0);
    assert.ok(geometry.mesh.triangles.some(({ surface }) => surface === "rear"));
    const frontClosure = geometry.mesh.triangles
      .filter(({ surface }) => surface === "front-closure");
    assert.ok(frontClosure.length > 0);
    assert.ok(frontClosure.every(({ render }) => render === false));
    assert.ok(geometry.frontPaint.length > 0);
    assert.ok(geometry.frontPaint.every((triangle) =>
      triangle.vertices.every((vertex) => vertex.position[1] > 0)));
    const clearance = geometry.attachmentProfile.minimumShoulderClearanceCssPx;
    assert.ok(clearance === null || clearance >= 0.5);
  }
});

test("standalone rear-long hair separates its front paint from the rear shell", async () => {
  for (const row of remainingRows.filter(({ strategy }) => strategy === "rear-long")) {
    const { geometry, manifest } = await loadGeometry(row.family, row.sourceId);
    assert.deepEqual(manifest.dependencies, []);
    assert.equal(geometry.displayGroups.behindHead.mesh, true);
    assert.equal(geometry.displayGroups.behindHead.paint, false);
    assert.equal(geometry.displayGroups.frontHair.mesh, false);
    assert.equal(geometry.displayGroups.frontHair.paint, true);
    assert.ok(geometry.frontPaint.length > 0);
    assert.ok(geometry.mesh.rearBoundary.length > 0);
    const frontClosure = geometry.mesh.triangles
      .filter(({ surface }) => surface === "front-closure");
    assert.ok(frontClosure.length > 0);
    assert.ok(frontClosure.every(({ render }) => render === false));
    assert.ok(geometry.mesh.vertices.every(({ position }) => position[1] > 0));
    assert.ok(geometry.frontPaint.every((triangle) =>
      triangle.vertices.every(({ position }) => position[1] < 0)));
    assert.ok(geometry.metrics.minimumFrontPaintClearanceCssPx >= 0.7);
  }
});

test("the empty background source remains explicit and non-rendering", async () => {
  const { geometry, manifest } = await loadGeometry("hairBg", "none");
  assert.equal(geometry.empty, true);
  assert.equal(geometry.metrics.triangleCount, 0);
  assert.deepEqual(manifest.materialRoles, []);
  assert.deepEqual(manifest.dependencies, []);
});

test("hair support evidence names the package and strategy gates", () => {
  for (const family of ["hair", "hairBg"]) {
    for (const row of compatibility.families[family].ids) {
      assert.equal(row.support, "supported");
      assert.deepEqual(row.evidence, [
        "contract:cssface.facesjs-hair-component@1",
        "test:facesjs-hair-components",
      ]);
    }
  }
});
