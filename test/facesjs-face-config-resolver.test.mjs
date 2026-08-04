import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { faceToSvgString } from "facesjs";

import {
  createFacesJsComponentGraph,
} from "../.build/prepare/src/adapters/facesjs/model-package/componentCatalog.js";
import {
  validateFacesJsComponentCatalog,
} from "../.build/prepare/src/adapters/facesjs/model-package/componentPackage.js";
import {
  CSSFACE_GENERATOR_ID,
  CSSFACE_MAXIMUM_SEED,
  FacesJsFaceConfigResolutionError,
  collectCssFaceCoverageSeeds,
  createCssFaceShareUrl,
  generateCssFaceConfig,
  parseFacesJsFaceConfigJson,
  readCssFaceShareUrl,
  resolveFacesJsFaceConfig,
  serializeFacesJsFaceConfig,
} from "../.build/prepare/src/adapters/facesjs/player/faceConfigResolver.js";
import {
  facesJsSnippet,
  facesJsSnippetBody,
  minimalFacesJsFaceConfig,
} from "../.build/prepare/src/adapters/facesjs/preview/facesJsSnippet.js";

const [catalog, presets] = await Promise.all([
  readFile(new URL(
    "../src/adapters/facesjs/component-catalog.json",
    import.meta.url,
  ), "utf8").then(JSON.parse).then(validateFacesJsComponentCatalog),
  readFile(new URL(
    "../src/adapters/facesjs/presets.json",
    import.meta.url,
  ), "utf8").then(JSON.parse),
]);
const graph = createFacesJsComponentGraph(catalog);

test("fixtures and arbitrary supported FaceConfigs use the same resolver", () => {
  for (const preset of presets) {
    const resolved = resolveFacesJsFaceConfig(graph, preset.face);
    assert.equal(resolved.baseId, "bust");
    assert.equal(resolved.selections.length, 16);
    assert.equal(resolved.graph.components.length, 16);
  }
  const arbitrary = generateCssFaceConfig(catalog, 412);
  const resolved = resolveFacesJsFaceConfig(graph, arbitrary);
  assert.deepEqual(resolved.config, arbitrary);
  assert.equal(resolved.selectedKeys.length, 16);
});

test("the CSSFace generator is deterministic and every seed is resolvable", () => {
  assert.equal(CSSFACE_GENERATOR_ID, "cssface-uniform-catalog-v1");
  for (let seed = 0; seed <= CSSFACE_MAXIMUM_SEED; seed += 1) {
    const first = generateCssFaceConfig(catalog, seed);
    assert.deepEqual(generateCssFaceConfig(catalog, seed), first);
    assert.equal(resolveFacesJsFaceConfig(graph, first).selectedKeys.length, 16);
  }
});

test("a coverage-directed seed set reaches every supported component id", () => {
  const seeds = collectCssFaceCoverageSeeds(graph);
  assert.ok(seeds.length > 0);
  assert.ok(seeds.every((seed) => seed >= 0 && seed <= CSSFACE_MAXIMUM_SEED));
  const reached = new Set(seeds.flatMap((seed) =>
    resolveFacesJsFaceConfig(graph, generateCssFaceConfig(catalog, seed)).selectedKeys));
  assert.equal(reached.size, catalog.components.length);
  for (const { family, sourceId } of catalog.components) {
    assert.ok(reached.has(`${family}:${sourceId}`), `${family}.${sourceId} is unreachable`);
  }
});

test("unsupported ids and invalid coupled hair are structured failures", () => {
  const face = generateCssFaceConfig(catalog, 0);
  assert.throws(
    () => resolveFacesJsFaceConfig(graph, {
      ...face,
      eye: { ...face.eye, id: "not-supported" },
    }),
    (error) => error instanceof FacesJsFaceConfigResolutionError
      && error.code === "unsupported-component"
      && error.family === "eye"
      && error.sourceId === "not-supported",
  );
  assert.throws(
    () => resolveFacesJsFaceConfig(graph, {
      ...face,
      accessories: { id: "none" },
      hair: { ...face.hair, id: "female1" },
      hairBg: { id: "none" },
    }),
    (error) => error instanceof FacesJsFaceConfigResolutionError
      && error.code === "dependency-mismatch"
      && error.family === "hairBg",
  );
});

test("hat hair substitutions follow the FacesJS display contract", () => {
  const face = generateCssFaceConfig(catalog, 1);
  const short = resolveFacesJsFaceConfig(graph, {
    ...face,
    accessories: { id: "hat" },
    hair: { ...face.hair, id: "afro" },
  });
  assert.equal(short.effectiveIds.hair, "short");
  const hidden = resolveFacesJsFaceConfig(graph, {
    ...face,
    accessories: { id: "hat" },
    hair: { ...face.hair, id: "cornrows" },
  });
  assert.equal(hidden.effectiveIds.hair, "bald");
});

test("share URLs and serialized JSON round-trip the exact FaceConfig", () => {
  const face = generateCssFaceConfig(catalog, 9347);
  const downloaded = serializeFacesJsFaceConfig(face);
  assert.deepEqual(parseFacesJsFaceConfigJson(downloaded), face);
  const url = createCssFaceShareUrl("https://cssface.com/demo?keep=1", face, 9347);
  assert.equal(url.searchParams.get("keep"), "1");
  const shared = readCssFaceShareUrl(url);
  assert.equal(shared.seed, 9347);
  assert.deepEqual(shared.face, face);
});

test("the FacesJS example contains only values needed to reproduce the face", () => {
  const face = presets[0].face;
  const minimal = minimalFacesJsFaceConfig(face);

  assert.deepEqual(minimal, {
    fatness: 0.55,
    teamColors: ["#89bfd3", "#7a1319", "#07364f"],
    body: { id: "body", color: "#ad6453" },
    jersey: { id: "jersey" },
    ear: { id: "ear1", size: 0.8 },
    head: { id: "head1", shave: "rgba(0, 0, 0, 0)" },
    eye: { id: "eye1" },
    eyebrow: { id: "eyebrow1", angle: 5 },
    hair: { id: "short", color: "#272421" },
    mouth: { id: "smile" },
    nose: { id: "nose3", size: 0.9 },
    accessories: { id: "none" },
  });

  const snippet = facesJsSnippet(face);
  assert.doesNotMatch(
    snippet,
    /hairBg|eyeLine|smileLine|miscLine|facialHair|glasses|size: 1|angle: 0|flip: false/u,
  );
  assert.match(snippet, /accessories: \{ id: "none" \}/u);
  assert.match(snippet, /display\("face", face\);/u);

  const comparisonSnippet = facesJsSnippetBody(face, "face2d", "face-2d");
  assert.match(comparisonSnippet, /const face2d = \{/u);
  assert.match(comparisonSnippet, /display\("face-2d", face2d\);/u);

  const withoutIdentityRotation = (svg) => svg.replace(
    / rotate\(0 [^)]+\)/gu,
    "",
  );
  for (let seed = 0; seed < 256; seed += 1) {
    const completeFace = generateCssFaceConfig(catalog, seed);
    const minimalFace = minimalFacesJsFaceConfig(completeFace);
    assert.equal(
      withoutIdentityRotation(faceToSvgString(structuredClone(minimalFace))),
      withoutIdentityRotation(faceToSvgString(structuredClone(completeFace))),
      `minimal FacesJS source changed seed ${seed}`,
    );
  }
});
