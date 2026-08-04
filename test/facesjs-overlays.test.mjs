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
  FACES_JS_PROJECTED_COMPONENT_SCHEMA,
} from "../src/adapters/facesjs/scripts/projectedComponentCompiler.mjs";
import {
  parseSvgFragment,
} from "../src/adapters/facesjs/scripts/svgGeometry.mjs";

const overlayFamilies = ["eyeLine", "smileLine", "miscLine", "facialHair"];
const expectedCounts = { eyeLine: 7, smileLine: 5, miscLine: 11, facialHair: 83 };
const expectedLayers = { eyeLine: 5, smileLine: 6, miscLine: 7, facialHair: 8 };
const expectedStates = {
  eyeLine: [],
  smileLine: ["smile-line-size-max", "smile-line-size-min"],
  miscLine: [],
  facialHair: ["fatness"],
};
const expectedEmptyIds = new Set(overlayFamilies.map((family) => `${family}:none`));
const allowedRoles = new Set([
  "blush",
  "freckle",
  "hair",
  "ink",
  "team-primary",
]);

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function roleForPaint(value) {
  const color = value.toLowerCase();
  if (color === "none") return null;
  if (color === "$[haircolor]") return "hair";
  if (color === "$[primary]") return "team-primary";
  if (color === "#000" || color === "#000000") return "ink";
  if (color === "#a15757") return "blush";
  if (color === "#8b6135") return "freckle";
  throw new Error(`Unmapped overlay paint ${value}.`);
}

function area(points) {
  return Math.abs(
    ((points[0][0] * (points[1][1] - points[2][1]))
      + (points[1][0] * (points[2][1] - points[0][1]))
      + (points[2][0] * (points[0][1] - points[1][1]))) * 0.5,
  );
}

function pointsFor(instance, stateId = null) {
  return instance.triangles.flatMap((triangle) =>
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

test("overlay SVG parsing keeps translucent fills and blend semantics", () => {
  const blush = parseSvgFragment(svgs.miscLine.blush);
  assert.deepEqual(blush.map(({ element }) => element), ["path", "ellipse", "ellipse"]);
  assert.deepEqual(blush.map(({ opacity }) => opacity), [0.251, 0.25, 0.25]);
  const freckles = parseSvgFragment(svgs.miscLine.freckles1);
  assert.equal(freckles[0].opacity, 0.251);
  assert.equal(freckles[0].mixBlendMode, "multiply");
});

test("all 106 overlay ids are explicit source-bound component packages", async () => {
  const catalog = await validateFacesJsComponentCatalog(catalogDocument, sourceIndex);
  const rows = catalog.components.filter(({ family }) => overlayFamilies.includes(family));
  assert.equal(rows.length, 106);
  assert.deepEqual(Object.fromEntries(overlayFamilies.map((family) => [
    family,
    rows.filter((row) => row.family === family).length,
  ])), expectedCounts);

  const liftRanges = Object.fromEntries(overlayFamilies.map((family) => [
    family,
    { minimum: Infinity, maximum: -Infinity },
  ]));
  let emptyCount = 0;
  for (const row of rows) {
    const packageRoot = new URL(
      `../public/facesjs-components/components/${row.family}/${row.sourceId}/`,
      import.meta.url,
    );
    const manifestBytes = await readFile(new URL("manifest.json", packageRoot));
    assert.equal(sha256(manifestBytes), row.manifestSha256);
    const manifest = await validateFacesJsComponentManifest(
      JSON.parse(manifestBytes),
      sourceIndex,
    );
    assert.equal(manifest.family, row.family);
    assert.equal(manifest.sourceId, row.sourceId);
    assert.equal(manifest.sourceSha256, sourceIndex[row.family][row.sourceId]);
    assert.equal(manifest.layer, expectedLayers[row.family]);
    assert.equal(manifest.attachment, "face-surface");
    assert.deepEqual(manifest.dependencies, []);
    assert.ok(manifest.materialRoles.every((role) => allowedRoles.has(role)));

    const descriptor = manifest.assets.geometry;
    const compressed = await readFile(new URL(descriptor.path, packageRoot));
    assert.equal(compressed.byteLength, descriptor.bytes);
    assert.equal(sha256(compressed), descriptor.sha256);
    const geometry = JSON.parse(gunzipSync(compressed));
    assert.equal(geometry.schema, FACES_JS_PROJECTED_COMPONENT_SCHEMA);
    assert.equal(geometry.family, row.family);
    assert.equal(geometry.sourceId, row.sourceId);
    assert.equal(geometry.layer, row.layer);
    assert.deepEqual(geometry.attachmentProfileIds, ["head1"]);
    assert.deepEqual(geometry.stateIds, expectedStates[row.family]);
    assert.deepEqual(geometry.materialRoles, manifest.materialRoles);
    assert.equal(geometry.instances.length, row.family === "smileLine" ? 2 : 1);
    assert.equal(geometry.metrics.triangleCount, geometry.instances
      .reduce((sum, instance) => sum + instance.triangles.length, 0));
    const shouldBeEmpty = expectedEmptyIds.has(`${row.family}:${row.sourceId}`);
    assert.equal(geometry.empty, shouldBeEmpty);
    assert.equal(svgs[row.family][row.sourceId].trim() === "", shouldBeEmpty);
    if (shouldBeEmpty) {
      emptyCount += 1;
      assert.equal(geometry.metrics.triangleCount, 0);
      assert.equal(geometry.metrics.minimumTriangleArea, null);
      assert.equal(geometry.metrics.minimumClearanceCssPx, null);
      assert.equal(geometry.metrics.sourceBounds, null);
      assert.deepEqual(geometry.materialRoles, []);
      continue;
    }

    assert.ok(geometry.metrics.minimumClearanceCssPx >= 0.72);
    assert.ok(geometry.metrics.minimumTriangleArea > 0);
    assert.ok(geometry.metrics.sourceBounds);
    const sourceRoles = [...new Set(parseSvgFragment(svgs[row.family][row.sourceId])
      .flatMap((path) => [roleForPaint(path.fill), roleForPaint(path.stroke)])
      .filter(Boolean))].sort();
    assert.deepEqual(geometry.materialRoles, sourceRoles);
    if (svgs[row.family][row.sourceId].includes("$[hairColor]")) {
      assert.ok(geometry.materialRoles.includes("hair"));
    }
    for (const instance of geometry.instances) {
      assert.deepEqual(instance.stateIds, expectedStates[row.family]);
      let previousPathIndex = -1;
      const operationLifts = new Map();
      for (const triangle of instance.triangles) {
        assert.ok(triangle.pathIndex >= previousPathIndex);
        previousPathIndex = triangle.pathIndex;
        assert.ok(area(triangle.points) > 0);
        assert.ok(allowedRoles.has(triangle.material.role));
        assert.ok(triangle.material.opacity >= 0 && triangle.material.opacity <= 1);
        assert.deepEqual(Object.keys(triangle.states), expectedStates[row.family]);
        for (const points of Object.values(triangle.states)) assert.ok(area(points) > 0);
        const operation = `${triangle.pathIndex}:${triangle.kind}`;
        const existing = operationLifts.get(operation);
        if (existing !== undefined) assert.equal(triangle.surfaceLift, existing);
        operationLifts.set(operation, triangle.surfaceLift);
        liftRanges[row.family].minimum = Math.min(
          liftRanges[row.family].minimum,
          triangle.surfaceLift,
        );
        liftRanges[row.family].maximum = Math.max(
          liftRanges[row.family].maximum,
          triangle.surfaceLift,
        );
      }
      assert.equal(new Set(operationLifts.values()).size, operationLifts.size);
    }
    const { contentHash, ...payload } = geometry;
    assert.equal(contentHash, sha256(JSON.stringify(payload)));
  }
  assert.equal(emptyCount, 4);
  for (let index = 0; index < overlayFamilies.length - 1; index += 1) {
    const current = liftRanges[overlayFamilies[index]];
    const next = liftRanges[overlayFamilies[index + 1]];
    assert.ok(current.maximum < next.minimum);
  }
  const eye = await loadGeometry("eye", "eye1");
  assert.ok(liftRanges.facialHair.maximum < Math.min(
    ...eye.instances.flatMap((instance) =>
      instance.triangles.map(({ surfaceLift }) => surfaceLift)),
  ));
});

test("overlay transform states retain paired smile sizing and facial-hair fatness", async () => {
  const smile = await loadGeometry("smileLine", "line1");
  assert.deepEqual(smile.instances.map(({ position }) => position), [[150, 435], [250, 435]]);
  assert.deepEqual(smile.instances.map(({ pairedMirror }) => pairedMirror), [false, true]);
  for (const instance of smile.instances) {
    const baseSpan = spanX(pointsFor(instance));
    const minimumSpan = spanX(pointsFor(instance, "smile-line-size-min"));
    const maximumSpan = spanX(pointsFor(instance, "smile-line-size-max"));
    assert.ok(minimumSpan < baseSpan * 0.5);
    assert.ok(maximumSpan > baseSpan * 2);
  }
  const left = pointsFor(smile.instances[0]);
  const right = pointsFor(smile.instances[1]);
  assert.equal(left.length, right.length);
  for (let index = 0; index < left.length; index += 1) {
    assert.ok(Math.abs((left[index][0] + right[index][0]) - 400) < 1e-6);
    assert.ok(Math.abs(left[index][1] - right[index][1]) < 1e-6);
  }

  const beard = await loadGeometry("facialHair", "beard1");
  assert.equal(beard.instances[0].position, null);
  const baseSpan = spanX(pointsFor(beard.instances[0]));
  const fatSpan = spanX(pointsFor(beard.instances[0], "fatness"));
  assert.ok(fatSpan > baseSpan * 1.2);
  assert.ok(fatSpan < baseSpan * 1.27);
});

test("overlay support evidence is recorded only for generated packages", () => {
  for (const family of overlayFamilies) {
    assert.equal(compatibility.families[family].ids.length, expectedCounts[family]);
    for (const entry of compatibility.families[family].ids) {
      assert.equal(entry.support, "supported");
      assert.deepEqual(entry.evidence, [
        "contract:cssface.facesjs-projected-component@1",
        "test:facesjs-overlays",
      ]);
    }
  }
});
