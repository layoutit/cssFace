import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FACES_JS_DISPLAY_LAYERS,
  createFacesJsComponentCatalog,
  createFacesJsComponentManifest,
  validateFacesJsComponentCatalog,
  validateFacesJsComponentManifest,
} from "../.build/prepare/src/adapters/facesjs/model-package/componentPackage.js";
import {
  createFacesJsComponentGraph,
  loadFacesJsComponentGraph,
  loadFacesJsComponentManifest,
  resolveFacesJsComponentAssetUrl,
} from "../.build/prepare/src/adapters/facesjs/model-package/componentCatalog.js";

const compatibility = JSON.parse(
  await readFile(new URL("../src/adapters/facesjs/compatibility.json", import.meta.url)),
);
const trackedCatalog = JSON.parse(
  await readFile(new URL("../src/adapters/facesjs/component-catalog.json", import.meta.url)),
);
const sourceIndex = Object.fromEntries(
  Object.entries(compatibility.families).map(([family, row]) => [
    family,
    Object.fromEntries(row.ids.map((entry) => [entry.id, entry.sourceSha256])),
  ]),
);
const HASH = "0".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("tracked component catalog keeps compatibility fixtures alongside reusable components", async () => {
  const catalog = await validateFacesJsComponentCatalog(trackedCatalog, sourceIndex);
  assert.equal(catalog.compatibilityFixtures.length, 6);
  assert.equal(catalog.bases.length, 1);
  assert.equal(catalog.components.length, 326);
  assert.deepEqual(
    [...new Set(catalog.components.map(({ family }) => family))],
    [
      "accessories",
      "body",
      "ear",
      "eye",
      "eyeLine",
      "eyebrow",
      "facialHair",
      "glasses",
      "hair",
      "hairBg",
      "head",
      "jersey",
      "miscLine",
      "mouth",
      "nose",
      "smileLine",
    ],
  );
  for (const fixture of catalog.compatibilityFixtures) {
    assert.equal(fixture.baseId, "bust");
    assert.deepEqual(fixture.selections.map(({ family }) => family), FACES_JS_DISPLAY_LAYERS);
  }
  const graph = createFacesJsComponentGraph(catalog);
  const classic = graph.getCompatibilityFixture("classic");
  assert.equal(classic.baseId, "bust");
  assert.equal(
    graph.resolve(classic.baseId, classic.selections).components.length,
    FACES_JS_DISPLAY_LAYERS.length,
  );
  assert.throws(() => graph.resolve("classic", []), /base classic is unavailable/u);
});

test("component graph resolves one source-hash-bound component per family", async () => {
  const headHash = sourceIndex.head.head1;
  const eyeHash = sourceIndex.eye.eye1;
  const catalog = await createFacesJsComponentCatalog({
    facesJsVersion: "5.0.3",
    sourceRevision: compatibility.facesJs.sourceRevision,
    layers: FACES_JS_DISPLAY_LAYERS,
    bases: [{
      id: "bust",
      manifestPath: "bases/bust/manifest.json",
      manifestSha256: HASH,
    }],
    components: [{
      family: "eye",
      sourceId: "eye1",
      sourceSha256: eyeHash,
      manifestPath: "components/eye/eye1/manifest.json",
      manifestSha256: HASH,
      layer: FACES_JS_DISPLAY_LAYERS.indexOf("eye"),
      dependencies: [{ family: "head", sourceId: "head1" }],
    }, {
      family: "head",
      sourceId: "head1",
      sourceSha256: headHash,
      manifestPath: "components/head/head1/manifest.json",
      manifestSha256: HASH,
      layer: FACES_JS_DISPLAY_LAYERS.indexOf("head"),
      dependencies: [],
    }],
    compatibilityFixtures: [],
  }, sourceIndex);
  const graph = createFacesJsComponentGraph(catalog);
  const selections = [{ family: "head", sourceId: "head1", sourceSha256: headHash }, {
    family: "eye",
    sourceId: "eye1",
    sourceSha256: eyeHash,
  }];
  assert.deepEqual(
    graph.resolve("bust", selections).components.map(({ family }) => family),
    ["head", "eye"],
  );
  assert.throws(
    () => graph.resolve("bust", [selections[1]]),
    /requires selected head:head1/u,
  );
  assert.throws(
    () => graph.resolve("bust", [selections[0], selections[0]]),
    /selected more than once/u,
  );
  assert.throws(
    () => graph.resolve("bust", [{ ...selections[0], sourceId: "head2" }]),
    /unavailable or stale/u,
  );
});

test("component manifests reject unsafe assets and source drift", async () => {
  const value = {
    id: "eye-eye1",
    family: "eye",
    sourceId: "eye1",
    sourceSha256: sourceIndex.eye.eye1,
    layer: FACES_JS_DISPLAY_LAYERS.indexOf("eye"),
    attachment: "face-surface",
    materialRoles: ["eye-white", "ink"],
    dependencies: [{ family: "head", sourceId: "head1" }],
    assets: {
      geometry: {
        path: "assets/geometry.json",
        mediaType: "application/json",
        bytes: 10,
        sha256: HASH,
      },
    },
  };
  const manifest = await createFacesJsComponentManifest(value);
  assert.equal(
    (await validateFacesJsComponentManifest(manifest, sourceIndex)).sourceId,
    "eye1",
  );
  await assert.rejects(
    validateFacesJsComponentManifest({ ...manifest, sourceSha256: HASH }, sourceIndex),
    /stale source bytes/u,
  );
  await assert.rejects(
    createFacesJsComponentManifest({
      ...value,
      assets: {
        geometry: { ...value.assets.geometry, path: "../geometry.json" },
      },
    }),
    /safe relative path/u,
  );
});

test("component loader validates catalog rows, manifest bytes, and asset URLs", async () => {
  const manifest = await createFacesJsComponentManifest({
    id: "head-head1",
    family: "head",
    sourceId: "head1",
    sourceSha256: sourceIndex.head.head1,
    layer: FACES_JS_DISPLAY_LAYERS.indexOf("head"),
    attachment: "head-shell",
    materialRoles: ["skin-base"],
    dependencies: [],
    assets: {
      geometry: {
        path: "assets/geometry.json",
        mediaType: "application/json",
        bytes: 10,
        sha256: HASH,
      },
    },
  });
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const catalog = await createFacesJsComponentCatalog({
    facesJsVersion: "5.0.3",
    sourceRevision: compatibility.facesJs.sourceRevision,
    layers: FACES_JS_DISPLAY_LAYERS,
    bases: [{
      id: "bust",
      manifestPath: "bases/bust/manifest.json",
      manifestSha256: HASH,
    }],
    components: [{
      family: "head",
      sourceId: "head1",
      sourceSha256: sourceIndex.head.head1,
      manifestPath: "components/head/head1/manifest.json",
      manifestSha256: sha256(manifestBytes),
      layer: FACES_JS_DISPLAY_LAYERS.indexOf("head"),
      dependencies: [],
    }],
    compatibilityFixtures: [],
  }, sourceIndex);
  const catalogBytes = new TextEncoder().encode(JSON.stringify(catalog));
  const responses = new Map([
    ["/facesjs-components/catalog.json", catalogBytes],
    ["/facesjs-components/components/head/head1/manifest.json", manifestBytes],
  ]);
  const fetchImpl = async (url) => {
    const bytes = responses.get(url);
    return bytes
      ? new Response(bytes, { status: 200 })
      : new Response("missing", { status: 404 });
  };
  const graph = await loadFacesJsComponentGraph(fetchImpl, "/facesjs-components", sourceIndex);
  const row = graph.resolve("bust", [{
    family: "head",
    sourceId: "head1",
    sourceSha256: sourceIndex.head.head1,
  }]).components[0];
  const loaded = await loadFacesJsComponentManifest(
    fetchImpl,
    row,
    "/facesjs-components",
    sourceIndex,
  );
  assert.equal(
    resolveFacesJsComponentAssetUrl(row, loaded, "geometry", "/facesjs-components"),
    "/facesjs-components/components/head/head1/assets/geometry.json",
  );
  await assert.rejects(
    loadFacesJsComponentManifest(
      async () => new Response("{}", { status: 200 }),
      row,
      "/facesjs-components",
      sourceIndex,
    ),
    /manifest hash is stale/u,
  );
});

test("catalog validator rejects duplicate components and broken dependencies", async () => {
  const row = {
    family: "head",
    sourceId: "head1",
    sourceSha256: sourceIndex.head.head1,
    manifestPath: "components/head/head1/manifest.json",
    manifestSha256: HASH,
    layer: FACES_JS_DISPLAY_LAYERS.indexOf("head"),
    dependencies: [],
  };
  await assert.rejects(
    createFacesJsComponentCatalog({
      facesJsVersion: "5.0.3",
      sourceRevision: compatibility.facesJs.sourceRevision,
      layers: FACES_JS_DISPLAY_LAYERS,
      bases: [],
      components: [row, row],
      compatibilityFixtures: [],
    }, sourceIndex),
    /duplicate keys/u,
  );
  await assert.rejects(
    createFacesJsComponentCatalog({
      facesJsVersion: "5.0.3",
      sourceRevision: compatibility.facesJs.sourceRevision,
      layers: FACES_JS_DISPLAY_LAYERS,
      bases: [],
      components: [{
        ...row,
        dependencies: [{ family: "eye", sourceId: "eye1" }],
      }],
      compatibilityFixtures: [],
    }, sourceIndex),
    /requires missing eye:eye1/u,
  );
});
