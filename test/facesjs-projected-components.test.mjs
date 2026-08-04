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
  boundsOfPaths,
  parseSvgFragment,
} from "../src/adapters/facesjs/scripts/svgGeometry.mjs";

const projectedFamilies = ["eye", "eyebrow", "mouth", "nose"];
const expectedCounts = { eye: 35, eyebrow: 30, mouth: 17, nose: 17 };
const expectedLayers = { eye: 9, eyebrow: 10, mouth: 11, nose: 12 };
const expectedStates = {
  eye: ["eye-angle-negative", "eye-angle-positive"],
  eyebrow: ["brow-down", "brow-up"],
  mouth: ["mouth-flip"],
  nose: ["nose-flip", "nose-size-max", "nose-size-min"],
};
const allowedRoles = new Set([
  "eye-off-white",
  "eye-white",
  "hair",
  "ink",
  "mouth-dark",
  "skin",
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

function area(points) {
  return Math.abs(
    ((points[0][0] * (points[1][1] - points[2][1]))
      + (points[1][0] * (points[2][1] - points[0][1]))
      + (points[2][0] * (points[0][1] - points[1][1]))) * 0.5,
  );
}

function roleForPaint(value) {
  const color = value.toLowerCase();
  if (color === "none") return null;
  if (color === "$[haircolor]") return "hair";
  if (color === "$[skincolor]") return "skin";
  if (color === "#fff" || color === "#ffffff") return "eye-white";
  if (color === "#f5f3ee") return "eye-off-white";
  if (color === "#501414") return "mouth-dark";
  if (color === "#000" || color === "#000000") return "ink";
  throw new Error(`Unmapped test paint ${value}`);
}

function flattenedPoints(instance, stateId = null, kind = null) {
  return instance.triangles
    .filter((triangle) => kind === null || triangle.kind === kind)
    .flatMap((triangle) => stateId === null ? triangle.points : triangle.states[stateId]);
}

test("SVG geometry preserves source order, circles, ellipses, and transforms", () => {
  assert.deepEqual(
    parseSvgFragment(svgs.eye.female10).map(({ element }) => element),
    ["path", "path", "ellipse", "path"],
  );
  assert.deepEqual(
    parseSvgFragment(svgs.eye.female11).map(({ element }) => element),
    ["circle", "circle", "path"],
  );
  const rotated = parseSvgFragment(svgs.eye.female13)
    .find(({ element }) => element === "ellipse");
  assert.ok(rotated, "female13 keeps its transformed ellipse");
  const bounds = boundsOfPaths([rotated]);
  assert.ok(bounds.maximumX - bounds.minimumX > bounds.maximumY - bounds.minimumY);
  for (const family of projectedFamilies) {
    for (const sourceId of svgsIndex[family]) {
      assert.ok(parseSvgFragment(svgs[family][sourceId]).length > 0);
    }
  }
});

test("all 99 ordinary projected components are source-bound prepared packages", async () => {
  const catalog = await validateFacesJsComponentCatalog(catalogDocument, sourceIndex);
  const ordinaryComponents = catalog.components.filter(({ family }) =>
    projectedFamilies.includes(family));
  assert.equal(ordinaryComponents.length, 99);
  const actualCounts = Object.fromEntries(projectedFamilies.map((family) => [
    family,
    ordinaryComponents.filter((row) => row.family === family).length,
  ]));
  assert.deepEqual(actualCounts, expectedCounts);

  let triangleCount = 0;
  for (const row of ordinaryComponents) {
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
    assert.equal(geometry.sourceSha256, row.sourceSha256);
    assert.equal(geometry.layer, row.layer);
    assert.equal(geometry.attachment, "face-surface");
    assert.deepEqual(geometry.attachmentProfileIds, ["head1"]);
    assert.equal(geometry.empty, false);
    assert.deepEqual(geometry.materialRoles, manifest.materialRoles);
    assert.equal(geometry.instances.length, row.family === "eye" || row.family === "eyebrow" ? 2 : 1);
    assert.equal(geometry.metrics.triangleCount, geometry.instances
      .reduce((sum, instance) => sum + instance.triangles.length, 0));
    assert.ok(geometry.metrics.minimumClearanceCssPx >= 0.72);
    assert.ok(geometry.metrics.minimumTriangleArea > 0);
    assert.ok(geometry.metrics.sourceBounds);
    const { contentHash, ...payload } = geometry;
    assert.equal(contentHash, sha256(JSON.stringify(payload)));

    const sourceRoles = [...new Set(parseSvgFragment(svgs[row.family][row.sourceId])
      .flatMap((path) => [roleForPaint(path.fill), roleForPaint(path.stroke)])
      .filter(Boolean))].sort();
    assert.deepEqual(geometry.materialRoles, sourceRoles);
    for (const instance of geometry.instances) {
      assert.deepEqual(Object.keys(instance.triangles[0].states), expectedStates[row.family]);
      for (const triangle of instance.triangles) {
        assert.equal(triangle.points.length, 3);
        assert.ok(area(triangle.points) > 0);
        assert.ok(allowedRoles.has(triangle.material.role));
        assert.deepEqual(Object.keys(triangle.states), expectedStates[row.family]);
        for (const points of Object.values(triangle.states)) {
          assert.equal(points.length, 3);
          assert.ok(area(points) > 0);
        }
      }
    }
    triangleCount += geometry.metrics.triangleCount;
  }
  assert.equal(triangleCount, 13_082);
});

test("paired angles, flips, sizing, and Pinocchio alignment retain source hooks", async () => {
  const load = async (family, sourceId) => {
    const path = new URL(
      `../public/facesjs-components/components/${family}/${sourceId}/assets/geometry.json.gz`,
      import.meta.url,
    );
    return JSON.parse(gunzipSync(await readFile(path)));
  };
  const eye = await load("eye", "eye1");
  assert.deepEqual(eye.instances.map(({ position }) => position), [[140, 310], [260, 310]]);
  assert.deepEqual(eye.instances.map(({ pairedMirror }) => pairedMirror), [false, true]);

  const mouth = await load("mouth", "smile");
  const mouthBase = flattenedPoints(mouth.instances[0]);
  const mouthFlip = flattenedPoints(mouth.instances[0], "mouth-flip");
  for (let index = 0; index < mouthBase.length; index += 1) {
    assert.ok(Math.abs((mouthBase[index][0] + mouthFlip[index][0]) - 400) < 1e-6);
    assert.ok(Math.abs(mouthBase[index][1] - mouthFlip[index][1]) < 1e-6);
  }

  const nose = await load("nose", "nose3");
  const noseBase = flattenedPoints(nose.instances[0], null, "fill");
  const noseMinimum = flattenedPoints(nose.instances[0], "nose-size-min", "fill");
  const noseMaximum = flattenedPoints(nose.instances[0], "nose-size-max", "fill");
  const meanDistance = (points) => points.reduce(
    (sum, point) => sum + Math.hypot(point[0] - 200, point[1] - 370),
    0,
  ) / points.length;
  assert.ok(Math.abs(meanDistance(noseMinimum) / meanDistance(noseBase) - 0.5) < 1e-6);
  assert.ok(Math.abs(meanDistance(noseMaximum) / meanDistance(noseBase) - 1.25) < 1e-6);

  for (const sourceId of ["nose4", "pinocchio"]) {
    const projected = await load("nose", sourceId);
    const base = flattenedPoints(projected.instances[0], null, "fill");
    const flipped = flattenedPoints(projected.instances[0], "nose-flip", "fill");
    assert.ok(Math.abs(Math.min(...base.map((point) => point[0])) - 200) < 1e-6);
    assert.ok(Math.abs(Math.max(...flipped.map((point) => point[0])) - 200) < 1e-6);
  }
  assert.ok(expectedLayers.mouth < expectedLayers.nose);
});

test("compatibility support moves only after package evidence exists", () => {
  for (const family of projectedFamilies) {
    assert.equal(compatibility.families[family].ids.length, expectedCounts[family]);
    for (const entry of compatibility.families[family].ids) {
      assert.equal(entry.support, "supported");
      assert.deepEqual(entry.evidence, [
        "contract:cssface.facesjs-projected-component@1",
        "test:facesjs-projected-components",
      ]);
    }
  }
});
