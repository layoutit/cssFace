import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FACES_JS_MATERIAL_ROLES,
} from "../.build/prepare/src/adapters/facesjs/player/materialColors.js";

const [corpus, compatibility, catalog] = await Promise.all([
  readFile(new URL(
    "./fixtures/facesjs-corpus/corpus.json",
    import.meta.url,
  ), "utf8").then(JSON.parse),
  readFile(new URL(
    "../src/adapters/facesjs/compatibility.json",
    import.meta.url,
  ), "utf8").then(JSON.parse),
  readFile(new URL(
    "../public/facesjs-components/catalog.json",
    import.meta.url,
  ), "utf8").then(JSON.parse),
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const catalogKeys = catalog.components.map(
  ({ family, sourceId }) => `${family}:${sourceId}`,
).sort();

test("the differential corpus is self-authenticating and covers the catalog", () => {
  assert.equal(corpus.schema, "cssface.facesjs-differential-corpus@1");
  const { contentHash, ...payload } = corpus;
  assert.equal(contentHash, sha256(JSON.stringify(payload)));
  assert.equal(corpus.componentCount, catalog.components.length);
  assert.equal(corpus.caseCount, corpus.cases.length);
  assert.deepEqual(Object.keys(corpus.components).sort(), catalogKeys);
  assert.deepEqual(
    [...new Set(corpus.cases.flatMap(({ selectedKeys }) => selectedKeys))].sort(),
    catalogKeys,
  );
});

test("every FaceConfig property and boundary family has named evidence", () => {
  assert.deepEqual(
    Object.keys(corpus.propertyCoverage),
    compatibility.display.faceConfigProperties,
  );
  const caseIds = new Set(corpus.cases.map(({ id }) => id));
  for (const [property, ids] of Object.entries(corpus.propertyCoverage)) {
    assert.ok(ids.length > 0, `${property} has no evidence`);
    assert.ok(ids.every((id) => caseIds.has(id)), `${property} names an absent case`);
  }
  assert.deepEqual(
    [...new Set(corpus.cases.map(({ kind }) => kind))].sort(),
    [
      "body-jersey-pair",
      "catalog-coverage",
      "color-boundary",
      "glasses",
      "hair-background-pair",
      "hat-substitution",
      "layer-collision",
      "transform-boundary",
    ],
  );
});

test("upstream SVG evidence preserves FacesJS source identity, order, and transforms", () => {
  const displayIndex = new Map(
    compatibility.display.order.map((family, index) => [family, index]),
  );
  const sourceHash = new Map(Object.entries(compatibility.families).flatMap(
    ([family, document]) => document.ids.map(
      ({ id, sourceSha256 }) => [`${family}:${id}`, sourceSha256],
    ),
  ));
  for (const row of corpus.cases) {
    let priorFamily = -1;
    for (const [index, group] of row.upstream.groups.entries()) {
      assert.equal(group.displayIndex, index);
      assert.equal(
        group.sourceSha256,
        sourceHash.get(`${group.family}:${group.sourceId}`),
        `${row.id} lost ${group.family}.${group.sourceId} provenance`,
      );
      assert.equal(typeof group.transform, "string");
      const familyIndex = displayIndex.get(group.family);
      assert.ok(familyIndex >= priorFamily, `${row.id} changed FacesJS display order`);
      priorFamily = familyIndex;
    }
  }
});

test("selected 3D components retain layer order, content hashes, and material roles", () => {
  for (const row of corpus.cases) {
    let priorLayer = -1;
    for (const key of row.selectedKeys) {
      const component = corpus.components[key];
      assert.ok(component, `${row.id} selected unknown ${key}`);
      assert.ok(component.layer >= priorLayer, `${row.id} changed 3D layer order`);
      assert.match(component.manifestSha256, /^[a-f0-9]{64}$/u);
      assert.match(component.manifestContentHash, /^[a-f0-9]{64}$/u);
      assert.match(component.preparedSha256, /^[a-f0-9]{64}$/u);
      assert.match(component.preparedContentHash, /^[a-f0-9]{64}$/u);
      assert.ok(component.materialRoles.every(
        (role) => FACES_JS_MATERIAL_ROLES.includes(role),
      ), `${key} has an unknown material role`);
      priorLayer = component.layer;
    }
  }
});

test("unsupported ids have only the structured failures declared by compatibility", () => {
  const expected = Object.entries(compatibility.families).flatMap(
    ([family, document]) => document.ids
      .filter(({ support }) => support === "unsupported")
      .map(({ id, reason }) => ({ family, sourceId: id, reason })),
  );
  assert.deepEqual(
    corpus.unsupportedExpectedFailures.map(
      ({ family, sourceId, reason }) => ({ family, sourceId, reason }),
    ),
    expected,
  );
  for (const failure of corpus.unsupportedExpectedFailures) {
    assert.equal(typeof failure.errorCode, "string");
    assert.ok(failure.errorCode.length > 0);
  }
});
