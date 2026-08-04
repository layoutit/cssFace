import { createHash } from "node:crypto";

import {
  triangulateFacesJsPaint,
} from "./projectedComponentCompiler.mjs";
import {
  horizontalSpanAtY,
  parseSvgFragment,
} from "./svgGeometry.mjs";

export const FACES_JS_HAIR_COMPONENT_SCHEMA = "cssface.facesjs-hair-component@1";
export const FACES_JS_B11_HAIR_STRATEGIES = Object.freeze([
  "cap",
  "empty-bald",
  "fade",
  "raised-mass",
]);
export const FACES_JS_HAIR_STRATEGIES = Object.freeze([
  ...FACES_JS_B11_HAIR_STRATEGIES,
  "background-coupled",
  "rear-long",
]);

const SVG_FACE_X_SCALE = 1.07 / 150;
const SVG_FACE_Z_SCALE = (1.48 - -0.99) / 400;
const MODEL_SCALE = 120;
const BASE_WIDTH = 0.8;
const FRONT_LIFT = 0.06;
const FRONT_CLOSURE_LIFT = 0.05;
const FRONT_PAINT_MINIMUM_CLEARANCE = 0.006;
const FRONT_PAINT_MAXIMUM_SUBDIVISIONS = 5;
const REAR_LIFT = 0.012;
const POINT_EPSILON = 1e-7;
const HAIR_CONTOUR_TOLERANCE = 0.9;
const COMPLEX_HAIR_CONTOUR_TOLERANCE = 2.25;
const COMPLEX_HAIR_POINT_THRESHOLD = 1_200;
const PROFILE_CACHE = new WeakMap();
const STRATEGY_DEPTH = Object.freeze({
  cap: Object.freeze({ ratio: 0.72, minimum: 0.026, frontScale: 1.08 }),
  fade: Object.freeze({ ratio: 0.7, minimum: 0.024, frontScale: 1.08 }),
  "raised-mass": Object.freeze({ ratio: 0.84, minimum: 0.045, frontScale: 1.08 }),
  "background-coupled": Object.freeze({ ratio: 0.76, minimum: 0.03, frontScale: 1.08 }),
  "rear-long": Object.freeze({ ratio: 0.78, minimum: 0.032, frontScale: 1.08 }),
  "accessory-band": Object.freeze({ ratio: 0.76, minimum: 0.032 }),
  "accessory-hat": Object.freeze({ ratio: 0.86, minimum: 0.05 }),
});

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

function sourceFaceX(value, width = 1, flipped = false) {
  return (value - 200) * SVG_FACE_X_SCALE * width * (flipped ? -1 : 1);
}

function sourceFaceZ(value) {
  return 1.48 - ((value - 100) * SVG_FACE_Z_SCALE);
}

function signedArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += (current[0] * next[1]) - (next[0] * current[1]);
  }
  return area * 0.5;
}

function pointSegmentDistance(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared <= POINT_EPSILON) {
    return Math.hypot(point[0] - start[0], point[1] - start[1]);
  }
  const amount = Math.max(0, Math.min(1,
    (((point[0] - start[0]) * dx) + ((point[1] - start[1]) * dy))
      / lengthSquared));
  return Math.hypot(
    point[0] - (start[0] + (dx * amount)),
    point[1] - (start[1] + (dy * amount)),
  );
}

function simplifyOpenPoints(points, tolerance) {
  if (points.length <= 2) return [...points];
  let maximumDistance = 0;
  let splitIndex = -1;
  for (let index = 1; index < points.length - 1; index += 1) {
    const candidate = pointSegmentDistance(points[index], points[0], points.at(-1));
    if (candidate > maximumDistance) {
      maximumDistance = candidate;
      splitIndex = index;
    }
  }
  if (maximumDistance <= tolerance) return [points[0], points.at(-1)];
  const left = simplifyOpenPoints(points.slice(0, splitIndex + 1), tolerance);
  const right = simplifyOpenPoints(points.slice(splitIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

function contourChain(points, startIndex, endIndex) {
  const output = [points[startIndex]];
  let index = startIndex;
  while (index !== endIndex) {
    index = (index + 1) % points.length;
    output.push(points[index]);
  }
  return output;
}

function simplifyClosedPoints(points, tolerance) {
  if (points.length <= 3) return [...points];
  let oppositeIndex = 1;
  let oppositeDistance = 0;
  for (let index = 1; index < points.length; index += 1) {
    const candidate = Math.hypot(
      points[index][0] - points[0][0],
      points[index][1] - points[0][1],
    );
    if (candidate > oppositeDistance) {
      oppositeDistance = candidate;
      oppositeIndex = index;
    }
  }
  const first = simplifyOpenPoints(
    contourChain(points, 0, oppositeIndex),
    tolerance,
  );
  const second = simplifyOpenPoints(
    contourChain(points, oppositeIndex, 0),
    tolerance,
  );
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

function simplifyHairPaths(paths) {
  const sourcePointCount = paths.reduce((pathSum, path) =>
    pathSum + path.subpaths.reduce((subpathSum, subpath) =>
      subpathSum + subpath.points.length, 0), 0);
  const tolerance = sourcePointCount > COMPLEX_HAIR_POINT_THRESHOLD
    ? COMPLEX_HAIR_CONTOUR_TOLERANCE
    : HAIR_CONTOUR_TOLERANCE;
  return Object.freeze(paths.map((path) => Object.freeze({
    ...path,
    subpaths: Object.freeze(path.subpaths.map((subpath) => Object.freeze({
      ...subpath,
      points: Object.freeze((subpath.closed
        ? simplifyClosedPoints(subpath.points, tolerance)
        : simplifyOpenPoints(subpath.points, tolerance))
        .map((point) => Object.freeze([...point]))),
    }))),
  })));
}

function subtract(left, right) {
  return left.map((value, axis) => value - right[axis]);
}

function cross(left, right) {
  return [
    (left[1] * right[2]) - (left[2] * right[1]),
    (left[2] * right[0]) - (left[0] * right[2]),
    (left[0] * right[1]) - (left[1] * right[0]),
  ];
}

function triangleArea(points) {
  return Math.hypot(...cross(subtract(points[1], points[0]), subtract(points[2], points[0]))) * 0.5;
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

function orientClosedMesh(vertices, triangles) {
  const reverse = signedVolume(vertices, triangles) < 0;
  return Object.freeze(triangles.map((triangle) => Object.freeze({
    ...triangle,
    indices: Object.freeze(reverse
      ? [triangle.indices[0], triangle.indices[2], triangle.indices[1]]
      : triangle.indices),
  })));
}

function topologyMetrics(vertices, triangles) {
  if (!triangles.length) {
    return Object.freeze({
      boundaryEdgeCount: 0,
      connected: true,
      minimumTriangleArea: 0,
      nonManifoldEdgeCount: 0,
      signedVolume: 0,
    });
  }
  const edges = new Map();
  const adjacency = new Map();
  let minimumTriangleArea = Infinity;
  for (const triangle of triangles) {
    const points = triangle.indices.map((index) => vertices[index].position);
    minimumTriangleArea = Math.min(minimumTriangleArea, triangleArea(points));
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
    connected: visited.size === used.size,
    minimumTriangleArea: Number(minimumTriangleArea.toFixed(14)),
    nonManifoldEdgeCount: [...edges.values()].filter((count) => count !== 2).length,
    signedVolume: rounded(signedVolume(vertices, triangles)),
  });
}

function cleanedContour(points) {
  const output = points.filter((point, index) => index === 0
    || Math.hypot(point[0] - points[index - 1][0], point[1] - points[index - 1][1]) > 1e-5)
    .map((point) => [...point]);
  if (output.length > 2 && Math.hypot(
    output[0][0] - output.at(-1)[0],
    output[0][1] - output.at(-1)[1],
  ) <= 1e-5) output.pop();
  if (output.length < 3 || Math.abs(signedArea(output)) <= POINT_EPSILON) {
    throw new RangeError("FacesJS hair shell contour is degenerate.");
  }
  return Object.freeze(output.map((point) => Object.freeze(point)));
}

function primaryContour(paths, family, sourceId) {
  const candidates = paths.flatMap((path, pathIndex) => path.subpaths
    .filter(({ points }) => points.length >= 3)
    .map(({ points }) => ({ path, pathIndex, points: cleanedContour(points) })));
  candidates.sort((left, right) => Math.abs(signedArea(right.points)) - Math.abs(signedArea(left.points)));
  const selected = candidates[0];
  if (!selected) throw new TypeError(`FacesJS ${family}.${sourceId} has no closed hair contour.`);
  return Object.freeze(selected);
}

function sourceProfiles(fragments, family) {
  const cachedFamilies = PROFILE_CACHE.get(fragments);
  if (cachedFamilies?.has(family)) return cachedFamilies.get(family);
  const profiles = Object.freeze(Object.entries(fragments)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceId, fragment]) => {
      const paths = parseSvgFragment(fragment);
      const contour = paths.flatMap((path) => path.subpaths)
        .filter(({ points }) => points.length >= 3)
        .map(({ points }) => points)
        .sort((left, right) => Math.abs(signedArea(right)) - Math.abs(signedArea(left)))[0];
      if (!contour) throw new TypeError(`FacesJS ${family}.${sourceId} has no contour.`);
      return Object.freeze({
        sourceId,
        contour,
        minimumY: Math.min(...contour.map((point) => point[1])),
        maximumY: Math.max(...contour.map((point) => point[1])),
      });
    }));
  const next = cachedFamilies ?? new Map();
  next.set(family, profiles);
  if (!cachedFamilies) PROFILE_CACHE.set(fragments, next);
  return profiles;
}

function spanDepth(contour, source, ratio, minimum, clamp = true) {
  const ys = contour.map((point) => point[1]);
  const inset = 1e-4;
  const sourceY = clamp
    ? Math.min(Math.max(source[1], Math.min(...ys) + inset), Math.max(...ys) - inset)
    : source[1];
  const span = horizontalSpanAtY(contour, sourceY);
  if (!span) return minimum;
  const center = (span[0] + span[1]) * 0.5;
  const radius = (span[1] - span[0]) * 0.5;
  if (radius <= POINT_EPSILON) return minimum;
  const normalized = Math.min(1, Math.abs(source[0] - center) / radius);
  return Math.max(
    minimum,
    radius * SVG_FACE_X_SCALE * ratio * Math.sqrt(Math.max(0, 1 - (normalized ** 2))),
  );
}

function envelopeDepth(source, contour, profiles, strategy, front) {
  const settings = STRATEGY_DEPTH[strategy];
  const own = spanDepth(contour, source, settings.ratio, settings.minimum);
  const mirroredSource = [400 - source[0], source[1]];
  const head = profiles.reduce((maximum, profile) => Math.max(
    maximum,
    spanDepth(profile.contour, source, 0.755, settings.minimum),
    spanDepth(profile.contour, mirroredSource, 0.755, settings.minimum),
  ), settings.minimum);
  return Math.max(own, head * (front ? settings.frontScale ?? 1 : 1));
}

function hairPosition(source, side, width, flipped, contour, profiles, strategy, pathLift = 0) {
  const depth = envelopeDepth(source, contour, profiles, strategy, side === "front");
  return roundedPoint([
    sourceFaceX(source[0], width, flipped),
    side === "front"
      ? -depth - FRONT_LIFT - pathLift
      : (depth * 0.86) + REAR_LIFT + pathLift,
    sourceFaceZ(source[1]),
  ]);
}

function hairVertex(source, side, contour, profiles, strategy, pathLift = 0) {
  return Object.freeze({
    source: roundedPoint(source),
    position: hairPosition(source, side, BASE_WIDTH, false, contour, profiles, strategy, pathLift),
    states: Object.freeze({
      fatness: hairPosition(source, side, 1, false, contour, profiles, strategy, pathLift),
      "hair-flip": hairPosition(source, side, BASE_WIDTH, true, contour, profiles, strategy, pathLift),
      "hair-flip-fatness": hairPosition(source, side, 1, true, contour, profiles, strategy, pathLift),
    }),
  });
}

function interpolatedPoint(points, weights) {
  return points[0].map((_, axis) => weights.reduce(
    (sum, weight, index) => sum + (points[index][axis] * weight),
    0,
  ));
}

function sourceCacheKey(source) {
  return `${source[0]}:${source[1]}`;
}

function frontHeadDepth(source, profiles, flipped, cache) {
  const key = `${sourceCacheKey(source)}:${flipped ? "flip" : "base"}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const resolvedSource = flipped
    ? [400 - source[0], source[1]]
    : source;
  const depth = profiles.reduce((maximum, profile) => Math.max(
    maximum,
    spanDepth(profile.contour, resolvedSource, 0.755, 0.018),
  ), 0.018);
  cache.set(key, depth);
  return depth;
}

const FRONT_PAINT_SAMPLES = Object.freeze([
  Object.freeze([0.5, 0.5, 0]),
  Object.freeze([0, 0.5, 0.5]),
  Object.freeze([0.5, 0, 0.5]),
  Object.freeze([1 / 3, 1 / 3, 1 / 3]),
]);

const FRONT_PAINT_STATES = Object.freeze([
  Object.freeze({ id: null, flipped: false }),
  Object.freeze({ id: "fatness", flipped: false }),
  Object.freeze({ id: "hair-flip", flipped: true }),
  Object.freeze({ id: "hair-flip-fatness", flipped: true }),
]);

function frontPaintClearance(vertices, profiles, depthCache) {
  let minimum = Infinity;
  for (const weights of FRONT_PAINT_SAMPLES) {
    const source = interpolatedPoint(vertices.map(({ source: point }) => point), weights);
    for (const state of FRONT_PAINT_STATES) {
      const positions = vertices.map((vertex) => state.id === null
        ? vertex.position
        : vertex.states[state.id]);
      const position = interpolatedPoint(positions, weights);
      minimum = Math.min(
        minimum,
        -frontHeadDepth(source, profiles, state.flipped, depthCache) - position[1],
      );
    }
  }
  return minimum;
}

function midpoint(left, right) {
  return Object.freeze([
    (left[0] + right[0]) * 0.5,
    (left[1] + right[1]) * 0.5,
  ]);
}

function subdivideFrontPaintTriangle(sources) {
  const [first, second, third] = sources;
  const firstSecond = midpoint(first, second);
  const secondThird = midpoint(second, third);
  const thirdFirst = midpoint(third, first);
  return Object.freeze([
    Object.freeze([first, firstSecond, thirdFirst]),
    Object.freeze([firstSecond, second, secondThird]),
    Object.freeze([thirdFirst, secondThird, third]),
    Object.freeze([firstSecond, secondThird, thirdFirst]),
  ]);
}

function conformFrontPaintTriangle(
  sources,
  contour,
  profiles,
  strategy,
  pathLift,
  cache,
  subdivision = 0,
) {
  const vertices = Object.freeze(sources.map((source) => {
    const key = `${sourceCacheKey(source)}:${pathLift}`;
    let vertex = cache.vertices.get(key);
    if (!vertex) {
      vertex = hairVertex(source, "front", contour, profiles, strategy, pathLift);
      cache.vertices.set(key, vertex);
    }
    return vertex;
  }));
  const clearance = frontPaintClearance(vertices, profiles, cache.depths);
  if (clearance >= FRONT_PAINT_MINIMUM_CLEARANCE) {
    return Object.freeze([{ vertices, clearance }]);
  }
  if (subdivision >= FRONT_PAINT_MAXIMUM_SUBDIVISIONS) {
    throw new RangeError(
      `FacesJS front hair paint clearance ${(clearance * MODEL_SCALE).toFixed(3)}px is insufficient.`,
    );
  }
  return Object.freeze(subdivideFrontPaintTriangle(sources).flatMap((triangle) =>
    conformFrontPaintTriangle(
      triangle,
      contour,
      profiles,
      strategy,
      pathLift,
      cache,
      subdivision + 1,
    )));
}

function materialRole(path, family = "hair") {
  const fill = path.fill.trim().toLowerCase();
  if (family === "accessories") {
    if (fill === "$[primary]") return "team-primary";
    if (fill === "$[secondary]") return "team-secondary";
    if (fill === "$[accent]") return "team-accent";
    if (fill === "#e50002") return "accessory-red";
    if (fill === "#eeeaef") return "accessory-white";
    if (fill === "#000" || fill === "#000000") return "ink";
  }
  return fill.startsWith("url(#") ? "hair-fade" : "hair";
}

function closureRows(contour, collapseEnds) {
  const minimumY = Math.min(...contour.map((point) => point[1]));
  const maximumY = Math.max(...contour.map((point) => point[1]));
  const inset = Math.min(1e-4, (maximumY - minimumY) / 10000);
  const range = maximumY - minimumY;
  const edgeOffsets = [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 4]
    .filter((offset) => offset < range * 0.2);
  const values = [...new Set([
    minimumY,
    maximumY,
    ...edgeOffsets.flatMap((offset) => [minimumY + offset, maximumY - offset]),
    ...Array.from({ length: 31 }, (_, index) =>
      minimumY + ((range * (index + 1)) / 32)),
  ])].sort((left, right) => left - right);
  return Object.freeze(values.map((sourceY, index) => {
    const sampledY = index === 0
      ? sourceY + inset
      : index === values.length - 1 ? sourceY - inset : sourceY;
    const span = horizontalSpanAtY(contour, sampledY);
    if (!span) throw new RangeError(`FacesJS hair closure has no span at y=${sampledY}.`);
    return Object.freeze({
      sourceY,
      centerX: (span[0] + span[1]) * 0.5,
      radius: collapseEnds && (index === 0 || index === values.length - 1)
        ? 0
        : Math.max(0.5, (span[1] - span[0]) * 0.5),
    });
  }));
}

function closurePosition(source, depth, width, flipped) {
  return roundedPoint([
    sourceFaceX(source[0], width, flipped),
    depth,
    sourceFaceZ(source[1]),
  ]);
}

function closureVertex(source, depth) {
  return Object.freeze({
    source: roundedPoint(source),
    position: closurePosition(source, depth, BASE_WIDTH, false),
    states: Object.freeze({
      fatness: closurePosition(source, depth, 1, false),
      "hair-flip": closurePosition(source, depth, BASE_WIDTH, true),
      "hair-flip-fatness": closurePosition(source, depth, 1, true),
    }),
  });
}

function buildShell(contour, primaryPath, profiles, strategy, behindOnly, family = "hair") {
  const radialSegments = 16;
  const rows = closureRows(contour, behindOnly);
  const vertices = [];
  const rowIndices = rows.map((row, rowIndex) => {
    if (row.radius <= 1e-3) {
      const index = vertices.length;
      vertices.push(closureVertex([row.centerX, row.sourceY], 0.018));
      return Object.freeze([index]);
    }
    return Object.freeze(Array.from({ length: radialSegments + 1 }, (_, segment) => {
      const angle = Math.PI - ((segment / radialSegments) * Math.PI);
      const source = [row.centerX + (Math.cos(angle) * row.radius), row.sourceY];
      const ownDepth = Math.sin(angle) * row.radius * SVG_FACE_X_SCALE
        * STRATEGY_DEPTH[strategy].ratio * 0.9;
      const headDepth = profiles.reduce((maximum, profile) => Math.max(
        maximum,
        spanDepth(profile.contour, source, 0.68, 0.018),
      ), 0.018);
      const edgeTaper = Math.sin((rowIndex / (rows.length - 1)) * Math.PI) ** 0.35;
      const depth = 0.018 + (Math.max(ownDepth, headDepth) * edgeTaper);
      const index = vertices.length;
      vertices.push(closureVertex(source, depth));
      return index;
    }));
  });
  const frontRowIndices = rows.map((row, rowIndex) => {
    if (rowIndices[rowIndex].length === 1) {
      if (behindOnly) return rowIndices[rowIndex];
      const source = [row.centerX, row.sourceY];
      const profileDepth = profiles.reduce((maximum, profile) => Math.max(
        maximum,
        spanDepth(profile.contour, source, 0.755, 0.018),
      ), 0.018);
      const index = vertices.length;
      vertices.push(closureVertex(source, -profileDepth - FRONT_CLOSURE_LIFT));
      return Object.freeze([index]);
    }
    return Object.freeze(Array.from({ length: radialSegments + 1 }, (_, segment) => {
      if (behindOnly && segment === 0) return rowIndices[rowIndex][0];
      if (behindOnly && segment === radialSegments) return rowIndices[rowIndex].at(-1);
      const angle = Math.PI - ((segment / radialSegments) * Math.PI);
      const source = [row.centerX + (Math.cos(angle) * row.radius), row.sourceY];
      const ownDepth = Math.sin(angle) * row.radius * SVG_FACE_X_SCALE
        * STRATEGY_DEPTH[strategy].ratio;
      const profileDepth = profiles.reduce((maximum, profile) => Math.max(
        maximum,
        spanDepth(profile.contour, source, 0.755, 0.018),
      ), 0.018);
      const edgeTaper = Math.sin((rowIndex / (rows.length - 1)) * Math.PI) ** 0.35;
      const depth = behindOnly
        ? 0.018
        : -Math.max(
          0.018,
          ownDepth * 0.62,
          profileDepth,
        ) - FRONT_CLOSURE_LIFT;
      const index = vertices.length;
      vertices.push(closureVertex(source, depth));
      return index;
    }));
  });
  const triangles = [];
  const role = materialRole(primaryPath, family);
  const append = (indices, surface) => triangles.push({
    indices,
    materialRole: role,
    surface,
    ...(surface === "front-closure" ? { render: false } : {}),
  });
  const connect = (first, second, surface) => {
    if (first.length === 1 && second.length === 1) return;
    if (first.length === 1) {
      for (let segment = 0; segment < second.length - 1; segment += 1) {
        append([first[0], second[segment], second[segment + 1]], surface);
      }
      return;
    }
    if (second.length === 1) {
      for (let segment = 0; segment < first.length - 1; segment += 1) {
        append([first[segment], second[0], first[segment + 1]], surface);
      }
      return;
    }
    for (let segment = 0; segment < radialSegments; segment += 1) {
      append([first[segment], second[segment], second[segment + 1]], surface);
      append([first[segment], second[segment + 1], first[segment + 1]], surface);
    }
  };
  for (let index = 0; index < rowIndices.length - 1; index += 1) {
    connect(rowIndices[index], rowIndices[index + 1], "rear");
    connect(frontRowIndices[index + 1], frontRowIndices[index], "front-closure");
  }
  const boundaryLoop = (indicesByRow) => {
    const output = [
      ...indicesByRow[0],
      ...indicesByRow.slice(1, -1).map((indices) => indices.at(-1)),
      ...[...indicesByRow.at(-1)].reverse(),
      ...indicesByRow.slice(1, -1).reverse().map((indices) => indices[0]),
    ].filter((index, offset, values) => offset === 0 || index !== values[offset - 1]);
    if (output[0] === output.at(-1)) output.pop();
    return output;
  };
  const boundary = boundaryLoop(rowIndices);
  const frontBoundary = boundaryLoop(frontRowIndices);
  if (!behindOnly) {
    for (let index = 0; index < boundary.length; index += 1) {
      const next = (index + 1) % boundary.length;
      append([boundary[index], boundary[next], frontBoundary[next]], "side");
      append([boundary[index], frontBoundary[next], frontBoundary[index]], "side");
    }
  }
  return Object.freeze({
    vertices: Object.freeze(vertices),
    triangles: orientClosedMesh(vertices, triangles),
    frontBoundary: Object.freeze(frontBoundary),
    rearBoundary: Object.freeze(rowIndices.flatMap((indices) => indices.slice(1, -1))),
    sourceRows: rows.length,
  });
}

function buildSourcePaint(paths, contour, profiles, strategy, family, side) {
  const cache = Object.freeze({ depths: new Map(), vertices: new Map() });
  const rows = triangulateFacesJsPaint(paths, {}, family).flatMap((triangle) => {
    const pathLift = 0.012 + (triangle.pathIndex * 0.001);
    const conformed = side === "front" && family === "hair"
      ? conformFrontPaintTriangle(
        triangle.points,
        contour,
        profiles,
        strategy,
        pathLift,
        cache,
      )
      : [{
        vertices: Object.freeze(triangle.points.map((source) =>
          hairVertex(source, side, contour, profiles, strategy, pathLift))),
        clearance: null,
      }];
    return conformed.map(({ vertices, clearance }) => ({
      kind: triangle.kind,
      material: triangle.material,
      pathIndex: triangle.pathIndex,
      vertices,
      clearance,
    }));
  });
  return Object.freeze(rows.map((row, id) => Object.freeze({ ...row, id })));
}

function rgbaAlpha(value) {
  const rgba = value.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/iu);
  if (rgba) return Number.parseFloat(rgba[1]);
  return 1;
}

function gradientProfile(fragment) {
  const match = fragment.match(/<linearGradient\b([^>]*)>([\s\S]*?)<\/linearGradient>/iu);
  if (!match) return null;
  const attribute = (source, name, fallback = null) => {
    const row = source.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "iu"));
    return row?.[1] ?? fallback;
  };
  const stops = [...match[2].matchAll(/<stop\b([^>]*)\/?\s*>/giu)].map((row) => {
    const offsetSource = attribute(row[1], "offset", "0");
    const color = attribute(row[1], "stop-color", "rgba(0,0,0,1)");
    const opacity = Number.parseFloat(attribute(row[1], "stop-opacity", "1"));
    const offset = offsetSource.endsWith("%")
      ? Number.parseFloat(offsetSource) / 100
      : Number.parseFloat(offsetSource);
    return Object.freeze({
      offset: rounded(offset),
      opacity: rounded(rgbaAlpha(color) * opacity),
      sourceColor: color,
    });
  });
  if (stops.length < 2 || stops.some(({ offset, opacity }) =>
    !Number.isFinite(offset) || !Number.isFinite(opacity))) {
    throw new TypeError("FacesJS hair gradient is incomplete.");
  }
  return Object.freeze({
    id: attribute(match[1], "id"),
    x1: Number.parseFloat(attribute(match[1], "x1", "0")),
    x2: Number.parseFloat(attribute(match[1], "x2", "0")),
    y1: Number.parseFloat(attribute(match[1], "y1", "0")),
    y2: Number.parseFloat(attribute(match[1], "y2", "1")),
    stops: Object.freeze(stops),
  });
}

function attachmentProfile(contour, profiles, bodyProfiles, family, strategy) {
  const rows = profiles.map((profile) => {
    const overlapPoints = contour.filter((point) => {
      if (point[1] < profile.minimumY || point[1] > profile.maximumY) return false;
      const span = horizontalSpanAtY(profile.contour, point[1]);
      return span && point[0] >= span[0] && point[0] <= span[1];
    }).length;
    return Object.freeze({ sourceId: profile.sourceId, overlapPoints });
  });
  const bodyClearances = family === "hairBg" ? contour.flatMap((source) => {
    const bodyDepths = bodyProfiles.flatMap((profile) => {
      if (source[1] < profile.minimumY || source[1] > profile.maximumY) return [];
      const span = horizontalSpanAtY(profile.contour, source[1]);
      if (!span || source[0] < span[0] || source[0] > span[1]) return [];
      return [spanDepth(profile.contour, source, 0.46, 0)];
    });
    if (!bodyDepths.length) return [];
    const hairDepth = (envelopeDepth(source, contour, [...profiles, ...bodyProfiles], strategy) * 0.86)
      + REAR_LIFT;
    return [(hairDepth - Math.max(...bodyDepths)) * MODEL_SCALE];
  }) : [];
  return Object.freeze({
    family: "head",
    compatibleSourceIds: Object.freeze(rows.map(({ sourceId }) => sourceId)),
    headProfiles: Object.freeze(rows),
    minimumOverlapPoints: Math.min(...rows.map(({ overlapPoints }) => overlapPoints)),
    minimumShoulderClearanceCssPx: bodyClearances.length
      ? rounded(Math.min(...bodyClearances))
      : null,
    seam: "nested-source-contour-intersection",
  });
}

function projectedBounds(vertices, axes, stateId = null) {
  const points = vertices.map((vertex) => stateId === null
    ? vertex.position
    : vertex.states[stateId]);
  const first = points.map((point) => point[axes[0]]);
  const second = points.map((point) => point[axes[1]]);
  return Object.freeze({
    minimumX: rounded(Math.min(...first)),
    maximumX: rounded(Math.max(...first)),
    minimumY: rounded(Math.min(...second)),
    maximumY: rounded(Math.max(...second)),
  });
}

export function buildFacesJsHeadMountedSource({
  fragment,
  headFragments,
  family = "accessories",
  depthStrategy,
  includeShell = true,
}) {
  if (depthStrategy !== "accessory-band" && depthStrategy !== "accessory-hat") {
    throw new TypeError(`FacesJS head-mounted depth strategy ${depthStrategy} is unsupported.`);
  }
  const paths = parseSvgFragment(fragment);
  const primary = primaryContour(paths, family, "source");
  const profiles = sourceProfiles(headFragments, "head");
  const frontPaint = buildSourcePaint(
    paths,
    primary.points,
    profiles,
    depthStrategy,
    family,
    "front",
  );
  const mesh = includeShell
    ? buildShell(primary.points, primary.path, profiles, depthStrategy, false, family)
    : Object.freeze({
      vertices: Object.freeze([]),
      triangles: Object.freeze([]),
      frontBoundary: Object.freeze([]),
      rearBoundary: Object.freeze([]),
      sourceRows: 0,
    });
  const topology = topologyMetrics(mesh.vertices, mesh.triangles);
  const attachment = attachmentProfile(primary.points, profiles, [], family, depthStrategy);
  const materialRoles = [...new Set([
    ...mesh.triangles.map(({ materialRole: role }) => role),
    ...frontPaint.map(({ material }) => material.role),
  ])].sort();
  if (includeShell && (!topology.connected || topology.nonManifoldEdgeCount !== 0
    || topology.minimumTriangleArea <= 0 || topology.signedVolume <= 0)) {
    throw new RangeError(`FacesJS ${family} head-mounted shell is invalid.`);
  }
  return Object.freeze({
    attachmentProfile: attachment,
    frontPaint,
    materialRoles: Object.freeze(materialRoles),
    mesh,
    metrics: Object.freeze({
      ...topology,
      frontPaintTriangleCount: frontPaint.length,
      triangleCount: mesh.triangles.length + frontPaint.length,
      vertexCount: mesh.vertices.length
        + frontPaint.reduce((sum, triangle) => sum + triangle.vertices.length, 0),
    }),
  });
}

function layerFor(family) {
  return family === "hairBg" ? 0 : 13;
}

function attachmentFor(family) {
  return family === "hairBg" ? "rear-layer" : "head-shell";
}

function dependencyRows(strategyRow) {
  return strategyRow.family === "hair"
    ? strategyRow.compatibleBackgroundSourceIds.map((sourceId) => ({
      family: "hairBg",
      sourceId,
    }))
    : [];
}

function displayGroups(strategyRow) {
  if (strategyRow.family === "hairBg") {
    return Object.freeze({
      behindHead: Object.freeze({ component: "self", mesh: true, paint: true }),
      frontHair: null,
    });
  }
  if (strategyRow.strategy === "background-coupled") {
    return Object.freeze({
      behindHead: Object.freeze({
        componentFamily: "hairBg",
        sourceIds: Object.freeze([...strategyRow.compatibleBackgroundSourceIds]),
      }),
      frontHair: Object.freeze({ component: "self", mesh: true, paint: true }),
    });
  }
  if (strategyRow.strategy === "rear-long") {
    return Object.freeze({
      behindHead: Object.freeze({ component: "self", mesh: true, paint: false }),
      frontHair: Object.freeze({ component: "self", mesh: false, paint: true }),
    });
  }
  return Object.freeze({
    behindHead: null,
    frontHair: Object.freeze({ component: "self", mesh: true, paint: true }),
  });
}

function compileEmpty({ family, strategyRow, profiles }) {
  return {
    layer: layerFor(family),
    attachment: attachmentFor(family),
    materialRoles: [],
    empty: true,
    stateIds: [],
    strategy: strategyRow.strategy,
    geometryContract: strategyRow.geometryContract,
    accessorySubstitution: strategyRow.accessorySubstitution,
    dependencies: dependencyRows(strategyRow),
    displayGroups: displayGroups(strategyRow),
    provenance: {
      frontSilhouette: "facesjs-empty-source",
      depthProfile: "none",
      rearClosure: "none",
    },
    attachmentProfile: {
      family: "head",
      compatibleSourceIds: profiles.map(({ sourceId: id }) => id),
      headProfiles: [],
      minimumOverlapPoints: 0,
      minimumShoulderClearanceCssPx: null,
      seam: "none",
    },
    mesh: { vertices: [], triangles: [], frontBoundary: [], rearBoundary: [] },
    frontPaint: [],
    gradient: null,
    metrics: {
      boundaryEdgeCount: 0,
      connected: true,
      frontPaintTriangleCount: 0,
      frontSilhouetteErrorCssPx: 0,
      minimumTriangleArea: 0,
      nonManifoldEdgeCount: 0,
      signedVolume: 0,
      triangleCount: 0,
      vertexCount: 0,
    },
  };
}

export function compileFacesJsHairComponent({
  family,
  sourceId,
  fragment,
  sourceSha256,
  strategyRow,
  headFragments,
  bodyFragments = {},
}) {
  if (family !== "hair" && family !== "hairBg") {
    throw new TypeError(`FacesJS hair family ${family} is unsupported.`);
  }
  if (sha256(fragment) !== sourceSha256 || strategyRow.sourceSha256 !== sourceSha256) {
    throw new TypeError(`FacesJS hair.${sourceId} source hash is stale.`);
  }
  if (strategyRow.family !== family || strategyRow.sourceId !== sourceId
    || !FACES_JS_HAIR_STRATEGIES.includes(strategyRow.strategy)) {
    throw new TypeError(`FacesJS ${family}.${sourceId} has no hair strategy contract.`);
  }
  const profiles = sourceProfiles(headFragments, "head");
  const bodyProfiles = sourceProfiles(bodyFragments, "body");
  const surfaceProfiles = family === "hairBg" ? [...profiles, ...bodyProfiles] : profiles;
  const paths = simplifyHairPaths(parseSvgFragment(fragment));
  const compiled = !fragment.trim()
    ? compileEmpty({ family, strategyRow, profiles })
    : (() => {
      const primary = primaryContour(paths, family, sourceId);
      const mesh = buildShell(
        primary.points,
        primary.path,
        surfaceProfiles,
        strategyRow.strategy,
        family === "hairBg" || strategyRow.strategy === "rear-long",
        family,
      );
      const topology = topologyMetrics(mesh.vertices, mesh.triangles);
      const paintSide = family === "hairBg" ? "rear" : "front";
      const frontPaint = buildSourcePaint(
        paths,
        primary.points,
        surfaceProfiles,
        strategyRow.strategy,
        family,
        paintSide,
      );
      const materialRoles = [...new Set([
        ...mesh.triangles.map(({ materialRole: role }) => role),
        ...frontPaint.map(({ material }) => material.role),
      ])].sort();
      const attachment = attachmentProfile(
        primary.points,
        profiles,
        bodyProfiles,
        family,
        strategyRow.strategy,
      );
      if (!topology.connected || topology.nonManifoldEdgeCount !== 0
        || topology.minimumTriangleArea <= 0 || topology.signedVolume <= 0
        || attachment.minimumOverlapPoints <= 0
        || (family === "hairBg"
          && attachment.minimumShoulderClearanceCssPx !== null
          && attachment.minimumShoulderClearanceCssPx < 0.5)) {
        throw new RangeError(
          `FacesJS ${family}.${sourceId} shell is invalid: ${JSON.stringify({ topology, attachment })}.`,
        );
      }
      return {
        layer: layerFor(family),
        attachment: attachmentFor(family),
        materialRoles,
        empty: false,
        stateIds: ["fatness", "hair-flip", "hair-flip-fatness"],
        strategy: strategyRow.strategy,
        geometryContract: strategyRow.geometryContract,
        accessorySubstitution: strategyRow.accessorySubstitution,
        dependencies: dependencyRows(strategyRow),
        displayGroups: displayGroups(strategyRow),
        provenance: {
          frontSilhouette: family === "hairBg"
            ? "facesjs-svg-behind-layer-contours"
            : "facesjs-svg-fill-contours",
          depthProfile: strategyRow.strategy === "raised-mass"
            ? "adapter-authored-offset-envelope"
            : "adapter-authored-head-conforming-envelope",
          rearClosure: family === "hairBg"
            ? "adapter-authored-behind-head-and-shoulder-shell"
            : "adapter-authored-welded-side-and-rear-shell",
        },
        attachmentProfile: attachment,
        mesh,
        frontPaint,
        gradient: gradientProfile(fragment),
        captureBounds: {
          front: projectedBounds(mesh.vertices, [0, 2]),
          side: projectedBounds(mesh.vertices, [1, 2]),
          rear: projectedBounds(mesh.vertices, [0, 2], "hair-flip"),
        },
        metrics: {
          ...topology,
          frontPaintTriangleCount: frontPaint.length,
          minimumFrontPaintClearanceCssPx: paintSide === "front"
            ? rounded(Math.min(...frontPaint.map(({ clearance }) => clearance)) * MODEL_SCALE)
            : null,
          frontSilhouetteErrorCssPx: 0,
          triangleCount: mesh.triangles.length + frontPaint.length,
          vertexCount: mesh.vertices.length
            + frontPaint.reduce((sum, triangle) => sum + triangle.vertices.length, 0),
        },
      };
    })();
  const payload = {
    schema: FACES_JS_HAIR_COMPONENT_SCHEMA,
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
