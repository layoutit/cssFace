import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import sharp from "sharp";
import earcut from "earcut";
import { svgs as facesJsSvgs } from "facesjs";
import {
  SOLID_QUAD_CANONICAL_SIZE,
} from "@layoutit/polycss";
import {
  buildPolyMorphCatalog,
  buildPolyMorphPackage,
  preparePolyMorphModel,
  validatePolyMorphModel,
} from "@layoutit/polycss-morph/prepare";

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
  boundsOfPaths,
  horizontalSpanAtY,
  parseSvgFragment,
  transformSvgPoint,
  transformSvgPaths,
  triangulateSvgContour,
  verticalSpanAtX,
} from "./svgGeometry.mjs";
import {
  loadBakedFaceline,
  normalizeBakedFaceline,
} from "./facelineGeometry.mjs";

const repoRoot = process.cwd();
const adapterRoot = resolve(repoRoot, "src/adapters/facesjs");
const presetsPath = resolve(adapterRoot, "presets.json");
const PRESETS = JSON.parse(await readFile(presetsPath, "utf8"));
const selectedPresetId = process.argv[2];

async function preparePreset(id) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [process.argv[1], id], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(
        `FacesJS preset ${id} preparation failed (${signal ?? code}).`,
      ));
    });
  });
}

if (!selectedPresetId) {
  for (const { id } of PRESETS) await preparePreset(id);
  process.exit(0);
}

const PRESET = PRESETS.find(({ id }) => id === selectedPresetId);
if (!PRESET) throw new Error(`Unknown FacesJS preset ${selectedPresetId}.`);
const FACE = PRESET.face;
const MODEL_ID = PRESET.modelId;
const MODEL_NAME = `FacesJS ${PRESET.name} Bust`;
const MODEL_SOURCE_FILENAME = `${MODEL_ID}.gltf`;
const localRoot = resolve(repoRoot, ".local/facesjs", PRESET.id);
const sourceRoot = resolve(localRoot, "source");
const morphOutputRoot = resolve(localRoot, "prepared/poly-morph");
const cssGraphicsRoot = resolve(repoRoot, "public/cssgraphics");
const cssGraphicsModelsRoot = resolve(cssGraphicsRoot, "models");
const outputRoot = resolve(cssGraphicsModelsRoot, MODEL_ID);
const polyMorphRoot = resolve(repoRoot, "public/faces");
const polyMorphModelsRoot = resolve(polyMorphRoot, "models");
const polyMorphOutputRoot = resolve(polyMorphModelsRoot, MODEL_ID);
const FACELINE_BY_HEAD_ID = Object.freeze({
  female1: 1,
  female2: 4,
  female3: 6,
  ...Object.fromEntries(Array.from({ length: 18 }, (_, index) => [
    `head${index + 1}`,
    index % 8,
  ])),
});
const FACELINE_INDEX = FACELINE_BY_HEAD_ID[FACE.head.id];
if (!Number.isInteger(FACELINE_INDEX)) {
  throw new Error(`FacesJS head.${FACE.head.id} has no faceline mapping.`);
}
const FACELINE_SOURCE = await loadBakedFaceline(
  resolve(adapterRoot, "assets/facelines.json"),
  FACELINE_INDEX,
);

const SOURCE_REVISION = "92c91d4b67893dbeef4053c25c04cc01fdd5419a";
const SUPPORTED_PARTS = Object.freeze({
  body: new Set(["body"]),
  ear: new Set(["ear1"]),
  eye: new Set(["eye1", "eye2"]),
  eyebrow: new Set(["eyebrow1"]),
  hair: new Set(["afro", "bald", "short", "short2"]),
  head: new Set(Object.keys(FACELINE_BY_HEAD_ID)),
  jersey: new Set(["jersey"]),
  mouth: new Set(["closed", "smile"]),
  nose: new Set(["nose1", "nose3"]),
});
for (const [part, ids] of Object.entries(SUPPORTED_PARTS)) {
  if (!ids.has(FACE[part].id)) {
    throw new Error(`FacesJS preset ${PRESET.id} uses unsupported ${part}.${FACE[part].id}.`);
  }
}
const SOURCE_SVG_FRAGMENTS = Object.freeze(Object.fromEntries(
  Object.keys(SUPPORTED_PARTS).map((part) => {
    const fragment = facesJsSvgs[part]?.[FACE[part].id];
    if (typeof fragment !== "string") {
      throw new Error(`FacesJS SVG source is missing ${part}.${FACE[part].id}.`);
    }
    return [part, fragment];
  }),
));
const SOURCE_SVG_PATHS = Object.freeze(Object.fromEntries(
  Object.entries(SOURCE_SVG_FRAGMENTS).map(([part, fragment]) => [
    part,
    parseSvgFragment(fragment),
  ]),
));
const SOURCE_SVG_SHA256 = sha256(Buffer.from(JSON.stringify(SOURCE_SVG_FRAGMENTS)));
const FACES_JS_PROFILE = "facesjs-face";
const FACES_JS_SCENE_SCHEMA = "cssgraphics.facesjs-scene@1";
const ROTATION_LIGHTING_SCHEMA = "cssgraphics.facesjs-rotation-lighting@3";
const ROTATION_LIGHTING_ASSET_ROLE = "rotation-texels";
const TRIANGLE_FALLBACK_ASSET_ROLE = "triangle-fallback";
const TRIANGLE_FALLBACK_RESOURCE_PATH = "assets/triangle-fallback.webp";
const ROTATION_LIGHTING_STEPS = 120;
const ROTATION_LIGHTING_FIELD_PX = 3;
const ROTATION_LIGHTING_KEY = Object.freeze({
  direction: Object.freeze([-0.62, -0.35, -0.70]),
  intensity: 0.92,
});
const ROTATION_LIGHTING_FILL = Object.freeze({
  direction: Object.freeze([0.55, -0.10, -0.55]),
  intensity: 0.06,
});
const ROTATION_LIGHTING_AMBIENT = 0.28;
const ROTATION_LIGHTING_VIEW_DIRECTION = Object.freeze([0, 0, -1]);
const ROTATION_LIGHTING_SPECULAR = Object.freeze({
  model: "blinn-phong",
  materials: Object.freeze({
    "skin-base": Object.freeze({ strength: 0.13, shininess: 14 }),
    "skin-shadow": Object.freeze({ strength: 0.08, shininess: 14 }),
    "ear-cap": Object.freeze({ strength: 0.04, shininess: 12 }),
    "hair-base": Object.freeze({ strength: 0, shininess: 1 }),
    "jersey-base": Object.freeze({ strength: 0.03, shininess: 10 }),
    "eye-white": Object.freeze({ strength: 0.16, shininess: 36 }),
    ink: Object.freeze({ strength: 0, shininess: 1 }),
  }),
});
const ROTATION_LIGHTING_TEMPORAL_MAX_RGB_DELTA = 4;
const MODEL_SCALE = 120;
const QUAD_PLANAR_EPSILON = 1e-6;
const HAIR_WELD_EPSILON = 1e-8;
const FEATURE_SURFACE_MINIMUM_CLEARANCE = 0.006;
const FEATURE_SURFACE_SAMPLE_RESOLUTION = 4;
const FEATURE_SURFACE_MAXIMUM_SUBDIVISIONS = 3;
const TARGETS = [
  { id: "fatness", name: "FacesJS Fatness" },
  { id: "body-size", name: "Body Size" },
  { id: "ear-size", name: "Ear Size" },
  { id: "nose-size", name: "Nose Size" },
  { id: "brow-up", name: "Brow Up" },
  { id: "brow-down", name: "Brow Down" },
];

function rgba(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [
    ((value >> 16) & 0xff) / 255,
    ((value >> 8) & 0xff) / 255,
    (value & 0xff) / 255,
    1,
  ];
}

const MATERIALS = [
  ["skin-base", rgba(FACE.body.color)],
  ["skin-shadow", rgba("#74453d")],
  ["ear-cap", rgba(FACE.body.color)],
  ["hair-base", rgba(FACE.hair.color)],
  ["eye-white", rgba("#ffffff")],
  ["ink", rgba("#000000")],
  ["jersey-base", rgba(FACE.teamColors[0])],
];

const MATERIAL_INDEX = new Map(
  MATERIALS.map(([id], index) => [id, index]),
);

const FACE_WIDTH_MINIMUM = 0.8;
const FACE_WIDTH_RANGE = 0.2;
const BODY_SIZE_MINIMUM = 0.75;
const BODY_SIZE_RANGE = 0.5;
const DEFAULT_FACE_WIDTH = FACE_WIDTH_MINIMUM + (FACE.fatness * FACE_WIDTH_RANGE);
const SOURCE_FACE_HORIZONTAL_SCALE = 0.9;
const SVG_FACE_X_SCALE = 1.07 / 150;
const SVG_FACE_Z_SCALE = (1.48 - -0.99) / 400;

function svgFaceX(value) {
  return (value - 200) * SVG_FACE_X_SCALE;
}

function svgFaceZ(value) {
  return 1.48 - ((value - 100) * SVG_FACE_Z_SCALE);
}

function primarySourceContour(part) {
  const contour = SOURCE_SVG_PATHS[part]
    ?.flatMap((path) => path.subpaths)
    .find((subpath) => subpath.points.length >= 3)
    ?.points;
  if (!contour) throw new Error(`FacesJS SVG source ${part}.${FACE[part].id} has no contour.`);
  return contour;
}

const HEAD_SOURCE_CONTOUR = primarySourceContour("head");
const HEAD_SAMPLE_ROWS = Object.freeze([
  { y: 102, quadGroup: 0, depthRatio: 0.80 },
  { y: 110, quadGroup: 0, depthRatio: 0.80 },
  { y: 125, quadGroup: 0, depthRatio: 0.80 },
  { y: 150, quadGroup: 1, depthRatio: 0.755 },
  { y: 180, quadGroup: 1, depthRatio: 0.755 },
  { y: 220, quadGroup: 1, depthRatio: 0.755 },
  { y: 270, quadGroup: 1, depthRatio: 0.755 },
  { y: 320, quadGroup: 1, depthRatio: 0.755 },
  { y: 370, quadGroup: 1, depthRatio: 0.755 },
  { y: 420, quadGroup: 1, depthRatio: 0.755 },
  { y: 455, quadGroup: 2, depthRatio: 0.82 },
  { y: 480, quadGroup: 2, depthRatio: 0.82 },
  { y: 493, quadGroup: 3, depthRatio: 0.96 },
  { y: 498, quadGroup: 3, depthRatio: 0.96 },
]);

function sourceRadiusAtY(contour, y) {
  const span = horizontalSpanAtY(contour, y);
  if (!span) throw new Error(`FacesJS SVG contour has no horizontal span at y=${y}.`);
  return ((span[1] - span[0]) / 2) * SVG_FACE_X_SCALE;
}

const HEAD_SOURCE_BANDS = HEAD_SAMPLE_ROWS.map((row) => Object.freeze({
  ...row,
  z: svgFaceZ(row.y),
  radius: sourceRadiusAtY(HEAD_SOURCE_CONTOUR, row.y),
}));
const HEAD_BANDS = HEAD_SOURCE_BANDS.map((band) => Object.freeze({
  z: band.z,
  radius: band.radius,
  depth: band.radius * band.depthRatio,
  quadGroup: band.quadGroup,
}));
const FACELINE = normalizeBakedFaceline(FACELINE_SOURCE, {
  bottom: svgFaceZ(500),
  frontDepth: 0.84,
  halfWidth: Math.max(...HEAD_BANDS.map(({ radius }) => radius)),
  top: svgFaceZ(180),
});

const HAIR_SOURCE_CONTOUR = SOURCE_SVG_PATHS.hair.length
  ? primarySourceContour("hair")
  : null;
const HAIR_FRONT_HALF_WIDTH = 140;

function frontHairlineSourceY(normalizedX) {
  if (!HAIR_SOURCE_CONTOUR) return 200;
  const x = 200 + (Math.max(-1, Math.min(1, normalizedX)) * HAIR_FRONT_HALF_WIDTH);
  const span = verticalSpanAtX(HAIR_SOURCE_CONTOUR, x);
  if (!span) throw new Error(`FacesJS hair SVG has no vertical span at x=${x}.`);
  return span[1];
}

function hairlineZ(angle) {
  const sine = Math.sin(angle);
  if (sine <= 0) return svgFaceZ(frontHairlineSourceY(Math.cos(angle)));
  const sideY = Math.max(
    frontHairlineSourceY(-1),
    frontHairlineSourceY(1),
  );
  return svgFaceZ(sideY + (55 * sine));
}

function vectorSub(left, right) {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function dot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function normalize(vector) {
  const length = Math.hypot(...vector);
  return length > 1e-12
    ? vector.map((component) => component / length)
    : [0, 0, 0];
}

function triangleNormal(points) {
  return normalize(cross(
    vectorSub(points[1], points[0]),
    vectorSub(points[2], points[0]),
  ));
}

function oriented(points, expected) {
  return dot(triangleNormal(points), expected) >= 0
    ? points
    : [points[0], points[2], points[1]];
}

function shadedMaterial(family) {
  return `${family}-base`;
}

function zeroDeltas() {
  return Object.fromEntries(TARGETS.map(({ id }) => [id, [0, 0, 0]]));
}

function vertex(position, morphs = {}, fat = false) {
  const deltas = zeroDeltas();
  if (fat) deltas.fatness = [position[0] * FACE_WIDTH_RANGE, 0, 0];
  for (const [id, delta] of Object.entries(morphs)) deltas[id] = delta;
  return {
    position: [
      (fat ? position[0] * FACE_WIDTH_MINIMUM : position[0]) * SOURCE_FACE_HORIZONTAL_SCALE,
      position[1],
      position[2],
    ],
    deltas: Object.fromEntries(Object.entries(deltas).map(([id, delta]) => [
      id,
      [delta[0] * SOURCE_FACE_HORIZONTAL_SCALE, delta[1], delta[2]],
    ])),
  };
}

function sourceVertexStateKey(row) {
  const values = [...row.position];
  for (const { id } of TARGETS) values.push(...row.deltas[id]);
  return values.map(rounded).join(",");
}

function primitiveMap() {
  const vertexPool = {
    positions: [],
    vertexIndexByState: new Map(),
    targetValues: Object.fromEntries(TARGETS.map(({ id }) => [id, []])),
  };
  return new Map(MATERIALS.map(([id]) => [id, {
    indices: [],
    quadPairs: [],
    vertexPool,
  }]));
}

function appendTriangle(primitives, materialId, rows) {
  const primitive = primitives.get(materialId);
  if (!primitive) throw new Error(`Unknown material ${materialId}.`);
  const polygonIndex = primitive.indices.length / 3;
  const indices = [];
  for (const row of rows) {
    const key = sourceVertexStateKey(row);
    let vertexIndex = primitive.vertexPool.vertexIndexByState.get(key);
    if (vertexIndex === undefined) {
      vertexIndex = primitive.vertexPool.positions.length / 3;
      primitive.vertexPool.vertexIndexByState.set(key, vertexIndex);
      primitive.vertexPool.positions.push(...row.position);
      for (const { id } of TARGETS) {
        primitive.vertexPool.targetValues[id].push(...row.deltas[id]);
      }
    }
    indices.push(vertexIndex);
  }
  if (new Set(indices).size !== 3) {
    throw new Error("FacesJS source triangle collapsed after shared-vertex indexing.");
  }
  primitive.indices.push(...indices);
  return polygonIndex;
}

function addSurfaceTriangle(
  primitives,
  family,
  positions,
  expected,
  makeVertex,
) {
  const ordered = oriented(positions, expected);
  const normal = triangleNormal(ordered);
  return appendTriangle(
    primitives,
    shadedMaterial(family, normal),
    ordered.map((position) => makeVertex(position)),
  );
}

function addSurfaceTrianglePair(
  primitives,
  family,
  triangles,
  expected,
  makeVertex,
  quadCandidate = true,
) {
  const materialId = shadedMaterial(family);
  const first = addSurfaceTriangle(
    primitives,
    family,
    triangles[0],
    expected,
    makeVertex,
  );
  const second = addSurfaceTriangle(
    primitives,
    family,
    triangles[1],
    expected,
    makeVertex,
  );
  if (quadCandidate) {
    primitives.get(materialId).quadPairs.push([first, second]);
  }
}

function addPlanarFan(
  primitives,
  materialId,
  points,
  depth,
  makeVertex = (position) => vertex(position),
) {
  const center = [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    depth,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
  ];
  for (let index = 0; index < points.length; index += 1) {
    const next = (index + 1) % points.length;
    const positions = oriented([
      center,
      [points[index][0], depth, points[index][1]],
      [points[next][0], depth, points[next][1]],
    ], [0, -1, 0]);
    appendTriangle(primitives, materialId, positions.map(makeVertex));
  }
}

function headBandAt(z) {
  if (z >= HEAD_BANDS[0].z) return HEAD_BANDS[0];
  if (z <= HEAD_BANDS.at(-1).z) return HEAD_BANDS.at(-1);
  for (let index = 0; index < HEAD_BANDS.length - 1; index += 1) {
    const upper = HEAD_BANDS[index];
    const lower = HEAD_BANDS[index + 1];
    if (z > upper.z || z < lower.z) continue;
    const amount = (upper.z - z) / (upper.z - lower.z);
    return {
      z,
      radius: upper.radius + ((lower.radius - upper.radius) * amount),
      depth: upper.depth + ((lower.depth - upper.depth) * amount),
    };
  }
  throw new Error(`Unable to sample head at z=${z}.`);
}

function inferredFaceSurfaceY(x, z, faceWidth = DEFAULT_FACE_WIDTH) {
  const band = headBandAt(z);
  const radius = band.radius * faceWidth;
  const normalizedX = Math.min(0.985, Math.abs(x) / radius);
  return -band.depth * Math.sqrt(1 - (normalizedX * normalizedX));
}

function faceSurfaceY(x, z, faceWidth = DEFAULT_FACE_WIDTH) {
  return FACELINE.surfaceY(x, z, faceWidth)
    ?? inferredFaceSurfaceY(x, z, faceWidth);
}

function addFacePatchFan(
  primitives,
  materialId,
  points,
  lift,
  makeVertex = (position) => vertex(position),
) {
  const centerX = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const centerZ = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  const project = ([x, z]) => [x, faceSurfaceY(x, z) - lift, z];
  const center = project([centerX, centerZ]);
  for (let index = 0; index < points.length; index += 1) {
    const next = (index + 1) % points.length;
    const positions = oriented([
      center,
      project(points[index]),
      project(points[next]),
    ], [0, -1, 0]);
    appendTriangle(primitives, materialId, positions.map(makeVertex));
  }
}

function interpolatePoint(first, second, amount) {
  return first.map((value, axis) => value + ((second[axis] - value) * amount));
}

function projectedPointKey([x, , z]) {
  return `${Math.round(x / HAIR_WELD_EPSILON)},${Math.round(z / HAIR_WELD_EPSILON)}`;
}

function projectedSegmentAmount(point, start, end) {
  const dx = end[0] - start[0];
  const dz = end[2] - start[2];
  const denominator = (dx * dx) + (dz * dz);
  if (denominator <= HAIR_WELD_EPSILON ** 2) return 0;
  return (((point[0] - start[0]) * dx) + ((point[2] - start[2]) * dz)) / denominator;
}

function projectedPointOnSegment(point, start, end) {
  const amount = projectedSegmentAmount(point, start, end);
  if (amount < -HAIR_WELD_EPSILON || amount > 1 + HAIR_WELD_EPSILON) return false;
  const projected = interpolatePoint(start, end, Math.max(0, Math.min(1, amount)));
  return Math.hypot(point[0] - projected[0], point[2] - projected[2])
    <= HAIR_WELD_EPSILON * 4;
}

function projectedSegmentIntersection(firstStart, firstEnd, secondStart, secondEnd) {
  const firstX = firstEnd[0] - firstStart[0];
  const firstZ = firstEnd[2] - firstStart[2];
  const secondX = secondEnd[0] - secondStart[0];
  const secondZ = secondEnd[2] - secondStart[2];
  const denominator = (firstX * secondZ) - (firstZ * secondX);
  if (Math.abs(denominator) <= HAIR_WELD_EPSILON) return null;
  const offsetX = secondStart[0] - firstStart[0];
  const offsetZ = secondStart[2] - firstStart[2];
  const firstAmount = ((offsetX * secondZ) - (offsetZ * secondX)) / denominator;
  const secondAmount = ((offsetX * firstZ) - (offsetZ * firstX)) / denominator;
  if (
    firstAmount < -HAIR_WELD_EPSILON ||
    firstAmount > 1 + HAIR_WELD_EPSILON ||
    secondAmount < -HAIR_WELD_EPSILON ||
    secondAmount > 1 + HAIR_WELD_EPSILON
  ) {
    return null;
  }
  return Object.freeze({
    firstAmount: Math.max(0, Math.min(1, firstAmount)),
    secondAmount: Math.max(0, Math.min(1, secondAmount)),
  });
}

function projectedPointInTriangle(point, triangle) {
  const [a, b, c] = triangle;
  const denominator = ((b[2] - c[2]) * (a[0] - c[0]))
    + ((c[0] - b[0]) * (a[2] - c[2]));
  if (Math.abs(denominator) <= HAIR_WELD_EPSILON) return false;
  const first = (((b[2] - c[2]) * (point[0] - c[0]))
    + ((c[0] - b[0]) * (point[2] - c[2]))) / denominator;
  const second = (((c[2] - a[2]) * (point[0] - c[0]))
    + ((a[0] - c[0]) * (point[2] - c[2]))) / denominator;
  const third = 1 - first - second;
  return first >= -HAIR_WELD_EPSILON
    && second >= -HAIR_WELD_EPSILON
    && third >= -HAIR_WELD_EPSILON;
}

function createHairFacelineWeld(lowerRing) {
  if (lowerRing.length % 4 !== 0) {
    throw new Error("FacesJS hair weld requires a four-way ring lattice.");
  }
  const quarter = lowerRing.length / 4;
  const ringStartIndex = quarter * 3;
  const frontRingIndices = [
    ...Array.from({ length: quarter }, (_, index) => ringStartIndex + index),
    ...Array.from({ length: quarter + 1 }, (_, index) => index),
  ];
  const frontSegments = frontRingIndices.slice(0, -1).map((ringIndex, index) => ({
    end: lowerRing[frontRingIndices[index + 1]],
    endParam: index + 1,
    ringIndex,
    start: lowerRing[ringIndex],
    startParam: index,
  }));
  const sampleRingParam = (param) => {
    const wrappedParam = ((param % lowerRing.length) + lowerRing.length)
      % lowerRing.length;
    const segmentOffset = Math.floor(wrappedParam);
    const ringIndex = (ringStartIndex + segmentOffset) % lowerRing.length;
    const amount = wrappedParam - segmentOffset;
    return Object.freeze({
      amount,
      param,
      position: Object.freeze(interpolatePoint(
        lowerRing[ringIndex],
        lowerRing[(ringIndex + 1) % lowerRing.length],
        amount,
      )),
      ringIndex,
    });
  };
  const sampleParam = (param) => {
    if (
      param < -HAIR_WELD_EPSILON
      || param > frontSegments.length + HAIR_WELD_EPSILON
    ) {
      throw new RangeError(`FacesJS front hair parameter ${param} is outside its arc.`);
    }
    return sampleRingParam(Math.max(0, Math.min(frontSegments.length, param)));
  };
  const boundaryHits = [];
  for (const segment of frontSegments) {
    for (let index = 0; index < FACELINE.boundary.length; index += 1) {
      const hit = projectedSegmentIntersection(
        segment.start,
        segment.end,
        FACELINE.boundary[index],
        FACELINE.boundary[(index + 1) % FACELINE.boundary.length],
      );
      if (!hit) continue;
      const param = segment.startParam + hit.firstAmount;
      if (!boundaryHits.some((entry) =>
        Math.abs(entry.param - param) <= HAIR_WELD_EPSILON)) {
        boundaryHits.push(Object.freeze({
          boundarySegmentIndex: index,
          param,
        }));
      }
    }
  }
  const centerParam = frontRingIndices.indexOf(0);
  const leftHit = boundaryHits
    .filter(({ param }) => param < centerParam - HAIR_WELD_EPSILON)
    .sort((left, right) => right.param - left.param)[0];
  const rightHit = boundaryHits
    .filter(({ param }) => param > centerParam + HAIR_WELD_EPSILON)
    .sort((left, right) => left.param - right.param)[0];
  if (!leftHit || !rightHit) {
    throw new Error(`FacesJS ${FACE.hair.id} hairline does not cross faceline ${FACELINE.index}.`);
  }
  const leftParam = leftHit.param;
  const rightParam = rightHit.param;
  const controlParams = [
    leftParam,
    ...Array.from(
      { length: Math.max(0, Math.ceil(rightParam) - Math.floor(leftParam) - 1) },
      (_, index) => Math.floor(leftParam) + index + 1,
    ).filter((param) => param > leftParam && param < rightParam),
    rightParam,
  ];
  const seamParams = [...controlParams];
  for (const triangle of FACELINE.triangles) {
    for (let edge = 0; edge < 3; edge += 1) {
      const edgeStart = triangle[edge];
      const edgeEnd = triangle[(edge + 1) % 3];
      for (let index = 0; index < controlParams.length - 1; index += 1) {
        const startParam = controlParams[index];
        const endParam = controlParams[index + 1];
        const start = sampleParam(startParam).position;
        const end = sampleParam(endParam).position;
        const hit = projectedSegmentIntersection(start, end, edgeStart, edgeEnd);
        if (!hit) continue;
        const param = startParam + ((endParam - startParam) * hit.firstAmount);
        if (!seamParams.some((entry) => Math.abs(entry - param) <= HAIR_WELD_EPSILON)) {
          seamParams.push(param);
        }
      }
    }
  }
  seamParams.sort((left, right) => left - right);
  const points = seamParams.map(sampleParam);
  for (let index = 0; index < points.length - 1; index += 1) {
    if (points[index + 1].position[0] - points[index].position[0] <= HAIR_WELD_EPSILON) {
      throw new Error("FacesJS front hair seam must increase monotonically in x.");
    }
  }
  const splitsBySegment = new Map();
  for (const point of points) {
    if (
      point.amount <= HAIR_WELD_EPSILON ||
      point.amount >= 1 - HAIR_WELD_EPSILON
    ) {
      continue;
    }
    const entries = splitsBySegment.get(point.ringIndex) ?? [];
    if (!entries.some(({ amount }) => Math.abs(amount - point.amount) <= HAIR_WELD_EPSILON)) {
      entries.push(point);
      entries.sort((left, right) => left.amount - right.amount);
      splitsBySegment.set(point.ringIndex, entries);
    }
  }
  const backHairPoints = [points.at(-1).position];
  for (
    let param = Math.floor(rightParam) + 1;
    param < leftParam + lowerRing.length - HAIR_WELD_EPSILON;
    param += 1
  ) {
    backHairPoints.push(sampleRingParam(param).position);
  }
  backHairPoints.push(points[0].position);

  const boundaryPath = (
    start,
    startSegmentIndex,
    end,
    endSegmentIndex,
    direction,
  ) => {
    const path = [start];
    let boundaryIndex = direction > 0
      ? (startSegmentIndex + 1) % FACELINE.boundary.length
      : startSegmentIndex;
    const terminalIndex = direction > 0
      ? endSegmentIndex
      : (endSegmentIndex + 1) % FACELINE.boundary.length;
    for (let count = 0; count <= FACELINE.boundary.length; count += 1) {
      path.push(FACELINE.boundary[boundaryIndex]);
      if (boundaryIndex === terminalIndex) break;
      boundaryIndex = (
        boundaryIndex + direction + FACELINE.boundary.length
      ) % FACELINE.boundary.length;
      if (count === FACELINE.boundary.length) {
        throw new Error("FacesJS rear faceline boundary traversal overflowed.");
      }
    }
    path.push(end);
    return path.filter((position, index) =>
      index === 0
      || Math.hypot(
        position[0] - path[index - 1][0],
        position[2] - path[index - 1][2],
      ) > HAIR_WELD_EPSILON * 4);
  };
  const forwardBoundaryPath = boundaryPath(
    points.at(-1).position,
    rightHit.boundarySegmentIndex,
    points[0].position,
    leftHit.boundarySegmentIndex,
    1,
  );
  const backwardBoundaryPath = boundaryPath(
    points.at(-1).position,
    rightHit.boundarySegmentIndex,
    points[0].position,
    leftHit.boundarySegmentIndex,
    -1,
  );
  const averageZ = (path) => path.reduce((sum, point) => sum + point[2], 0)
    / path.length;
  const backFacelinePoints = averageZ(forwardBoundaryPath)
      < averageZ(backwardBoundaryPath)
    ? forwardBoundaryPath
    : backwardBoundaryPath;
  return Object.freeze({
    backFacelinePoints: Object.freeze(backFacelinePoints),
    backHairPoints: Object.freeze(backHairPoints),
    points: Object.freeze(points),
    splitsBySegment,
  });
}

function sampleHairWeldAtX(weld, x) {
  if (x <= weld.points[0].position[0]) return weld.points[0].position;
  if (x >= weld.points.at(-1).position[0]) return weld.points.at(-1).position;
  for (let index = 0; index < weld.points.length - 1; index += 1) {
    const start = weld.points[index].position;
    const end = weld.points[index + 1].position;
    if (x < start[0] - HAIR_WELD_EPSILON || x > end[0] + HAIR_WELD_EPSILON) {
      continue;
    }
    return interpolatePoint(start, end, (x - start[0]) / (end[0] - start[0]));
  }
  throw new Error(`Unable to sample FacesJS hair weld at x=${x}.`);
}

function retainedBelowHairline(point, weld) {
  const minimumX = weld.points[0].position[0];
  const maximumX = weld.points.at(-1).position[0];
  if (point[0] < minimumX - HAIR_WELD_EPSILON) return true;
  if (point[0] > maximumX + HAIR_WELD_EPSILON) return true;
  return point[2] <= sampleHairWeldAtX(weld, point[0])[2] + HAIR_WELD_EPSILON;
}

function addClippedFacelineTriangle(primitives, triangle, expected, weld, makeVertex) {
  const nodeByKey = new Map();
  const segments = new Map();
  const seamPointFor = (point) => weld.points.find(({ position }) =>
    Math.hypot(position[0] - point[0], position[2] - point[2])
      <= HAIR_WELD_EPSILON * 4);
  const addNode = (position, seam = false) => {
    const key = projectedPointKey(position);
    const existing = nodeByKey.get(key);
    if (!existing || seam) nodeByKey.set(key, { position, seam });
    return key;
  };
  const addSegment = (firstPosition, secondPosition, seam = false) => {
    const firstKey = addNode(firstPosition, seam);
    const secondKey = addNode(secondPosition, seam);
    if (firstKey === secondKey) return;
    const key = firstKey < secondKey
      ? `${firstKey}|${secondKey}`
      : `${secondKey}|${firstKey}`;
    if (!segments.has(key)) segments.set(key, [firstKey, secondKey]);
  };

  for (let edge = 0; edge < 3; edge += 1) {
    const start = triangle[edge];
    const end = triangle[(edge + 1) % 3];
    const edgeNodes = [
      { amount: 0, position: seamPointFor(start)?.position ?? start },
      ...weld.points
        .filter(({ position }) => projectedPointOnSegment(position, start, end))
        .map(({ position }) => ({
          amount: projectedSegmentAmount(position, start, end),
          position,
        })),
      { amount: 1, position: seamPointFor(end)?.position ?? end },
    ].sort((left, right) => left.amount - right.amount)
      .filter((entry, index, entries) =>
        index === 0 || Math.abs(entry.amount - entries[index - 1].amount) > HAIR_WELD_EPSILON);
    for (let index = 0; index < edgeNodes.length - 1; index += 1) {
      const first = edgeNodes[index].position;
      const second = edgeNodes[index + 1].position;
      if (retainedBelowHairline(interpolatePoint(first, second, 0.5), weld)) {
        addSegment(first, second);
      }
    }
  }

  for (let index = 0; index < weld.points.length - 1; index += 1) {
    const first = weld.points[index].position;
    const second = weld.points[index + 1].position;
    if (projectedPointInTriangle(interpolatePoint(first, second, 0.5), triangle)) {
      addSegment(first, second, true);
    }
  }

  if (segments.size === 0) return 0;
  const adjacency = new Map();
  for (const [first, second] of segments.values()) {
    if (!adjacency.has(first)) adjacency.set(first, new Set());
    if (!adjacency.has(second)) adjacency.set(second, new Set());
    adjacency.get(first).add(second);
    adjacency.get(second).add(first);
  }
  for (const [key, neighbours] of adjacency) {
    if (neighbours.size !== 2) {
      throw new Error(
        `FacesJS hair weld opened faceline triangle node ${key} with degree ${neighbours.size}.`,
      );
    }
  }
  const unused = new Map(segments);
  const loops = [];
  while (unused.size > 0) {
    const [edgeKey, [start, firstNext]] = unused.entries().next().value;
    unused.delete(edgeKey);
    const loop = [start];
    let previous = start;
    let current = firstNext;
    while (current !== start) {
      loop.push(current);
      const next = [...adjacency.get(current)].find((candidate) => candidate !== previous);
      if (next === undefined) {
        throw new Error("FacesJS hair weld faceline boundary did not close.");
      }
      const nextEdgeKey = current < next
        ? `${current}|${next}`
        : `${next}|${current}`;
      unused.delete(nextEdgeKey);
      previous = current;
      current = next;
      if (loop.length > adjacency.size + 1) {
        throw new Error("FacesJS hair weld faceline boundary traversal overflowed.");
      }
    }
    loops.push(loop);
  }
  let triangleCount = 0;
  for (const loop of loops) {
    if (loop.length < 3) continue;
    const positions = loop.map((key) => nodeByKey.get(key).position);
    const indices = earcut(positions.flatMap((position) => [position[0], position[2]]));
    if (indices.length < 3) {
      throw new Error("FacesJS hair weld produced an untriangulatable faceline region.");
    }
    for (let offset = 0; offset < indices.length; offset += 3) {
      addSurfaceTriangle(
        primitives,
        "skin",
        indices.slice(offset, offset + 3).map((index) => positions[index]),
        expected,
        makeVertex,
      );
      triangleCount += 1;
    }
  }
  return triangleCount;
}

function normalizedPolylineAmounts(points) {
  const distances = [0];
  for (let index = 1; index < points.length; index += 1) {
    distances.push(distances.at(-1) + Math.hypot(...vectorSub(
      points[index],
      points[index - 1],
    )));
  }
  const total = distances.at(-1);
  if (total <= HAIR_WELD_EPSILON) {
    throw new Error("FacesJS rear faceline path collapsed.");
  }
  return distances.map((distance) => distance / total);
}

function addRearPatch(primitives, weld, family, expectedFrom, makeVertex) {
  const hairPoints = weld.backHairPoints;
  const facelinePoints = weld.backFacelinePoints;
  if (hairPoints.length < 3 || facelinePoints.length < 3) {
    throw new Error("FacesJS rear patch requires two resolved boundary arcs.");
  }
  for (const index of [0, 1]) {
    const hairPoint = hairPoints[index === 0 ? 0 : hairPoints.length - 1];
    const facelinePoint = facelinePoints[
      index === 0 ? 0 : facelinePoints.length - 1
    ];
    if (Math.hypot(...vectorSub(hairPoint, facelinePoint)) > HAIR_WELD_EPSILON) {
      throw new Error("FacesJS rear patch arcs do not share endpoints.");
    }
  }
  const hairAmounts = normalizedPolylineAmounts(hairPoints);
  const facelineAmounts = normalizedPolylineAmounts(facelinePoints);
  const positions = [
    ...hairPoints,
    ...facelinePoints.slice(1, -1).reverse(),
  ];
  const plane = [
    ...hairAmounts.flatMap((amount) => [amount, 0]),
    ...facelineAmounts.slice(1, -1).reverse().flatMap((amount) => [amount, 1]),
  ];
  const indices = earcut(plane);
  if (indices.length < 3) {
    throw new Error("FacesJS rear patch could not be triangulated.");
  }
  let triangleCount = 0;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const triangle = indices.slice(offset, offset + 3).map((index) => positions[index]);
    if (Math.hypot(...triangleNormal(triangle)) <= HAIR_WELD_EPSILON) {
      throw new Error("FacesJS rear patch emitted a collapsed triangle.");
    }
    addSurfaceTriangle(
      primitives,
      family,
      triangle,
      expectedFrom(triangle),
      makeVertex,
    );
    triangleCount += 1;
  }
  return triangleCount;
}

function buildHead(primitives, weld) {
  const headVertex = (position) => vertex(position, {}, true);
  const headCenter = [0, 0.08, 0.35];
  const expectedFrom = (points) => normalize(vectorSub(average(points), headCenter));
  let frontTriangles = 0;

  for (const triangle of FACELINE.triangles) {
    if (weld) {
      frontTriangles += addClippedFacelineTriangle(
        primitives,
        triangle,
        expectedFrom(triangle),
        weld,
        headVertex,
      );
    } else {
      addSurfaceTriangle(
        primitives,
        "skin",
        triangle,
        expectedFrom(triangle),
        headVertex,
      );
      frontTriangles += 1;
    }
  }
  const rearPatchFamily = FACE.hair.id === "afro" ? "hair" : "skin";
  const rearPatchTriangles = weld
    ? addRearPatch(primitives, weld, rearPatchFamily, expectedFrom, headVertex)
    : 0;
  return Object.freeze({
    sourceQuadCells: 0,
    authoredQuadCells: 0,
    maximumDisplacementCssPx: 0,
    frontTriangles,
    rearPatchFamily,
    rearPatchTriangles,
    retainedTriangles: frontTriangles + rearPatchTriangles,
    skinTriangles: frontTriangles + (rearPatchFamily === "skin" ? rearPatchTriangles : 0),
  });
}

function buildHair(primitives) {
  const segments = 24;
  if (FACE.hair.id === "bald") {
    return Object.freeze({
      sourceQuadCells: 0,
      authoredQuadCells: 0,
      maximumDisplacementCssPx: 0,
      weld: null,
    });
  }
  const isAfro = FACE.hair.id === "afro";
  const crownSourceRows = isAfro
    ? [190, 160, 130, 100, 80, 72]
    : [180, 155, 130, 110, 102];
  const crownProfile = crownSourceRows.map((y) => [
    svgFaceZ(y),
    sourceRadiusAtY(HAIR_SOURCE_CONTOUR, y),
  ]);
  const crownStartZ = crownProfile[0][0];
  const crownStartRadius = crownProfile[0][1];
  const crownExpansion = crownStartRadius / headBandAt(crownStartZ).radius;
  const lowerLevels = [0, 1 / 3, 2 / 3, 1];
  const crownDepthRatio = 0.78;
  const shellPoint = (angle, z, expansion, authoredRadius) => {
    const band = headBandAt(z);
    const radius = authoredRadius ?? ((band.radius * expansion) + 0.01);
    const depth = radius * crownDepthRatio;
    return [
      Math.cos(angle) * radius,
      Math.sin(angle) * depth,
      z,
    ];
  };
  const lowerRings = lowerLevels.map((level) => Array.from({ length: segments }, (_, index) => {
    const angle = -Math.PI / 2 + (index / segments) * Math.PI * 2;
    const bottom = hairlineZ(angle);
    const amount = Math.sin(level * Math.PI / 2);
    return shellPoint(
      angle,
      bottom + ((crownStartZ - bottom) * amount),
      crownExpansion,
    );
  }));
  const crownRings = crownProfile.map(([z, radius]) =>
    Array.from({ length: segments }, (_, index) => {
      const angle = -Math.PI / 2 + (index / segments) * Math.PI * 2;
      return shellPoint(angle, z, crownExpansion, radius);
    }));
  const rings = [...lowerRings, ...crownRings.slice(1)];
  const weld = createHairFacelineWeld(lowerRings[0]);
  const mergeableBands = rings.slice(0, -1).map((_, band) =>
    band >= lowerRings.length - 1);
  const hairVertex = (position) => vertex(position, {}, true);
  const surfaceTriangles = [];

  for (let band = 0; band < rings.length - 1; band += 1) {
    for (let index = 0; index < segments; index += 1) {
      const next = (index + 1) % segments;
      const topLeft = rings[band][index];
      const topRight = rings[band][next];
      const bottomLeft = rings[band + 1][index];
      const bottomRight = rings[band + 1][next];
      const centerX = (topLeft[0] + topRight[0] + bottomLeft[0] + bottomRight[0]) / 4;
      let triangles = centerX < 0
        ? [
            [topLeft, bottomLeft, topRight],
            [bottomLeft, bottomRight, topRight],
          ]
        : [
            [topLeft, bottomLeft, bottomRight],
            [topLeft, bottomRight, topRight],
          ];
      const seamSplits = band === 0 ? weld.splitsBySegment.get(index) ?? [] : [];
      if (seamSplits.length > 0) {
        const chain = [topLeft, ...seamSplits.map(({ position }) => position), topRight];
        const splitTriangles = Array.from({ length: chain.length - 1 }, (_, splitIndex) =>
          centerX < 0
            ? [chain[splitIndex], bottomLeft, chain[splitIndex + 1]]
            : [chain[splitIndex], bottomRight, chain[splitIndex + 1]]);
        triangles = centerX < 0
          ? [...splitTriangles, [bottomLeft, bottomRight, topRight]]
          : [[topLeft, bottomLeft, bottomRight], ...splitTriangles];
      }
      const center = [topLeft, topRight, bottomLeft, bottomRight].reduce(
        (sum, point) => sum.map((value, axis) => value + point[axis]),
        [0, 0, 0],
      ).map((value) => value / 4);
      surfaceTriangles.push({
        band,
        triangles,
        center,
        expected: normalize([
          center[0],
          center[1],
          Math.max(0.18, center[2] - 0.55),
        ]),
      });
    }
  }

  const hairBounds = boundsOfPaths(SOURCE_SVG_PATHS.hair);
  if (!hairBounds) throw new Error("FacesJS hair SVG has no bounds.");
  const top = [0, 0, svgFaceZ(hairBounds.minimumY)];
  const last = rings.at(-1);
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    const triangle = [top, last[index], last[next]];
    const center = triangle.reduce(
      (sum, point) => sum.map((value, axis) => value + point[axis]),
      [0, 0, 0],
    ).map((value) => value / 3);
    surfaceTriangles.push({ triangle, center, expected: [0, 0, 1] });
  }

  surfaceTriangles.sort((left, right) =>
    (right.center[1] - left.center[1]) ||
    (left.center[0] - right.center[0]) ||
    (right.center[2] - left.center[2]));
  for (const { band, triangle, triangles, expected } of surfaceTriangles) {
    if (triangles) {
      if (triangles.length === 2) {
        addSurfaceTrianglePair(
          primitives,
          "hair",
          triangles,
          expected,
          hairVertex,
          mergeableBands[band],
        );
      } else {
        for (const splitTriangle of triangles) {
          addSurfaceTriangle(
            primitives,
            "hair",
            splitTriangle,
            expected,
            hairVertex,
          );
        }
      }
    } else {
      addSurfaceTriangle(
        primitives,
        "hair",
        triangle,
        expected,
        hairVertex,
      );
    }
  }
  return Object.freeze({
    sourceQuadCells: (rings.length - 1) * segments,
    authoredQuadCells: mergeableBands.filter(Boolean).length * segments,
    maximumDisplacementCssPx: 0,
    weld,
  });
}

function buildEar(primitives, side) {
  const position = [side < 0 ? 55 : 345, 325];
  const minimumPaths = transformSvgPaths(SOURCE_SVG_PATHS.ear, {
    position,
    mirrorX: side > 0,
    scale: 0.5,
  });
  const maximumPaths = transformSvgPaths(SOURCE_SVG_PATHS.ear, {
    position,
    mirrorX: side > 0,
    scale: 1.5,
  });
  const minimum = minimumPaths[0].subpaths[0].points;
  const maximum = maximumPaths[0].subpaths[0].points;
  const frontDepth = -0.14;
  const backDepth = 0.08;
  const project = ([x, y], depth) => [svgFaceX(x), depth, svgFaceZ(y)];
  const makeEarVertex = (index, depth) => {
    const base = project(minimum[index], depth);
    const target = project(maximum[index], depth);
    return vertex(base, { "ear-size": vectorSub(target, base) }, true);
  };
  const capIndices = triangulateSvgContour(minimum);
  for (const depth of [frontDepth, backDepth]) {
    const expected = depth === frontDepth ? [0, -1, 0] : [0, 1, 0];
    for (let offset = 0; offset < capIndices.length; offset += 3) {
      let indices = capIndices.slice(offset, offset + 3);
      if (dot(triangleNormal(indices.map((index) => project(minimum[index], depth))), expected) < 0) {
        indices = [indices[0], indices[2], indices[1]];
      }
      appendTriangle(
        primitives,
        "ear-cap",
        indices.map((index) => makeEarVertex(index, depth)),
      );
    }
  }
  const earCenter = project(position, 0);
  for (let index = 0; index < minimum.length; index += 1) {
    const next = (index + 1) % minimum.length;
    const polygonIndices = [];
    for (let triangle of [
      [[index, frontDepth], [next, frontDepth], [next, backDepth]],
      [[index, frontDepth], [next, backDepth], [index, backDepth]],
    ]) {
      const positions = triangle.map(([pointIndex, depth]) => project(minimum[pointIndex], depth));
      const midpoint = average(positions);
      const expected = normalize([
        midpoint[0] - earCenter[0],
        0,
        midpoint[2] - earCenter[2],
      ]);
      if (dot(triangleNormal(positions), expected) < 0) {
        triangle = [triangle[0], triangle[2], triangle[1]];
      }
      polygonIndices.push(appendTriangle(
        primitives,
        "skin-base",
        triangle.map(([pointIndex, depth]) => makeEarVertex(pointIndex, depth)),
      ));
    }
    primitives.get("skin-base").quadPairs.push(polygonIndices);
  }
}

function projectSourceFacePoint([x, y], lift) {
  const faceX = svgFaceX(x);
  const faceZ = svgFaceZ(y);
  return [faceX, faceSurfaceY(faceX, faceZ) - lift, faceZ];
}

function attachedSourceFacePoint([x, y], lift, attachmentX, faceWidth) {
  const sourceX = svgFaceX(x);
  const sourceAnchorX = svgFaceX(attachmentX);
  const canonicalAnchorX = sourceAnchorX / DEFAULT_FACE_WIDTH;
  const faceX = (sourceX - sourceAnchorX) + (canonicalAnchorX * faceWidth);
  const faceZ = svgFaceZ(y);
  return [faceX, faceSurfaceY(faceX, faceZ, faceWidth) - lift, faceZ];
}

function sourceMorphVertex(
  basePoint,
  targetPoints,
  lift,
  fat = false,
  attachmentX,
) {
  if (attachmentX !== undefined) {
    const base = attachedSourceFacePoint(
      basePoint,
      lift,
      attachmentX,
      FACE_WIDTH_MINIMUM,
    );
    const expanded = attachedSourceFacePoint(basePoint, lift, attachmentX, 1);
    return vertex(base, {
      fatness: vectorSub(expanded, base),
      ...Object.fromEntries(Object.entries(targetPoints).map(([id, point]) => [
        id,
        vectorSub(attachedSourceFacePoint(
          point,
          lift,
          attachmentX,
          FACE_WIDTH_MINIMUM,
        ), base),
      ])),
    });
  }
  const base = projectSourceFacePoint(basePoint, lift);
  return vertex(base, Object.fromEntries(Object.entries(targetPoints).map(([id, point]) => [
    id,
    vectorSub(projectSourceFacePoint(point, lift), base),
  ])), fat);
}

function sourceRowMidpoint(left, right) {
  return {
    base: interpolatePoint(left.base, right.base, 0.5),
    targets: Object.fromEntries(Object.keys(left.targets).map((id) => [
      id,
      interpolatePoint(left.targets[id], right.targets[id], 0.5),
    ])),
  };
}

function subdivideSourceTriangles(triangles) {
  return triangles.flatMap(([first, second, third]) => {
    const firstSecond = sourceRowMidpoint(first, second);
    const secondThird = sourceRowMidpoint(second, third);
    const thirdFirst = sourceRowMidpoint(third, first);
    return [
      [first, firstSecond, thirdFirst],
      [firstSecond, second, secondThird],
      [thirdFirst, secondThird, third],
      [firstSecond, secondThird, thirdFirst],
    ];
  });
}

function minimumSourceTriangleClearance(rows, lift, fat, attachmentX) {
  const vertices = rows.map(({ base, targets }) =>
    sourceMorphVertex(base, targets, lift, fat, attachmentX));
  const targetStates = [null, ...Object.keys(rows[0].targets)];
  let minimum = Infinity;
  for (const fatness of [0, 0.5, 1]) {
    const faceWidth = FACE_WIDTH_MINIMUM + (fatness * FACE_WIDTH_RANGE);
    for (const targetId of targetStates) {
      const targetWeights = targetId === null ? [0] : [0.5, 1];
      for (const targetWeight of targetWeights) {
        const positions = vertices.map((source) => [0, 1, 2].map((axis) =>
          source.position[axis]
            + (fatness * source.deltas.fatness[axis])
            + (targetId === null ? 0 : targetWeight * source.deltas[targetId][axis])));
        for (let first = 0; first <= FEATURE_SURFACE_SAMPLE_RESOLUTION; first += 1) {
          for (
            let second = 0;
            second <= FEATURE_SURFACE_SAMPLE_RESOLUTION - first;
            second += 1
          ) {
            const firstWeight = first / FEATURE_SURFACE_SAMPLE_RESOLUTION;
            const secondWeight = second / FEATURE_SURFACE_SAMPLE_RESOLUTION;
            const thirdWeight = 1 - firstWeight - secondWeight;
            const point = [0, 1, 2].map((axis) =>
              (positions[0][axis] * firstWeight)
                + (positions[1][axis] * secondWeight)
                + (positions[2][axis] * thirdWeight));
            const surface = faceSurfaceY(
              point[0] / SOURCE_FACE_HORIZONTAL_SCALE,
              point[2],
              faceWidth,
            );
            minimum = Math.min(minimum, surface - point[1]);
          }
        }
      }
    }
  }
  return minimum;
}

function conformSourceTrianglesToFace(triangles, lift, fat, attachmentX) {
  let output = triangles;
  for (let depth = 0; depth <= FEATURE_SURFACE_MAXIMUM_SUBDIVISIONS; depth += 1) {
    const minimum = Math.min(...output.map((rows) =>
      minimumSourceTriangleClearance(rows, lift, fat, attachmentX)));
    if (minimum >= FEATURE_SURFACE_MINIMUM_CLEARANCE) {
      return output;
    }
    if (depth < FEATURE_SURFACE_MAXIMUM_SUBDIVISIONS) {
      output = subdivideSourceTriangles(output);
      continue;
    }
    throw new Error(
      `FacesJS feature surface clearance ${(minimum * MODEL_SCALE).toFixed(3)}px is below `
        + `${(FEATURE_SURFACE_MINIMUM_CLEARANCE * MODEL_SCALE).toFixed(3)}px.`,
    );
  }
  throw new Error("FacesJS feature surface conformance did not resolve.");
}

function appendSourceFaceTriangles(
  primitives,
  materialId,
  triangles,
  lift,
  fat,
  attachmentX,
) {
  return conformSourceTrianglesToFace(triangles, lift, fat, attachmentX).map((rows) => {
    let vertices = rows.map(({ base, targets }) =>
      sourceMorphVertex(base, targets, lift, fat, attachmentX));
    if (dot(triangleNormal(vertices.map(({ position }) => position)), [0, -1, 0]) < 0) {
      vertices = [vertices[0], vertices[2], vertices[1]];
    }
    return appendTriangle(primitives, materialId, vertices);
  });
}

function addSourceContourFill(
  primitives,
  materialId,
  basePoints,
  targetContours,
  lift,
  fat = false,
  attachmentX,
) {
  const indices = triangulateSvgContour(basePoints);
  const triangles = [];
  for (let offset = 0; offset < indices.length; offset += 3) {
    const pointIndices = indices.slice(offset, offset + 3);
    triangles.push(pointIndices.map((index) => ({
      base: basePoints[index],
      targets: Object.fromEntries(Object.entries(targetContours).map(([id, points]) => [
        id,
        points[index],
      ])),
    })));
  }
  appendSourceFaceTriangles(
    primitives,
    materialId,
    triangles,
    lift,
    fat,
    attachmentX,
  );
}

function sourceStrokeRibbon(start, end, width) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (length <= 1e-8) return null;
  const directionX = dx / length;
  const directionY = dy / length;
  const extension = width * 0.35;
  const offsetX = -directionY * width * 0.5;
  const offsetY = directionX * width * 0.5;
  const extendedStart = [
    start[0] - (directionX * extension),
    start[1] - (directionY * extension),
  ];
  const extendedEnd = [
    end[0] + (directionX * extension),
    end[1] + (directionY * extension),
  ];
  return [
    [extendedStart[0] + offsetX, extendedStart[1] + offsetY],
    [extendedEnd[0] + offsetX, extendedEnd[1] + offsetY],
    [extendedEnd[0] - offsetX, extendedEnd[1] - offsetY],
    [extendedStart[0] - offsetX, extendedStart[1] - offsetY],
  ];
}

function sourceStrokeOutline(points, width) {
  if (points.length < 2) return [];
  const halfWidth = width * 0.5;
  const normals = points.slice(0, -1).map((point, index) => {
    const next = points[index + 1];
    const dx = next[0] - point[0];
    const dy = next[1] - point[1];
    const length = Math.hypot(dx, dy);
    if (length <= 1e-8) return [0, 0];
    return [-dy / length, dx / length];
  });
  const offsets = points.map((_, index) => {
    if (index === 0) return normals[0].map((value) => value * halfWidth);
    if (index === points.length - 1) return normals.at(-1).map((value) => value * halfWidth);
    const previous = normals[index - 1];
    const next = normals[index];
    const combined = normalize([previous[0] + next[0], previous[1] + next[1]]);
    const denominator = (combined[0] * next[0]) + (combined[1] * next[1]);
    if (Math.abs(denominator) <= 1e-6) return next.map((value) => value * halfWidth);
    const miterLength = Math.min(halfWidth * 4, Math.abs(halfWidth / denominator));
    return combined.map((value) => value * miterLength * Math.sign(denominator));
  });
  const left = points.map((point, index) => [
    point[0] + offsets[index][0],
    point[1] + offsets[index][1],
  ]);
  const right = points.map((point, index) => [
    point[0] - offsets[index][0],
    point[1] - offsets[index][1],
  ]).reverse();
  return [...left, ...right];
}

function addSourceStroke(
  primitives,
  materialId,
  basePoints,
  targetContours,
  width,
  lift,
  closed,
  fat = false,
  attachmentX,
) {
  if (!closed) {
    const outline = sourceStrokeOutline(basePoints, width);
    const targetOutlines = Object.fromEntries(Object.entries(targetContours).map(([id, points]) => [
      id,
      sourceStrokeOutline(points, width),
    ]));
    addSourceContourFill(
      primitives,
      materialId,
      outline,
      targetOutlines,
      lift,
      fat,
      attachmentX,
    );
    return;
  }
  const segmentCount = closed ? basePoints.length : basePoints.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const next = (index + 1) % basePoints.length;
    const baseRibbon = sourceStrokeRibbon(basePoints[index], basePoints[next], width);
    if (!baseRibbon) continue;
    const targetRibbons = Object.fromEntries(Object.entries(targetContours).map(([id, points]) => {
      const ribbon = sourceStrokeRibbon(points[index], points[next], width);
      if (!ribbon) throw new Error(`FacesJS SVG stroke target ${id} collapsed.`);
      return [id, ribbon];
    }));
    const triangles = [[0, 1, 2], [0, 2, 3]].map((triangle) =>
      triangle.map((pointIndex) => ({
        base: baseRibbon[pointIndex],
        targets: Object.fromEntries(Object.entries(targetRibbons).map(([id, points]) => [
          id,
          points[pointIndex],
        ])),
      })));
    const polygonIndices = appendSourceFaceTriangles(
      primitives,
      materialId,
      triangles,
      lift,
      fat,
      attachmentX,
    );
    if (!fat && attachmentX === undefined && polygonIndices.length === 2) {
      primitives.get(materialId).quadPairs.push(polygonIndices);
    }
  }
}

function fillMaterial(part, fill) {
  if (part === "eye" || part === "mouth") {
    return fill.toLowerCase().includes("fff") ? "eye-white" : "ink";
  }
  if (part === "eyebrow" || part === "hair") return "hair-base";
  return "skin-base";
}

function addSourceFeaturePaths(
  primitives,
  part,
  basePaths,
  targetPaths,
  fillLift,
  strokeLift,
  attachmentX,
) {
  for (let pathIndex = 0; pathIndex < basePaths.length; pathIndex += 1) {
    const path = basePaths[pathIndex];
    for (let subpathIndex = 0; subpathIndex < path.subpaths.length; subpathIndex += 1) {
      const subpath = path.subpaths[subpathIndex];
      const targets = Object.fromEntries(Object.entries(targetPaths).map(([id, paths]) => [
        id,
        paths[pathIndex].subpaths[subpathIndex].points,
      ]));
      const layerOffset = pathIndex * 0.012;
      if (path.fill !== "none" && subpath.points.length >= 3) {
        addSourceContourFill(
          primitives,
          fillMaterial(part, path.fill),
          subpath.points,
          targets,
          fillLift + layerOffset,
          false,
          attachmentX,
        );
      }
      if (path.stroke !== "none" && path.strokeWidth > 0) {
        addSourceStroke(
          primitives,
          "ink",
          subpath.points,
          targets,
          path.strokeWidth,
          strokeLift + layerOffset,
          subpath.closed,
          false,
          attachmentX,
        );
      }
    }
  }
}

function buildEyes(primitives) {
  for (const side of [-1, 1]) {
    const paths = transformSvgPaths(SOURCE_SVG_PATHS.eye, {
      position: [side < 0 ? 140 : 260, 310],
      mirrorX: side > 0,
      angle: side < 0 ? FACE.eye.angle : -FACE.eye.angle,
    });
    addSourceFeaturePaths(
      primitives,
      "eye",
      paths,
      {},
      0.040,
      0.050,
      side < 0 ? 140 : 260,
    );
  }
}

function buildBrows(primitives) {
  for (const side of [-1, 1]) {
    const position = [side < 0 ? 140 : 260, 270];
    const base = transformSvgPaths(SOURCE_SVG_PATHS.eyebrow, {
      position,
      mirrorX: side > 0,
    });
    const up = transformSvgPaths(SOURCE_SVG_PATHS.eyebrow, {
      position,
      mirrorX: side > 0,
      angle: side < 0 ? -15 : 15,
    });
    const down = transformSvgPaths(SOURCE_SVG_PATHS.eyebrow, {
      position,
      mirrorX: side > 0,
      angle: side < 0 ? 20 : -20,
    });
    addSourceFeaturePaths(
      primitives,
      "eyebrow",
      base,
      { "brow-up": up, "brow-down": down },
      0.050,
      0.060,
      position[0],
    );
  }
}

function buildNose(primitives) {
  const options = {
    position: [200, 370],
    mirrorX: FACE.nose.flip,
  };
  const minimum = transformSvgPaths(SOURCE_SVG_PATHS.nose, {
    ...options,
    scale: 0.5,
  });
  const maximum = transformSvgPaths(SOURCE_SVG_PATHS.nose, {
    ...options,
    scale: 1.25,
  });
  addSourceFeaturePaths(
    primitives,
    "nose",
    minimum,
    { "nose-size": maximum },
    0.047,
    0.057,
    200,
  );
}

function buildMouth(primitives) {
  const paths = transformSvgPaths(SOURCE_SVG_PATHS.mouth, {
    position: [200, 440],
    mirrorX: FACE.mouth.flip,
  });
  addSourceFeaturePaths(primitives, "mouth", paths, {}, 0.046, 0.056, 200);
}

function ovalRing(z, radiusX, radiusY, segments) {
  return Array.from({ length: segments }, (_, index) => {
    const angle = -Math.PI / 2 + (index / segments) * Math.PI * 2;
    return [
      Math.cos(angle) * radiusX,
      Math.sin(angle) * radiusY,
      z,
    ];
  });
}

function sourceContourContains(contour, [x, y]) {
  let inside = false;
  for (let index = 0, previousIndex = contour.length - 1;
    index < contour.length;
    previousIndex = index, index += 1) {
    const point = contour[index];
    const previous = contour[previousIndex];
    if (
      (point[1] > y) !== (previous[1] > y)
      && x < ((previous[0] - point[0]) * (y - point[1])
        / (previous[1] - point[1])) + point[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function sourceHorizontalIntersections(contour, y) {
  const values = [];
  for (let index = 0; index < contour.length; index += 1) {
    const start = contour[index];
    const end = contour[(index + 1) % contour.length];
    if (Math.abs(start[1] - end[1]) <= 1e-7) continue;
    const crosses = (start[1] <= y && end[1] > y)
      || (end[1] <= y && start[1] > y);
    if (!crosses) continue;
    const amount = (y - start[1]) / (end[1] - start[1]);
    values.push(start[0] + ((end[0] - start[0]) * amount));
  }
  return [...new Set(values.map((value) => Math.round(value * 1e6) / 1e6))]
    .sort((left, right) => left - right);
}

function sourceBodyRow(bodyContour, sourceY) {
  const span = horizontalSpanAtY(bodyContour, sourceY);
  if (!span) throw new Error(`FacesJS body contour has no row at y=${sourceY}.`);
  return {
    sourceY,
    bodyLeft: span[0],
    bodyRight: span[1],
  };
}

function sourceTankTopRow(bodyContour, jerseyContour, sourceY) {
  const row = sourceBodyRow(bodyContour, sourceY);
  const intersections = sourceHorizontalIntersections(jerseyContour, sourceY);
  const clamp = (value) => Math.max(row.bodyLeft, Math.min(row.bodyRight, value));
  if (sourceY <= 510) {
    if (intersections.length < 2) {
      throw new Error(`FacesJS jersey contour has no strap roots at y=${sourceY}.`);
    }
    const left = clamp(intersections[0]);
    const right = clamp(intersections.at(-1));
    return { ...row, outerLeft: left, innerLeft: left, innerRight: right, outerRight: right };
  }
  if (sourceY < 590) {
    if (intersections.length !== 4) {
      throw new Error(`FacesJS jersey contour expected four crossings at y=${sourceY}.`);
    }
    return {
      ...row,
      outerLeft: clamp(intersections[0]),
      innerLeft: clamp(intersections[1]),
      innerRight: clamp(intersections[2]),
      outerRight: clamp(intersections[3]),
    };
  }
  if (intersections.length < 2) {
    throw new Error(`FacesJS jersey contour has no torso span at y=${sourceY}.`);
  }
  return {
    ...row,
    outerLeft: clamp(intersections[0]),
    innerLeft: 200,
    innerRight: 200,
    outerRight: clamp(intersections.at(-1)),
  };
}

function projectSourceBodyPoint(bodyContour, [sourceX, sourceY], side) {
  const radiusX = sourceRadiusAtY(bodyContour, sourceY);
  const x = svgFaceX(sourceX);
  const normalizedX = Math.max(-1, Math.min(1, x / radiusX));
  const radiusY = radiusX * 0.46;
  return [
    x,
    side * radiusY * Math.sqrt(Math.max(0, 1 - (normalizedX * normalizedX))),
    svgFaceZ(sourceY),
  ];
}

function sourceInterval(left, right, sourceY, subdivisions) {
  return Array.from({ length: subdivisions + 1 }, (_, index) => [
    left + ((right - left) * index / subdivisions),
    sourceY,
  ]);
}

function addSourceBodyRegion(
  primitives,
  bodyContour,
  family,
  upper,
  lower,
  subdivisions,
  side,
  makeVertex,
) {
  const upperPoints = sourceInterval(
    upper.left,
    upper.right,
    upper.sourceY,
    subdivisions,
  ).map((point) => projectSourceBodyPoint(bodyContour, point, side));
  const lowerPoints = sourceInterval(
    lower.left,
    lower.right,
    lower.sourceY,
    subdivisions,
  ).map((point) => projectSourceBodyPoint(bodyContour, point, side));
  const upperCollapsed = Math.abs(upper.right - upper.left) <= 1e-7;
  const lowerCollapsed = Math.abs(lower.right - lower.left) <= 1e-7;
  if (upperCollapsed && lowerCollapsed) return { cells: subdivisions, quads: 0 };
  if (upperCollapsed || lowerCollapsed) {
    const apex = upperCollapsed ? upperPoints[0] : lowerPoints[0];
    const edge = upperCollapsed ? lowerPoints : upperPoints;
    for (let index = 0; index < subdivisions; index += 1) {
      const positions = upperCollapsed
        ? [apex, edge[index], edge[index + 1]]
        : [edge[index], apex, edge[index + 1]];
      const center = average(positions);
      addSurfaceTriangle(
        primitives,
        family,
        positions,
        normalize([center[0], center[1], 0]),
        makeVertex,
      );
    }
    return { cells: subdivisions, quads: 0 };
  }
  for (let index = 0; index < subdivisions; index += 1) {
    const topLeft = upperPoints[index];
    const topRight = upperPoints[index + 1];
    const bottomLeft = lowerPoints[index];
    const bottomRight = lowerPoints[index + 1];
    const center = average([topLeft, topRight, bottomLeft, bottomRight]);
    const triangles = center[0] < 0
      ? [
          [topLeft, bottomLeft, topRight],
          [bottomLeft, bottomRight, topRight],
        ]
      : [
          [topLeft, bottomLeft, bottomRight],
          [topLeft, bottomRight, topRight],
        ];
    addSurfaceTrianglePair(
      primitives,
      family,
      triangles,
      normalize([center[0], center[1], 0]),
      makeVertex,
    );
  }
  return { cells: subdivisions, quads: subdivisions };
}

function addSourceBodyBand(
  primitives,
  bodyContour,
  upper,
  lower,
  keys,
  families,
  subdivisions,
  side,
  makeVertex,
) {
  const totals = { cells: 0, quads: 0 };
  for (let index = 0; index < families.length; index += 1) {
    const metrics = addSourceBodyRegion(
      primitives,
      bodyContour,
      families[index],
      {
        left: upper[keys[index]],
        right: upper[keys[index + 1]],
        sourceY: upper.sourceY,
      },
      {
        left: lower[keys[index]],
        right: lower[keys[index + 1]],
        sourceY: lower.sourceY,
      },
      subdivisions[index],
      side,
      makeVertex,
    );
    totals.cells += metrics.cells;
    totals.quads += metrics.quads;
  }
  return totals;
}

function subdividedSourceRow(row, keys, subdivisions) {
  const points = [];
  for (let index = 0; index < subdivisions.length; index += 1) {
    const interval = sourceInterval(
      row[keys[index]],
      row[keys[index + 1]],
      row.sourceY,
      subdivisions[index],
    );
    points.push(...(index === 0 ? interval : interval.slice(1)));
  }
  return points;
}

function addOvalRingStrip(
  primitives,
  family,
  upper,
  lower,
  makeVertex,
) {
  for (let index = 0; index < upper.length; index += 1) {
    const next = (index + 1) % upper.length;
    const topLeft = upper[index];
    const topRight = upper[next];
    const bottomLeft = lower[index];
    const bottomRight = lower[next];
    const center = average([topLeft, topRight, bottomLeft, bottomRight]);
    const triangles = center[0] < 0
      ? [
          [topLeft, bottomLeft, topRight],
          [bottomLeft, bottomRight, topRight],
        ]
      : [
          [topLeft, bottomLeft, bottomRight],
          [topLeft, bottomRight, topRight],
        ];
    addSurfaceTrianglePair(
      primitives,
      family,
      triangles,
      normalize([center[0], center[1], 0]),
      makeVertex,
    );
  }
  return upper.length;
}

function buildShoulders(primitives) {
  const segments = 16;
  const bodyVertex = (position) => vertex(
    [position[0] * BODY_SIZE_MINIMUM, position[1], position[2]],
    { "body-size": [position[0] * BODY_SIZE_RANGE, 0, 0] },
  );
  const neckProfiles = [
    { z: -0.68, radiusX: 0.28 },
    { z: -1.18, radiusX: 0.37 },
  ].map((ring) => ({ ...ring, radiusY: ring.radiusX * 0.72 }));
  const bodyContour = primarySourceContour("body");
  const jerseyContour = primarySourceContour("jersey");
  const neckRings = neckProfiles.map(({ z, radiusX, radiusY }) =>
    ovalRing(z, radiusX, radiusY, segments));

  addOvalRingStrip(primitives, "skin", neckRings[0], neckRings[1], bodyVertex);
  const rows = new Map([480, 510, 530, 550, 570, 585, 590, 600].map((sourceY) => [
    sourceY,
    sourceY < 510
      ? sourceBodyRow(bodyContour, sourceY)
      : sourceTankTopRow(bodyContour, jerseyContour, sourceY),
  ]));
  const topKeys = ["bodyLeft", "bodyRight"];
  const splitKeys = [
    "bodyLeft",
    "outerLeft",
    "innerLeft",
    "innerRight",
    "outerRight",
    "bodyRight",
  ];
  const splitFamilies = ["skin", "jersey", "skin", "jersey", "skin"];
  const splitSubdivisions = [1, 1, 4, 1, 1];
  const torsoKeys = ["bodyLeft", "outerLeft", "outerRight", "bodyRight"];
  const torsoFamilies = ["skin", "jersey", "skin"];
  const torsoSubdivisions = [1, 2, 1];
  const totals = { cells: 0, quads: 0 };
  for (const side of [-1, 1]) {
    const top = addSourceBodyBand(
      primitives,
      bodyContour,
      rows.get(480),
      rows.get(510),
      topKeys,
      ["skin"],
      [4],
      side,
      bodyVertex,
    );
    totals.cells += top.cells;
    totals.quads += top.quads;
    for (const [upperY, lowerY] of [
      [510, 530],
      [530, 550],
      [550, 570],
      [570, 585],
      [585, 590],
    ]) {
      const band = addSourceBodyBand(
        primitives,
        bodyContour,
        rows.get(upperY),
        rows.get(lowerY),
        splitKeys,
        splitFamilies,
        splitSubdivisions,
        side,
        bodyVertex,
      );
      totals.cells += band.cells;
      totals.quads += band.quads;
    }
    const torso = addSourceBodyBand(
      primitives,
      bodyContour,
      rows.get(590),
      rows.get(600),
      torsoKeys,
      torsoFamilies,
      torsoSubdivisions,
      side,
      bodyVertex,
    );
    totals.cells += torso.cells;
    totals.quads += torso.quads;
  }

  const bottomRow = rows.get(600);
  const bottomSourcePoints = subdividedSourceRow(
    bottomRow,
    torsoKeys,
    torsoSubdivisions,
  );
  const front = bottomSourcePoints.map((point) => ({
    position: projectSourceBodyPoint(bodyContour, point, -1),
    sourceX: point[0],
  }));
  const back = [...bottomSourcePoints].reverse().slice(1, -1).map((point) => ({
    position: projectSourceBodyPoint(bodyContour, point, 1),
    sourceX: point[0],
  }));
  const bottomLoop = [...front, ...back];
  const bottom = [0, 0, svgFaceZ(600)];
  for (let index = 0; index < bottomLoop.length; index += 1) {
    const next = (index + 1) % bottomLoop.length;
    const sourceX = (200 + bottomLoop[index].sourceX + bottomLoop[next].sourceX) / 3;
    const positions = oriented(
      [bottom, bottomLoop[next].position, bottomLoop[index].position],
      [0, 0, -1],
    );
    appendTriangle(primitives, sourceContourContains(
      jerseyContour,
      [sourceX, 599.5],
    ) ? "jersey-base" : "skin-base", positions.map(bodyVertex));
  }

  return Object.freeze({
    sourceQuadCells: segments + totals.cells,
    authoredQuadCells: segments + totals.quads,
  });
}

function primitiveEdgeCounts(primitive) {
  const counts = new Map();
  for (let offset = 0; offset < primitive.indices.length; offset += 3) {
    const triangle = primitive.indices.slice(offset, offset + 3);
    for (const [first, second] of [
      [triangle[0], triangle[1]],
      [triangle[1], triangle[2]],
      [triangle[2], triangle[0]],
    ]) {
      const key = first < second ? `${first},${second}` : `${second},${first}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function validateHairFacelineWeld(primitives, hair, head) {
  if (!hair.weld) {
    return Object.freeze({
      backSeamEdges: 0,
      backSeamVertices: 0,
      backInternalJoinEdges: 0,
      backInternalJoinVertices: 0,
      enabled: false,
      frontFacelineTriangles: head.frontTriangles,
      frontSeamEdges: 0,
      frontSeamVertices: 0,
      insertedHairBoundaryVertices: 0,
      maximumBaseGapCssPx: 0,
      maximumFatnessGapCssPx: 0,
      rearPatchMaterial: null,
      rearPatchTriangles: 0,
      rearMaskBoundaryEdges: 0,
      seamEdges: 0,
      seamVertices: 0,
      sourceFacelineTriangles: FACELINE.triangles.length,
      weldedFacelineTriangles: head.retainedTriangles,
    });
  }
  const skinPrimitive = primitives.get("skin-base");
  const hairPrimitive = primitives.get("hair-base");
  const pool = skinPrimitive.vertexPool;
  const indicesForPositions = (positions) => positions.map((position) => {
    const key = sourceVertexStateKey(vertex(position, {}, true));
    const index = pool.vertexIndexByState.get(key);
    if (index === undefined) {
      throw new Error("FacesJS welded hair vertex was not emitted into the shared source pool.");
    }
    return index;
  });
  const frontSeamIndices = indicesForPositions(
    hair.weld.points.map(({ position }) => position),
  );
  const backHairIndices = indicesForPositions(hair.weld.backHairPoints);
  const backFacelineIndices = indicesForPositions(hair.weld.backFacelinePoints);
  const rearPatchIsHair = head.rearPatchFamily === "hair";
  const backSeamIndices = rearPatchIsHair ? backFacelineIndices : backHairIndices;
  const backInternalJoinIndices = rearPatchIsHair ? backHairIndices : backFacelineIndices;
  const seamIndices = new Set([...frontSeamIndices, ...backSeamIndices]);
  const seamEdges = (frontSeamIndices.length - 1) + (backSeamIndices.length - 1);
  if (seamIndices.size !== seamEdges) {
    throw new Error("FacesJS welded hair seam is not one simple closed source loop.");
  }
  const skinEdges = primitiveEdgeCounts(skinPrimitive);
  const hairEdges = primitiveEdgeCounts(hairPrimitive);
  const validateSeamPath = (indices, label) => {
    if (new Set(indices).size !== indices.length) {
      throw new Error(`FacesJS ${label} hair seam contains duplicate source vertices.`);
    }
    for (let index = 0; index < indices.length - 1; index += 1) {
      const first = indices[index];
      const second = indices[index + 1];
      const key = first < second ? `${first},${second}` : `${second},${first}`;
      if (skinEdges.get(key) !== 1 || hairEdges.get(key) !== 1) {
        throw new Error(
          `FacesJS ${label} hair seam edge ${index} must have one skin and one hair triangle.`,
        );
      }
    }
  };
  validateSeamPath(frontSeamIndices, "front");
  validateSeamPath(backSeamIndices, "back");
  for (let index = 0; index < backInternalJoinIndices.length - 1; index += 1) {
    const first = backInternalJoinIndices[index];
    const second = backInternalJoinIndices[index + 1];
    const key = first < second ? `${first},${second}` : `${second},${first}`;
    const sameMaterialEdges = rearPatchIsHair ? hairEdges : skinEdges;
    const otherMaterialEdges = rearPatchIsHair ? skinEdges : hairEdges;
    if (otherMaterialEdges.has(key) || sameMaterialEdges.get(key) !== 2) {
      throw new Error(
        `FacesJS rear ${head.rearPatchFamily} join edge ${index} must join two ${head.rearPatchFamily} triangles.`,
      );
    }
  }
  return Object.freeze({
    backSeamEdges: backSeamIndices.length - 1,
    backSeamVertices: backSeamIndices.length,
    backInternalJoinEdges: backInternalJoinIndices.length - 1,
    backInternalJoinVertices: backInternalJoinIndices.length,
    enabled: true,
    frontFacelineTriangles: head.frontTriangles,
    frontSeamEdges: frontSeamIndices.length - 1,
    frontSeamVertices: frontSeamIndices.length,
    insertedHairBoundaryVertices: [...hair.weld.splitsBySegment.values()]
      .reduce((sum, entries) => sum + entries.length, 0),
    maximumBaseGapCssPx: 0,
    maximumFatnessGapCssPx: 0,
    rearPatchMaterial: head.rearPatchFamily,
    rearPatchTriangles: head.rearPatchTriangles,
    rearMaskBoundaryEdges: backSeamIndices.length - 1,
    seamEdges,
    seamVertices: seamIndices.size,
    sourceFacelineTriangles: FACELINE.triangles.length,
    weldedFacelineTriangles: head.skinTriangles,
  });
}

function buildFaceGeometry() {
  const primitives = primitiveMap();
  buildEar(primitives, -1);
  buildEar(primitives, 1);
  const hair = buildHair(primitives);
  const head = buildHead(primitives, hair.weld);
  buildEyes(primitives);
  buildBrows(primitives);
  buildNose(primitives);
  buildMouth(primitives);
  const shoulders = buildShoulders(primitives);
  const hairWeld = validateHairFacelineWeld(primitives, hair, head);
  return Object.freeze({
    hairWeld,
    primitives,
    quadAuthoring: Object.freeze({
      sourceQuadCells:
        head.sourceQuadCells + hair.sourceQuadCells + shoulders.sourceQuadCells,
      authoredQuadCells:
        head.authoredQuadCells + hair.authoredQuadCells + shoulders.authoredQuadCells,
      maximumProfileDepthAdjustmentCssPx: Math.max(
        head.maximumDisplacementCssPx,
        hair.maximumDisplacementCssPx,
      ),
    }),
  });
}

function align4(value) {
  return (value + 3) & ~3;
}

function extrema(values, components) {
  const minimum = Array.from({ length: components }, () => Infinity);
  const maximum = Array.from({ length: components }, () => -Infinity);
  for (let offset = 0; offset < values.length; offset += components) {
    for (let component = 0; component < components; component += 1) {
      minimum[component] = Math.min(minimum[component], values[offset + component]);
      maximum[component] = Math.max(maximum[component], values[offset + component]);
    }
  }
  return { minimum, maximum };
}

function buildGltf(primitives) {
  const bufferViews = [];
  const accessors = [];
  const chunks = [];
  let byteLength = 0;

  const append = (values, componentType, type, target, includeBounds = false) => {
    const TypedArray = componentType === 5123 ? Uint16Array : Float32Array;
    const typed = new TypedArray(values);
    const alignedOffset = align4(byteLength);
    if (alignedOffset > byteLength) {
      chunks.push(Buffer.alloc(alignedOffset - byteLength));
    }
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const bufferView = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: alignedOffset,
      byteLength: bytes.byteLength,
      target,
    });
    chunks.push(bytes);
    byteLength = alignedOffset + bytes.byteLength;
    const components = type === "SCALAR" ? 1 : 3;
    const accessor = accessors.length;
    const row = {
      bufferView,
      componentType,
      count: typed.length / components,
      type,
    };
    if (includeBounds) {
      const { minimum, maximum } = extrema(typed, components);
      row.min = minimum;
      row.max = maximum;
    }
    accessors.push(row);
    return accessor;
  };

  const gltfPrimitives = [];
  const quadPairs = [];
  const vertexPool = primitives.values().next().value.vertexPool;
  const sourceVertexCount = vertexPool.positions.length / 3;
  if (sourceVertexCount > 65_535) {
    throw new Error(`FacesJS shared source vertex pool exceeds uint16 indices (${sourceVertexCount}).`);
  }
  const positionAccessor = append(vertexPool.positions, 5126, "VEC3", 34962, true);
  const targetAccessors = TARGETS.map(({ id }) =>
    append(vertexPool.targetValues[id], 5126, "VEC3", 34962));
  let vertexCount = 0;
  let polygonCount = 0;
  for (const [materialId, primitive] of primitives) {
    if (primitive.indices.length === 0) continue;
    const polygonOffset = polygonCount;
    const indexAccessor = append(primitive.indices, 5123, "SCALAR", 34963, true);
    gltfPrimitives.push({
      attributes: { POSITION: positionAccessor },
      indices: indexAccessor,
      material: MATERIAL_INDEX.get(materialId),
      mode: 4,
      targets: targetAccessors.map((accessor) => ({ POSITION: accessor })),
    });
    quadPairs.push(...primitive.quadPairs.map(([first, second]) => [
      polygonOffset + first,
      polygonOffset + second,
    ]));
    vertexCount += new Set(primitive.indices).size;
    polygonCount += primitive.indices.length / 3;
  }
  const buffer = Buffer.concat(chunks);
  const materials = MATERIALS.map(([name, color]) => ({
    name,
    pbrMetallicRoughness: {
      baseColorFactor: color,
      metallicFactor: 0,
      roughnessFactor: 0.92,
    },
  }));

  return {
    gltf: {
      asset: {
        version: "2.0",
        generator: "cssface-facesjs-svg-to-polycss",
      },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: MODEL_NAME }],
      buffers: [{
        byteLength: buffer.byteLength,
        uri: `data:application/octet-stream;base64,${buffer.toString("base64")}`,
      }],
      bufferViews,
      accessors,
      materials,
      meshes: [{
        name: MODEL_NAME,
        extras: {
          targetNames: TARGETS.map(({ name }) => name),
          faceConfig: FACE,
          faceline: {
            index: FACELINE.index,
            sourceSha256: FACELINE.sourceSha256,
            sourceVersion: FACELINE.sourceVersion,
          },
        },
        primitives: gltfPrimitives,
      }],
    },
    polygonCount,
    quadPairs,
    vertexCount,
  };
}

function buildPrepareConfig(polygonCount, vertexCount) {
  return {
    schema: "polycss-morph.prepare@1",
    identity: {
      id: MODEL_ID,
      name: MODEL_NAME,
      revision: "0.9.0",
    },
    profile: "morph-regions",
    source: {
      path: MODEL_SOURCE_FILENAME,
      id: `facesjs-rfl-${PRESET.id}-${SOURCE_SVG_SHA256.slice(0, 8)}-${FACELINE.sourceSha256.slice(0, 8)}-${FACELINE.index}`,
      kind: "generated",
      uri: "local:cssface-faceline-composite",
      license: "mixed",
    },
    transform: {
      axes: ["x", "z", "y"],
      signs: [1, -1, -1],
      scale: MODEL_SCALE,
      center: true,
    },
    morphAliases: Object.fromEntries(TARGETS.map(({ name, id }) => [name, id])),
    controls: [],
    springs: [],
    animations: [],
    budgets: {
      maxVertices: vertexCount,
      maxPolygons: polygonCount,
      maxLeaves: polygonCount,
      maxFrames: 1,
      maxJoints: 1,
      maxResources: 8,
      maxBytes: 8_000_000,
    },
  };
}

function rounded(value) {
  const output = Number(value.toFixed(10));
  return Object.is(output, -0) ? 0 : output;
}

function add(left, right) {
  return [
    left[0] + right[0],
    left[1] + right[1],
    left[2] + right[2],
  ];
}

function scale(value, amount) {
  return value.map((component) => component * amount);
}

function planarDistance(points) {
  const normal = normalize(cross(
    vectorSub(points[1], points[0]),
    vectorSub(points[3], points[0]),
  ));
  if (Math.hypot(...normal) <= 1e-12) return Infinity;
  return Math.abs(dot(vectorSub(points[2], points[0]), normal));
}

function projectiveQuadMatrix(points, width, height) {
  if (planarDistance(points) > QUAD_PLANAR_EPSILON) return null;
  const [p0, p1, p2, p3] = points;
  const edgeX = vectorSub(p1, p0);
  const edgeY = vectorSub(p3, p0);
  const z = normalize(cross(edgeX, edgeY));
  if (Math.hypot(...z) <= 1e-12) return null;
  const a = vectorSub(p1, p2);
  const b = vectorSub(p3, p2);
  const residual = add(vectorSub(p0, p1), vectorSub(p2, p3));
  const axes = [[0, 1], [0, 2], [1, 2]]
    .map(([first, second]) => ({
      first,
      second,
      determinant: (a[first] * b[second]) - (a[second] * b[first]),
    }))
    .sort((left, right) =>
      Math.abs(right.determinant) - Math.abs(left.determinant));
  const basis = axes[0];
  if (!basis || Math.abs(basis.determinant) <= 1e-12) return null;
  const g = (
    (residual[basis.first] * b[basis.second])
    - (residual[basis.second] * b[basis.first])
  ) / basis.determinant;
  const h = (
    (a[basis.first] * residual[basis.second])
    - (a[basis.second] * residual[basis.first])
  ) / basis.determinant;
  if (
    Math.abs(1 + g) <= 1e-10
    || Math.abs(1 + h) <= 1e-10
    || Math.abs(1 + g + h) <= 1e-10
  ) return null;
  const x = [
    ((1 + g) * p1[0] - p0[0]) / width,
    ((1 + g) * p1[1] - p0[1]) / width,
    ((1 + g) * p1[2] - p0[2]) / width,
  ];
  const y = [
    ((1 + h) * p3[0] - p0[0]) / height,
    ((1 + h) * p3[1] - p0[1]) / height,
    ((1 + h) * p3[2] - p0[2]) / height,
  ];
  return [
    x[0], x[1], x[2], g / width,
    y[0], y[1], y[2], h / height,
    z[0], z[1], z[2], 0,
    p0[0], p0[1], p0[2], 1,
  ].map(rounded);
}

function targetPositionMaps(model) {
  if (model.deformation.kind !== "morph-regions") {
    throw new TypeError("FacesJS preparation requires morph regions.");
  }
  return new Map(model.deformation.targets.map((target) => [
    target.id,
    new Map(target.deltas.map((delta) => [delta.vertexIndex, delta.position])),
  ]));
}

function preparedHairFacelineEdgeCount(modelInput) {
  const model = validatePolyMorphModel(modelInput);
  const skinMaterialId = model.materials.find(({ id }) => id.endsWith("-skin-base"))?.id;
  const hairMaterialId = model.materials.find(({ id }) => id.endsWith("-hair-base"))?.id;
  if (!hairMaterialId) return 0;
  if (!skinMaterialId) {
    throw new Error("FacesJS prepared hair weld could not resolve the skin material.");
  }
  const polygonById = new Map(model.topology.polygons.map((polygon) => [polygon.id, polygon]));
  const edgeMaterials = new Map();
  for (const leaf of model.render.leaves) {
    if (leaf.materialId !== skinMaterialId && leaf.materialId !== hairMaterialId) continue;
    const polygon = polygonById.get(leaf.polygonId);
    if (!polygon) throw new Error(`FacesJS prepared hair weld lost polygon ${leaf.polygonId}.`);
    for (let index = 0; index < polygon.vertexIndices.length; index += 1) {
      const first = polygon.vertexIndices[index];
      const second = polygon.vertexIndices[(index + 1) % polygon.vertexIndices.length];
      const key = first < second ? `${first},${second}` : `${second},${first}`;
      const materials = edgeMaterials.get(key) ?? [];
      materials.push(leaf.materialId);
      edgeMaterials.set(key, materials);
    }
  }
  return [...edgeMaterials.values()].filter((materials) =>
    materials.length === 2
    && materials.includes(skinMaterialId)
    && materials.includes(hairMaterialId)).length;
}

function weldPreparedHairFacelineVertices(modelInput, hairWeld) {
  const model = structuredClone(validatePolyMorphModel(modelInput));
  if (!hairWeld.enabled) {
    return Object.freeze({
      metrics: Object.freeze({
        crossMaterialSeamEdges: 0,
        mergedPreparedVertices: 0,
        preparedVerticesAfterWeld: model.topology.vertices.length,
        preparedVerticesBeforeWeld: model.topology.vertices.length,
      }),
      model,
    });
  }
  if (model.deformation.kind !== "morph-regions") {
    throw new TypeError("FacesJS prepared hair weld requires morph regions.");
  }
  if (model.deformation.targets.some(({ deltas }) =>
    deltas.some(({ normal }) => normal !== null))) {
    throw new Error("FacesJS prepared hair weld does not accept animated vertex normals.");
  }
  const skinMaterialId = model.materials.find(({ id }) => id.endsWith("-skin-base"))?.id;
  const hairMaterialId = model.materials.find(({ id }) => id.endsWith("-hair-base"))?.id;
  if (!skinMaterialId || !hairMaterialId) {
    throw new Error("FacesJS prepared hair weld could not resolve skin and hair materials.");
  }
  const polygonById = new Map(model.topology.polygons.map((polygon) => [polygon.id, polygon]));
  const vertexIndicesForMaterial = (materialId) => new Set(model.render.leaves
    .filter((leaf) => leaf.materialId === materialId)
    .flatMap((leaf) => polygonById.get(leaf.polygonId)?.vertexIndices ?? []));
  const skinVertexIndices = vertexIndicesForMaterial(skinMaterialId);
  const hairVertexIndices = vertexIndicesForMaterial(hairMaterialId);
  const targets = targetPositionMaps(model);
  const targetIds = [...targets.keys()].sort();
  const stateKey = (vertexIndex) => [
    ...model.topology.vertices[vertexIndex],
    ...targetIds.flatMap((targetId) =>
      targets.get(targetId).get(vertexIndex) ?? [0, 0, 0]),
  ].map(rounded).join(",");
  const skinVertexByState = new Map([...skinVertexIndices].map((vertexIndex) => [
    stateKey(vertexIndex),
    vertexIndex,
  ]));
  const representative = Array.from(
    { length: model.topology.vertices.length },
    (_, index) => index,
  );
  let mergedPreparedVertices = 0;
  for (const hairVertexIndex of hairVertexIndices) {
    const skinVertexIndex = skinVertexByState.get(stateKey(hairVertexIndex));
    if (skinVertexIndex === undefined || skinVertexIndex === hairVertexIndex) continue;
    representative[hairVertexIndex] = skinVertexIndex;
    mergedPreparedVertices += 1;
  }
  if (mergedPreparedVertices !== hairWeld.seamVertices) {
    throw new Error(
      `FacesJS prepared hair weld merged ${mergedPreparedVertices} vertices; expected ${hairWeld.seamVertices}.`,
    );
  }

  const compactIndexByRepresentative = new Map();
  const compactVertices = [];
  const compactIndexByOldIndex = representative.map((sourceIndex) => {
    let compactIndex = compactIndexByRepresentative.get(sourceIndex);
    if (compactIndex === undefined) {
      compactIndex = compactVertices.length;
      compactIndexByRepresentative.set(sourceIndex, compactIndex);
      compactVertices.push(model.topology.vertices[sourceIndex]);
    }
    return compactIndex;
  });
  model.topology.vertices = compactVertices;
  model.topology.polygons = model.topology.polygons.map((polygon) => ({
    ...polygon,
    vertexIndices: polygon.vertexIndices.map((vertexIndex) =>
      compactIndexByOldIndex[vertexIndex]),
  }));
  model.deformation.targets = model.deformation.targets.map((target) => {
    const deltaByCompactIndex = new Map();
    for (const delta of target.deltas) {
      const vertexIndex = compactIndexByOldIndex[delta.vertexIndex];
      const existing = deltaByCompactIndex.get(vertexIndex);
      if (existing) {
        if (JSON.stringify(existing.position) !== JSON.stringify(delta.position)) {
          throw new Error(`FacesJS prepared hair weld disagrees on ${target.id} delta ${vertexIndex}.`);
        }
        continue;
      }
      deltaByCompactIndex.set(vertexIndex, { ...delta, vertexIndex });
    }
    return {
      ...target,
      deltas: [...deltaByCompactIndex.values()]
        .sort((left, right) => left.vertexIndex - right.vertexIndex),
    };
  });

  const welded = validatePolyMorphModel(model);
  const crossMaterialSeamEdges = preparedHairFacelineEdgeCount(welded);
  if (crossMaterialSeamEdges !== hairWeld.seamEdges) {
    throw new Error(
      `FacesJS prepared hair weld has ${crossMaterialSeamEdges} cross-material edges; expected ${hairWeld.seamEdges}.`,
    );
  }
  return Object.freeze({
    metrics: Object.freeze({
      crossMaterialSeamEdges,
      mergedPreparedVertices,
      preparedVerticesAfterWeld: welded.topology.vertices.length,
      preparedVerticesBeforeWeld: modelInput.topology.vertices.length,
    }),
    model: welded,
  });
}

function repairPreparedQuadPlanarity(model, quadPairs) {
  const targets = targetPositionMaps(model);
  const eligible = [];
  const repairedVertexIndices = new Set();
  for (const [firstIndex, secondIndex] of quadPairs) {
    const firstPolygon = model.topology.polygons[firstIndex];
    const secondPolygon = model.topology.polygons[secondIndex];
    if (!firstPolygon || !secondPolygon) continue;
    const vertexIndices = quadBoundary(firstPolygon, secondPolygon);
    if (!vertexIndices) continue;
    const affectedTargetIds = [...targets]
      .filter(([, deltaByVertex]) =>
        vertexIndices.some((vertexIndex) =>
          Math.hypot(...(deltaByVertex.get(vertexIndex) ?? [0, 0, 0])) > 1e-12))
      .map(([targetId]) => targetId);
    if (
      affectedTargetIds.length !== 1
      || affectedTargetIds[0] !== "fatness"
    ) continue;
    eligible.push(vertexIndices);
    for (const vertexIndex of vertexIndices) repairedVertexIndices.add(vertexIndex);
  }

  const originalPositions = new Map([...repairedVertexIndices].map((vertexIndex) => [
    vertexIndex,
    [...model.topology.vertices[vertexIndex]],
  ]));
  for (let sweep = 0; sweep < 256; sweep += 1) {
    const candidates = sweep % 2 === 0 ? eligible : [...eligible].reverse();
    for (const vertexIndices of candidates) {
      const points = vertexIndices.map((vertexIndex) =>
        model.topology.vertices[vertexIndex]);
      const normal = normalize(cross(
        vectorSub(points[1], points[0]),
        vectorSub(points[3], points[0]),
      ));
      if (Math.hypot(...normal) <= 1e-12) continue;
      const signedDistance = dot(vectorSub(points[2], points[0]), normal);
      if (Math.abs(signedDistance) <= 1e-12) continue;
      const adjusted = vectorSub(points[2], scale(normal, signedDistance));
      model.topology.vertices[vertexIndices[2]] = adjusted.map(rounded);
    }
  }

  const fatness = targets.get("fatness");
  for (const vertexIndex of repairedVertexIndices) {
    const delta = fatness?.get(vertexIndex);
    if (!delta) continue;
    delta[0] = rounded(model.topology.vertices[vertexIndex][0] * 0.25);
    delta[1] = 0;
    delta[2] = 0;
  }

  const maximumRepairCssPx = Math.max(0, ...[...originalPositions].map(
    ([vertexIndex, position]) => Math.hypot(...vectorSub(
      model.topology.vertices[vertexIndex],
      position,
    )),
  ));
  const maximumResidualCssPx = Math.max(0, ...eligible.map((vertexIndices) =>
    planarDistance(vertexIndices.map((vertexIndex) =>
      model.topology.vertices[vertexIndex]))));
  if (maximumRepairCssPx > 0.01 || maximumResidualCssPx > 2e-7) {
    throw new Error(
      `FacesJS shared quad repair exceeded its contract: ${maximumRepairCssPx}px movement, ${maximumResidualCssPx}px residual.`,
    );
  }
  return Object.freeze({
    maximumRepairCssPx: rounded(maximumRepairCssPx),
    maximumResidualCssPx: rounded(maximumResidualCssPx),
    repairedVertices: repairedVertexIndices.size,
  });
}

function quadBoundary(firstPolygon, secondPolygon) {
  const triangles = [firstPolygon, secondPolygon].map((polygon) =>
    [...polygon.vertexIndices]);
  if (triangles.some((triangle) => new Set(triangle).size !== 3)) {
    return null;
  }
  const shared = triangles[0].filter((vertexIndex) =>
    triangles[1].includes(vertexIndex));
  if (new Set(shared).size !== 2) return null;
  const edges = new Map();
  for (const triangle of triangles) {
    for (let index = 0; index < 3; index += 1) {
      const start = triangle[index];
      const end = triangle[(index + 1) % 3];
      const edgeKey = start < end ? `${start}|${end}` : `${end}|${start}`;
      const edge = edges.get(edgeKey);
      if (edge) edge.count += 1;
      else edges.set(edgeKey, { count: 1, start, end });
    }
  }
  if (new Set(triangles.flat()).size !== 4) return null;
  const boundaryEdges = [...edges.values()].filter(({ count }) => count === 1);
  if (boundaryEdges.length !== 4) return null;
  const nextByKey = new Map(boundaryEdges.map(({ start, end }) => [start, end]));
  if (nextByKey.size !== 4) return null;
  const keys = [boundaryEdges[0].start];
  while (keys.length < 4) {
    const next = nextByKey.get(keys.at(-1));
    if (next === undefined || keys.includes(next)) return null;
    keys.push(next);
  }
  if (nextByKey.get(keys.at(-1)) !== keys[0]) return null;
  return keys;
}

function quadNormalBoundary(model, firstPolygon, secondPolygon, vertexIndices) {
  const polygons = [firstPolygon, secondPolygon];
  const normalIndices = [];
  for (const vertexIndex of vertexIndices) {
    const candidates = polygons.flatMap((polygon) =>
      polygon.vertexIndices.flatMap((candidateVertexIndex, index) =>
        candidateVertexIndex === vertexIndex ? [polygon.normalIndices[index]] : []));
    if (candidates.length === 0) return null;
    const representative = model.topology.normals[candidates[0]];
    if (
      !representative
      || candidates.some((normalIndex) => {
        const normal = model.topology.normals[normalIndex];
        return !normal || Math.hypot(...vectorSub(normal, representative)) > 1e-8;
      })
    ) {
      return null;
    }
    normalIndices.push(candidates[0]);
  }
  return normalIndices;
}

function targetStates(targetIds) {
  const states = [];
  const count = 3 ** targetIds.length;
  for (let encoded = 0; encoded < count; encoded += 1) {
    let value = encoded;
    const weights = new Map();
    for (const id of targetIds) {
      weights.set(id, [0, 0.5, 1][value % 3]);
      value = Math.floor(value / 3);
    }
    states.push(weights);
  }
  return states;
}

function optimizePreparedQuads(modelInput, quadPairs, quadAuthoring) {
  const model = structuredClone(validatePolyMorphModel(modelInput));
  const planarityRepair = repairPreparedQuadPlanarity(model, quadPairs);
  const targets = targetPositionMaps(model);
  const polygons = model.topology.polygons;
  const leaves = model.render.leaves;
  const usedPolygonIndices = new Set();
  const merges = new Map();
  const skipped = new Set();
  let rejectedPlanarity = 0;
  let rejectedContract = 0;
  let maximumAcceptedPlanarityError = 0;

  for (const [firstIndex, secondIndex] of quadPairs) {
    if (
      usedPolygonIndices.has(firstIndex)
      || usedPolygonIndices.has(secondIndex)
      || firstIndex === secondIndex
    ) {
      throw new Error("FacesJS quad candidates overlap.");
    }
    usedPolygonIndices.add(firstIndex);
    usedPolygonIndices.add(secondIndex);
    const firstPolygon = polygons[firstIndex];
    const secondPolygon = polygons[secondIndex];
    const firstLeaf = leaves[firstIndex];
    const secondLeaf = leaves[secondIndex];
    if (
      !firstPolygon
      || !secondPolygon
      || !firstLeaf
      || !secondLeaf
      || firstLeaf.polygonId !== firstPolygon.id
      || secondLeaf.polygonId !== secondPolygon.id
      || firstLeaf.shapeId !== secondLeaf.shapeId
      || firstLeaf.materialId !== secondLeaf.materialId
      || firstLeaf.strategy !== "solid-triangle"
      || secondLeaf.strategy !== "solid-triangle"
    ) {
      throw new Error("FacesJS quad candidate no longer matches its prepared triangles.");
    }
    const vertexIndices = quadBoundary(firstPolygon, secondPolygon);
    if (!vertexIndices) {
      rejectedContract += 1;
      continue;
    }
    const normalIndices = quadNormalBoundary(
      model,
      firstPolygon,
      secondPolygon,
      vertexIndices,
    );
    if (!normalIndices) {
      rejectedContract += 1;
      continue;
    }
    const basePoints = vertexIndices.map((index) =>
      [...model.topology.vertices[index]]);
    const basePlanarityError = planarDistance(basePoints);
    if (basePlanarityError > QUAD_PLANAR_EPSILON) {
      rejectedPlanarity += 1;
      continue;
    }
    const affectedTargetIds = [...targets]
      .filter(([, deltaByVertex]) =>
        vertexIndices.some((vertexIndex) =>
          Math.hypot(...(deltaByVertex.get(vertexIndex) ?? [0, 0, 0])) > 1e-12))
      .map(([targetId]) => targetId);
    const candidateStates = targetStates(affectedTargetIds);
    let candidateMaximumPlanarityError = basePlanarityError;
    const validAcrossMorphs = candidateStates.every((weights) => {
      const points = basePoints.map((point, index) => {
        const vertexIndex = vertexIndices[index];
        let position = [...point];
        for (const [targetId, weight] of weights) {
          const delta = targets.get(targetId).get(vertexIndex) ?? [0, 0, 0];
          position = add(position, scale(delta, weight));
        }
        return position;
      });
      const planarityError = planarDistance(points);
      candidateMaximumPlanarityError = Math.max(
        candidateMaximumPlanarityError,
        planarityError,
      );
      return planarityError <= QUAD_PLANAR_EPSILON
        && projectiveQuadMatrix(
          points,
          SOLID_QUAD_CANONICAL_SIZE,
          SOLID_QUAD_CANONICAL_SIZE,
        ) !== null;
    });
    const rawMatrix = projectiveQuadMatrix(
      basePoints,
      SOLID_QUAD_CANONICAL_SIZE,
      SOLID_QUAD_CANONICAL_SIZE,
    );
    if (!validAcrossMorphs || !rawMatrix) {
      rejectedContract += 1;
      continue;
    }
    maximumAcceptedPlanarityError = Math.max(
      maximumAcceptedPlanarityError,
      candidateMaximumPlanarityError,
    );
    const matrix = rawMatrix;
    merges.set(firstIndex, {
      polygon: {
        id: firstPolygon.id,
        vertexIndices,
        normalIndices,
      },
      leaf: {
        ...firstLeaf,
        strategy: "solid-quad",
        width: SOLID_QUAD_CANONICAL_SIZE,
        height: SOLID_QUAD_CANONICAL_SIZE,
        matrix,
        atlas: null,
        fallback: null,
      },
    });
    skipped.add(secondIndex);
  }

  const optimizedPolygons = [];
  const optimizedLeaves = [];
  for (let index = 0; index < polygons.length; index += 1) {
    const merge = merges.get(index);
    if (merge) {
      optimizedPolygons.push(merge.polygon);
      optimizedLeaves.push(merge.leaf);
    } else if (!skipped.has(index)) {
      optimizedPolygons.push(polygons[index]);
      optimizedLeaves.push(leaves[index]);
    }
  }
  model.topology.polygons = optimizedPolygons;
  model.render.leaves = optimizedLeaves;
  const optimized = validatePolyMorphModel(model);
  const solidQuads = optimized.render.leaves.filter(
    ({ strategy }) => strategy === "solid-quad",
  ).length;
  const solidTriangles = optimized.render.leaves.length - solidQuads;
  return Object.freeze({
    model: optimized,
    metrics: Object.freeze({
      sourceTriangles: polygons.length,
      sourceQuadCells: quadPairs.length,
      quadCandidates: quadPairs.length,
      mergedQuads: solidQuads,
      retainedTriangles: solidTriangles,
      preparedLeaves: optimized.render.leaves.length,
      leafReduction: polygons.length - optimized.render.leaves.length,
      rejectedPlanarity,
      rejectedContract,
      maximumAcceptedPlanarityErrorCssPx:
        rounded(maximumAcceptedPlanarityError),
      maximumPlanarityRepairCssPx: planarityRepair.maximumRepairCssPx,
      maximumPlanarityRepairResidualCssPx:
        planarityRepair.maximumResidualCssPx,
      repairedPlanarityVertices: planarityRepair.repairedVertices,
      maximumProfileDepthAdjustmentCssPx:
        quadAuthoring.maximumProfileDepthAdjustmentCssPx,
    }),
  });
}

function bindTriangleFallback(modelInput) {
  const model = structuredClone(validatePolyMorphModel(modelInput));
  for (const leaf of model.render.leaves) {
    if (!leaf.fallback) continue;
    leaf.fallback.atlas.resourcePath = TRIANGLE_FALLBACK_RESOURCE_PATH;
  }
  return validatePolyMorphModel(model);
}

function srgbChannelToLinear(value) {
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function linearChannelToSrgb(value) {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function average(vectors) {
  const result = [0, 0, 0];
  for (const vector of vectors) {
    for (let axis = 0; axis < 3; axis += 1) {
      result[axis] += vector[axis] / vectors.length;
    }
  }
  return result;
}

function rotationLightingSpecular(materialId) {
  const entry = Object.entries(ROTATION_LIGHTING_SPECULAR.materials).find(
    ([id]) => materialId === id || materialId.endsWith(`-${id}`),
  );
  if (!entry) {
    throw new TypeError(`FacesJS material ${materialId} has no specular profile.`);
  }
  return entry[1];
}

function rotationLightingSamples(model) {
  const polygonById = new Map(
    model.topology.polygons.map((polygon) => [polygon.id, polygon]),
  );
  const materialById = new Map(
    model.materials.map((material) => [material.id, material]),
  );
  return model.render.leaves.map((leaf) => {
    const polygon = polygonById.get(leaf.polygonId);
    const material = materialById.get(leaf.materialId);
    if (
      !polygon
      || ![3, 4].includes(polygon.normalIndices.length)
      || !material
    ) {
      throw new TypeError(`FacesJS leaf ${leaf.id} has no lighting source.`);
    }
    // The FacesJS x/z/y source transform changes handedness. Restore the
    // source-facing direction before baking the yaw-lighting atlas.
    const sourceNormal = normalize(average(
      polygon.normalIndices.map((index) =>
        model.topology.normals[index].map((component) => -component)),
    ));
    const normal = material.id.endsWith("-ear-cap")
      ? [Math.sign(sourceNormal[0]) || 1, 0, 0]
      : sourceNormal;
    return Object.freeze({
      leafId: leaf.id,
      normal: Object.freeze(normal),
      linearColor: Object.freeze(
        material.color.slice(0, 3).map(srgbChannelToLinear),
      ),
      specular: rotationLightingSpecular(material.id),
    });
  });
}

function shadeRotationSample(
  sample,
  yawRadians,
  keyDirection,
  fillDirection,
  halfDirection,
) {
  const cosine = Math.cos(yawRadians);
  const sine = Math.sin(yawRadians);
  const normal = [
    (cosine * sample.normal[0]) + (sine * sample.normal[2]),
    sample.normal[1],
    (-sine * sample.normal[0]) + (cosine * sample.normal[2]),
  ];
  const keyDiffuse = Math.max(0, dot(normal, keyDirection));
  const intensity = ROTATION_LIGHTING_AMBIENT
    + (ROTATION_LIGHTING_KEY.intensity * keyDiffuse)
    + (ROTATION_LIGHTING_FILL.intensity * Math.max(0, dot(normal, fillDirection)));
  const specular = keyDiffuse > 0
    ? ROTATION_LIGHTING_KEY.intensity
      * sample.specular.strength
      * Math.max(0, dot(normal, halfDirection)) ** sample.specular.shininess
    : 0;
  return sample.linearColor.map((channel) =>
    Math.round(linearChannelToSrgb((channel * intensity) + specular) * 255));
}

function maximumRgbDelta(left, right) {
  return Math.max(
    Math.abs(left[0] - right[0]),
    Math.abs(left[1] - right[1]),
    Math.abs(left[2] - right[2]),
  );
}

function sameRgb(left, right) {
  return left[0] === right[0]
    && left[1] === right[1]
    && left[2] === right[2];
}

function circularHoldRows(colors) {
  let bestRows = null;
  let bestChanges = Number.POSITIVE_INFINITY;
  for (let anchor = 0; anchor < colors.length; anchor += 1) {
    const rows = new Uint8Array(colors.length);
    let representative = anchor;
    rows[anchor] = anchor;
    for (let offset = 1; offset < colors.length; offset += 1) {
      const state = (anchor + offset) % colors.length;
      if (maximumRgbDelta(
        colors[state],
        colors[representative],
      ) > ROTATION_LIGHTING_TEMPORAL_MAX_RGB_DELTA) {
        representative = state;
      }
      rows[state] = representative;
    }
    let changes = 0;
    for (let state = 0; state < colors.length; state += 1) {
      const previous = (state + colors.length - 1) % colors.length;
      changes += Number(!sameRgb(
        colors[rows[state]],
        colors[rows[previous]],
      ));
    }
    if (changes < bestChanges) {
      bestChanges = changes;
      bestRows = rows;
    }
  }
  if (!bestRows) throw new Error("FacesJS rotation lighting has no hold schedule.");
  return bestRows;
}

function uint16LeBase64(values) {
  const bytes = Buffer.alloc(values.length * 2);
  for (let index = 0; index < values.length; index += 1) {
    bytes.writeUInt16LE(values[index], index * 2);
  }
  return bytes.toString("base64");
}

function uint32LeBase64(values) {
  const bytes = Buffer.alloc(values.length * 4);
  for (let index = 0; index < values.length; index += 1) {
    bytes.writeUInt32LE(values[index], index * 4);
  }
  return bytes.toString("base64");
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function rotationLightingTransitions(colorsByLeaf) {
  const rowsByLeaf = colorsByLeaf.map(circularHoldRows);
  const offsets = [0];
  const faceIndices = [];
  const forwardRows = [];
  const backwardRows = [];
  const writes = [];
  for (let state = 0; state < ROTATION_LIGHTING_STEPS; state += 1) {
    const previous = (state + ROTATION_LIGHTING_STEPS - 1)
      % ROTATION_LIGHTING_STEPS;
    const start = faceIndices.length;
    for (let faceIndex = 0; faceIndex < colorsByLeaf.length; faceIndex += 1) {
      const colors = colorsByLeaf[faceIndex];
      const rows = rowsByLeaf[faceIndex];
      if (sameRgb(colors[rows[state]], colors[rows[previous]])) continue;
      faceIndices.push(faceIndex);
      forwardRows.push(rows[state]);
      backwardRows.push(rows[previous]);
    }
    writes.push(faceIndices.length - start);
    offsets.push(faceIndices.length);
  }
  return Object.freeze({
    initialRowsBase64: Buffer.from(
      rowsByLeaf.map((rows) => rows[0]),
    ).toString("base64"),
    contract: Object.freeze({
      encoding:
        "csr-uint32le-offsets-parallel-uint16le-face-uint8-row-indices-base64",
      stepCount: ROTATION_LIGHTING_STEPS,
      offsetCount: offsets.length,
      changeCount: faceIndices.length,
      offsetsBase64: uint32LeBase64(offsets),
      faceIndicesBase64: uint16LeBase64(faceIndices),
      forwardRowsBase64: Buffer.from(forwardRows).toString("base64"),
      backwardRowsBase64: Buffer.from(backwardRows).toString("base64"),
      meanChangedFaces: rounded(
        writes.reduce((total, value) => total + value, 0) / writes.length,
      ),
      p50ChangedFaces: percentile(writes, 0.5),
      p95ChangedFaces: percentile(writes, 0.95),
      maximumChangedFaces: Math.max(...writes),
    }),
  });
}

async function buildRotationLighting(model) {
  const samples = rotationLightingSamples(model);
  const width = samples.length * ROTATION_LIGHTING_FIELD_PX;
  const height = ROTATION_LIGHTING_STEPS * ROTATION_LIGHTING_FIELD_PX;
  if (width > 8192) {
    throw new RangeError(`FacesJS rotation texel atlas width ${width} exceeds 8192.`);
  }
  const keyDirection = normalize(ROTATION_LIGHTING_KEY.direction);
  const fillDirection = normalize(ROTATION_LIGHTING_FILL.direction);
  const viewDirection = normalize(ROTATION_LIGHTING_VIEW_DIRECTION);
  const halfDirection = normalize([
    keyDirection[0] + viewDirection[0],
    keyDirection[1] + viewDirection[1],
    keyDirection[2] + viewDirection[2],
  ]);
  const colorsByLeaf = samples.map(() => new Array(ROTATION_LIGHTING_STEPS));
  const rgba = Buffer.alloc(width * height * 4);
  for (let spinIndex = 0; spinIndex < ROTATION_LIGHTING_STEPS; spinIndex += 1) {
    const yawRadians = spinIndex * Math.PI * 2 / ROTATION_LIGHTING_STEPS;
    for (let leafIndex = 0; leafIndex < samples.length; leafIndex += 1) {
      const rgb = shadeRotationSample(
        samples[leafIndex],
        yawRadians,
        keyDirection,
        fillDirection,
        halfDirection,
      );
      colorsByLeaf[leafIndex][spinIndex] = rgb;
      for (let y = 0; y < ROTATION_LIGHTING_FIELD_PX; y += 1) {
        for (let x = 0; x < ROTATION_LIGHTING_FIELD_PX; x += 1) {
          const atlasX = (leafIndex * ROTATION_LIGHTING_FIELD_PX) + x;
          const atlasY = (spinIndex * ROTATION_LIGHTING_FIELD_PX) + y;
          const offset = ((atlasY * width) + atlasX) * 4;
          rgba[offset] = rgb[0];
          rgba[offset + 1] = rgb[1];
          rgba[offset + 2] = rgb[2];
          rgba[offset + 3] = 255;
        }
      }
    }
  }
  const transitions = rotationLightingTransitions(colorsByLeaf);
  const imageBytes = await sharp(rgba, {
    raw: { width, height, channels: 4 },
  }).webp({ lossless: true, effort: 6 }).toBuffer();
  const contract = Object.freeze({
    schema: ROTATION_LIGHTING_SCHEMA,
    technique: "prepared-yaw-space-texel-atlas-sparse-transitions",
    runtimeColorWrites: 0,
    runtimeLightingMath: 0,
    runtimeStyleWritesMaximum:
      transitions.contract.maximumChangedFaces,
    modelId: model.identity.id,
    modelRevision: model.identity.revision,
    leafIds: Object.freeze(samples.map(({ leafId }) => leafId)),
    state: Object.freeze({
      spinSteps: ROTATION_LIGHTING_STEPS,
      fieldSourcePx: ROTATION_LIGHTING_FIELD_PX,
      temporalMaximumRgbDelta:
        ROTATION_LIGHTING_TEMPORAL_MAX_RGB_DELTA,
      initialRowsBase64: transitions.initialRowsBase64,
    }),
    transitions: transitions.contract,
    atlas: Object.freeze({
      layout: "source-order-face-columns-by-yaw-state-rows",
      asset: ROTATION_LIGHTING_ASSET_ROLE,
      width,
      height,
    }),
    lighting: Object.freeze({
      ambient: ROTATION_LIGHTING_AMBIENT,
      key: ROTATION_LIGHTING_KEY,
      fill: ROTATION_LIGHTING_FILL,
      specular: Object.freeze({
        ...ROTATION_LIGHTING_SPECULAR,
        viewDirection: ROTATION_LIGHTING_VIEW_DIRECTION,
      }),
    }),
  });
  return Object.freeze({
    contract,
    imageBytes,
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeCatalog() {
  const entries = await readdir(cssGraphicsModelsRoot, { withFileTypes: true });
  const modelRoots = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(cssGraphicsModelsRoot, entry.name))
    .sort();
  const catalog = await buildCssGraphicsCatalog({ modelRoots });
  const target = resolve(cssGraphicsRoot, "catalog.json");
  const staging = `${target}.next-${process.pid}`;
  try {
    await writeFile(staging, catalog.bytes);
    await rename(staging, target);
  } finally {
    await rm(staging, { force: true });
  }
  return catalog;
}

async function writePolyMorphPackage(model, fallbackBytes) {
  const built = await buildPolyMorphPackage(model, [{
    path: TRIANGLE_FALLBACK_RESOURCE_PATH,
    role: "image",
    mediaType: "image/webp",
    bytes: fallbackBytes,
  }]);
  await replaceGeneratedOutput({
    target: polyMorphOutputRoot,
    prefix: ".facesjs-poly-morph-package-",
    build: async (stagingRoot) => {
      for (const [path, bytes] of [...built.files].sort(([left], [right]) =>
        left.localeCompare(right))) {
        const target = resolve(stagingRoot, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      await writeFile(resolve(stagingRoot, "manifest.json"), built.manifestBytes);
      return built;
    },
  });
  return built;
}

async function writePolyMorphCatalog() {
  const entries = await readdir(polyMorphModelsRoot, { withFileTypes: true });
  const packages = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const manifestPath = `models/${entry.name}/manifest.json`;
    const manifestBytes = await readFile(resolve(polyMorphRoot, manifestPath));
    packages.push({
      manifest: JSON.parse(manifestBytes.toString("utf8")),
      manifestPath,
      manifestSha256: sha256(manifestBytes),
    });
  }
  const defaultId = PRESETS[0]?.modelId;
  if (!defaultId) throw new Error("FacesJS needs a default PolyCSS model.");
  const catalog = await buildPolyMorphCatalog(defaultId, packages);
  const target = resolve(polyMorphRoot, "catalog.json");
  const staging = `${target}.next-${process.pid}`;
  try {
    await writeFile(staging, catalog.bytes);
    await rename(staging, target);
  } finally {
    await rm(staging, { force: true });
  }
  return catalog;
}

async function main() {
  const { hairWeld, primitives, quadAuthoring } = buildFaceGeometry();
  const { gltf, polygonCount, quadPairs, vertexCount } = buildGltf(primitives);
  const config = buildPrepareConfig(polygonCount, vertexCount);
  const gltfPath = resolve(sourceRoot, MODEL_SOURCE_FILENAME);
  const configPath = resolve(sourceRoot, "prepare.json");
  const copiedFaceConfigPath = resolve(sourceRoot, "face.json");
  await mkdir(sourceRoot, { recursive: true });
  await Promise.all([
    writeFile(gltfPath, `${JSON.stringify(gltf)}\n`),
    writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`),
    writeFile(copiedFaceConfigPath, `${JSON.stringify(FACE, null, 2)}\n`),
  ]);
  const report = await preparePolyMorphModel({
    configPath,
    outputRoot: morphOutputRoot,
  });
  const preparedWeld = weldPreparedHairFacelineVertices(report.model, hairWeld);
  const optimized = optimizePreparedQuads(
    preparedWeld.model,
    quadPairs,
    quadAuthoring,
  );
  const optimizedCrossMaterialSeamEdges = preparedHairFacelineEdgeCount(
    optimized.model,
  );
  if (optimizedCrossMaterialSeamEdges !== hairWeld.seamEdges) {
    throw new Error(
      `FacesJS optimized hair weld has ${optimizedCrossMaterialSeamEdges} cross-material edges; expected ${hairWeld.seamEdges}.`,
    );
  }
  const hairFacelineWeld = Object.freeze({
    ...hairWeld,
    prepared: Object.freeze({
      ...preparedWeld.metrics,
      optimizedCrossMaterialSeamEdges,
    }),
  });
  const model = bindTriangleFallback(optimized.model);
  const fallbackResource = report.manifest.resources.find(
    ({ mediaType, role }) => mediaType === "image/png" && role === "image",
  );
  if (!fallbackResource) {
    throw new Error("FacesJS Morph preparation emitted no triangle fallback atlas.");
  }
  const fallbackPng = await readFile(resolve(morphOutputRoot, fallbackResource.path));
  const fallbackWebp = await sharp(fallbackPng)
    .webp({ lossless: true, effort: 6 })
    .toBuffer();
  const polyMorphPackage = await writePolyMorphPackage(model, fallbackWebp);
  const lighting = await buildRotationLighting(model);
  const source = Object.freeze({
    schema: "cssgraphics.facesjs-source@1",
    license: "mixed",
    faceConfig: FACE,
    faceline: Object.freeze({
      index: FACELINE.index,
      source: "RFL_Res.dat",
      sourceSha256: FACELINE.sourceSha256,
      sourceVersion: FACELINE.sourceVersion,
      topology: Object.freeze({
        polygons: FACELINE.triangles.length,
        vertices: FACELINE.points.length,
      }),
    }),
    facesJs: Object.freeze({
      revision: SOURCE_REVISION,
      uri: `https://github.com/zengm-games/facesjs/tree/${SOURCE_REVISION}/svgs`,
      license: "Apache-2.0",
    }),
    svg: Object.freeze({
      sha256: SOURCE_SVG_SHA256,
      parts: Object.freeze(Object.fromEntries(Object.keys(SOURCE_SVG_FRAGMENTS).map((part) => [
        part,
        FACE[part].id,
      ]))),
    }),
    generatedGltf: Object.freeze({
      bytes: report.source.sourceBytes,
      sha256: report.source.sourceSha256,
      contentSha256: report.source.contentSha256,
    }),
    hairFacelineWeld,
  });
  const scene = Object.freeze({
    schema: FACES_JS_SCENE_SCHEMA,
    id: model.identity.id,
    artifactMode: "prepared-polycss-morph",
    faceConfig: FACE,
    faceline: Object.freeze({ index: FACELINE.index }),
    hairFacelineWeld,
    model,
    rotationLighting: lighting.contract,
    metrics: optimized.metrics,
  });
  const generationHash = await cssGraphicsContentHash({
    schema: "cssgraphics.facesjs-generation@1",
    source,
    scene,
    triangleFallbackSha256: sha256(fallbackWebp),
    rotationLightingSha256: sha256(lighting.imageBytes),
  });
  const css = `
[data-cssgraphics-model="${model.identity.id}"] .polycss-morph-leaf {
  background-repeat: no-repeat;
  backface-visibility: visible;
  transform-origin: 0 0;
}

[data-cssgraphics-model="${model.identity.id}"] b.polycss-morph-leaf {
  background-color: currentColor;
}
`.trimStart();
  let packaged;
  await replaceGeneratedOutput({
    target: outputRoot,
    prefix: ".facesjs-package-",
    build: async (stagingRoot) => {
      packaged = await writeCssGraphicsModelPackage({
        outputRoot: stagingRoot,
        id: model.identity.id,
        name: model.identity.name,
        profile: FACES_JS_PROFILE,
        features: [
          "faceconfig-morphs",
          "facesjs-shoulders",
          "facesjs-svg-geometry",
          "hair-faceline-weld",
          "prepared-lighting",
          "retained-dom",
          "rom-backed-faceline",
          ROTATION_LIGHTING_ASSET_ROLE,
          "solid-quads",
          "source-provenance",
          TRIANGLE_FALLBACK_ASSET_ROLE,
        ],
        generationHash,
        codecId: CSSGRAPHICS_GENERIC_JSON_CODEC_ID,
        sections: {
          provenance: source,
          scene,
        },
        css,
        assets: [{
          role: ROTATION_LIGHTING_ASSET_ROLE,
          bytes: lighting.imageBytes,
        }, {
          role: TRIANGLE_FALLBACK_ASSET_ROLE,
          bytes: fallbackWebp,
        }],
      });
      return packaged;
    },
  });
  const catalog = await writeCatalog();
  const polyMorphCatalog = await writePolyMorphCatalog();
  console.log(JSON.stringify({
    model: model.identity.id,
    profile: FACES_JS_PROFILE,
    vertices: model.topology.vertices.length,
    polygons: model.topology.polygons.length,
    leaves: model.render.leaves.length,
    strategies: {
      b: optimized.metrics.mergedQuads,
      u: optimized.metrics.retainedTriangles,
    },
    optimization: optimized.metrics,
    hairFacelineWeld,
    targets: model.deformation.kind === "morph-regions"
      ? model.deformation.targets.map(({ id }) => id)
      : [],
    manifest: packaged.manifest.contentHash,
    rotationLighting: {
      states: lighting.contract.state.spinSteps,
      atlas: `${lighting.contract.atlas.width}x${lighting.contract.atlas.height}`,
      bytes: lighting.imageBytes.byteLength,
      sparseWrites: {
        mean: lighting.contract.transitions.meanChangedFaces,
        p50: lighting.contract.transitions.p50ChangedFaces,
        p95: lighting.contract.transitions.p95ChangedFaces,
        max: lighting.contract.transitions.maximumChangedFaces,
      },
    },
    catalog: {
      path: resolve(cssGraphicsRoot, "catalog.json"),
      models: catalog.catalog.models.length,
    },
    polyMorph: {
      manifest: polyMorphPackage.manifestSha256,
      catalog: resolve(polyMorphRoot, "catalog.json"),
      models: polyMorphCatalog.catalog.packages.length,
    },
    outputRoot,
  }, null, 2));
}

await main();
