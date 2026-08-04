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
  FACES_JS_BODY_REGION_SCHEMA,
} from "../src/adapters/facesjs/scripts/bodyRegionCompiler.mjs";
import {
  FACES_JS_BODY_NECK_OPENING_SOURCE_Y,
} from "../src/adapters/facesjs/scripts/componentPreparedCompiler.mjs";

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
    const [first, second, third] = triangle.indices.map((index) => stateId === null
      ? vertices[index].position
      : vertices[index].states[stateId]);
    return sum + ((first[0] * ((second[1] * third[2]) - (second[2] * third[1])))
      - (first[1] * ((second[0] * third[2]) - (second[2] * third[0])))
      + (first[2] * ((second[0] * third[1]) - (second[1] * third[0])))) / 6;
  }, 0);
}

async function loadPackage(family, sourceId) {
  const root = new URL(
    `../public/facesjs-components/components/${family}/${sourceId}/`,
    import.meta.url,
  );
  const manifestBytes = await readFile(new URL("manifest.json", root));
  const manifest = await validateFacesJsComponentManifest(
    JSON.parse(manifestBytes),
    sourceIndex,
  );
  const geometryBytes = await readFile(new URL(manifest.assets.geometry.path, root));
  assert.equal(geometryBytes.byteLength, manifest.assets.geometry.bytes);
  assert.equal(sha256(geometryBytes), manifest.assets.geometry.sha256);
  const preparedBytes = await readFile(new URL(manifest.assets.prepared.path, root));
  assert.equal(preparedBytes.byteLength, manifest.assets.prepared.bytes);
  assert.equal(sha256(preparedBytes), manifest.assets.prepared.sha256);
  return {
    root,
    manifestBytes,
    manifest,
    geometry: JSON.parse(gunzipSync(geometryBytes)),
    prepared: JSON.parse(gunzipSync(preparedBytes)),
  };
}

function assertBodySizeState(vertices) {
  for (const vertex of vertices) {
    const state = vertex.states["body-size"];
    assert.ok(state);
    assert.ok(Math.abs(state[0] - (vertex.position[0] * 1.05 / 0.8)) < 1e-6);
    assert.equal(state[1], vertex.position[1]);
    assert.equal(state[2], vertex.position[2]);
  }
}

function assertClosedRegion(geometry) {
  assert.equal(geometry.metrics.boundaryEdgeCount, 0);
  assert.equal(geometry.metrics.nonManifoldEdgeCount, 0);
  assert.equal(geometry.metrics.duplicateTriangleCount, 0);
  assert.equal(geometry.metrics.connected, true);
  assert.ok(geometry.metrics.minimumTriangleArea > 0);
  assert.ok(geometry.metrics.signedVolume > 0);
  assert.ok(signedVolume(geometry.mesh.vertices, geometry.mesh.triangles) > 0);
  assert.ok(signedVolume(geometry.mesh.vertices, geometry.mesh.triangles, "body-size") > 0);
  assertBodySizeState(geometry.mesh.vertices);
}

test("all five body ids are closed source-contour skin regions", async () => {
  const catalog = await validateFacesJsComponentCatalog(catalogDocument, sourceIndex);
  const rows = catalog.components.filter(({ family }) => family === "body");
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(({ sourceId }) => sourceId).sort(), [...svgsIndex.body].sort());
  let triangleCount = 0;
  for (const row of rows) {
    const loaded = await loadPackage("body", row.sourceId);
    assert.equal(sha256(loaded.manifestBytes), row.manifestSha256);
    assert.equal(loaded.manifest.layer, 1);
    assert.equal(loaded.manifest.attachment, "body-shell");
    assert.deepEqual(loaded.manifest.dependencies, []);
    assert.ok(loaded.manifest.materialRoles.includes("skin"));
    const { geometry } = loaded;
    assert.equal(geometry.schema, FACES_JS_BODY_REGION_SCHEMA);
    assert.equal(geometry.family, "body");
    assert.equal(geometry.sourceId, row.sourceId);
    assert.equal(geometry.sourceSha256, sourceIndex.body[row.sourceId]);
    assert.deepEqual(geometry.stateIds, ["body-size"]);
    assert.deepEqual(geometry.attachmentProfile.bodySizeRange, [0.8, 1.05]);
    assert.deepEqual(
      geometry.attachmentProfile.compatibleJerseyIds,
      [...svgsIndex.jersey].sort(),
    );
    assert.equal(geometry.outlinePolicy.silhouetteStroke, "omitted-shell-boundary");
    assert.equal(geometry.provenance.frontSilhouette, "facesjs-svg-contour");
    assert.ok(geometry.metrics.frontSilhouetteErrorCssPx <= 0.75);
    assertClosedRegion(geometry);
    assert.ok(geometry.mesh.triangles.every(({ materialRole }) => materialRole === "skin"));
    assert.equal(geometry.surfaceDetails.length > 0, row.sourceId === "body3");
    const preparedVertices = loaded.prepared.model.topology.vertices;
    const openingY = -(
      1.48 - ((FACES_JS_BODY_NECK_OPENING_SOURCE_Y - 100) * (2.47 / 400))
    ) * 120;
    const minimumY = Math.min(...preparedVertices.map((vertex) => vertex[1]));
    const openingVertices = preparedVertices.filter((vertex) =>
      Math.abs(vertex[1] - minimumY) <= 1e-8);
    assert.ok(Math.abs(minimumY - openingY) <= 1e-8);
    assert.ok(openingVertices.length >= 12);
    assert.ok(openingVertices.every(([x, , z]) => Math.hypot(x, z) > 1));
    assert.equal(
      loaded.prepared.model.topology.polygons.length,
      204 + geometry.surfaceDetails.length,
    );
    triangleCount += geometry.metrics.triangleCount;
  }
  assert.equal(triangleCount, 27_860);
});

test("all eighteen jerseys are closed raised regions with exact team paint roles", async () => {
  const catalog = await validateFacesJsComponentCatalog(catalogDocument, sourceIndex);
  const rows = catalog.components.filter(({ family }) => family === "jersey");
  assert.equal(rows.length, 18);
  assert.deepEqual(rows.map(({ sourceId }) => sourceId).sort(), [...svgsIndex.jersey].sort());
  let triangleCount = 0;
  for (const row of rows) {
    const loaded = await loadPackage("jersey", row.sourceId);
    assert.equal(sha256(loaded.manifestBytes), row.manifestSha256);
    assert.equal(loaded.manifest.layer, 2);
    assert.equal(loaded.manifest.attachment, "body-shell");
    assert.deepEqual(loaded.manifest.dependencies, []);
    const { geometry } = loaded;
    assert.equal(geometry.schema, FACES_JS_BODY_REGION_SCHEMA);
    assert.equal(geometry.family, "jersey");
    assert.equal(geometry.sourceId, row.sourceId);
    assert.equal(geometry.sourceSha256, sourceIndex.jersey[row.sourceId]);
    assert.deepEqual(geometry.stateIds, ["body-size"]);
    assert.deepEqual(geometry.attachmentProfile.bodySizeRange, [0.8, 1.05]);
    assert.deepEqual(
      geometry.attachmentProfile.compatibleBodyIds,
      [...svgsIndex.body].sort(),
    );
    assert.equal(Object.keys(geometry.attachmentProfile.clearanceByBodyCssPx).length, 5);
    assert.ok(Object.values(geometry.attachmentProfile.clearanceByBodyCssPx)
      .every((clearance) => clearance >= 0.72));
    assert.ok(geometry.metrics.minimumBodyClearanceCssPx >= 0.72);
    assert.equal(geometry.outlinePolicy.silhouetteStroke, "omitted-shell-boundary");
    assert.ok(!geometry.materialRoles.includes("skin"));
    assert.ok(geometry.materialRoles.includes("team-primary")
      || geometry.materialRoles.includes("team-secondary")
      || geometry.materialRoles.includes("jersey-white"));
    for (const [token, role] of [
      ["$[primary]", "team-primary"],
      ["$[secondary]", "team-secondary"],
      ["$[accent]", "team-accent"],
    ]) {
      assert.equal(geometry.materialRoles.includes(role), svgs.jersey[row.sourceId].includes(token));
    }
    if (row.sourceId.startsWith("jersey")) {
      assert.equal(geometry.openingSemantics.kind, "tank-top");
      assert.equal(geometry.openingSemantics.sourceContourPreserved, true);
      assert.ok(geometry.openingSemantics.maximumHorizontalRegions >= 2);
    }
    assertClosedRegion(geometry);
    assertBodySizeState(geometry.surfacePaint.flatMap(({ vertices }) => vertices));
    const preparedRoles = new Set(Object.values(loaded.prepared.materialRoles));
    for (const role of geometry.materialRoles) {
      assert.ok(preparedRoles.has(role), `${row.sourceId} lost prepared ${role} paint`);
    }
    triangleCount += geometry.metrics.triangleCount;
  }
  assert.equal(triangleCount, 12_329);
});

test("the complete body-by-jersey matrix shares one attachment contract without pair packages", async () => {
  const catalog = await validateFacesJsComponentCatalog(catalogDocument, sourceIndex);
  const bodies = catalog.components.filter(({ family }) => family === "body");
  const jerseys = catalog.components.filter(({ family }) => family === "jersey");
  assert.equal(bodies.length * jerseys.length, 90);
  const loadedBodies = new Map(await Promise.all(bodies.map(async (row) => [
    row.sourceId,
    (await loadPackage("body", row.sourceId)).geometry,
  ])));
  for (const jersey of jerseys) {
    const geometry = (await loadPackage("jersey", jersey.sourceId)).geometry;
    for (const body of bodies) {
      assert.equal(
        loadedBodies.get(body.sourceId).attachmentProfile.id,
        geometry.attachmentProfile.id,
      );
      assert.ok(geometry.attachmentProfile.clearanceByBodyCssPx[body.sourceId] >= 0.72);
    }
  }
  assert.ok(catalog.components.every(({ family, dependencies }) =>
    family !== "body" && family !== "jersey" || dependencies.length === 0));
  assert.equal(catalog.components.some(({ sourceId }) => sourceId.includes("body--jersey")), false);
  const before = new Set(["body:body", "jersey:jersey"]);
  const bodyChanged = new Set(["body:body2", "jersey:jersey"]);
  const jerseyChanged = new Set(["body:body", "jersey:jersey2"]);
  const delta = (left, right) => [...new Set([...left, ...right])]
    .filter((key) => left.has(key) !== right.has(key));
  assert.deepEqual(delta(before, bodyChanged).sort(), ["body:body", "body:body2"]);
  assert.deepEqual(delta(before, jerseyChanged).sort(), ["jersey:jersey", "jersey:jersey2"]);
});

test("body and jersey support evidence is region-package-backed", () => {
  for (const family of ["body", "jersey"]) {
    for (const entry of compatibility.families[family].ids) {
      assert.equal(entry.support, "supported");
      assert.deepEqual(entry.evidence, [
        "contract:cssface.facesjs-body-region@1",
        "test:facesjs-body-regions",
      ]);
    }
  }
});
