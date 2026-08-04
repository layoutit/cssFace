import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { svgs, svgsIndex } from "facesjs";

import {
  validateFacesJsComponentCatalog,
  validateFacesJsComponentManifest,
} from "../.build/prepare/src/adapters/facesjs/model-package/componentPackage.js";
import {
  parseSvgFragment,
} from "../src/adapters/facesjs/scripts/svgGeometry.mjs";

const compatibility = JSON.parse(await readFile(
  new URL("../src/adapters/facesjs/compatibility.json", import.meta.url),
  "utf8",
));
const catalogDocument = JSON.parse(await readFile(
  new URL("../src/adapters/facesjs/component-catalog.json", import.meta.url),
  "utf8",
));
const sourceIndex = Object.fromEntries(Object.entries(compatibility.families)
  .map(([family, row]) => [
    family,
    Object.fromEntries(row.ids.map((entry) => [entry.id, entry.sourceSha256])),
  ]));
const allowedRoles = new Set([
  "frame-dark",
  "highlight",
  "ink",
  "lens",
  "team-primary",
  "team-secondary",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function roleForPaint(value, kind) {
  const color = value.toLowerCase();
  if (color === "none") return null;
  if (color === "#000" || color === "#000000") return "ink";
  if (color === "#333" || color === "#333333") return "frame-dark";
  if (color === "#fff" || color === "#ffffff") return "highlight";
  if (color === "rgba(150,150,175,.5)") return "lens";
  if (color === "$[primary]") return "team-primary";
  if (color === "$[secondary]") return "team-secondary";
  throw new Error(`Unmapped glasses ${kind} paint ${value}.`);
}

function pointsFor(geometry, stateId = null) {
  return geometry.instances[0].triangles.flatMap((triangle) =>
    stateId === null ? triangle.points : triangle.states[stateId]);
}

function spanX(points) {
  return Math.max(...points.map((point) => point[0]))
    - Math.min(...points.map((point) => point[0]));
}

async function loadGeometry(family, sourceId) {
  const path = new URL(
    `../public/facesjs-components/components/${family}/${sourceId}/assets/geometry.json.gz`,
    import.meta.url,
  );
  return JSON.parse(gunzipSync(await readFile(path)));
}

test("SVG groups preserve inherited glasses stroke semantics", () => {
  const facemask = parseSvgFragment(svgs.glasses.facemask);
  assert.equal(facemask.length, 3);
  assert.ok(facemask.every(({ strokeWidth }) => strokeWidth === 2));
  assert.deepEqual(facemask.map(({ fill }) => fill), [
    "rgba(150,150,175,.5)",
    "#333",
    "none",
  ]);
});

test("all seven glasses ids are explicit raised source-bound components", async () => {
  const catalog = await validateFacesJsComponentCatalog(catalogDocument, sourceIndex);
  const rows = catalog.components.filter(({ family }) => family === "glasses");
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map(({ sourceId }) => sourceId).sort(), [...svgsIndex.glasses].sort());
  let emptyCount = 0;
  for (const row of rows) {
    const packageRoot = new URL(
      `../public/facesjs-components/components/glasses/${row.sourceId}/`,
      import.meta.url,
    );
    const manifestBytes = await readFile(new URL("manifest.json", packageRoot));
    assert.equal(sha256(manifestBytes), row.manifestSha256);
    const manifest = await validateFacesJsComponentManifest(
      JSON.parse(manifestBytes),
      sourceIndex,
    );
    assert.equal(manifest.layer, 14);
    assert.equal(manifest.attachment, "raised");
    assert.deepEqual(manifest.dependencies, []);
    assert.ok(manifest.materialRoles.every((role) => allowedRoles.has(role)));
    const compressed = await readFile(new URL(manifest.assets.geometry.path, packageRoot));
    assert.equal(compressed.byteLength, manifest.assets.geometry.bytes);
    assert.equal(sha256(compressed), manifest.assets.geometry.sha256);
    const geometry = JSON.parse(gunzipSync(compressed));
    assert.equal(geometry.attachment, "raised");
    assert.equal(geometry.attachmentProjection, "raised-head-surface");
    assert.equal(geometry.layer, 14);
    assert.deepEqual(geometry.stateIds, ["fatness"]);
    assert.deepEqual(geometry.materialRoles, manifest.materialRoles);
    assert.equal(geometry.instances.length, 1);
    assert.equal(geometry.instances[0].position, null);
    assert.deepEqual(geometry.instances[0].stateIds, ["fatness"]);
    if (row.sourceId === "none") {
      emptyCount += 1;
      assert.equal(geometry.empty, true);
      assert.equal(geometry.metrics.triangleCount, 0);
      continue;
    }
    assert.equal(geometry.empty, false);
    assert.ok(geometry.metrics.minimumClearanceCssPx >= 0.72);
    assert.ok(geometry.metrics.sourceBounds.minimumX < 100);
    assert.ok(geometry.metrics.sourceBounds.maximumX > 300);
    const sourceRoles = [...new Set(parseSvgFragment(svgs.glasses[row.sourceId])
      .flatMap((path) => [
        roleForPaint(path.fill, "fill"),
        roleForPaint(path.stroke, "stroke"),
      ])
      .filter(Boolean))].sort();
    assert.deepEqual(geometry.materialRoles, sourceRoles);
    const lifts = geometry.instances[0].triangles.map(({ surfaceLift }) => surfaceLift);
    assert.ok(Math.min(...lifts) >= 0.072);
    assert.ok(Math.max(...lifts) <= 0.078);
    const basePoints = pointsFor(geometry);
    const fatPoints = pointsFor(geometry, "fatness");
    assert.ok(spanX(fatPoints) > spanX(basePoints) * 1.2);
    assert.ok(spanX(fatPoints) < spanX(basePoints) * 1.27);
    assert.ok(basePoints.some((point) => point[0] < 200));
    assert.ok(basePoints.some((point) => point[0] > 200));
  }
  assert.equal(emptyCount, 1);
});

test("glasses stay above every prepared face-surface feature", async () => {
  const glasses = await loadGeometry("glasses", "glasses1-primary");
  const glassesMinimum = Math.min(...glasses.instances[0].triangles
    .map(({ surfaceLift }) => surfaceLift));
  for (const [family, sourceId] of [
    ["eye", "eye1"],
    ["eyebrow", "eyebrow1"],
    ["mouth", "smile"],
    ["nose", "nose3"],
  ]) {
    const feature = await loadGeometry(family, sourceId);
    const maximum = Math.max(...feature.instances.flatMap((instance) =>
      instance.triangles.map(({ surfaceLift }) => surfaceLift)));
    assert.ok(maximum < glassesMinimum, `${family} must stay behind glasses`);
  }
});

test("glasses support evidence is package-backed", () => {
  assert.equal(compatibility.families.glasses.ids.length, 7);
  for (const entry of compatibility.families.glasses.ids) {
    assert.equal(entry.support, "supported");
    assert.deepEqual(entry.evidence, [
      "contract:cssface.facesjs-projected-component@1",
      "test:facesjs-glasses",
    ]);
  }
});
