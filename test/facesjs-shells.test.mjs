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
  FACES_JS_SHELL_COMPONENT_SCHEMA,
} from "../src/adapters/facesjs/scripts/shellComponentCompiler.mjs";

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

function signedVolume(vertices, triangles, stateId = null) {
  return triangles.reduce((sum, triangle) => {
    const points = triangle.indices.map((index) => stateId === null
      ? vertices[index].position
      : vertices[index].states[stateId]);
    const [first, second, third] = points;
    return sum + ((first[0] * ((second[1] * third[2]) - (second[2] * third[1])))
      - (first[1] * ((second[0] * third[2]) - (second[2] * third[0])))
      + (first[2] * ((second[0] * third[1]) - (second[1] * third[0])))) / 6;
  }, 0);
}

async function loadGeometry(family, sourceId) {
  const path = new URL(
    `../public/facesjs-components/components/${family}/${sourceId}/assets/geometry.json.gz`,
    import.meta.url,
  );
  return JSON.parse(gunzipSync(await readFile(path)));
}

test("all 21 heads are distinct source-contour closed shells", async () => {
  const catalog = await validateFacesJsComponentCatalog(catalogDocument, sourceIndex);
  const rows = catalog.components.filter(({ family }) => family === "head");
  assert.equal(rows.length, 21);
  assert.deepEqual(rows.map(({ sourceId }) => sourceId).sort(), [...svgsIndex.head].sort());
  const geometryHashes = new Set();
  let triangleCount = 0;
  for (const row of rows) {
    const packageRoot = new URL(
      `../public/facesjs-components/components/head/${row.sourceId}/`,
      import.meta.url,
    );
    const manifestBytes = await readFile(new URL("manifest.json", packageRoot));
    assert.equal(sha256(manifestBytes), row.manifestSha256);
    const manifest = await validateFacesJsComponentManifest(
      JSON.parse(manifestBytes),
      sourceIndex,
    );
    assert.equal(manifest.layer, 4);
    assert.equal(manifest.attachment, "head-shell");
    assert.deepEqual(manifest.dependencies, []);
    assert.ok(manifest.materialRoles.includes("skin"));
    const compressed = await readFile(new URL(manifest.assets.geometry.path, packageRoot));
    assert.equal(compressed.byteLength, manifest.assets.geometry.bytes);
    assert.equal(sha256(compressed), manifest.assets.geometry.sha256);
    const geometry = JSON.parse(gunzipSync(compressed));
    assert.equal(geometry.schema, FACES_JS_SHELL_COMPONENT_SCHEMA);
    assert.equal(geometry.family, "head");
    assert.equal(geometry.sourceId, row.sourceId);
    assert.equal(geometry.sourceSha256, sourceIndex.head[row.sourceId]);
    assert.equal(geometry.attachment, "head-shell");
    assert.deepEqual(geometry.stateIds, ["fatness"]);
    assert.equal(geometry.provenance.frontSilhouette, "facesjs-svg-contour");
    assert.equal(geometry.provenance.depthProfile, "adapter-authored-elliptic-sweep");
    assert.equal(geometry.provenance.rearClosure, "adapter-authored-elliptic-sweep");
    assert.equal(geometry.metrics.boundaryEdgeCount, 0);
    assert.equal(geometry.metrics.nonManifoldEdgeCount, 0);
    assert.equal(geometry.metrics.connected, true);
    assert.ok(geometry.metrics.minimumTriangleArea > 0);
    assert.ok(geometry.metrics.signedVolume > 0);
    assert.ok(geometry.metrics.frontSilhouetteErrorCssPx <= 0.75);
    assert.ok(geometry.mesh.triangles.some(({ surface }) => surface === "front"));
    assert.ok(geometry.mesh.triangles.some(({ surface }) => surface === "rear"));
    assert.ok(geometry.mesh.frontBoundary.length > 20);
    assert.equal(
      geometry.mesh.vertices.filter(({ source }) => Math.abs(source[1] - 480) <= 1e-7).length,
      24,
    );
    assert.ok(signedVolume(geometry.mesh.vertices, geometry.mesh.triangles) > 0);
    assert.ok(signedVolume(geometry.mesh.vertices, geometry.mesh.triangles, "fatness") > 0);
    for (const vertex of geometry.mesh.vertices) {
      assert.ok(Math.abs(vertex.states.fatness[0] - (vertex.position[0] / 0.8)) < 1e-6);
      assert.equal(vertex.states.fatness[1], vertex.position[1]);
      assert.equal(vertex.states.fatness[2], vertex.position[2]);
    }
    const sourceRoles = svgs.head[row.sourceId].includes("$[headShave]")
      ? ["face-shave", "head-shave", "skin"]
      : ["skin"];
    assert.deepEqual(geometry.materialRoles, sourceRoles);
    assert.deepEqual(manifest.materialRoles, sourceRoles);
    assert.deepEqual(
      [...new Set(geometry.paintRegions.map(({ role }) => role))].sort(),
      sourceRoles.filter((role) => role !== "skin"),
    );
    const { contentHash, ...payload } = geometry;
    assert.equal(contentHash, sha256(JSON.stringify(payload)));
    geometryHashes.add(contentHash);
    triangleCount += geometry.metrics.triangleCount;
  }
  assert.equal(geometryHashes.size, 21);
  assert.equal(triangleCount, 90_192);
});

test("all three ears are closed paired shells across size and fatness endpoints", async () => {
  const catalog = await validateFacesJsComponentCatalog(catalogDocument, sourceIndex);
  const rows = catalog.components.filter(({ family }) => family === "ear");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(({ sourceId }) => sourceId).sort(), [...svgsIndex.ear].sort());
  let triangleCount = 0;
  for (const row of rows) {
    const packageRoot = new URL(
      `../public/facesjs-components/components/ear/${row.sourceId}/`,
      import.meta.url,
    );
    const manifestBytes = await readFile(new URL("manifest.json", packageRoot));
    assert.equal(sha256(manifestBytes), row.manifestSha256);
    const manifest = await validateFacesJsComponentManifest(
      JSON.parse(manifestBytes),
      sourceIndex,
    );
    assert.equal(manifest.layer, 3);
    assert.equal(manifest.attachment, "head-shell");
    assert.deepEqual(manifest.materialRoles, ["ink", "skin"]);
    const geometry = await loadGeometry("ear", row.sourceId);
    assert.equal(geometry.schema, FACES_JS_SHELL_COMPONENT_SCHEMA);
    assert.deepEqual(geometry.stateIds, ["ear-size", "ear-size-fatness", "fatness"]);
    assert.equal(geometry.provenance.depthProfile, "adapter-authored-extrusion");
    assert.equal(geometry.metrics.boundaryEdgeCount, 0);
    assert.equal(geometry.metrics.nonManifoldEdgeCount, 0);
    assert.ok(geometry.metrics.minimumTriangleArea > 0);
    assert.deepEqual(
      geometry.attachmentProfile.compatibleSourceIds,
      [...svgsIndex.head].sort(),
    );
    assert.equal(geometry.instances.length, 2);
    assert.deepEqual(geometry.instances.map(({ side }) => side), ["left", "right"]);
    for (const instance of geometry.instances) {
      assert.ok(signedVolume(instance.vertices, instance.triangles) > 0);
      for (const stateId of ["ear-size", "ear-size-fatness", "fatness"]) {
        assert.ok(signedVolume(instance.vertices, instance.triangles, stateId) > 0);
      }
      assert.ok(instance.vertices.some(({ source }) => source[0] < instance.anchor[0]));
      assert.ok(instance.vertices.some(({ source }) => source[0] > instance.anchor[0]));
    }
    triangleCount += geometry.metrics.triangleCount;
  }
  assert.equal(triangleCount, 416);
});

test("the component preparer uses every selected FacesJS contour without substitution", async () => {
  const source = await readFile(
    new URL("../src/adapters/facesjs/scripts/prepareProjectedComponents.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes("compileFacesJsShellComponent"));
  assert.ok(source.includes("svgsIndex.head.map"));
  assert.ok(source.includes("svgs.head[sourceId]"));
  assert.ok(!source.includes("FACELINE_BY_HEAD_ID"));
  assert.ok(!source.includes("index % 8"));
  assert.ok(!source.includes("RFL_Res.dat"));
  assert.ok(!source.includes("rom-backed-faceline"));
});

test("head and ear support evidence is shell-package-backed", () => {
  for (const family of ["head", "ear"]) {
    for (const entry of compatibility.families[family].ids) {
      assert.equal(entry.support, "supported");
      assert.deepEqual(entry.evidence, [
        "contract:cssface.facesjs-shell-component@1",
        "test:facesjs-shells",
      ]);
    }
  }
});
