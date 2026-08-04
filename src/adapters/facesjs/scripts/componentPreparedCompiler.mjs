import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  compilePolyMorphSource,
  parsePolyMorphPrepareConfig,
} from "@layoutit/polycss-morph/prepare";

import {
  horizontalSpanAtY,
  parseSvgFragment,
} from "./svgGeometry.mjs";
import {
  FACES_JS_HEAD_NECK_JUNCTION_SOURCE_Y,
} from "./weldedBustCompiler.mjs";
import {
  compileFacesJsComponentRotationLighting,
  FACES_JS_COMPONENT_ROTATION_DIFFUSE_ROLE,
  FACES_JS_COMPONENT_ROTATION_SPECULAR_ROLE,
} from "./rotationLightingCompiler.mjs";

export const FACES_JS_PREPARED_COMPONENT_SCHEMA =
  "cssface.facesjs-prepared-component@1";

const SOURCE_REVISION = "92c91d4b67893dbeef4053c25c04cc01fdd5419a";
const MODEL_SCALE = 120;
const SVG_FACE_X_SCALE = 1.07 / 150;
const SVG_FACE_Z_SCALE = (1.48 - -0.99) / 400;
const BODY_HEAD_OCCLUSION_SOURCE_Y = 500;
export const FACES_JS_BODY_NECK_OPENING_SOURCE_Y = 480;
const IDENTITY_MATRIX = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);
const MATERIAL_COLORS = Object.freeze({
  skin: Object.freeze([0.68, 0.39, 0.32, 1]),
  hair: Object.freeze([0.15, 0.14, 0.13, 1]),
  "head-shave": Object.freeze([0, 0, 0, 1]),
  "face-shave": Object.freeze([0, 0, 0, 1]),
  "team-primary": Object.freeze([0.54, 0.75, 0.83, 1]),
  "team-secondary": Object.freeze([0.48, 0.07, 0.10, 1]),
  "team-accent": Object.freeze([0.03, 0.21, 0.31, 1]),
  "eye-white": Object.freeze([1, 1, 1, 1]),
  "eye-off-white": Object.freeze([0.96, 0.95, 0.93, 1]),
  ink: Object.freeze([0, 0, 0, 1]),
  "mouth-dark": Object.freeze([0.31, 0.08, 0.08, 1]),
  blush: Object.freeze([0.63, 0.34, 0.34, 1]),
  freckle: Object.freeze([0.55, 0.38, 0.21, 1]),
  "frame-dark": Object.freeze([0.2, 0.2, 0.2, 1]),
  lens: Object.freeze([0.59, 0.59, 0.69, 0.5]),
  highlight: Object.freeze([1, 1, 1, 1]),
  "jersey-white": Object.freeze([1, 1, 1, 1]),
  "accessory-red": Object.freeze([0.9, 0, 0.01, 1]),
  "accessory-white": Object.freeze([0.93, 0.92, 0.94, 1]),
  "accessory-translucent-ink": Object.freeze([0, 0, 0, 0.53]),
  "hair-fade": Object.freeze([0.15, 0.14, 0.13, 1]),
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedId(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase();
}

function rounded(value) {
  const output = Number(value.toFixed(10));
  return Object.is(output, -0) ? 0 : output;
}

function vectorDelta(target, base) {
  return target.map((value, index) => rounded(value - base[index]));
}

function createHeadProfile(fragment) {
  const contour = parseSvgFragment(fragment)
    .flatMap((path) => path.subpaths)
    .find(({ points }) => points.length >= 3)?.points;
  if (!contour) throw new TypeError("FacesJS prepared components require head1 contour geometry.");
  return Object.freeze({
    contour,
    minimumY: Math.min(...contour.map((point) => point[1])),
    maximumY: Math.max(...contour.map((point) => point[1])),
  });
}

function surfacePoint(source, fatness, profile, lift, clampToProfile) {
  let span = horizontalSpanAtY(profile.contour, source[1]);
  if (!span && clampToProfile) {
    const inset = 1e-4;
    span = horizontalSpanAtY(
      profile.contour,
      Math.min(profile.maximumY - inset, Math.max(profile.minimumY + inset, source[1])),
    );
  }
  if (!span) {
    throw new RangeError(`FacesJS prepared point ${source.join(",")} is outside head1.`);
  }
  const center = (span[0] + span[1]) * 0.5;
  const radius = (span[1] - span[0]) * 0.5;
  const widthScale = 0.8 + (0.2 * fatness);
  const normalized = Math.min(
    Math.abs(source[0] - center) / (radius * widthScale),
    1 - 1e-7,
  );
  const depth = radius * SVG_FACE_X_SCALE * 0.755;
  return Object.freeze([
    rounded((source[0] - 200) * SVG_FACE_X_SCALE),
    rounded(-(depth * Math.sqrt(1 - (normalized * normalized))) - lift),
    rounded(1.48 - ((source[1] - 100) * SVG_FACE_Z_SCALE)),
  ]);
}

function projectedRows(geometry, headFragment) {
  const profile = createHeadProfile(headFragment);
  const clampToProfile = geometry.attachmentProjection !== "strict-head-surface";
  const rows = [];
  for (const instance of geometry.instances) {
    for (const triangle of instance.triangles) {
      const hasExplicitFatness = Boolean(triangle.states.fatness);
      const basePositions = triangle.points.map((point) =>
        surfacePoint(point, 0, profile, triangle.surfaceLift, clampToProfile));
      const states = {};
      const fatnessSource = triangle.states.fatness ?? triangle.points;
      states.fatness = fatnessSource.map((point) =>
        surfacePoint(point, 1, profile, triangle.surfaceLift, clampToProfile));
      for (const [stateId, sourcePoints] of Object.entries(triangle.states)) {
        if (stateId === "fatness") continue;
        states[stateId] = sourcePoints.map((point) =>
          surfacePoint(point, 0, profile, triangle.surfaceLift, clampToProfile));
        const interactionId = `${stateId}-fatness`;
        states[interactionId] = sourcePoints.map((point, index) => {
          const combined = surfacePoint(
            point,
            1,
            profile,
            triangle.surfaceLift,
            clampToProfile,
          );
          const base = basePositions[index];
          const fatnessDelta = vectorDelta(states.fatness[index], base);
          const stateDelta = vectorDelta(states[stateId][index], base);
          return combined.map((value, axis) =>
            rounded(value - fatnessDelta[axis] - stateDelta[axis]));
        });
      }
      if (hasExplicitFatness) {
        delete states["fatness-fatness"];
      }
      rows.push(Object.freeze({
        visibilityMode: "front",
        materialRole: triangle.material.role,
        positions: Object.freeze(basePositions),
        states: Object.freeze(states),
      }));
    }
  }
  return rows;
}

function meshVisibilityMode(geometry, triangle, vertices) {
  if (geometry.family === "jersey") return "front";
  if (geometry.family === "body") {
    const sourceY = triangle.indices.reduce((sum, index) =>
      sum + vertices[index].source[1], 0) / triangle.indices.length;
    if (sourceY < BODY_HEAD_OCCLUSION_SOURCE_Y) return "front";
  }
  return "radial";
}

function meshRows(geometry) {
  const vertices = geometry.mesh.vertices;
  return geometry.mesh.triangles.filter(({ render }) => render !== false).map((triangle) => ({
    visibilityMode: meshVisibilityMode(geometry, triangle, vertices),
    materialRole: triangle.materialRole ?? triangle.material?.role,
    positions: triangle.indices.map((index) => vertices[index].position),
    states: Object.fromEntries(geometry.stateIds.map((stateId) => [
      stateId,
      triangle.indices.map((index) =>
        vertices[index].states?.[stateId] ?? vertices[index].position),
    ])),
  }));
}

const STRUCTURED_RUNTIME_RING_LIMITS = Object.freeze({
  body: 9,
  head: 13,
});
const RUNTIME_GRID_ROW_LIMIT = 12;
const RUNTIME_GRID_COLUMN_LIMIT = 12;

function evenlySpacedIndices(count, limit) {
  if (count <= limit) return Array.from({ length: count }, (_, index) => index);
  const output = [];
  for (let index = 0; index < limit; index += 1) {
    const selected = Math.round(index * (count - 1) / (limit - 1));
    if (output.at(-1) !== selected) output.push(selected);
  }
  return output;
}

function includingIndex(indices, required) {
  if (indices.includes(required)) return indices;
  let replacement = 0;
  for (let index = 1; index < indices.length; index += 1) {
    if (Math.abs(indices[index] - required) < Math.abs(indices[replacement] - required)) {
      replacement = index;
    }
  }
  return indices.map((value, index) => index === replacement ? required : value)
    .sort((left, right) => left - right);
}

function structuredMeshRows(geometry) {
  const vertices = geometry.mesh.vertices;
  const triangles = geometry.mesh.triangles;
  if (triangles.some(({ render }) => render === false)) return null;
  const firstPoleTriangles = triangles.filter(({ indices }) => indices.includes(0));
  const radialSegments = firstPoleTriangles.length;
  const internalRingCount = (vertices.length - 2) / radialSegments;
  const materialRoles = [...new Set(triangles.map((triangle) =>
    triangle.materialRole ?? triangle.material?.role))];
  const ringLimit = STRUCTURED_RUNTIME_RING_LIMITS[geometry.family];
  if (!ringLimit || materialRoles.length !== 1 || radialSegments < 3
    || !Number.isSafeInteger(internalRingCount)
    || triangles.length !== radialSegments * internalRingCount * 2) {
    return null;
  }
  const radialLimit = Math.min(12, radialSegments);
  const radialIndices = evenlySpacedIndices(radialSegments, radialLimit);
  const availableRingIndices = Array.from(
    { length: internalRingCount },
    (_, index) => index,
  ).filter((ringIndex) => geometry.family !== "body"
    || vertices[1 + (ringIndex * radialSegments)].source[1]
      >= FACES_JS_BODY_NECK_OPENING_SOURCE_Y);
  if (availableRingIndices.length < 2) return null;
  let selectedRingIndices = evenlySpacedIndices(availableRingIndices.length, ringLimit);
  if (geometry.family === "head") {
    const requiredRingIndex = availableRingIndices.findIndex((ringIndex) =>
      Math.abs(vertices[1 + (ringIndex * radialSegments)].source[1]
        - FACES_JS_HEAD_NECK_JUNCTION_SOURCE_Y) <= 1e-7);
    if (requiredRingIndex < 0) {
      throw new RangeError(
        `FacesJS head.${geometry.sourceId} has no welded neck junction row.`,
      );
    }
    selectedRingIndices = includingIndex(selectedRingIndices, requiredRingIndex);
  }
  const ringIndices = selectedRingIndices.map((index) => availableRingIndices[index]);
  const firstTriangle = triangles[0].indices;
  const forward = firstTriangle[1] === 1;
  const finalPole = vertices.length - 1;
  const vertexAt = (ringIndex, radialIndex) =>
    1 + (ringIndex * radialSegments) + radialIndex;
  const row = (indices) => ({
    visibilityMode: meshVisibilityMode(geometry, { indices }, vertices),
    materialRole: materialRoles[0],
    positions: indices.map((index) => vertices[index].position),
    states: Object.fromEntries(geometry.stateIds.map((stateId) => [
      stateId,
      indices.map((index) =>
        vertices[index].states?.[stateId] ?? vertices[index].position),
    ])),
  });
  const output = [];
  if (geometry.family !== "body") {
    for (let radialIndex = 0; radialIndex < radialIndices.length; radialIndex += 1) {
      const left = radialIndices[radialIndex];
      const right = radialIndices[(radialIndex + 1) % radialIndices.length];
      const firstLeft = vertexAt(ringIndices[0], left);
      const firstRight = vertexAt(ringIndices[0], right);
      output.push(row(forward
        ? [0, firstLeft, firstRight]
        : [0, firstRight, firstLeft]));
    }
  }
  for (let ringIndex = 0; ringIndex < ringIndices.length - 1; ringIndex += 1) {
    const topRing = ringIndices[ringIndex];
    const bottomRing = ringIndices[ringIndex + 1];
    for (let radialIndex = 0; radialIndex < radialIndices.length; radialIndex += 1) {
      const left = radialIndices[radialIndex];
      const right = radialIndices[(radialIndex + 1) % radialIndices.length];
      const topLeft = vertexAt(topRing, left);
      const topRight = vertexAt(topRing, right);
      const bottomLeft = vertexAt(bottomRing, left);
      const bottomRight = vertexAt(bottomRing, right);
      output.push(row(forward
        ? [topLeft, bottomLeft, bottomRight]
        : [topLeft, bottomRight, bottomLeft]));
      output.push(row(forward
        ? [topLeft, bottomRight, topRight]
        : [topLeft, topRight, bottomRight]));
    }
  }
  const lastRing = ringIndices.at(-1);
  for (let radialIndex = 0; radialIndex < radialIndices.length; radialIndex += 1) {
    const left = radialIndices[radialIndex];
    const right = radialIndices[(radialIndex + 1) % radialIndices.length];
    const lastLeft = vertexAt(lastRing, left);
    const lastRight = vertexAt(lastRing, right);
    output.push(row(forward
      ? [lastLeft, finalPole, lastRight]
      : [finalPole, lastRight, lastLeft]));
  }
  return output;
}

function sameCyclicTriangle(left, right) {
  return left.length === 3 && right.length === 3
    && [0, 1, 2].some((offset) => left.every(
      (value, index) => value === right[(index + offset) % 3],
    ));
}

function rearLongHairMeshRows(geometry) {
  if ((geometry.family !== "hair" && geometry.family !== "hairBg")
    || !geometry.mesh?.vertices
    || !geometry.mesh?.triangles) return null;
  const vertices = geometry.mesh.vertices;
  const renderedTriangles = geometry.mesh.triangles.filter(
    ({ render }) => render !== false,
  );
  if (renderedTriangles.length === 0
    || renderedTriangles.some(({ surface }) => surface !== "rear")
    || !geometry.mesh.triangles.some(({ render }) => render === false)) return null;
  const materialRoles = [...new Set(renderedTriangles.map((triangle) =>
    triangle.materialRole ?? triangle.material?.role))];
  if (materialRoles.length !== 1) return null;
  const usedIndices = new Set(renderedTriangles.flatMap(({ indices }) => indices));
  const rowsByY = new Map();
  for (const vertexIndex of usedIndices) {
    const source = vertices[vertexIndex].source;
    if (!Array.isArray(source) || source.length !== 2) return null;
    const key = source[1].toFixed(8);
    const row = rowsByY.get(key) ?? [];
    row.push(vertexIndex);
    rowsByY.set(key, row);
  }
  const sourceRows = [...rowsByY.values()]
    .map((indices) => indices.sort((left, right) =>
      vertices[left].source[0] - vertices[right].source[0]))
    .sort((left, right) =>
      vertices[left[0]].source[1] - vertices[right[0]].source[1]);
  const widths = [...new Set(sourceRows.filter(({ length }) => length > 1)
    .map(({ length }) => length))];
  if (sourceRows.length < 3 || widths.length !== 1 || widths[0] < 3
    || sourceRows.some(({ length }) => length !== 1 && length !== widths[0])) return null;
  const first = sourceRows[0];
  const second = sourceRows[1];
  if (first.length !== 1 || second.length < 2) return null;
  const forwardTriangle = [first[0], second[0], second[1]];
  const reverseTriangle = [first[0], second[1], second[0]];
  const sourceFirstTriangle = renderedTriangles[0].indices;
  const reverse = sameCyclicTriangle(sourceFirstTriangle, reverseTriangle)
    ? true
    : sameCyclicTriangle(sourceFirstTriangle, forwardTriangle) ? false : null;
  if (reverse === null) return null;
  const selectedRows = evenlySpacedIndices(sourceRows.length, RUNTIME_GRID_ROW_LIMIT)
    .map((index) => sourceRows[index]);
  const selectedColumns = evenlySpacedIndices(
    widths[0],
    RUNTIME_GRID_COLUMN_LIMIT,
  );
  const reducedRows = selectedRows.map((indices) => indices.length === 1
    ? indices
    : selectedColumns.map((index) => indices[index]));
  const row = (indices) => ({
    visibilityMode: "radial",
    materialRole: materialRoles[0],
    positions: indices.map((index) => vertices[index].position),
    states: Object.fromEntries(geometry.stateIds.map((stateId) => [
      stateId,
      indices.map((index) =>
        vertices[index].states?.[stateId] ?? vertices[index].position),
    ])),
  });
  const append = (output, indices) => output.push(row(reverse
    ? [indices[0], indices[2], indices[1]]
    : indices));
  const output = [];
  for (let rowIndex = 0; rowIndex < reducedRows.length - 1; rowIndex += 1) {
    const top = reducedRows[rowIndex];
    const bottom = reducedRows[rowIndex + 1];
    if (top.length === 1) {
      for (let column = 0; column < bottom.length - 1; column += 1) {
        append(output, [top[0], bottom[column], bottom[column + 1]]);
      }
      continue;
    }
    if (bottom.length === 1) {
      for (let column = 0; column < top.length - 1; column += 1) {
        append(output, [top[column], bottom[0], top[column + 1]]);
      }
      continue;
    }
    for (let column = 0; column < top.length - 1; column += 1) {
      append(output, [top[column], bottom[column], bottom[column + 1]]);
      append(output, [top[column], bottom[column + 1], top[column + 1]]);
    }
  }
  return output;
}

function gridShellMeshRows(geometry) {
  const supportedGrid = geometry.family === "hair"
    || (geometry.family === "accessories"
      && (geometry.kind === "hat" || geometry.kind === "headband"));
  if (!supportedGrid || !geometry.mesh?.vertices
    || !geometry.mesh?.triangles?.some(({ render }) => render === false)) {
    return null;
  }
  const vertices = geometry.mesh.vertices;
  const triangles = geometry.mesh.triangles;
  const frontTriangles = triangles.filter(({ render, surface }) =>
    render !== false && surface !== "side");
  const hiddenTriangles = triangles.filter(({ render }) => render === false);
  const materialRoles = [...new Set(triangles.map((triangle) =>
    triangle.materialRole ?? triangle.material?.role))];
  if (frontTriangles.length < 2 || hiddenTriangles.length === 0
    || materialRoles.length !== 1) return null;
  const firstIndices = frontTriangles[0].indices;
  const differences = [...new Set(firstIndices.flatMap((left, leftIndex) =>
    firstIndices.slice(leftIndex + 1).map((right) => Math.abs(right - left))))]
    .filter((value) => value > 1)
    .sort((left, right) => left - right);
  const rowWidth = differences[0];
  const surfaceVertexCount = Math.min(...hiddenTriangles.flatMap(({ indices }) => indices));
  if (!Number.isSafeInteger(rowWidth) || rowWidth < 3
    || surfaceVertexCount % rowWidth !== 0
    || vertices.length !== surfaceVertexCount * 2) return null;
  const rowCount = surfaceVertexCount / rowWidth;
  const selectedRows = evenlySpacedIndices(rowCount, RUNTIME_GRID_ROW_LIMIT);
  const selectedColumns = evenlySpacedIndices(
    rowWidth,
    RUNTIME_GRID_COLUMN_LIMIT,
  );
  const vertexAt = (surface, row, column) =>
    (surface * surfaceVertexCount) + (row * rowWidth) + column;
  const row = (indices) => ({
    visibilityMode: "radial",
    materialRole: materialRoles[0],
    positions: indices.map((index) => vertices[index].position),
    states: Object.fromEntries(geometry.stateIds.map((stateId) => [
      stateId,
      indices.map((index) =>
        vertices[index].states?.[stateId] ?? vertices[index].position),
    ])),
  });
  const output = [];
  for (let rowIndex = 0; rowIndex < selectedRows.length - 1; rowIndex += 1) {
    const top = selectedRows[rowIndex];
    const bottom = selectedRows[rowIndex + 1];
    for (let columnIndex = 0;
      columnIndex < selectedColumns.length - 1;
      columnIndex += 1) {
      const left = selectedColumns[columnIndex];
      const right = selectedColumns[columnIndex + 1];
      const topLeft = vertexAt(0, top, left);
      const topRight = vertexAt(0, top, right);
      const bottomLeft = vertexAt(0, bottom, left);
      const bottomRight = vertexAt(0, bottom, right);
      output.push(
        row([topLeft, bottomRight, bottomLeft]),
        row([topLeft, topRight, bottomRight]),
      );
    }
  }
  const perimeter = [
    ...selectedColumns.map((column) => [selectedRows[0], column]),
    ...selectedRows.slice(1).map((selectedRow) =>
      [selectedRow, selectedColumns.at(-1)]),
    ...selectedColumns.slice(0, -1).reverse().map((column) =>
      [selectedRows.at(-1), column]),
    ...selectedRows.slice(1, -1).reverse().map((selectedRow) =>
      [selectedRow, selectedColumns[0]]),
  ];
  for (let index = 0; index < perimeter.length; index += 1) {
    const [firstRow, firstColumn] = perimeter[index];
    const [secondRow, secondColumn] = perimeter[(index + 1) % perimeter.length];
    const frontFirst = vertexAt(0, firstRow, firstColumn);
    const frontSecond = vertexAt(0, secondRow, secondColumn);
    const rearFirst = vertexAt(1, firstRow, firstColumn);
    const rearSecond = vertexAt(1, secondRow, secondColumn);
    output.push(
      row([frontFirst, rearSecond, frontSecond]),
      row([frontFirst, rearFirst, rearSecond]),
    );
  }
  return output;
}

function instanceMeshRows(geometry) {
  return geometry.instances.flatMap((instance) => instance.triangles.map((triangle) => ({
    visibilityMode: "radial",
    materialRole: triangle.materialRole ?? triangle.material?.role,
    positions: triangle.indices.map((index) => instance.vertices[index].position),
    states: Object.fromEntries(geometry.stateIds.map((stateId) => [
      stateId,
      triangle.indices.map((index) =>
        instance.vertices[index].states?.[stateId] ?? instance.vertices[index].position),
    ])),
  })));
}

function paintRows(geometry) {
  if (geometry.family === "hairBg") return [];
  const paint = geometry.frontPaint
    ?? geometry.surfacePaint
    ?? geometry.surfaceDetails
    ?? [];
  return paint.map((triangle) => ({
    visibilityMode: "front",
    materialRole: triangle.material.role,
    positions: triangle.vertices.map((vertex) => vertex.position),
    states: Object.fromEntries(geometry.stateIds.map((stateId) => [
      stateId,
      triangle.vertices.map((vertex) =>
        vertex.states?.[stateId] ?? vertex.position),
    ])),
  }));
}

function triangleAreaSquared([left, middle, right]) {
  const first = middle.map((value, axis) => value - left[axis]);
  const second = right.map((value, axis) => value - left[axis]);
  const cross = [
    (first[1] * second[2]) - (first[2] * second[1]),
    (first[2] * second[0]) - (first[0] * second[2]),
    (first[0] * second[1]) - (first[1] * second[0]),
  ];
  return cross.reduce((sum, value) => sum + (value * value), 0) * 0.25;
}

function preparedRows(rows, geometry) {
  const output = rows.filter(({ positions }) => triangleAreaSquared(positions) > 1e-20);
  if (output.length === 0 && !geometry.empty) {
    throw new RangeError(
      `FacesJS component ${geometry.family}.${geometry.sourceId} has no non-degenerate runtime cells.`,
    );
  }
  return output;
}

function geometryRows(geometry, headFragment) {
  if (geometry.mesh?.vertices && geometry.mesh?.triangles) {
    return preparedRows([
      ...(rearLongHairMeshRows(geometry)
        ?? gridShellMeshRows(geometry)
        ?? structuredMeshRows(geometry)
        ?? meshRows(geometry)),
      ...paintRows(geometry),
    ], geometry);
  }
  if (geometry.instances?.[0]?.vertices) {
    return preparedRows(instanceMeshRows(geometry), geometry);
  }
  if (Array.isArray(geometry.instances)) {
    return preparedRows(projectedRows(geometry, headFragment), geometry);
  }
  throw new TypeError(`FacesJS component ${geometry.family}.${geometry.sourceId} has no prepared geometry rows.`);
}

function gltfSource(geometry, rows) {
  const materialGroups = [...new Map(rows.map((row) => {
    const key = `${row.materialRole}--${row.visibilityMode}`;
    return [key, Object.freeze({
      key,
      role: row.materialRole,
      visibilityMode: row.visibilityMode,
    })];
  })).values()].sort((left, right) => left.key.localeCompare(right.key));
  for (const group of materialGroups) {
    if (!group.role || !MATERIAL_COLORS[group.role]) {
      throw new TypeError(`FacesJS component material role ${group.role} has no prepared color.`);
    }
  }
  const stateIds = [...new Set(rows.flatMap(({ states }) => Object.keys(states)))]
    .filter((stateId) => rows.some((row) => {
      const target = row.states[stateId] ?? row.positions;
      return target.some((position, vertexIndex) =>
        vectorDelta(position, row.positions[vertexIndex]).some((value) => Math.abs(value) > 1e-12));
    }))
    .sort();
  const materials = materialGroups.map((group, sourceIndex) => ({
    sourceIndex,
    name: group.key,
    color: MATERIAL_COLORS[group.role],
  }));
  const primitives = materialGroups.map((group, primitiveIndex) => {
    const selectedRows = rows.filter((row) =>
      row.materialRole === group.role && row.visibilityMode === group.visibilityMode);
    const positions = [];
    const targetPositions = Object.fromEntries(stateIds.map((stateId) => [stateId, []]));
    const vertexIndices = new Map();
    const triangles = selectedRows.map((row) => row.positions.map((position, vertexIndex) => {
      const states = Object.fromEntries(stateIds.map((stateId) => [
        stateId,
        row.states[stateId]?.[vertexIndex] ?? position,
      ]));
      const key = JSON.stringify([position, ...stateIds.map((stateId) => states[stateId])]);
      let index = vertexIndices.get(key);
      if (index === undefined) {
        index = positions.length;
        vertexIndices.set(key, index);
        positions.push(position);
        for (const stateId of stateIds) targetPositions[stateId].push(states[stateId]);
      }
      return index;
    }));
    return Object.freeze({
      primitiveIndex,
      materialIndex: primitiveIndex,
      positions,
      triangles,
      targets: stateIds.map((name, index) => Object.freeze({
        index,
        name,
        positionDeltas: targetPositions[name].map((position, vertexIndex) =>
          vectorDelta(position, positions[vertexIndex])),
      })),
    });
  });
  return Object.freeze({
    materialGroups,
    stateIds,
    source: Object.freeze({
      format: "gltf",
      sourceBytes: Buffer.byteLength(JSON.stringify(geometry)),
      sourceSha256: geometry.sourceSha256,
      contentSha256: geometry.contentHash,
      materials,
      instances: [Object.freeze({
        nodeIndex: 0,
        nodeName: `${geometry.family}-${geometry.sourceId}`,
        meshIndex: 0,
        meshName: `${geometry.family}-${geometry.sourceId}`,
        matrix: IDENTITY_MATRIX,
        primitives,
      })],
    }),
  });
}

function prepareConfig(geometry, stateIds, rows) {
  const id = `${normalizedId(geometry.family)}-${normalizedId(geometry.sourceId)}`;
  const triangleCount = rows.length;
  const vertexCount = triangleCount * 3;
  return parsePolyMorphPrepareConfig({
    schema: "polycss-morph.prepare@1",
    identity: {
      id,
      name: `FacesJS ${geometry.family}.${geometry.sourceId}`,
      revision: "1.0.0",
    },
    profile: stateIds.length > 0 ? "morph-regions" : "static-prepared",
    source: {
      path: `${id}.gltf`,
      id: `${id}-source`,
      kind: "generated",
      uri: `https://github.com/zengm-games/facesjs/tree/${SOURCE_REVISION}/svgs`,
      license: "Apache-2.0",
    },
    transform: {
      axes: ["x", "z", "y"],
      signs: [1, -1, -1],
      scale: MODEL_SCALE,
      center: false,
    },
    morphAliases: Object.fromEntries(stateIds.map((stateId) => [stateId, stateId])),
    controls: [],
    springs: [],
    animations: [],
    budgets: {
      maxVertices: Math.max(1, vertexCount),
      maxPolygons: Math.max(1, triangleCount),
      maxLeaves: Math.max(1, triangleCount),
      maxFrames: 1,
      maxJoints: 1,
      maxResources: 16,
      maxBytes: 64_000_000,
    },
  });
}

function materialBindings(model, materialGroups) {
  if (model.materials.length !== materialGroups.length) {
    throw new Error("FacesJS prepared component material order changed.");
  }
  const roles = Object.freeze(Object.fromEntries(model.materials.map((material, index) => [
    material.id,
    materialGroups[index].role,
  ])));
  const visibilityModes = new Map(model.materials.map((material, index) => [
    material.id,
    materialGroups[index].visibilityMode,
  ]));
  return Object.freeze({ roles, visibilityModes });
}

export async function compileFacesJsPreparedComponent({ geometry, headFragment }) {
  if (geometry.empty) {
    const payload = {
      schema: FACES_JS_PREPARED_COMPONENT_SCHEMA,
      family: geometry.family,
      sourceId: geometry.sourceId,
      sourceSha256: geometry.sourceSha256,
      empty: true,
      model: null,
      materialRoles: {},
      rotationLighting: null,
      resources: {},
    };
    const document = Object.freeze({
      ...payload,
      contentHash: sha256(JSON.stringify(payload)),
    });
    return Object.freeze({
      document,
      preparedBytes: gzipSync(Buffer.from(JSON.stringify(document)), { level: 9, mtime: 0 }),
      assets: Object.freeze({}),
      metrics: Object.freeze({ leaves: 0, vertices: 0 }),
    });
  }
  const rows = geometryRows(geometry, headFragment);
  const { materialGroups, stateIds, source } = gltfSource(geometry, rows);
  let prepared;
  try {
    prepared = await compilePolyMorphSource(
      source,
      prepareConfig(geometry, stateIds, rows),
    );
  } catch (error) {
    throw new Error(
      `FacesJS prepared component ${geometry.family}.${geometry.sourceId} failed.`,
      { cause: error },
    );
  }
  const material = materialBindings(prepared.model, materialGroups);
  const lighting = await compileFacesJsComponentRotationLighting(
    prepared.model,
    material.roles,
    material.visibilityModes,
  );
  const assets = {};
  const resources = {};
  for (const [index, page] of prepared.fallbackAtlasPages.entries()) {
    const role = `fallback-${String(index).padStart(3, "0")}`;
    assets[role] = Object.freeze({
      path: page.path,
      mediaType: "image/png",
      bytes: Buffer.from(page.bytes),
    });
    resources[page.path] = role;
  }
  assets[FACES_JS_COMPONENT_ROTATION_DIFFUSE_ROLE] = Object.freeze({
    path: `assets/${FACES_JS_COMPONENT_ROTATION_DIFFUSE_ROLE}.webp`,
    mediaType: "image/webp",
    bytes: Buffer.from(lighting.diffuseImageBytes),
  });
  assets[FACES_JS_COMPONENT_ROTATION_SPECULAR_ROLE] = Object.freeze({
    path: `assets/${FACES_JS_COMPONENT_ROTATION_SPECULAR_ROLE}.webp`,
    mediaType: "image/webp",
    bytes: Buffer.from(lighting.specularImageBytes),
  });
  const payload = {
    schema: FACES_JS_PREPARED_COMPONENT_SCHEMA,
    family: geometry.family,
    sourceId: geometry.sourceId,
    sourceSha256: geometry.sourceSha256,
    empty: false,
    model: prepared.model,
    materialRoles: material.roles,
    rotationLighting: lighting.contract,
    resources,
  };
  const document = Object.freeze({
    ...payload,
    contentHash: sha256(JSON.stringify(payload)),
  });
  return Object.freeze({
    document,
    preparedBytes: gzipSync(Buffer.from(JSON.stringify(document)), { level: 9, mtime: 0 }),
    assets: Object.freeze(assets),
    metrics: Object.freeze({
      leaves: prepared.model.render.leaves.length,
      vertices: prepared.model.topology.vertices.length,
    }),
  });
}
