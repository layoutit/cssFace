import { createHash } from "node:crypto";

import {
  boundsOfPaths,
  horizontalSpanAtY,
  parseSvgFragment,
  triangulateSvgContour,
} from "./svgGeometry.mjs";
import {
  FACES_JS_HEAD_NECK_JUNCTION_SOURCE_Y,
} from "./weldedBustCompiler.mjs";

export const FACES_JS_SHELL_COMPONENT_SCHEMA = "cssface.facesjs-shell-component@1";
export const FACES_JS_SHELL_FAMILIES = Object.freeze(["ear", "head"]);

const SVG_FACE_X_SCALE = 1.07 / 150;
const SVG_FACE_Z_SCALE = (1.48 - -0.99) / 400;
const MODEL_SCALE = 120;
const HEAD_RADIAL_SEGMENTS = 24;
const HEAD_MINIMUM_VERTICAL_SEGMENTS = 48;
const HEAD_MAXIMUM_ROWS = 512;
const HEAD_SILHOUETTE_TOLERANCE_CSS_PX = 0.75;
const HEAD_FRONT_DEPTH_RATIO = 0.755;
const HEAD_REAR_DEPTH_RATIO = 0.65;
const FACE_WIDTH_MINIMUM = 0.8;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rounded(value) {
  const output = Number(value.toFixed(8));
  return Object.is(output, -0) ? 0 : output;
}

function roundedPoint(point) {
  return Object.freeze(point.map(rounded));
}

function sourceFaceX(value) {
  return (value - 200) * SVG_FACE_X_SCALE;
}

function sourceFaceZ(value) {
  return 1.48 - ((value - 100) * SVG_FACE_Z_SCALE);
}

function cross(left, right) {
  return [
    (left[1] * right[2]) - (left[2] * right[1]),
    (left[2] * right[0]) - (left[0] * right[2]),
    (left[0] * right[1]) - (left[1] * right[0]),
  ];
}

function subtract(left, right) {
  return left.map((value, axis) => value - right[axis]);
}

function triangleArea(points) {
  return Math.hypot(...cross(subtract(points[1], points[0]), subtract(points[2], points[0]))) * 0.5;
}

function signedVolume(vertices, triangles) {
  return triangles.reduce((sum, triangle) => {
    const [first, second, third] = triangle.indices.map((index) => vertices[index].position);
    return sum + ((first[0] * ((second[1] * third[2]) - (second[2] * third[1])))
      - (first[1] * ((second[0] * third[2]) - (second[2] * third[0])))
      + (first[2] * ((second[0] * third[1]) - (second[1] * third[0])))) / 6;
  }, 0);
}

function orientClosedMesh(vertices, triangles) {
  const reverse = signedVolume(vertices, triangles) < 0;
  return triangles.map((triangle) => Object.freeze({
    ...triangle,
    indices: Object.freeze(reverse
      ? [triangle.indices[0], triangle.indices[2], triangle.indices[1]]
      : triangle.indices),
  }));
}

function topologyMetrics(vertices, triangles) {
  const edges = new Map();
  const adjacency = new Map();
  let minimumArea = Infinity;
  for (const triangle of triangles) {
    const points = triangle.indices.map((index) => vertices[index].position);
    minimumArea = Math.min(minimumArea, triangleArea(points));
    for (const [left, right] of [
      [triangle.indices[0], triangle.indices[1]],
      [triangle.indices[1], triangle.indices[2]],
      [triangle.indices[2], triangle.indices[0]],
    ]) {
      const key = left < right ? `${left}:${right}` : `${right}:${left}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
      adjacency.set(left, new Set([...(adjacency.get(left) ?? []), right]));
      adjacency.set(right, new Set([...(adjacency.get(right) ?? []), left]));
    }
  }
  const used = new Set(triangles.flatMap(({ indices }) => indices));
  const visited = new Set();
  const pending = used.size ? [used.values().next().value] : [];
  while (pending.length) {
    const index = pending.pop();
    if (visited.has(index)) continue;
    visited.add(index);
    pending.push(...(adjacency.get(index) ?? []));
  }
  return Object.freeze({
    boundaryEdgeCount: [...edges.values()].filter((count) => count === 1).length,
    nonManifoldEdgeCount: [...edges.values()].filter((count) => count !== 2).length,
    connected: visited.size === used.size,
    minimumTriangleArea: Number(minimumArea.toFixed(14)),
    signedVolume: rounded(signedVolume(vertices, triangles)),
  });
}

function primaryContour(paths, family, sourceId) {
  const contour = paths[0]?.subpaths.find(({ closed, points }) => closed && points.length >= 3)?.points;
  if (!contour) throw new TypeError(`FacesJS ${family}.${sourceId} has no closed primary contour.`);
  return contour;
}

function headRows(contour, verticalSegments, detailed = true) {
  const minimumY = Math.min(...contour.map((point) => point[1]));
  const maximumY = Math.max(...contour.map((point) => point[1]));
  const range = maximumY - minimumY;
  const inset = Math.min(1e-4, range / 10000);
  const edgeOffsets = [
    0.001,
    0.005,
    0.01,
    0.015,
    0.02,
    0.025,
    0.035,
    0.05,
    0.1,
    0.2,
    0.3,
    0.5,
    0.75,
    1,
    1.5,
    2,
    3,
    4,
  ]
    .filter((offset) => offset < range * 0.25);
  const turningYs = contour.flatMap((point, index) => {
    const previous = contour[(index - 1 + contour.length) % contour.length][1];
    const next = contour[(index + 1) % contour.length][1];
    return (point[1] - previous) * (next - point[1]) <= 0 ? [point[1]] : [];
  });
  const sourceRows = [...new Set([
    minimumY,
    maximumY,
    ...(FACES_JS_HEAD_NECK_JUNCTION_SOURCE_Y > minimumY
      && FACES_JS_HEAD_NECK_JUNCTION_SOURCE_Y < maximumY
      ? [FACES_JS_HEAD_NECK_JUNCTION_SOURCE_Y]
      : []),
    ...(detailed
      ? edgeOffsets.flatMap((offset) => [minimumY + offset, maximumY - offset])
      : []),
    ...(detailed
      ? turningYs.flatMap((sourceY) => [sourceY - 1e-4, sourceY + 1e-4])
        .filter((value) => value > minimumY && value < maximumY)
      : []),
    ...Array.from(
      { length: verticalSegments - 1 },
      (_, index) => minimumY + ((range * (index + 1)) / verticalSegments),
    ),
  ])].sort((left, right) => left - right)
    .filter((value, index, values) => index === 0 || value - values[index - 1] > 1e-6);
  const rows = [{
    sourceY: minimumY,
    centerX: horizontalSpanAtY(contour, minimumY + inset)?.reduce((sum, value) => sum + value, 0) / 2,
    radius: 0,
  }];
  for (const sourceY of sourceRows.slice(1, -1)) {
    const span = horizontalSpanAtY(contour, sourceY);
    if (!span) throw new RangeError(`FacesJS head contour has no span at y=${sourceY}.`);
    const radius = (span[1] - span[0]) * 0.5;
    if (radius <= 1e-5) continue;
    rows.push({
      sourceY,
      centerX: (span[0] + span[1]) * 0.5,
      radius,
    });
  }
  const bottomSpan = horizontalSpanAtY(contour, maximumY - inset);
  rows.push({
    sourceY: maximumY,
    centerX: bottomSpan ? (bottomSpan[0] + bottomSpan[1]) * 0.5 : 200,
    radius: 0,
  });
  if (!Number.isFinite(rows[0].centerX)) rows[0].centerX = rows[1].centerX;
  return rows;
}

function silhouetteError(contour, rows) {
  let maximum = 0;
  let sourceYAtMaximum = null;
  for (let rowIndex = 0; rowIndex < rows.length - 1; rowIndex += 1) {
    const first = rows[rowIndex];
    const second = rows[rowIndex + 1];
    if (second.sourceY - first.sourceY < 0.01) continue;
    for (const amount of [0.25, 0.5, 0.75]) {
      const sourceY = first.sourceY + ((second.sourceY - first.sourceY) * amount);
      const span = horizontalSpanAtY(contour, sourceY);
      if (!span) continue;
      const expected = [first.centerX - first.radius, first.centerX + first.radius]
        .map((value, side) => value + (((second.centerX
          + (side === 0 ? -second.radius : second.radius)) - value) * amount));
      const error = Math.max(
        Math.abs(span[0] - expected[0]),
        Math.abs(span[1] - expected[1]),
      );
      if (error > maximum) {
        maximum = error;
        sourceYAtMaximum = sourceY;
      }
    }
  }
  return {
    cssPx: maximum * SVG_FACE_X_SCALE * MODEL_SCALE,
    sourceY: sourceYAtMaximum,
  };
}

function resolvedHeadRows(contour) {
  const rows = headRows(contour, HEAD_MINIMUM_VERTICAL_SEGMENTS);
  while (rows.length <= HEAD_MAXIMUM_ROWS) {
    const error = silhouetteError(contour, rows);
    if (error.cssPx <= HEAD_SILHOUETTE_TOLERANCE_CSS_PX) {
      return { rows, error: error.cssPx };
    }
    const span = horizontalSpanAtY(contour, error.sourceY);
    if (!span || rows.some(({ sourceY }) => Math.abs(sourceY - error.sourceY) <= 1e-7)) {
      break;
    }
    const row = {
      sourceY: error.sourceY,
      centerX: (span[0] + span[1]) * 0.5,
      radius: (span[1] - span[0]) * 0.5,
    };
    const index = rows.findIndex(({ sourceY }) => sourceY > row.sourceY);
    rows.splice(index < 0 ? rows.length - 1 : index, 0, row);
  }
  const error = silhouetteError(contour, rows);
  throw new RangeError(
    `FacesJS head silhouette error ${error.cssPx.toFixed(3)}px at source y=`
    + `${error.sourceY} exceeds ${HEAD_SILHOUETTE_TOLERANCE_CSS_PX}px.`,
  );
}

function headVertex(sourceX, sourceY, depth) {
  const maximum = [sourceFaceX(sourceX), depth, sourceFaceZ(sourceY)];
  const minimum = [...maximum];
  minimum[0] *= FACE_WIDTH_MINIMUM;
  return Object.freeze({
    source: Object.freeze([rounded(sourceX), rounded(sourceY)]),
    position: roundedPoint(minimum),
    states: Object.freeze({ fatness: roundedPoint(maximum) }),
  });
}

function buildHeadMesh(contour, options = {}) {
  const radialSegments = options.radialSegments ?? HEAD_RADIAL_SEGMENTS;
  const resolved = options.verticalSegments === undefined
    ? resolvedHeadRows(contour)
    : {
      rows: headRows(contour, options.verticalSegments, false),
      error: silhouetteError(
        contour,
        headRows(contour, options.verticalSegments, false),
      ).cssPx,
    };
  const { rows, error } = resolved;
  const vertices = [];
  const rowIndices = [];
  for (const [rowIndex, row] of rows.entries()) {
    if (rowIndex === 0 || rowIndex === rows.length - 1) {
      rowIndices.push([vertices.length]);
      vertices.push(headVertex(row.centerX, row.sourceY, 0));
      continue;
    }
    const indices = [];
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = (segment / radialSegments) * Math.PI * 2;
      const sine = Math.sin(angle);
      const sourceX = row.centerX + (Math.cos(angle) * row.radius);
      const depthRatio = sine < 0 ? HEAD_FRONT_DEPTH_RATIO : HEAD_REAR_DEPTH_RATIO;
      const depth = sine * row.radius * SVG_FACE_X_SCALE * depthRatio;
      indices.push(vertices.length);
      vertices.push(headVertex(sourceX, row.sourceY, depth));
    }
    rowIndices.push(indices);
  }

  const triangles = [];
  const append = (indices) => {
    const depth = indices.reduce((sum, index) => sum + vertices[index].position[1], 0) / 3;
    triangles.push({
      indices,
      materialRole: "skin",
      surface: depth <= 0 ? "front" : "rear",
    });
  };
  const top = rowIndices[0][0];
  const firstRing = rowIndices[1];
  for (let segment = 0; segment < radialSegments; segment += 1) {
    append([top, firstRing[segment], firstRing[(segment + 1) % radialSegments]]);
  }
  for (let rowIndex = 1; rowIndex < rowIndices.length - 2; rowIndex += 1) {
    const first = rowIndices[rowIndex];
    const second = rowIndices[rowIndex + 1];
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const next = (segment + 1) % radialSegments;
      append([first[segment], second[segment], second[next]]);
      append([first[segment], second[next], first[next]]);
    }
  }
  const lastRing = rowIndices.at(-2);
  const bottom = rowIndices.at(-1)[0];
  for (let segment = 0; segment < radialSegments; segment += 1) {
    append([lastRing[segment], bottom, lastRing[(segment + 1) % radialSegments]]);
  }
  const orientedTriangles = orientClosedMesh(vertices, triangles);
  const right = 0;
  const left = radialSegments / 2;
  const frontBoundary = [
    top,
    ...rowIndices.slice(1, -1).map((indices) => indices[right]),
    bottom,
    ...rowIndices.slice(1, -1).reverse().map((indices) => indices[left]),
  ];
  return {
    vertices: Object.freeze(vertices),
    triangles: Object.freeze(orientedTriangles),
    frontBoundary: Object.freeze(frontBoundary),
    verticalSegments: rows.length - 1,
    silhouetteErrorCssPx: rounded(error),
  };
}

function headPaintRegions(paths) {
  return Object.freeze(paths.slice(1).flatMap((path, pathOffset) => {
    const fill = path.fill.toLowerCase();
    const role = fill === "$[headshave]"
      ? "head-shave"
      : fill === "$[faceshave]" ? "face-shave" : null;
    if (!role) return [];
    return [Object.freeze({
      sourcePathIndex: pathOffset + 1,
      role,
      fillRule: path.fillRule,
      data: path.data,
    })];
  }));
}

function earVertex(source, depth, position, size) {
  const sourceX = position[0] + ((source[0] - position[2]) * size * position[3]);
  const sourceY = position[1] + ((source[1] - position[4]) * size);
  const maximum = [sourceFaceX(sourceX), depth, sourceFaceZ(sourceY)];
  const minimum = [...maximum];
  minimum[0] *= FACE_WIDTH_MINIMUM;
  return { source: [sourceX, sourceY], position: minimum, maximum };
}

function buildEarInstance(contour, side) {
  const xs = contour.map((point) => point[0]);
  const ys = contour.map((point) => point[1]);
  const centerX = (Math.min(...xs) + Math.max(...xs)) * 0.5;
  const centerY = (Math.min(...ys) + Math.max(...ys)) * 0.5;
  const anchorX = side < 0 ? 55 : 345;
  const anchorY = 325;
  const transform = [anchorX, anchorY, centerX, side < 0 ? 1 : -1, centerY];
  const frontDepth = -0.14;
  const backDepth = 0.08;
  const vertices = [];
  const addVertex = (source, depth) => {
    const base = earVertex(source, depth, transform, 0.5);
    const maximum = earVertex(source, depth, transform, 1.5);
    const index = vertices.length;
    vertices.push(Object.freeze({
      source: roundedPoint(base.source),
      position: roundedPoint(base.position),
      states: Object.freeze({
        "ear-size": roundedPoint(maximum.position),
        fatness: roundedPoint(base.maximum),
        "ear-size-fatness": roundedPoint(maximum.maximum),
      }),
    }));
    return index;
  };
  const front = contour.map((point) => addVertex(point, frontDepth));
  const back = contour.map((point) => addVertex(point, backDepth));
  const triangles = [];
  const capIndices = triangulateSvgContour(contour);
  for (let offset = 0; offset < capIndices.length; offset += 3) {
    const row = capIndices.slice(offset, offset + 3);
    triangles.push({ indices: row.map((index) => front[index]), materialRole: "skin", surface: "front" });
    triangles.push({ indices: row.map((index) => back[index]), materialRole: "skin", surface: "rear" });
  }
  for (let index = 0; index < contour.length; index += 1) {
    const next = (index + 1) % contour.length;
    triangles.push({
      indices: [front[index], front[next], back[next]],
      materialRole: "skin",
      surface: "side",
    }, {
      indices: [front[index], back[next], back[index]],
      materialRole: "skin",
      surface: "side",
    });
  }
  return Object.freeze({
    side: side < 0 ? "left" : "right",
    anchor: Object.freeze([anchorX, anchorY]),
    vertices: Object.freeze(vertices),
    triangles: Object.freeze(orientClosedMesh(vertices, triangles)),
  });
}

function compileHead({ sourceId, sourceSha256, paths }) {
  const contour = primaryContour(paths, "head", sourceId);
  const mesh = buildHeadMesh(contour);
  const paintRegions = headPaintRegions(paths);
  const materialRoles = [
    "skin",
    ...new Set(paintRegions.map(({ role }) => role)),
  ].sort();
  const topology = topologyMetrics(mesh.vertices, mesh.triangles);
  if (!topology.connected || topology.nonManifoldEdgeCount !== 0
    || topology.minimumTriangleArea <= 0 || topology.signedVolume <= 0) {
    throw new RangeError(
      `FacesJS head.${sourceId} shell topology is invalid: ${JSON.stringify(topology)}.`,
    );
  }
  return {
    layer: 4,
    attachment: "head-shell",
    materialRoles,
    empty: false,
    stateIds: ["fatness"],
    provenance: {
      frontSilhouette: "facesjs-svg-contour",
      depthProfile: "adapter-authored-elliptic-sweep",
      rearClosure: "adapter-authored-elliptic-sweep",
    },
    mesh,
    paintRegions,
    metrics: {
      vertexCount: mesh.vertices.length,
      triangleCount: mesh.triangles.length,
      verticalSegments: mesh.verticalSegments,
      frontSilhouetteErrorCssPx: mesh.silhouetteErrorCssPx,
      ...topology,
    },
  };
}

function compileEar({ sourceId, paths, headProfiles }) {
  const contour = primaryContour(paths, "ear", sourceId);
  const instances = [-1, 1].map((side) => buildEarInstance(contour, side));
  const topologies = instances.map((instance) =>
    topologyMetrics(instance.vertices, instance.triangles));
  if (topologies.some((topology) => !topology.connected
    || topology.nonManifoldEdgeCount !== 0
    || topology.minimumTriangleArea <= 0 || topology.signedVolume <= 0)) {
    throw new RangeError(`FacesJS ear.${sourceId} shell topology is invalid.`);
  }
  return {
    layer: 3,
    attachment: "head-shell",
    materialRoles: ["ink", "skin"],
    empty: false,
    stateIds: ["ear-size", "ear-size-fatness", "fatness"],
    provenance: {
      frontSilhouette: "facesjs-svg-contour",
      depthProfile: "adapter-authored-extrusion",
      rearClosure: "adapter-authored-extrusion",
    },
    attachmentProfile: {
      family: "head",
      sourceY: 325,
      compatibleSourceIds: Object.keys(headProfiles).sort(),
    },
    instances,
    metrics: {
      vertexCount: instances.reduce((sum, instance) => sum + instance.vertices.length, 0),
      triangleCount: instances.reduce((sum, instance) => sum + instance.triangles.length, 0),
      boundaryEdgeCount: topologies.reduce((sum, topology) => sum + topology.boundaryEdgeCount, 0),
      nonManifoldEdgeCount: topologies.reduce(
        (sum, topology) => sum + topology.nonManifoldEdgeCount,
        0,
      ),
      minimumTriangleArea: rounded(Math.min(
        ...topologies.map(({ minimumTriangleArea }) => minimumTriangleArea),
      )),
    },
  };
}

export function compileFacesJsShellComponent({
  family,
  sourceId,
  fragment,
  sourceSha256,
  headFragments,
}) {
  if (!FACES_JS_SHELL_FAMILIES.includes(family)) {
    throw new TypeError(`FacesJS shell family ${family} is unsupported.`);
  }
  if (sha256(fragment) !== sourceSha256) {
    throw new TypeError(`FacesJS ${family}.${sourceId} source hash is stale.`);
  }
  const paths = parseSvgFragment(fragment);
  const compiled = family === "head"
    ? compileHead({ sourceId, sourceSha256, paths })
    : compileEar({ sourceId, paths, headProfiles: headFragments });
  const payload = {
    schema: FACES_JS_SHELL_COMPONENT_SCHEMA,
    family,
    sourceId,
    sourceSha256,
    ...compiled,
  };
  return Object.freeze({
    ...payload,
    contentHash: sha256(JSON.stringify(payload)),
  });
}

function barycentricDepth(first, second, third, x, z) {
  const denominator = ((second[2] - third[2]) * (first[0] - third[0]))
    + ((third[0] - second[0]) * (first[2] - third[2]));
  if (Math.abs(denominator) <= 1e-10) return null;
  const a = (((second[2] - third[2]) * (x - third[0]))
    + ((third[0] - second[0]) * (z - third[2]))) / denominator;
  const b = (((third[2] - first[2]) * (x - third[0]))
    + ((first[0] - third[0]) * (z - third[2]))) / denominator;
  const c = 1 - a - b;
  if (a < -1e-6 || b < -1e-6 || c < -1e-6) return null;
  return (a * first[1]) + (b * second[1]) + (c * third[1]);
}

export function createFacesJsOpenHeadFaceline({ sourceId, fragment, sourceSha256, index }) {
  if (sha256(fragment) !== sourceSha256) {
    throw new TypeError(`FacesJS head.${sourceId} source hash is stale.`);
  }
  const contour = primaryContour(parseSvgFragment(fragment), "head", sourceId);
  const mesh = buildHeadMesh(contour, { radialSegments: 12, verticalSegments: 20 });
  const points = mesh.vertices.map(({ states }) => states.fatness);
  const frontRows = mesh.triangles.filter(({ surface }) => surface === "front");
  const triangles = frontRows.map(({ indices }) => indices.map((vertexIndex) => points[vertexIndex]));
  const boundary = mesh.frontBoundary.map((vertexIndex) => points[vertexIndex]);
  return Object.freeze({
    index,
    sourceId,
    sourceSha256,
    sourceVersion: 1,
    points: Object.freeze(points),
    triangles: Object.freeze(triangles),
    boundary: Object.freeze(boundary),
    rearTriangles: Object.freeze(mesh.triangles
      .filter(({ surface }) => surface === "rear")
      .map(({ indices }) => indices.map((vertexIndex) => points[vertexIndex]))),
    surfaceY(x, z, width = 1) {
      const sourceX = x / width;
      let front = Infinity;
      for (const [first, second, third] of triangles) {
        const depth = barycentricDepth(first, second, third, sourceX, z);
        if (depth !== null) front = Math.min(front, depth);
      }
      return Number.isFinite(front) ? front : null;
    },
  });
}
