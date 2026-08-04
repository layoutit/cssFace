import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  cssPositionToWorld,
  optimizeMeshPolygons,
} from "@layoutit/polycss";
import {
  svgs as facesJsSvgs,
} from "facesjs";

import {
  buildCssGraphicsCatalog,
} from "../../../cli/catalog.mjs";
import {
  CSSGRAPHICS_GENERIC_JSON_CODEC_ID,
  cssGraphicsContentHash,
} from "../../../model-package/modelPackage.mjs";
import {
  writeCssGraphicsModelPackage,
} from "../../../prepare/shared/modelPackage.mjs";
import {
  replaceGeneratedOutput,
} from "../../../prepare/shared/output.mjs";
import {
  createFacesJsComponentRuntime,
} from "../player/componentRuntime.js";
import {
  CSSFACE_GENERATOR_ID,
  CSSFACE_PREPARED_FACE_CATALOG_SCHEMA,
  generateCssFaceConfig,
  resolveFacesJsFaceConfig,
} from "../player/faceConfigResolver.js";
import {
  resolveFacesJsMorphWeights,
  validateFacesJsFaceConfig,
} from "../player/configTransforms.js";
import {
  facesJsShaveOpacity,
  resolveFacesJsMaterialColors,
} from "../player/materialColors.js";
import {
  compileFacesJsPaintedTankTop,
} from "./paintedBodyCompiler.mjs";
import {
  compileFacesJsPolygonRotationLighting,
  FACES_JS_COMPONENT_ROTATION_DIFFUSE_ROLE,
  FACES_JS_COMPONENT_ROTATION_SPECULAR_ROLE,
} from "./rotationLightingCompiler.mjs";
import {
  assertFacesJsWeldedJunction,
  compileFacesJsWeldedNeck,
  extractFacesJsBoundaryLoop,
  isFacesJsHeadUndersidePolygon,
} from "./weldedBustCompiler.mjs";

const MAXIMUM_MODEL_LEAVES = 2_000;
const FACES_JS_PROFILE = "facesjs-face";
const FACES_JS_PREPARED_SCENE_SCHEMA = "cssface.facesjs-prepared-scene@2";
const FACES_JS_FACE_DOCUMENT_SCHEMA = "cssface.polycss-face@1";
const FACES_JS_MODEL_REVISION = "1.0.0";

const repoRoot = process.cwd();
const argumentsList = process.argv.slice(2).filter((argument) => argument !== "--");
const checkMode = argumentsList.includes("--check");
const outputRoot = resolve(repoRoot, "public/cssgraphics");
const faceOutputRoot = resolve(repoRoot, "public/f");
const componentRoot = resolve(repoRoot, "public/facesjs-components");
const componentCatalogPath = resolve(componentRoot, "catalog.json");
const presetsPath = resolve(repoRoot, "src/adapters/facesjs/presets.json");

function slug(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();
}

function variedBaselineFace(baseFace, catalog, index) {
  const face = structuredClone(validateFacesJsFaceConfig(baseFace));
  const variation = generateCssFaceConfig(catalog, index % 10_000);
  face.fatness = variation.fatness;
  face.teamColors = variation.teamColors;
  face.body.color = variation.body.color;
  face.body.size = variation.body.size;
  face.ear.size = variation.ear.size;
  face.head.shave = variation.head.shave;
  face.smileLine.size = variation.smileLine.size;
  face.eye.angle = variation.eye.angle;
  face.eyebrow.angle = variation.eyebrow.angle;
  face.hair.color = variation.hair.color;
  face.hair.flip = variation.hair.flip;
  face.mouth.flip = variation.mouth.flip;
  face.nose.flip = variation.nose.flip;
  face.nose.size = variation.nose.size;
  return face;
}

function faceForComponent(baseFace, componentGraph, row, index) {
  const { catalog } = componentGraph;
  const face = variedBaselineFace(baseFace, catalog, index);
  if (row.family === "hairBg") {
    const matchingHair = catalog.components.find((candidate) =>
      candidate.family === "hair"
      && candidate.dependencies.some((dependency) =>
        dependency.family === "hairBg" && dependency.sourceId === row.sourceId));
    if (row.sourceId !== "none" && !matchingHair) {
      throw new TypeError(`FacesJS hairBg.${row.sourceId} has no selectable hair.`);
    }
    face.hairBg.id = row.sourceId;
    if (matchingHair) face.hair.id = matchingHair.sourceId;
  } else if (row.family === "hair") {
    face.hair.id = row.sourceId;
    face.hairBg.id = row.dependencies.find(
      ({ family }) => family === "hairBg",
    )?.sourceId ?? "none";
  } else {
    face[row.family].id = row.sourceId;
  }
  const validated = validateFacesJsFaceConfig(face);
  const selectedKey = `${row.family}:${row.sourceId}`;
  const resolved = resolveFacesJsFaceConfig(componentGraph, validated);
  if (!resolved.selectedKeys.includes(selectedKey)) {
    throw new TypeError(`FacesJS ${selectedKey} is not selected by its prepared face.`);
  }
  return validated;
}

function generatedFacePresets(componentRuntime, compatibilityPresets) {
  const basePreset = compatibilityPresets.find(({ id }) => id === "bald")
    ?? compatibilityPresets[0];
  if (!basePreset) throw new TypeError("FacesJS has no compatibility baseline.");
  const catalog = componentRuntime.graph.catalog;
  const generated = catalog.components.map((row, index) => Object.freeze({
    id: `component-${slug(row.family)}-${slug(row.sourceId)}`,
    name: `${row.family}.${row.sourceId}`,
    modelId: `facesjs-${slug(row.family)}-${slug(row.sourceId)}`,
    face: faceForComponent(basePreset.face, componentRuntime.graph, row, index),
  }));
  return Object.freeze([
    ...compatibilityPresets,
    ...generated,
  ]);
}

function preparedFaceCatalog(presets) {
  return Object.freeze({
    schema: CSSFACE_PREPARED_FACE_CATALOG_SCHEMA,
    generator: CSSFACE_GENERATOR_ID,
    models: Object.freeze(presets.map(({ name, modelId, face }, id) =>
      Object.freeze({ id, name, modelId, face }))),
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function files(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  await visit(root);
  return output.sort((left, right) => left.localeCompare(right));
}

async function assertDirectoryMatches(actualRoot, expectedRoot, label) {
  if (!await exists(expectedRoot)) throw new Error(`${label} is absent.`);
  const [actualFiles, expectedFiles] = await Promise.all([
    files(actualRoot),
    files(expectedRoot),
  ]);
  const actualRows = actualFiles.map((path) => relative(actualRoot, path));
  const expectedRows = expectedFiles.map((path) => relative(expectedRoot, path));
  if (JSON.stringify(actualRows) !== JSON.stringify(expectedRows)) {
    throw new Error(`${label} file inventory is stale.`);
  }
  for (let index = 0; index < actualRows.length; index += 1) {
    const [actual, expected] = await Promise.all([
      readFile(actualFiles[index]),
      readFile(expectedFiles[index]),
    ]);
    if (!actual.equals(expected)) {
      throw new Error(`${label} ${actualRows[index]} is stale.`);
    }
  }
}

function componentMediaType(path) {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".gz") || path.endsWith(".bin")) return "application/gzip";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

async function localComponentFetch(input) {
  const url = typeof input === "string" ? input : input.url;
  const prefix = "/facesjs-components/";
  if (!url.startsWith(prefix)) return new Response(null, { status: 404 });
  const path = url.slice(prefix.length);
  if (!path || path.startsWith("/") || path.includes("\\")
    || path.split("/").includes("..")) {
    return new Response(null, { status: 400 });
  }
  try {
    const bytes = await readFile(resolve(componentRoot, path));
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": componentMediaType(path) },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

function rounded(value) {
  const output = Number(value.toFixed(10));
  return Object.is(output, -0) ? 0 : output;
}

function materialOpacity(role, faceConfig) {
  if (role === "lens") return 0.5;
  if (role === "accessory-translucent-ink") return 0.53;
  if (role === "head-shave" || role === "face-shave") {
    return facesJsShaveOpacity(faceConfig.head.shave);
  }
  return 1;
}

function colorWithOpacity(color, opacity) {
  if (opacity >= 1) return color;
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return `rgb(${red} ${green} ${blue} / ${Number(opacity.toFixed(3))})`;
}

function transformCssPoint(matrix, point) {
  const [x, y, z] = point;
  return [
    rounded(matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]),
    rounded(matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]),
    rounded(matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]),
  ];
}

function featureDepthOffset(polygonId) {
  return polygonId.startsWith("eye-") || polygonId.startsWith("eyebrow-")
    ? 2
    : 0;
}

const HEAD_SURFACE_FAMILIES = Object.freeze(new Set([
  "accessories",
  "eye",
  "eyeLine",
  "eyebrow",
  "facialHair",
  "glasses",
  "hair",
  "hairBg",
  "miscLine",
  "mouth",
  "nose",
  "smileLine",
]));

function componentDescriptors(selectedKeys) {
  return selectedKeys.map((selectedKey) => {
    const separator = selectedKey.indexOf(":");
    const family = selectedKey.slice(0, separator);
    const sourceId = selectedKey.slice(separator + 1);
    const prefix = `${family}-${sourceId}`
      .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
      .toLowerCase();
    return Object.freeze({ family, prefix: `${prefix}-` });
  }).sort((left, right) => right.prefix.length - left.prefix.length);
}

function polygonFamily(polygonId, descriptors) {
  const descriptor = descriptors.find(({ prefix }) => polygonId.startsWith(prefix));
  if (!descriptor) throw new TypeError(`FacesJS polygon ${polygonId} has no component family.`);
  return descriptor.family;
}

function isProjectedHairOutline(family, role, materialId) {
  return family === "hair" && role === "ink" && materialId.endsWith("-front");
}

function boundsCenter(rows) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const { vertices } of rows) {
    for (const vertex of vertices) {
      for (let axis = 0; axis < 3; axis += 1) {
        minimum[axis] = Math.min(minimum[axis], vertex[axis]);
        maximum[axis] = Math.max(maximum[axis], vertex[axis]);
      }
    }
  }
  return minimum.map((value, axis) => (value + maximum[axis]) * 0.5);
}

function triangleNormal(vertices) {
  const [origin, middle, end] = vertices;
  const first = middle.map((value, axis) => value - origin[axis]);
  const second = end.map((value, axis) => value - origin[axis]);
  return [
    (first[1] * second[2]) - (first[2] * second[1]),
    (first[2] * second[0]) - (first[0] * second[2]),
    (first[0] * second[1]) - (first[1] * second[0]),
  ];
}

function orientAwayFromCenter(vertices, center) {
  const centroid = [0, 1, 2].map((axis) =>
    vertices.reduce((sum, vertex) => sum + vertex[axis], 0) / vertices.length);
  const normal = triangleNormal(vertices);
  const towardCenter = center.map((value, axis) => value - centroid[axis]);
  const alignment = normal.reduce((sum, value, axis) =>
    sum + (value * towardCenter[axis]), 0);
  return alignment <= 0
    ? vertices
    : [vertices[0], ...vertices.slice(1).reverse()];
}

function optimizePreparedRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.family, row.role, row.color]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const output = [];
  for (const group of groups.values()) {
    const first = group[0];
    const optimized = optimizeMeshPolygons(
      group.map(({ vertices, color }) => ({ vertices, color })),
      {
        meshResolution: "lossless",
        stopAtPolygonCount: MAXIMUM_MODEL_LEAVES,
      },
    );
    output.push(...optimized.map((polygon) => Object.freeze({
      family: first.family,
      role: first.role,
      vertices: Object.freeze(polygon.vertices.map((vertex) => Object.freeze([...vertex]))),
      color: polygon.color,
    })));
  }
  return Object.freeze(output);
}

function resolvePreparedPolygons(composed, faceConfig) {
  const model = composed.model;
  const vertices = model.topology.vertices.map((position) => [...position]);
  const targetIds = new Set(
    model.deformation.kind === "morph-regions"
      ? model.deformation.targets.map(({ id }) => id)
      : [],
  );
  const weights = resolveFacesJsMorphWeights(faceConfig, targetIds);
  if (model.deformation.kind === "morph-regions") {
    for (const target of model.deformation.targets) {
      const weight = weights[target.id] ?? 0;
      if (weight === 0) continue;
      for (const delta of target.deltas) {
        if (!delta.position) continue;
        const vertex = vertices[delta.vertexIndex];
        for (let axis = 0; axis < 3; axis += 1) {
          vertex[axis] = rounded(vertex[axis] + delta.position[axis] * weight);
        }
      }
    }
  }

  const colors = resolveFacesJsMaterialColors({
    skin: faceConfig.body.color,
    hair: faceConfig.hair.color,
    headShave: faceConfig.head.shave,
    teamColors: faceConfig.teamColors,
  });
  const leavesByPolygon = new Map(
    model.render.leaves.map((leaf) => [leaf.polygonId, leaf]),
  );
  const descriptors = componentDescriptors(composed.selectedKeys);
  const paintsTankTopCells = faceConfig.jersey.id.startsWith("jersey");
  const resolvedRows = [];
  for (const polygon of model.topology.polygons) {
    const leaf = leavesByPolygon.get(polygon.id);
    if (!leaf) throw new TypeError(`FacesJS polygon ${polygon.id} has no material binding.`);
    const role = composed.materialRoles.get(leaf.materialId);
    const color = role ? colors[role] : undefined;
    if (!role || !color) {
      throw new TypeError(`FacesJS material ${leaf.materialId} has no resolved color role.`);
    }
    const opacity = materialOpacity(role, faceConfig);
    if (opacity <= 0) continue;
    const depthOffset = featureDepthOffset(polygon.id);
    const family = polygonFamily(polygon.id, descriptors);
    if ((paintsTankTopCells && (family === "body" || family === "jersey"))
      || isProjectedHairOutline(family, role, leaf.materialId)) continue;
    const preparedVertices = polygon.vertexIndices.map((index) => [
      vertices[index][0],
      vertices[index][1],
      vertices[index][2] + depthOffset,
    ]);
    if (family === "head" && role === "skin"
      && isFacesJsHeadUndersidePolygon(preparedVertices)) continue;
    resolvedRows.push(Object.freeze({
      family,
      role,
      vertices: preparedVertices.map((vertex) =>
        cssPositionToWorld(
          transformCssPoint(composed.base.modelMatrix, vertex),
        ).map(rounded)),
      color: colorWithOpacity(color, opacity),
    }));
  }
  const headRows = resolvedRows.filter((row) => row.family === "head" && row.role === "skin");
  const headBoundary = extractFacesJsBoundaryLoop(headRows, "head underside");
  let paintedBody;
  if (paintsTankTopCells) {
    const bodyFragment = facesJsSvgs.body?.[faceConfig.body.id];
    const jerseyFragment = facesJsSvgs.jersey?.[faceConfig.jersey.id];
    if (typeof bodyFragment !== "string" || typeof jerseyFragment !== "string") {
      throw new TypeError(
        `FacesJS painted body source ${faceConfig.body.id}/${faceConfig.jersey.id} is absent.`,
      );
    }
    paintedBody = compileFacesJsPaintedTankTop({
      bodyFragment,
      jerseyFragment,
      bodySize: faceConfig.body.size,
      modelMatrix: composed.base.modelMatrix,
    });
  } else {
    paintedBody = Object.freeze({
      rows: Object.freeze([]),
      metrics: Object.freeze({
        polygonCount: 0,
        jerseyPolygonCount: 0,
        skinPolygonCount: 0,
        openingSourceY: null,
      }),
    });
  }
  const paintedBodyRows = paintedBody.rows.map((row) => Object.freeze({
    ...row,
    color: colors[row.role],
  }));
  resolvedRows.push(...paintedBodyRows);
  const bodyRows = paintsTankTopCells
    ? paintedBodyRows
    : resolvedRows.filter((row) => row.family === "body" && row.role === "skin");
  const bodyBoundary = extractFacesJsBoundaryLoop(bodyRows, "body opening");
  const weldedNeck = compileFacesJsWeldedNeck({ headBoundary, bodyBoundary });
  assertFacesJsWeldedJunction({
    headRows,
    bodyRows,
    neckRows: weldedNeck.rows,
    headBoundary,
    bodyBoundary,
  });
  resolvedRows.push(...weldedNeck.rows.map((row) => Object.freeze({
    ...row,
    color: colors[row.role],
  })));
  const rowsByFamily = new Map();
  for (const row of resolvedRows) {
    const familyRows = rowsByFamily.get(row.family) ?? [];
    familyRows.push(row);
    rowsByFamily.set(row.family, familyRows);
  }
  const centers = new Map([...rowsByFamily].map(([family, rows]) => [
    family,
    boundsCenter(rows),
  ]));
  const headCenter = centers.get("head");
  if (!headCenter) throw new TypeError("FacesJS prepared face has no head center.");
  const orientedRows = resolvedRows.map(({ family, role, vertices: rowVertices, color }) => {
    const center = HEAD_SURFACE_FAMILIES.has(family)
      ? headCenter
      : centers.get(family);
    if (!center) throw new TypeError(`FacesJS ${family} has no winding center.`);
    return Object.freeze({
      family,
      role,
      vertices: Object.freeze(orientAwayFromCenter(rowVertices, center)
        .map((vertex) => Object.freeze(vertex))),
      color,
    });
  });
  const optimizedRows = optimizePreparedRows(orientedRows);
  const polygonsByFamily = Object.freeze(Object.fromEntries(
    [...new Set(optimizedRows.map(({ family }) => family))].map((family) => [
      family,
      optimizedRows.filter((row) => row.family === family).length,
    ]),
  ));
  const polygons = optimizedRows.map(({ vertices, color }) => Object.freeze({
    vertices,
    color,
  }));
  return Object.freeze({
    rawCount: orientedRows.length,
    polygons: Object.freeze(polygons),
    materialRoles: Object.freeze(optimizedRows.map(({ role }) => role)),
    paintedBody: paintedBody.metrics,
    weldedJunction: weldedNeck.metrics,
    polygonsByFamily,
    weights,
  });
}

async function buildPreset(componentRuntime, preset, faceId, output) {
  const faceConfig = validateFacesJsFaceConfig(preset.face);
  const composed = await componentRuntime.composeFaceConfig(faceConfig, preset.id);
  const prepared = resolvePreparedPolygons(composed, faceConfig);
  if (prepared.polygons.length > MAXIMUM_MODEL_LEAVES) {
    throw new RangeError(
      `FacesJS preset ${preset.id} has ${prepared.polygons.length} PolyCSS polygons; `
      + `the hard maximum is ${MAXIMUM_MODEL_LEAVES}. `
      + `${JSON.stringify(prepared.polygonsByFamily)}`,
    );
  }
  const rotationLighting = await compileFacesJsPolygonRotationLighting({
    modelId: preset.modelId,
    modelRevision: FACES_JS_MODEL_REVISION,
    polygons: prepared.polygons,
    materialRoles: prepared.materialRoles,
  });
  const scene = Object.freeze({
    schema: FACES_JS_PREPARED_SCENE_SCHEMA,
    id: preset.modelId,
    artifactMode: "polycss-polygons",
    fixtureId: preset.id,
    faceConfig,
    polygons: prepared.polygons,
    rotationLighting: rotationLighting.contract,
    selectedKeys: composed.selectedKeys,
  });
  const provenance = Object.freeze({
    schema: "cssface.facesjs-package-source@2",
    renderer: "@layoutit/polycss",
    componentCatalog: componentRuntime.graph.catalog.contentHash,
    selectedKeys: composed.selectedKeys,
    fixtureId: preset.id,
    paintedBody: prepared.paintedBody,
    weldedJunction: prepared.weldedJunction,
  });
  const generationHash = await cssGraphicsContentHash({
    schema: "cssface.facesjs-package-generation@2",
    scene,
    provenance,
    assets: {
      [FACES_JS_COMPONENT_ROTATION_DIFFUSE_ROLE]: sha256(
        rotationLighting.diffuseImageBytes,
      ),
      [FACES_JS_COMPONENT_ROTATION_SPECULAR_ROLE]: sha256(
        rotationLighting.specularImageBytes,
      ),
    },
  });
  const packaged = await writeCssGraphicsModelPackage({
    outputRoot: output,
    id: preset.modelId,
    name: `FacesJS ${preset.name} Face`,
    profile: FACES_JS_PROFILE,
    features: [
      "polycss-polygons",
      "prebaked-face",
      FACES_JS_COMPONENT_ROTATION_DIFFUSE_ROLE,
      FACES_JS_COMPONENT_ROTATION_SPECULAR_ROLE,
      "source-provenance",
    ],
    generationHash,
    codecId: CSSGRAPHICS_GENERIC_JSON_CODEC_ID,
    sections: { provenance, scene },
    css: `[data-cssgraphics-model="${preset.modelId}"] { position: relative; }`,
    assets: [
      {
        role: FACES_JS_COMPONENT_ROTATION_DIFFUSE_ROLE,
        bytes: rotationLighting.diffuseImageBytes,
      },
      {
        role: FACES_JS_COMPONENT_ROTATION_SPECULAR_ROLE,
        bytes: rotationLighting.specularImageBytes,
      },
    ],
  });
  const faceDocument = Object.freeze({
    schema: FACES_JS_FACE_DOCUMENT_SCHEMA,
    id: faceId,
    polygons: prepared.polygons,
    lighting: Object.freeze({
      spinSteps: rotationLighting.contract.state.spinSteps,
      sourcePx: rotationLighting.contract.state.fieldSourcePx,
      width: rotationLighting.contract.atlases.diffuse.width,
      height: rotationLighting.contract.atlases.diffuse.height,
      diffuse: `${faceId}-d.webp`,
      specular: `${faceId}-s.webp`,
    }),
  });
  return Object.freeze({
    id: preset.modelId,
    faceId,
    fixtureId: preset.id,
    sourcePolygons: prepared.rawCount,
    polygons: prepared.polygons.length,
    paintedBody: prepared.paintedBody,
    weldedJunction: prepared.weldedJunction,
    lightingTexels: rotationLighting.contract.leafIds.length,
    manifest: packaged.manifest.contentHash,
    faceDocument,
    faceAssets: Object.freeze([
      Object.freeze({
        file: faceDocument.lighting.diffuse,
        bytes: rotationLighting.diffuseImageBytes,
      }),
      Object.freeze({
        file: faceDocument.lighting.specular,
        bytes: rotationLighting.specularImageBytes,
      }),
    ]),
  });
}

async function buildOutput(stagingRoot, presets, componentRuntime) {
  const modelsRoot = resolve(stagingRoot, "models");
  await mkdir(modelsRoot, { recursive: true });
  const rows = [];
  for (const [faceId, preset] of presets.entries()) {
    const modelRoot = resolve(modelsRoot, preset.modelId);
    await mkdir(modelRoot, { recursive: true });
    try {
      const row = await buildPreset(componentRuntime, preset, faceId, modelRoot);
      rows.push(row);
    } catch (error) {
      throw new Error(`FacesJS preset ${preset.id} preparation failed.`, { cause: error });
    }
  }
  const modelRoots = rows.map(({ id }) => resolve(modelsRoot, id));
  const catalog = await buildCssGraphicsCatalog({
    modelRoots,
    defaultId: presets[0].modelId,
  });
  await Promise.all([
    writeFile(resolve(stagingRoot, "catalog.json"), catalog.bytes),
    writeFile(
      resolve(stagingRoot, "faces.json"),
      `${JSON.stringify(preparedFaceCatalog(presets))}\n`,
    ),
  ]);
  return Object.freeze({ catalog: catalog.catalog, rows: Object.freeze(rows) });
}

async function writeFaceDocuments(output, rows) {
  await mkdir(output, { recursive: true });
  await Promise.all(rows.flatMap((row) => [
    writeFile(
      resolve(output, `${row.faceId}.json`),
      `${JSON.stringify(row.faceDocument)}\n`,
    ),
    ...row.faceAssets.map(({ file, bytes }) => writeFile(resolve(output, file), bytes)),
  ]));
}

if (!await exists(componentCatalogPath)) {
  throw new Error(
    "CSSFace preparation requires public/facesjs-components; run pnpm build:facesjs-components first.",
  );
}
const compatibilityPresets = JSON.parse(await readFile(presetsPath, "utf8"));
if (!Array.isArray(compatibilityPresets) || compatibilityPresets.length === 0
  || new Set(compatibilityPresets.map(({ id }) => id)).size !== compatibilityPresets.length
  || new Set(compatibilityPresets.map(({ modelId }) => modelId)).size
    !== compatibilityPresets.length) {
  throw new Error("FacesJS prepared presets require unique fixture and model ids.");
}
const componentRuntime = await createFacesJsComponentRuntime(
  localComponentFetch,
  "/facesjs-components/",
);
const presets = generatedFacePresets(componentRuntime, compatibilityPresets);

let result;
try {
  if (checkMode) {
    const stagingRoot = await mkdtemp(resolve(repoRoot, "public/.facesjs-output-check-"));
    try {
      const cssGraphicsStagingRoot = resolve(stagingRoot, "cssgraphics");
      const faceStagingRoot = resolve(stagingRoot, "f");
      result = await buildOutput(cssGraphicsStagingRoot, presets, componentRuntime);
      await writeFaceDocuments(faceStagingRoot, result.rows);
      await assertDirectoryMatches(
        cssGraphicsStagingRoot,
        outputRoot,
        "FacesJS cssGraphics output",
      );
      await assertDirectoryMatches(
        faceStagingRoot,
        faceOutputRoot,
        "FacesJS public face documents",
      );
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  } else {
    result = await replaceGeneratedOutput({
      target: outputRoot,
      prefix: ".facesjs-cssgraphics-output-",
      build: (stagingRoot) => buildOutput(stagingRoot, presets, componentRuntime),
    });
    await replaceGeneratedOutput({
      target: faceOutputRoot,
      prefix: ".facesjs-face-documents-",
      build: async (stagingRoot) => {
        await writeFaceDocuments(stagingRoot, result.rows);
      },
    });
  }
} finally {
  componentRuntime.destroy();
}

console.log(JSON.stringify({
  standard: "cssgraphics.model@1",
  profile: FACES_JS_PROFILE,
  renderer: "@layoutit/polycss",
  catalog: result.catalog.contentHash,
  models: result.rows.map(({ faceDocument: _document, faceAssets: _assets, ...row }) => row),
  checked: checkMode,
}, null, 2));
