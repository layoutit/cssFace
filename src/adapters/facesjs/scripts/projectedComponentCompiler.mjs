import { createHash } from "node:crypto";

import earcut from "earcut";

import {
  boundsOfPaths,
  horizontalSpanAtY,
  parseSvgFragment,
} from "./svgGeometry.mjs";

export const FACES_JS_PROJECTED_COMPONENT_SCHEMA =
  "cssface.facesjs-projected-component@1";

export const FACES_JS_ORDINARY_PROJECTED_FAMILIES = Object.freeze([
  "eye",
  "eyebrow",
  "mouth",
  "nose",
]);

export const FACES_JS_OVERLAY_FAMILIES = Object.freeze([
  "eyeLine",
  "smileLine",
  "miscLine",
  "facialHair",
]);

export const FACES_JS_RAISED_PROJECTED_FAMILIES = Object.freeze([
  "glasses",
]);

export const FACES_JS_PROJECTED_FAMILIES = Object.freeze([
  ...FACES_JS_OVERLAY_FAMILIES,
  ...FACES_JS_ORDINARY_PROJECTED_FAMILIES,
  ...FACES_JS_RAISED_PROJECTED_FAMILIES,
]);

const FAMILY_LAYER = Object.freeze({
  eyeLine: 5,
  smileLine: 6,
  miscLine: 7,
  facialHair: 8,
  eye: 9,
  eyebrow: 10,
  mouth: 11,
  nose: 12,
  glasses: 14,
});
const FAMILY_POSITION = Object.freeze({
  eyeLine: Object.freeze([null]),
  smileLine: Object.freeze([[150, 435], [250, 435]]),
  miscLine: Object.freeze([null]),
  facialHair: Object.freeze([null]),
  eye: Object.freeze([[140, 310], [260, 310]]),
  eyebrow: Object.freeze([[140, 270], [260, 270]]),
  mouth: Object.freeze([[200, 440]]),
  nose: Object.freeze([[200, 370]]),
  glasses: Object.freeze([null]),
});
const SVG_FACE_X_SCALE = 1.07 / 150;
const SVG_FACE_Z_SCALE = (1.48 - -0.99) / 400;
const MODEL_SCALE = 120;
const MINIMUM_CLEARANCE = 0.006;
const MAXIMUM_SUBDIVISIONS = 4;
const SURFACE_SAMPLE_RESOLUTION = 2;
const POINT_EPSILON = 1e-7;
const OVERLAY_BASE_LIFT = Object.freeze({
  eyeLine: 0.025,
  smileLine: 0.031,
  miscLine: 0.037,
  facialHair: 0.043,
  glasses: 0.072,
});
const OVERLAY_PATH_LIFT = 0.0015;
const OVERLAY_STROKE_LIFT = 0.001;

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

function distance(left, right) {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
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

function triangleArea(points) {
  return Math.abs(signedArea(points));
}

function pointInPolygon(point, points) {
  let inside = false;
  for (let index = 0, previousIndex = points.length - 1;
    index < points.length;
    previousIndex = index, index += 1) {
    const current = points[index];
    const previous = points[previousIndex];
    if (
      (current[1] > point[1]) !== (previous[1] > point[1])
      && point[0] < ((previous[0] - current[0]) * (point[1] - current[1])
        / (previous[1] - current[1])) + current[0]
    ) inside = !inside;
  }
  return inside;
}

function contourProbe(points) {
  return [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
  ];
}

function fillTriangles(subpaths) {
  const contours = subpaths
    .filter(({ points }) => points.length >= 3)
    .map(({ points }, index) => ({ index, points, area: Math.abs(signedArea(points)) }));
  const rows = contours.map((contour) => {
    const probe = contourProbe(contour.points);
    const parents = contours
      .filter((candidate) => candidate.index !== contour.index
        && candidate.area > contour.area
        && pointInPolygon(probe, candidate.points))
      .sort((left, right) => left.area - right.area);
    return { ...contour, depth: parents.length, parent: parents[0]?.index ?? null };
  });
  const output = [];
  for (const outer of rows.filter(({ depth }) => depth % 2 === 0)) {
    const holes = rows.filter(({ depth, parent }) =>
      depth === outer.depth + 1 && parent === outer.index);
    const points = [...outer.points];
    const holeIndices = [];
    for (const hole of holes) {
      holeIndices.push(points.length);
      points.push(...hole.points);
    }
    const indices = earcut(points.flat(), holeIndices, 2);
    for (let offset = 0; offset < indices.length; offset += 3) {
      output.push(indices.slice(offset, offset + 3).map((index) => points[index]));
    }
  }
  return output;
}

function strokeRibbon(start, end, width) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (length <= POINT_EPSILON) return null;
  const offsetX = (-dy / length) * width * 0.5;
  const offsetY = (dx / length) * width * 0.5;
  return [
    [start[0] + offsetX, start[1] + offsetY],
    [end[0] + offsetX, end[1] + offsetY],
    [end[0] - offsetX, end[1] - offsetY],
    [start[0] - offsetX, start[1] - offsetY],
  ];
}

function strokeOutline(points, width) {
  if (points.length < 2) return [];
  const halfWidth = width * 0.5;
  const normals = points.slice(0, -1).map((point, index) => {
    const next = points[index + 1];
    const dx = next[0] - point[0];
    const dy = next[1] - point[1];
    const length = Math.hypot(dx, dy);
    return length <= POINT_EPSILON ? [0, 0] : [-dy / length, dx / length];
  });
  const offsets = points.map((_, index) => {
    if (index === 0) return normals[0].map((value) => value * halfWidth);
    if (index === points.length - 1) return normals.at(-1).map((value) => value * halfWidth);
    const previous = normals[index - 1];
    const next = normals[index];
    const combinedLength = Math.hypot(previous[0] + next[0], previous[1] + next[1]);
    if (combinedLength <= POINT_EPSILON) return next.map((value) => value * halfWidth);
    const combined = [
      (previous[0] + next[0]) / combinedLength,
      (previous[1] + next[1]) / combinedLength,
    ];
    const denominator = (combined[0] * next[0]) + (combined[1] * next[1]);
    if (Math.abs(denominator) <= POINT_EPSILON) return next.map((value) => value * halfWidth);
    const amount = Math.min(halfWidth * 4, Math.abs(halfWidth / denominator));
    return combined.map((value) => value * amount * Math.sign(denominator));
  });
  return [
    ...points.map((point, index) => [
      point[0] + offsets[index][0],
      point[1] + offsets[index][1],
    ]),
    ...points.map((point, index) => [
      point[0] - offsets[index][0],
      point[1] - offsets[index][1],
    ]).reverse(),
  ];
}

function circleTriangles(center, radius, segments = 4) {
  return Array.from({ length: segments }, (_, index) => {
    const angle = (index / segments) * Math.PI * 2;
    const next = ((index + 1) / segments) * Math.PI * 2;
    return [
      center,
      [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius],
      [center[0] + Math.cos(next) * radius, center[1] + Math.sin(next) * radius],
    ];
  });
}

function strokeJoinTriangle(previous, current, next, width) {
  const previousRibbon = strokeRibbon(previous, current, width);
  const nextRibbon = strokeRibbon(current, next, width);
  if (!previousRibbon || !nextRibbon) return null;
  const previousDirection = subtract2d(current, previous);
  const nextDirection = subtract2d(next, current);
  const turn = (previousDirection[0] * nextDirection[1])
    - (previousDirection[1] * nextDirection[0]);
  if (Math.abs(turn) <= POINT_EPSILON) return null;
  return turn > 0
    ? [current, previousRibbon[1], nextRibbon[0]]
    : [current, nextRibbon[3], previousRibbon[2]];
}

function subtract2d(left, right) {
  return [left[0] - right[0], left[1] - right[1]];
}

function strokeTriangles(subpath, path) {
  const points = subpath.points;
  if (points.length < 2 || path.strokeWidth <= 0) return [];
  if (path.strokeLinecap === "round" || path.strokeLinejoin === "round") {
    const output = [];
    const segmentCount = subpath.closed ? points.length : points.length - 1;
    for (let index = 0; index < segmentCount; index += 1) {
      const ribbon = strokeRibbon(points[index], points[(index + 1) % points.length], path.strokeWidth);
      if (!ribbon) continue;
      output.push([ribbon[0], ribbon[1], ribbon[2]], [ribbon[0], ribbon[2], ribbon[3]]);
    }
    if (path.strokeLinejoin === "round") {
      const firstJoin = subpath.closed ? 0 : 1;
      const finalJoin = subpath.closed ? points.length : points.length - 1;
      for (let index = firstJoin; index < finalJoin; index += 1) {
        const join = strokeJoinTriangle(
          points[(index + points.length - 1) % points.length],
          points[index],
          points[(index + 1) % points.length],
          path.strokeWidth,
        );
        if (join) output.push(join);
      }
    }
    if (!subpath.closed && path.strokeLinecap === "round") {
      output.push(
        ...circleTriangles(points[0], path.strokeWidth * 0.5),
        ...circleTriangles(points.at(-1), path.strokeWidth * 0.5),
      );
    }
    return output;
  }
  if (subpath.closed) {
    const output = [];
    for (let index = 0; index < points.length; index += 1) {
      const ribbon = strokeRibbon(points[index], points[(index + 1) % points.length], path.strokeWidth);
      if (!ribbon) continue;
      output.push([ribbon[0], ribbon[1], ribbon[2]], [ribbon[0], ribbon[2], ribbon[3]]);
    }
    return output;
  }
  const outline = strokeOutline(points, path.strokeWidth);
  return fillTriangles([{ points: outline }]);
}

function material(value, path, family) {
  const source = value.trim();
  const color = source.toLowerCase();
  if (color === "none") return null;
  const appearance = {
    source,
    opacity: path.opacity,
    mixBlendMode: path.mixBlendMode,
  };
  if (/^url\(#[A-Za-z][\w.-]*\)$/u.test(source) && (family === "hair" || family === "hairBg")) {
    return Object.freeze({ role: "hair-fade", ...appearance });
  }
  if (color === "$[haircolor]") return Object.freeze({ role: "hair", ...appearance });
  if (color === "$[skincolor]") return Object.freeze({ role: "skin", ...appearance });
  if (color === "$[primary]") {
    return Object.freeze({ role: "team-primary", ...appearance });
  }
  if (color === "$[secondary]") {
    return Object.freeze({ role: "team-secondary", ...appearance });
  }
  if (color === "$[accent]") {
    return Object.freeze({ role: "team-accent", ...appearance });
  }
  if (color === "#fff" || color === "#ffffff") {
    return Object.freeze({
      role: family === "glasses"
        ? "highlight"
        : family === "jersey" ? "jersey-white" : "eye-white",
      ...appearance,
    });
  }
  if (color === "#f5f3ee") {
    return Object.freeze({ role: "eye-off-white", ...appearance });
  }
  if (color === "#501414") return Object.freeze({ role: "mouth-dark", ...appearance });
  if (color === "#a15757") return Object.freeze({ role: "blush", ...appearance });
  if (color === "#8b6135") return Object.freeze({ role: "freckle", ...appearance });
  if (color === "#e50002") return Object.freeze({ role: "accessory-red", ...appearance });
  if (color === "#eeeaef") return Object.freeze({ role: "accessory-white", ...appearance });
  if (color === "#0000008") {
    return Object.freeze({ role: "accessory-translucent-ink", ...appearance });
  }
  if (color === "#333" || color === "#333333") {
    return Object.freeze({ role: "frame-dark", ...appearance });
  }
  if (color === "rgba(150,150,175,.5)") {
    return Object.freeze({ role: "lens", ...appearance });
  }
  if (color === "#000" || color === "#000000") {
    return Object.freeze({ role: "ink", ...appearance });
  }
  throw new TypeError(`FacesJS projected component has unsupported paint ${source}.`);
}

function transformPoint(point, bounds, options) {
  const scale = options.scale ?? 1;
  const scaleX = options.scaleX ?? 1;
  const mirror = options.mirrorX ? -1 : 1;
  const radians = (options.angle ?? 0) * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const localX = (point[0] - bounds.centerX) * scale * scaleX * mirror;
  const localY = (point[1] - bounds.centerY) * scale;
  const position = options.position ?? [bounds.centerX, bounds.centerY];
  const anchorX = options.xAlign === "left"
    ? bounds.minimumX
    : options.xAlign === "right" ? bounds.maximumX : bounds.centerX;
  return [
    position[0] + bounds.centerX - anchorX
      + (localX * cosine) - (localY * sine),
    position[1] + (localX * sine) + (localY * cosine),
  ];
}

export function triangulateFacesJsPaint(paths, options, family) {
  const bounds = boundsOfPaths(paths);
  if (!bounds) return [];
  const transformTriangle = (points) =>
    points.map((point) => transformPoint(point, bounds, options));
  const output = [];
  const append = (kind, selectedMaterial, pathIndex, points) => {
    if (triangleArea(points) <= 1e-10) return;
    output.push({
      kind,
      material: selectedMaterial,
      pathIndex,
      points: transformTriangle(points),
    });
  };
  for (const [pathIndex, path] of paths.entries()) {
    const fillMaterial = material(path.fill, path, family);
    if (fillMaterial) {
      for (const points of fillTriangles(path.subpaths)) {
        append("fill", fillMaterial, pathIndex, points);
      }
    }
    const strokeMaterial = material(path.stroke, path, family);
    if (strokeMaterial) {
      const strokePath = {
        ...path,
        strokeWidth: path.strokeWidth / Math.abs(options.scale ?? 1),
      };
      for (const subpath of path.subpaths) {
        for (const points of strokeTriangles(subpath, strokePath)) {
          append("stroke", strokeMaterial, pathIndex, points);
        }
      }
    }
  }
  return output;
}

function optionsFor(family, sourceId, instance) {
  const position = FAMILY_POSITION[family][instance];
  const pairedMirror = instance === 1;
  const pinocchio = family === "nose"
    && (sourceId === "nose4" || sourceId === "pinocchio");
  const base = {
    position,
    xAlign: pinocchio ? "left" : "center",
    mirrorX: pairedMirror,
    angle: 0,
    scale: 1,
    scaleX: family === "facialHair" || family === "glasses" ? 0.8 : 1,
  };
  if (family === "facialHair" || family === "glasses") {
    return {
      base,
      states: { fatness: { ...base, scaleX: 1 } },
    };
  }
  if (family === "smileLine") {
    return {
      base,
      states: {
        "smile-line-size-min": { ...base, scale: 0.25 },
        "smile-line-size-max": { ...base, scale: 2.25 },
      },
    };
  }
  if (family === "eyeLine" || family === "miscLine") {
    return { base, states: {} };
  }
  if (family === "eye") {
    return {
      base,
      states: {
        "eye-angle-negative": { ...base, angle: instance === 0 ? -10 : 10 },
        "eye-angle-positive": { ...base, angle: instance === 0 ? 15 : -15 },
      },
    };
  }
  if (family === "eyebrow") {
    return {
      base,
      states: {
        "brow-down": { ...base, angle: instance === 0 ? 20 : -20 },
        "brow-up": { ...base, angle: instance === 0 ? -15 : 15 },
      },
    };
  }
  if (family === "mouth") {
    return { base, states: { "mouth-flip": { ...base, mirrorX: true } } };
  }
  return {
    base,
    states: {
      "nose-flip": {
        ...base,
        mirrorX: true,
        xAlign: pinocchio ? "right" : "center",
      },
      "nose-size-max": { ...base, scale: 1.25 },
      "nose-size-min": { ...base, scale: 0.5 },
    },
  };
}

function sourceFaceX(value) {
  return (value - 200) * SVG_FACE_X_SCALE;
}

function sourceFaceZ(value) {
  return 1.48 - ((value - 100) * SVG_FACE_Z_SCALE);
}

function createHeadProfiles(headFragments) {
  return Object.entries(headFragments)
    .filter(([id]) => id === "head1")
    .map(([id, fragment]) => {
      const paths = parseSvgFragment(fragment);
      const contour = paths
        .flatMap((path) => path.subpaths)
        .find(({ points }) => points.length >= 3)?.points;
      if (!contour) throw new TypeError(`FacesJS head ${id} has no profile contour.`);
      return Object.freeze({
        id,
        contour,
        minimumY: Math.min(...contour.map((point) => point[1])),
        maximumY: Math.max(...contour.map((point) => point[1])),
      });
    });
}

function surfacePoint(source, fatness, profile, lift, clampToProfile) {
  let span = horizontalSpanAtY(profile.contour, source[1]);
  if (!span && clampToProfile) {
    const inset = 1e-4;
    const clampedY = Math.min(
      profile.maximumY - inset,
      Math.max(profile.minimumY + inset, source[1]),
    );
    span = horizontalSpanAtY(profile.contour, clampedY);
  }
  if (!span) {
    throw new RangeError(
      `FacesJS projected point ${source.join(",")} is outside head ${profile.id}.`,
    );
  }
  const center = (span[0] + span[1]) * 0.5;
  const radius = (span[1] - span[0]) * 0.5;
  const widthScale = 0.8 + (0.2 * fatness);
  const sourceNormalized = Math.abs(source[0] - center) / (radius * widthScale);
  if (sourceNormalized >= 1 && !clampToProfile) {
    throw new RangeError(
      `FacesJS projected point ${source.join(",")} crosses head ${profile.id} at fatness ${fatness}.`,
    );
  }
  const normalized = Math.min(sourceNormalized, 1 - 1e-7);
  const depth = radius * SVG_FACE_X_SCALE * 0.755;
  return [
    sourceFaceX(source[0]),
    -(depth * Math.sqrt(1 - (normalized * normalized))) - lift,
    sourceFaceZ(source[1]),
  ];
}

function interpolatePoint(left, right, amount) {
  return left.map((value, axis) => value + ((right[axis] - value) * amount));
}

function stateRows(triangle) {
  if (triangle.states.fatness) {
    return [
      ["base", triangle.points, 0],
      ["fatness", triangle.states.fatness, 1],
      [
        "fatness@0.5",
        triangle.states.fatness.map((point, index) =>
          interpolatePoint(triangle.points[index], point, 0.5)),
        0.5,
      ],
    ];
  }
  return [
    ["base", triangle.points, null],
    ...Object.entries(triangle.states).map(([id, points]) => [id, points, null]),
    ...Object.entries(triangle.states).map(([id, points]) => [
      `${id}@0.5`,
      points.map((point, index) => interpolatePoint(triangle.points[index], point, 0.5)),
      null,
    ]),
  ];
}

function triangleClearance(triangle, profiles, lift) {
  let minimum = Infinity;
  for (const profile of profiles) {
    for (const [, sourcePoints, rowFatness] of stateRows(triangle)) {
      for (const fatness of rowFatness === null ? [0, 1] : [rowFatness]) {
        const positions = sourcePoints.map((point) =>
          surfacePoint(point, fatness, profile, lift, triangle.clampToProfile));
        for (let first = 0; first <= SURFACE_SAMPLE_RESOLUTION; first += 1) {
          for (let second = 0;
            second <= SURFACE_SAMPLE_RESOLUTION - first;
            second += 1) {
            const firstWeight = first / SURFACE_SAMPLE_RESOLUTION;
            const secondWeight = second / SURFACE_SAMPLE_RESOLUTION;
            const thirdWeight = 1 - firstWeight - secondWeight;
            const source = [0, 1].map((axis) =>
              (sourcePoints[0][axis] * firstWeight)
                + (sourcePoints[1][axis] * secondWeight)
                + (sourcePoints[2][axis] * thirdWeight));
            const position = [0, 1, 2].map((axis) =>
              (positions[0][axis] * firstWeight)
                + (positions[1][axis] * secondWeight)
                + (positions[2][axis] * thirdWeight));
            const surface = surfacePoint(
              source,
              fatness,
              profile,
              0,
              triangle.clampToProfile,
            );
            minimum = Math.min(minimum, surface[1] - position[1]);
          }
        }
      }
    }
  }
  return minimum;
}

function midpoint(left, right) {
  return roundedPoint(interpolatePoint(left, right, 0.5));
}

function subdivideTriangle(triangle) {
  const [first, second, third] = triangle.points;
  const firstSecond = midpoint(first, second);
  const secondThird = midpoint(second, third);
  const thirdFirst = midpoint(third, first);
  const sourceRows = [
    [first, firstSecond, thirdFirst],
    [firstSecond, second, secondThird],
    [thirdFirst, secondThird, third],
    [firstSecond, secondThird, thirdFirst],
  ];
  const stateRowsById = Object.fromEntries(Object.entries(triangle.states).map(([id, points]) => {
    const [stateFirst, stateSecond, stateThird] = points;
    const stateFirstSecond = midpoint(stateFirst, stateSecond);
    const stateSecondThird = midpoint(stateSecond, stateThird);
    const stateThirdFirst = midpoint(stateThird, stateFirst);
    return [id, [
      [stateFirst, stateFirstSecond, stateThirdFirst],
      [stateFirstSecond, stateSecond, stateSecondThird],
      [stateThirdFirst, stateSecondThird, stateThird],
      [stateFirstSecond, stateSecondThird, stateThirdFirst],
    ]];
  }));
  return sourceRows.map((points, index) => ({
    ...triangle,
    points,
    states: Object.fromEntries(Object.entries(stateRowsById).map(([id, rows]) => [
      id,
      rows[index],
    ])),
  }));
}

function conformTriangle(triangle, profiles, lift, depth = 0) {
  const clearance = triangleClearance(triangle, profiles, lift);
  if (clearance >= MINIMUM_CLEARANCE) return [{ triangle, clearance }];
  if (depth >= MAXIMUM_SUBDIVISIONS) {
    throw new RangeError(
      `FacesJS ${triangle.kind} clearance ${(clearance * MODEL_SCALE).toFixed(3)}px `
      + `is below ${(MINIMUM_CLEARANCE * MODEL_SCALE).toFixed(3)}px.`,
    );
  }
  return subdivideTriangle(triangle).flatMap((child) =>
    conformTriangle(child, profiles, lift, depth + 1));
}

function compileInstance(paths, family, sourceId, instance, profiles) {
  const options = optionsFor(family, sourceId, instance);
  const base = triangulateFacesJsPaint(paths, options.base, family);
  const states = Object.fromEntries(Object.entries(options.states)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, stateOptions]) => [id, triangulateFacesJsPaint(paths, stateOptions, family)]));
  for (const [id, rows] of Object.entries(states)) {
    if (rows.length !== base.length) {
      throw new Error(
        `FacesJS ${family}.${sourceId} state ${id} changed topology `
        + `(${base.length} base triangles, ${rows.length} state triangles).`,
      );
    }
  }
  const conformed = [];
  for (const [index, row] of base.entries()) {
    const statePoints = Object.fromEntries(Object.entries(states).map(([id, rows]) => {
      const state = rows[index];
      if (state.kind !== row.kind || state.pathIndex !== row.pathIndex
        || state.material.role !== row.material.role
        || state.points.length !== row.points.length) {
        throw new Error(`FacesJS ${family}.${sourceId} state ${id} changed paint topology.`);
      }
      return [id, state.points.map(roundedPoint)];
    }));
    const triangle = {
      kind: row.kind,
      material: row.material,
      pathIndex: row.pathIndex,
      clampToProfile: OVERLAY_BASE_LIFT[family] !== undefined,
      points: row.points.map(roundedPoint),
      states: statePoints,
    };
    const overlayBaseLift = OVERLAY_BASE_LIFT[family];
    const lift = overlayBaseLift === undefined
      ? row.kind === "fill" ? 0.055 : 0.065
      : overlayBaseLift
        + (row.pathIndex * OVERLAY_PATH_LIFT)
        + (row.kind === "stroke" ? OVERLAY_STROKE_LIFT : 0);
    triangle.surfaceLift = rounded(lift);
    conformed.push(...conformTriangle(triangle, profiles, lift));
  }
  return Object.freeze({
    instance,
    position: FAMILY_POSITION[family][instance] === null
      ? null
      : Object.freeze(FAMILY_POSITION[family][instance]),
    pairedMirror: instance === 1,
    stateIds: Object.freeze(Object.keys(options.states).sort()),
    triangles: Object.freeze(conformed.map(({ triangle }) => Object.freeze({
      kind: triangle.kind,
      material: triangle.material,
      pathIndex: triangle.pathIndex,
      surfaceLift: triangle.surfaceLift,
      points: Object.freeze(triangle.points),
      states: Object.freeze(Object.fromEntries(Object.entries(triangle.states).map(([id, points]) => [
        id,
        Object.freeze(points),
      ]))),
    }))),
    minimumClearanceCssPx: conformed.length === 0
      ? null
      : rounded(Math.min(...conformed.map(({ clearance }) => clearance)) * MODEL_SCALE),
  });
}

export function compileFacesJsProjectedComponent({
  family,
  sourceId,
  fragment,
  sourceSha256,
  headFragments,
}) {
  if (!FACES_JS_PROJECTED_FAMILIES.includes(family)) {
    throw new TypeError(`FacesJS projected family ${family} is unsupported.`);
  }
  if (typeof fragment !== "string" || typeof sourceId !== "string") {
    throw new TypeError("FacesJS projected source id and fragment are required.");
  }
  if (sha256(fragment) !== sourceSha256) {
    throw new TypeError(`FacesJS ${family}.${sourceId} source hash is stale.`);
  }
  const paths = parseSvgFragment(fragment);
  const profiles = createHeadProfiles(headFragments);
  const instances = FAMILY_POSITION[family].map((_, instance) =>
    compileInstance(paths, family, sourceId, instance, profiles));
  const triangles = instances.flatMap((instance) => instance.triangles);
  const materialRoles = [...new Set(triangles.map(({ material: row }) => row.role))].sort();
  const allPoints = triangles.flatMap(({ points, states }) => [
    ...points,
    ...Object.values(states).flat(),
  ]);
  const minimumArea = triangles.length === 0
    ? null
    : Math.min(...triangles.map(({ points }) => triangleArea(points)));
  if (minimumArea !== null && (!Number.isFinite(minimumArea) || minimumArea <= 1e-12)) {
    throw new RangeError(
      `FacesJS ${family}.${sourceId} contains a degenerate triangle (${minimumArea}).`,
    );
  }
  const payload = {
    schema: FACES_JS_PROJECTED_COMPONENT_SCHEMA,
    family,
    sourceId,
    sourceSha256,
    layer: FAMILY_LAYER[family],
    attachment: family === "glasses" ? "raised" : "face-surface",
    attachmentProjection: family === "glasses"
      ? "raised-head-surface"
      : OVERLAY_BASE_LIFT[family] === undefined
        ? "strict-head-surface"
        : "clamped-head-surface",
    attachmentProfileIds: profiles.map(({ id }) => id),
    empty: triangles.length === 0,
    stateIds: Object.freeze([...new Set(instances.flatMap(({ stateIds }) => stateIds))].sort()),
    materialRoles,
    instances,
    metrics: {
      pathCount: paths.length,
      sourceSubpathCount: paths.reduce((sum, path) => sum + path.subpaths.length, 0),
      triangleCount: triangles.length,
      minimumTriangleArea: minimumArea === null ? null : rounded(minimumArea),
      minimumClearanceCssPx: triangles.length === 0
        ? null
        : rounded(Math.min(
          ...instances.map(({ minimumClearanceCssPx }) => minimumClearanceCssPx),
        )),
      sourceBounds: allPoints.length === 0 ? null : Object.freeze({
        minimumX: rounded(Math.min(...allPoints.map((point) => point[0]))),
        maximumX: rounded(Math.max(...allPoints.map((point) => point[0]))),
        minimumY: rounded(Math.min(...allPoints.map((point) => point[1]))),
        maximumY: rounded(Math.max(...allPoints.map((point) => point[1]))),
      }),
    },
  };
  return Object.freeze({
    ...payload,
    contentHash: sha256(JSON.stringify(payload)),
  });
}
