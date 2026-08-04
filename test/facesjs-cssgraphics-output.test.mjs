import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CSSGRAPHICS_CATALOG_SCHEMA,
  CSSGRAPHICS_GENERIC_JSON_CODEC_ID,
  CSSGRAPHICS_MODEL_DATA_SCHEMA,
  CSSGRAPHICS_MODEL_SCHEMA,
  validateCssGraphicsCatalog,
  validateCssGraphicsModelPackage,
} from "../.build/prepare/src/model-package/modelPackage.mjs";
import {
  CSSFACE_GENERATOR_ID,
  CSSFACE_PREPARED_FACE_CATALOG_SCHEMA,
} from "../.build/prepare/src/adapters/facesjs/player/faceConfigResolver.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(repoRoot, "public/cssgraphics");
const faceOutputRoot = resolve(repoRoot, "public/f");
const presets = JSON.parse(await readFile(
  resolve(repoRoot, "src/adapters/facesjs/presets.json"),
));
const componentCatalog = JSON.parse(await readFile(
  resolve(repoRoot, "src/adapters/facesjs/component-catalog.json"),
));
const preparedFaceCatalog = JSON.parse(await readFile(
  resolve(outputRoot, "faces.json"),
));
const catalog = await validateCssGraphicsCatalog(
  await readFile(resolve(outputRoot, "catalog.json")),
);
const previewSource = await readFile(
  resolve(repoRoot, "src/adapters/facesjs/preview/main.ts"),
  "utf8",
);
const previewHtml = await readFile(
  resolve(repoRoot, "src/adapters/facesjs/preview/index.html"),
  "utf8",
);
const previewCss = await readFile(
  resolve(repoRoot, "src/adapters/facesjs/preview/preview.css"),
  "utf8",
);
const publicHeaders = await readFile(
  resolve(repoRoot, "public/_headers"),
  "utf8",
);
const sceneSource = await readFile(
  resolve(repoRoot, "src/adapters/facesjs/player/scene.ts"),
  "utf8",
);
const prepareSource = await readFile(
  resolve(repoRoot, "src/adapters/facesjs/scripts/prepare.mjs"),
  "utf8",
);

function pointKey(point) {
  return point.map((value) => Number(value.toFixed(8))).join(",");
}

function edgeKey(first, second) {
  const left = pointKey(first);
  const right = pointKey(second);
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function polygonEdges(polygon) {
  return polygon.vertices.map((vertex, index) => [
    vertex,
    polygon.vertices[(index + 1) % polygon.vertices.length],
  ]);
}

function largestConnectedAxisSpanRatio(polygons, color, axis) {
  const selected = polygons.filter((polygon) => polygon.color.toLowerCase() === color);
  const ownersByEdge = new Map();
  selected.forEach((polygon, polygonIndex) => {
    for (const [first, second] of polygonEdges(polygon)) {
      const key = edgeKey(first, second);
      const owners = ownersByEdge.get(key) ?? [];
      owners.push(polygonIndex);
      ownersByEdge.set(key, owners);
    }
  });
  const adjacency = Array.from({ length: selected.length }, () => new Set());
  for (const owners of ownersByEdge.values()) {
    for (const first of owners) {
      for (const second of owners) {
        if (first !== second) adjacency[first].add(second);
      }
    }
  }
  const visited = new Set();
  let largestSpan = 0;
  for (let start = 0; start < selected.length; start += 1) {
    if (visited.has(start)) continue;
    const pending = [start];
    const values = [];
    visited.add(start);
    while (pending.length) {
      const index = pending.pop();
      values.push(...selected[index].vertices.map((vertex) => vertex[axis]));
      for (const neighbor of adjacency[index]) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
    largestSpan = Math.max(largestSpan, Math.max(...values) - Math.min(...values));
  }
  const allValues = selected.flatMap((polygon) => polygon.vertices.map((vertex) => vertex[axis]));
  return largestSpan / (Math.max(...allValues) - Math.min(...allValues));
}

test("the browser catalog contains a final package for every supported component", async () => {
  assert.equal(catalog.schema, CSSGRAPHICS_CATALOG_SCHEMA);
  assert.equal(preparedFaceCatalog.schema, CSSFACE_PREPARED_FACE_CATALOG_SCHEMA);
  assert.equal(preparedFaceCatalog.generator, CSSFACE_GENERATOR_ID);
  assert.equal(preparedFaceCatalog.models.length, presets.length + componentCatalog.components.length);
  assert.equal(catalog.models.length, preparedFaceCatalog.models.length);
  assert.deepEqual(
    preparedFaceCatalog.models.map(({ id }) => id),
    Array.from({ length: preparedFaceCatalog.models.length }, (_, id) => id),
  );
  assert.equal(
    preparedFaceCatalog.models.find(({ name }) => name === "accessories.eye-black")?.id,
    6,
  );
  assert.ok(presets.every(({ modelId }) =>
    catalog.models.some(({ id }) => id === modelId)));
  assert.equal(
    new Set(catalog.models.map(({ id }) => id)).size,
    catalog.models.length,
  );
  assert.equal(
    new Set(catalog.models.map(({ manifestPath }) => manifestPath)).size,
    catalog.models.length,
  );
  assert.deepEqual(
    catalog.models.map(({ id }) => id).sort(),
    preparedFaceCatalog.models.map(({ modelId }) => modelId).sort(),
  );
  assert.deepEqual(
    [
      Math.min(...preparedFaceCatalog.models.map(({ face }) => face.fatness)),
      Math.max(...preparedFaceCatalog.models.map(({ face }) => face.fatness)),
    ],
    [0, 1],
  );
  assert.deepEqual(
    [
      Math.min(...preparedFaceCatalog.models.map(({ face }) => face.body.size)),
      Math.max(...preparedFaceCatalog.models.map(({ face }) => face.body.size)),
    ],
    [0.8, 1.05],
  );

  const preparedFacesByModel = new Map(preparedFaceCatalog.models.map((model) => [
    model.modelId,
    model,
  ]));
  const reachedComponents = new Set();
  for (const row of catalog.models) {
    const manifestPath = resolve(outputRoot, row.manifestPath);
    const modelRoot = dirname(manifestPath);
    const result = await validateCssGraphicsModelPackage({
      manifestBytes: await readFile(manifestPath),
      catalogEntry: row,
      loadResource: (path) => readFile(resolve(modelRoot, path)),
    });

    assert.equal(result.manifest.schema, CSSGRAPHICS_MODEL_SCHEMA);
    assert.equal(result.manifest.profile, "facesjs-face");
    assert.equal(
      result.manifest.resources.model.codec,
      CSSGRAPHICS_GENERIC_JSON_CODEC_ID,
    );
    assert.equal(result.model.schema, CSSGRAPHICS_MODEL_DATA_SCHEMA);
    assert.deepEqual(Object.keys(result.model.sections), ["provenance", "scene"]);

    const scene = result.model.sections.scene;
    const provenance = result.model.sections.provenance;
    assert.equal(scene.schema, "cssface.facesjs-prepared-scene@2");
    assert.equal(scene.id, row.id);
    assert.equal(scene.artifactMode, "polycss-polygons");
    const preparedFace = preparedFacesByModel.get(row.id);
    assert.deepEqual(scene.faceConfig, preparedFace?.face);
    const faceDocument = JSON.parse(await readFile(
      resolve(faceOutputRoot, `${preparedFace?.id}.json`),
    ));
    assert.deepEqual(Object.keys(faceDocument).sort(), ["id", "lighting", "polygons", "schema"]);
    assert.equal(faceDocument.schema, "cssface.polycss-face@1");
    assert.equal(faceDocument.id, preparedFace?.id);
    assert.deepEqual(faceDocument.polygons, scene.polygons);
    for (const key of scene.selectedKeys) reachedComponents.add(key);
    assert.deepEqual(Object.keys(scene).sort(), [
      "artifactMode",
      "faceConfig",
      "fixtureId",
      "id",
      "polygons",
      "rotationLighting",
      "schema",
      "selectedKeys",
    ]);
    assert.ok(scene.polygons.length > 0);
    assert.ok(
      scene.polygons.length <= 2_000,
      `${row.id} exceeds the 2,000-polygon model ceiling`,
    );
    assert.ok(scene.polygons.every((polygon) =>
      typeof polygon.color === "string"
      && polygon.doubleSided === undefined
      && polygon.vertices.length >= 3
      && polygon.vertices.every((vertex) =>
        vertex.length === 3 && vertex.every(Number.isFinite))));
    assert.deepEqual(provenance.weldedJunction, {
      topology: "shared-boundary-loft",
      headBoundaryEdges: provenance.weldedJunction.headBoundaryEdges,
      neckBoundaryEdges: provenance.weldedJunction.neckBoundaryEdges,
      bodyBoundaryEdges: provenance.weldedJunction.bodyBoundaryEdges,
      polygonCount: provenance.weldedJunction.headBoundaryEdges
        + provenance.weldedJunction.bodyBoundaryEdges
        + (provenance.weldedJunction.neckBoundaryEdges * 2),
      fatnessEndpoint: "head",
      bodySizeEndpoint: "body",
    });
    assert.ok(provenance.weldedJunction.headBoundaryEdges >= 13);
    assert.equal(
      provenance.weldedJunction.neckBoundaryEdges,
      provenance.weldedJunction.bodyBoundaryEdges,
    );
    assert.ok(provenance.weldedJunction.bodyBoundaryEdges >= 8);

    const teamColors = new Set(scene.faceConfig.teamColors.map((color) => color.toLowerCase()));
    const skinColor = scene.faceConfig.body.color.toLowerCase();
    assert.ok(
      largestConnectedAxisSpanRatio(scene.polygons, skinColor, 0) > 0.95,
      `${row.id} head and body do not share one welded skin component`,
    );
    const jerseyPolygons = scene.polygons.filter(
      (polygon) => teamColors.has(polygon.color.toLowerCase()),
    );
    assert.ok(jerseyPolygons.length > 0, `${row.id} has no resolved jersey color`);
    const ownersByEdge = new Map();
    for (const polygon of scene.polygons) {
      for (const [first, second] of polygonEdges(polygon)) {
        const owners = ownersByEdge.get(edgeKey(first, second)) ?? new Set();
        owners.add(polygon.color.toLowerCase());
        ownersByEdge.set(edgeKey(first, second), owners);
      }
    }
    if (scene.faceConfig.jersey.id.startsWith("jersey")) {
      assert.ok(jerseyPolygons.length >= 20);
      assert.ok(jerseyPolygons.some((polygon) => polygon.vertices
        .reduce((total, vertex) => total + vertex[2], 0) / polygon.vertices.length > 0.05));
      assert.ok(jerseyPolygons.some((polygon) => polygon.vertices
        .reduce((total, vertex) => total + vertex[2], 0) / polygon.vertices.length < -0.05));
      const paintedTankTopSeams = [...ownersByEdge.values()].filter((colors) =>
        colors.has(skinColor) && [...teamColors].some((color) => colors.has(color)));
      assert.ok(
        paintedTankTopSeams.length >= 8,
        `${row.id} tank top is not painted into connected body cells`,
      );
    }

    const assetRoles = Object.keys(result.manifest.resources.assets).sort();
    assert.deepEqual(assetRoles, ["rotation-diffuse", "rotation-specular"]);
    assert.equal(result.assets.size, assetRoles.length);
    const lighting = scene.rotationLighting;
    assert.equal(lighting.schema, "cssface.facesjs-component-rotation-lighting@3");
    assert.equal(
      lighting.technique,
      "prepared-yaw-space-time-neutral-texel-matrix",
    );
    assert.equal(lighting.leafIds.length, scene.polygons.length);
    assert.deepEqual(lighting.runtime, {
      rootStateWritesMaximum: 1,
      leafStateWrites: 0,
      faceStateScans: 0,
      operation: "one inherited space-time row offset",
    });
    assert.equal(lighting.visibility.managedLeafCount, 0);
    assert.equal(lighting.atlases.diffuse.asset, "rotation-diffuse");
    assert.equal(lighting.atlases.specular.asset, "rotation-specular");
    assert.deepEqual(faceDocument.lighting, {
      spinSteps: lighting.state.spinSteps,
      sourcePx: lighting.state.fieldSourcePx,
      width: lighting.atlases.diffuse.width,
      height: lighting.atlases.diffuse.height,
      diffuse: `${preparedFace?.id}-d.webp`,
      specular: `${preparedFace?.id}-s.webp`,
    });
    assert.equal(
      Buffer.compare(
        await readFile(resolve(faceOutputRoot, faceDocument.lighting.diffuse)),
        Buffer.from(result.assets.get("rotation-diffuse")),
      ),
      0,
    );
    assert.equal(
      Buffer.compare(
        await readFile(resolve(faceOutputRoot, faceDocument.lighting.specular)),
        Buffer.from(result.assets.get("rotation-specular")),
      ),
      0,
    );
    for (const role of assetRoles) {
      const descriptor = result.manifest.resources.assets[role];
      const atlas = lighting.atlases[role === "rotation-diffuse" ? "diffuse" : "specular"];
      assert.equal(descriptor.width, atlas.width);
      assert.equal(descriptor.height, atlas.height);
      assert.ok(result.assets.get(role).byteLength > 0);
    }
    assert.deepEqual(
      (await readdir(modelRoot)).sort(),
      ["assets", "manifest.json", "model.css", "model.json"],
    );
    assert.deepEqual(
      (await readdir(resolve(modelRoot, "assets"))).sort(),
      assetRoles.map((role) => `${role}.webp`),
    );

    const serialized = JSON.stringify(result.model);
    assert.equal(serialized.includes("/facesjs-components/"), false);
    assert.equal(serialized.includes("solid-quad"), false);
    assert.equal(serialized.includes("solid-triangle"), false);
    assert.equal(serialized.includes("render.leaves"), false);
  }

  assert.equal(reachedComponents.size, componentCatalog.components.length);
  for (const { family, sourceId } of componentCatalog.components) {
    assert.ok(
      reachedComponents.has(`${family}:${sourceId}`),
      `${family}.${sourceId} has no final prepared face`,
    );
  }

  assert.deepEqual(
    (await readdir(faceOutputRoot)).sort(),
    preparedFaceCatalog.models.flatMap(({ id }) => [
      `${id}.json`,
      `${id}-d.webp`,
      `${id}-s.webp`,
    ]).sort(),
  );
  await assert.rejects(
    readdir(resolve(outputRoot, "polygons")),
    { code: "ENOENT" },
  );
});

test("the shown and combined CodePen examples import PolyCSS without a CSSFace package API", async () => {
  const snippet = previewSource.match(
    /function polyCssSceneSnippet[\s\S]*?\n\}\n\nfunction highlightedCode/u,
  )?.[0];
  assert.ok(snippet, "PolyCSS sample source is absent");
  assert.match(snippet, /from "@layoutit\/polycss"/u);
  assert.doesNotMatch(snippet, /from ["']cssface["']/u);
  assert.doesNotMatch(snippet, /mountCssFace|mountCssGraphics/u);
  assert.match(previewSource, /function codePenFaceDocumentUrl/u);
  assert.match(previewSource, /hostname\.endsWith\("\.netlify\.app"\)/u);
  assert.match(previewSource, /return `\$\{publicOrigin\}\/f\/\$\{model\.id\}\.json`/u);
  assert.doesNotMatch(previewSource, /cssgraphics\/polygons/u);
  assert.match(snippet, /createPolyCamera/u);
  assert.match(snippet, /createPolyCamera\(\{ rotX: 0, rotY: 0, zoom: 49 \}\)/u);
  assert.ok(
    snippet.includes("`scene.add({ ...${faceVariable}, dispose() {} }, { merge: false });`"),
  );
  assert.doesNotMatch(
    snippet,
    /createPolyOrthographicCamera|const host|Missing #face-3d|textureLighting|meshResolution|objectUrls|warnings/u,
  );

  const codePenSnippet = previewSource.match(
    /function codePenSnippet[\s\S]*?\n\}\n\nfunction codePenPayload/u,
  )?.[0];
  assert.ok(codePenSnippet, "Combined CodePen source is absent");
  assert.match(codePenSnippet, /https:\/\/esm\.sh\/facesjs@5\.0\.3/u);
  assert.match(codePenSnippet, /https:\/\/esm\.sh\/@layoutit\/polycss@0\.2\.10/u);
  assert.match(codePenSnippet, /queryPolyLeaves/u);
  assert.match(codePenSnippet, /FacesJS: render the original face in 2D\./u);
  assert.match(codePenSnippet, /PolyCSS: render the same face in 3D\./u);
  assert.match(codePenSnippet, /facesJsSnippetBody\(currentFaceConfig\(\), "face2d", "face-2d"\)/u);
  assert.match(codePenSnippet, /JSON\.stringify\(codePenFaceDocumentUrl\(model\)\)/u);
  assert.match(codePenSnippet, /face3dHost/u);
  assert.match(codePenSnippet, /face3d\.lighting\.diffuse/u);
  assert.match(codePenSnippet, /face3d\.lighting\.specular/u);
  assert.match(codePenSnippet, /--cssface-light-row/u);
  assert.match(codePenSnippet, /mesh\.setTransform\(\{ rotation: \[yaw, 0, 0\] \}\)/u);
  assert.match(codePenSnippet, /ambientLight: \{ color: "#fff", intensity: 1 \}/u);
  assert.match(codePenSnippet, /directionalLight: \{ direction: \[0, 0, 1\], color: "#fff", intensity: 0 \}/u);
  assert.doesNotMatch(codePenSnippet, /JSON\.stringify\(face\)|currentPolyCssDocument/u);
  assert.doesNotMatch(codePenSnippet, /from ["']cssface["']/u);
  assert.doesNotMatch(codePenSnippet, /mountCssFace|mountCssGraphics/u);
  assert.match(previewSource, /function codePenPayload\(model: FacePreset\): string/u);
  assert.match(previewSource, /editors: "001"/u);
  assert.match(previewSource, /layout: "left"/u);
  assert.match(previewSource, /js: codePenSnippet\(model\)/u);
  assert.match(previewSource, /js_module: true/u);
  assert.match(previewSource, /codePenData\.value = codePenPayload\(currentModel\)/u);
  assert.doesNotMatch(previewSource, /__CPEmbed|codePenEmbed|codePenDialog/u);
  assert.match(publicHeaders, /^\/f\/\*/mu);
  assert.match(publicHeaders, /Access-Control-Allow-Origin: \*/u);

  const packageJson = JSON.parse(await readFile(resolve(repoRoot, "package.json")));
  assert.equal(packageJson.private, true);
  assert.equal(Object.hasOwn(packageJson, "exports"), false);
});

test("the top bar has one CodePen action for both faces", () => {
  assert.match(previewHtml, /<span>Random<\/span>/u);
  assert.doesNotMatch(previewHtml, /Randomize/u);
  assert.match(previewHtml, /action="https:\/\/codepen\.io\/pen\/define"/u);
  assert.match(previewHtml, /method="post"[\s\S]*target="_blank"/u);
  assert.match(previewHtml, /id="codepen-data" type="hidden" name="data"/u);
  assert.equal([...previewHtml.matchAll(/id="codepen-button"/gu)].length, 1);
  assert.doesNotMatch(previewHtml, /codepen-dialog|codepen-embed-host|codepen-close-button/u);
  assert.doesNotMatch(
    previewHtml,
    /facesjs-codepen|polycss-codepen|class="codepen-button"/u,
  );

  const codePenHtml = previewSource.match(
    /function codePenHtml[\s\S]*?\n\}\n\nfunction codePenCss/u,
  )?.[0];
  assert.ok(codePenHtml, "Combined CodePen HTML is absent");
  assert.match(codePenHtml, /FacesJS: the original 2D face\./u);
  assert.match(codePenHtml, /PolyCSS: the same face rendered in 3D\./u);
  assert.match(codePenHtml, /id="face-2d"/u);
  assert.match(codePenHtml, /id="face-3d"/u);
});

test("the top bar uses icon-only share and paired image download actions", () => {
  assert.match(
    previewHtml,
    /id="share-button"[\s\S]*?aria-label="Share face"[\s\S]*?<svg/u,
  );
  assert.match(
    previewHtml,
    /id="download-button"[\s\S]*?aria-label="Download FacesJS and PolyCSS images"[\s\S]*?<svg/u,
  );
  assert.doesNotMatch(previewHtml, /<span>(?:Share|Download)<\/span>/u);
  assert.match(previewSource, /import \{ toBlob \} from "html-to-image"/u);
  assert.match(
    previewSource,
    /captureFaceImage\(sourceCanvas, sourcePanel\)[\s\S]*captureFaceImage\(outputCanvas, outputPanel\)/u,
  );
  assert.match(previewSource, /cssface-\$\{currentSeed\}-facesjs\.png/u);
  assert.match(previewSource, /cssface-\$\{currentSeed\}-polycss\.png/u);
  assert.doesNotMatch(previewSource, /cssface-\$\{currentSeed\}\.json/u);
});

test("the prepared scene and examples preserve single-sided shell culling", () => {
  const selector = String.raw`\.polycss-scene \[data-polycss-double-sided="true"\] \{\s*backface-visibility: visible;`;
  assert.doesNotMatch(previewCss, new RegExp(selector, "u"));

  const codePenCss = previewSource.match(
    /function codePenCss[\s\S]*?\n\}\n\nfunction codePenSnippet/u,
  )?.[0];
  assert.ok(codePenCss, "Combined CodePen CSS is absent");
  assert.doesNotMatch(codePenCss, new RegExp(selector, "u"));
});

test("the final scene keeps projected hair fill and omits only its ink outline", () => {
  assert.match(
    prepareSource,
    /family === "hair" && role === "ink" && materialId\.endsWith\("-front"\)/u,
  );
  assert.match(
    prepareSource,
    /isProjectedHairOutline\(family, role, leaf\.materialId\)/u,
  );
});

test("the live scene selects the prepared lighting field with one root write", () => {
  assert.match(sceneSource, /ROTATION_ROW_VARIABLE = "--cssface-rotation-row"/u);
  assert.match(sceneSource, /rotationLighting\.apply\(yaw\)/u);
  assert.match(sceneSource, /stateWrites \+= 1/u);
  assert.doesNotMatch(sceneSource, /textureLighting: "dynamic"/u);
  assert.match(sceneSource, /rotation: \[yaw, 0, 0\]/u);
  assert.match(previewSource, /direction: \[-0\.18, -0\.22, 0\.96\]/u);
  assert.match(sceneSource, /seamBleed: 0/u);
  assert.match(previewSource, /seamBleed: 0/u);
});

test("pointer drags rotate the 3D preview horizontally only", () => {
  assert.match(
    sceneSource,
    /yaw -= deltaX \* 0\.32/u,
  );
  assert.match(
    previewSource,
    /orbitYaw -= deltaX \* 0\.32/u,
  );
  assert.doesNotMatch(sceneSource, /event\.clientY|\bpitch\b/u);
  assert.doesNotMatch(previewSource, /event\.clientY|orbitPitch/u);
});

test("loading spinners never share a visible frame with either face", () => {
  assert.match(
    previewCss,
    /\.source-canvas\[aria-busy="true"\] #source-face,\s*\.stage\[aria-busy="true"\] \.stage-host \{\s*visibility: hidden;/u,
  );
  assert.match(
    previewSource,
    /container\.setAttribute\("aria-busy", "false"\);\s*spinner\.hidden = true;/u,
  );
});
