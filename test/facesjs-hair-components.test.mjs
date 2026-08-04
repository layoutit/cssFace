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
  FACES_JS_B11_HAIR_STRATEGIES,
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
const expectedRows = strategyDocument.entries.filter((entry) => entry.family === "hair"
  && FACES_JS_B11_HAIR_STRATEGIES.includes(entry.strategy));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function loadGeometry(sourceId) {
  const packageRoot = new URL(
    `../public/facesjs-components/components/hair/${sourceId}/`,
    import.meta.url,
  );
  const manifestBytes = await readFile(new URL("manifest.json", packageRoot));
  const manifest = await validateFacesJsComponentManifest(
    JSON.parse(manifestBytes),
    sourceIndex,
  );
  const geometryBytes = await readFile(new URL(manifest.assets.geometry.path, packageRoot));
  assert.equal(sha256(manifestBytes), catalogDocument.components
    .find((row) => row.family === "hair" && row.sourceId === sourceId).manifestSha256);
  assert.equal(geometryBytes.byteLength, manifest.assets.geometry.bytes);
  assert.equal(sha256(geometryBytes), manifest.assets.geometry.sha256);
  return { geometry: JSON.parse(gunzipSync(geometryBytes)), manifest };
}

test("all B11 hair strategies are source-bound reusable components", async () => {
  const catalog = await validateFacesJsComponentCatalog(catalogDocument, sourceIndex);
  const expectedIds = new Set(expectedRows.map(({ sourceId }) => sourceId));
  const allRows = catalog.components.filter(({ family }) => family === "hair");
  const rows = allRows.filter(({ sourceId }) => expectedIds.has(sourceId));
  assert.equal(rows.length, 36);
  assert.deepEqual(rows.map(({ sourceId }) => sourceId).sort(), expectedRows
    .map(({ sourceId }) => sourceId).sort());
  assert.equal(allRows.length, svgsIndex.hair.length);
  for (const row of expectedRows) {
    const { geometry, manifest } = await loadGeometry(row.sourceId);
    assert.equal(manifest.layer, 13);
    assert.equal(manifest.attachment, "head-shell");
    assert.deepEqual(manifest.dependencies, []);
    assert.equal(geometry.schema, FACES_JS_HAIR_COMPONENT_SCHEMA);
    assert.equal(geometry.family, "hair");
    assert.equal(geometry.sourceId, row.sourceId);
    assert.equal(geometry.sourceSha256, row.sourceSha256);
    assert.equal(geometry.strategy, row.strategy);
    assert.equal(geometry.geometryContract, row.geometryContract);
    assert.deepEqual(geometry.accessorySubstitution, row.accessorySubstitution);
    assert.deepEqual(geometry.attachmentProfile.compatibleSourceIds.sort(), [...svgsIndex.head].sort());
    const { contentHash, ...payload } = geometry;
    assert.equal(contentHash, sha256(JSON.stringify(payload)));
  }
});

test("cap, fade, and raised hair use closed non-degenerate source-shaped shells", async () => {
  for (const row of expectedRows.filter(({ strategy }) => strategy !== "empty-bald")) {
    const { geometry, manifest } = await loadGeometry(row.sourceId);
    assert.equal(geometry.empty, false);
    assert.deepEqual(geometry.stateIds, ["fatness", "hair-flip", "hair-flip-fatness"]);
    assert.equal(geometry.provenance.frontSilhouette, "facesjs-svg-fill-contours");
    assert.match(geometry.provenance.depthProfile, /^adapter-authored-/u);
    assert.equal(geometry.provenance.rearClosure, "adapter-authored-welded-side-and-rear-shell");
    assert.equal(geometry.metrics.boundaryEdgeCount, 0);
    assert.equal(geometry.metrics.nonManifoldEdgeCount, 0);
    assert.equal(geometry.metrics.connected, true);
    assert.ok(geometry.metrics.minimumTriangleArea > 0);
    assert.ok(geometry.metrics.signedVolume > 0);
    assert.equal(geometry.metrics.frontSilhouetteErrorCssPx, 0);
    assert.ok(geometry.metrics.minimumFrontPaintClearanceCssPx >= 0.7);
    assert.ok(geometry.attachmentProfile.minimumOverlapPoints > 0);
    const frontClosure = geometry.mesh.triangles
      .filter(({ surface }) => surface === "front-closure");
    assert.ok(frontClosure.length > 0);
    assert.ok(frontClosure.every(({ render }) => render === false));
    assert.ok(geometry.mesh.triangles.some(({ surface }) => surface === "rear"));
    assert.ok(geometry.mesh.frontBoundary.length > 20);
    assert.ok(geometry.mesh.rearBoundary.length > geometry.mesh.frontBoundary.length);
    assert.ok(geometry.captureBounds.side.maximumX - geometry.captureBounds.side.minimumX > 0.2);
    assert.ok(geometry.captureBounds.side.maximumY - geometry.captureBounds.side.minimumY > 0.45);
    assert.deepEqual(manifest.materialRoles, geometry.materialRoles);
    assert.ok(geometry.materialRoles.includes(row.strategy === "fade" ? "hair-fade" : "hair"));

    for (const vertex of geometry.mesh.vertices) {
      assert.ok(Math.abs(vertex.states.fatness[0] - (vertex.position[0] / 0.8)) < 2e-8);
      assert.ok(Math.abs(vertex.states["hair-flip"][0] + vertex.position[0]) < 2e-8);
      assert.ok(Math.abs(vertex.states["hair-flip-fatness"][0] + vertex.states.fatness[0]) < 2e-8);
      for (const state of Object.values(vertex.states)) {
        assert.ok(state.every(Number.isFinite));
      }
    }

    const sourceBoundary = geometry.mesh.frontBoundary
      .map((index) => geometry.mesh.vertices[index].source);
    const projectedWidth = geometry.captureBounds.front.maximumX - geometry.captureBounds.front.minimumX;
    const sourceWidth = (Math.max(...sourceBoundary.map((point) => point[0]))
      - Math.min(...sourceBoundary.map((point) => point[0]))) * (1.07 / 150) * 0.8;
    assert.ok(Math.abs(projectedWidth - sourceWidth) < 1e-6);
  }
});

test("fade geometry preserves the exact source gradient stops", async () => {
  for (const row of expectedRows.filter(({ strategy }) => strategy === "fade")) {
    const { geometry } = await loadGeometry(row.sourceId);
    assert.equal(geometry.gradient.id, "a");
    assert.ok(geometry.gradient.stops.length >= 2);
    assert.equal(geometry.gradient.stops[0].offset, 0);
    assert.equal(geometry.gradient.stops.at(-1).offset, 1);
    assert.ok(geometry.gradient.stops.every(({ opacity }) => opacity >= 0 && opacity <= 1));
    assert.ok(geometry.frontPaint.some(({ material }) => material.role === "hair-fade"));
  }
});

test("bald is an intentional zero-geometry component", async () => {
  const { geometry, manifest } = await loadGeometry("bald");
  assert.equal(geometry.empty, true);
  assert.equal(geometry.metrics.triangleCount, 0);
  assert.deepEqual(geometry.mesh.vertices, []);
  assert.deepEqual(geometry.mesh.triangles, []);
  assert.deepEqual(manifest.materialRoles, []);
});
