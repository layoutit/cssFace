import { createHash } from "node:crypto";

import {
  triangulateFacesJsPaint,
} from "./projectedComponentCompiler.mjs";
import {
  horizontalSpanAtY,
  parseSvgFragment,
  triangulateSvgContour,
} from "./svgGeometry.mjs";

export const FACES_JS_BODY_REGION_SCHEMA = "cssface.facesjs-body-region@1";
export const FACES_JS_BODY_REGION_FAMILIES = Object.freeze(["body", "jersey"]);

const SVG_X_SCALE = 1.07 / 150;
const SVG_Z_SCALE = (1.48 - -0.99) / 400;
const MODEL_SCALE = 120;
const BODY_RADIAL_SEGMENTS = 16;
const BODY_ROW_STEP = 2;
const BODY_DEPTH_RATIO = 0.46;
const BODY_SIZE_MINIMUM = 0.8;
const BODY_SIZE_MAXIMUM = 1.05;
const JERSEY_RADIUS = 205;
const JERSEY_DEPTH_RATIO = 0.48;
const JERSEY_FRONT_OFFSET = -0.02;
const JERSEY_REAR_OFFSET = 0.005;
const PAINT_PATH_LIFT = 0.002;
const PAINT_STROKE_LIFT = 0.001;

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

function sourceX(value) {
  return (value - 200) * SVG_X_SCALE;
}

function sourceZ(value) {
  return 1.48 - ((value - 100) * SVG_Z_SCALE);
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
  const edges = new Map();
  const adjacency = new Map();
  const triangleKeys = new Set();
  let duplicateTriangleCount = 0;
  let minimumTriangleArea = Infinity;
  for (const triangle of triangles) {
    const key = [...triangle.indices].sort((left, right) => left - right).join(":");
    if (triangleKeys.has(key)) duplicateTriangleCount += 1;
    triangleKeys.add(key);
    const points = triangle.indices.map((index) => vertices[index].position);
    minimumTriangleArea = Math.min(minimumTriangleArea, triangleArea(points));
    for (const [left, right] of [
      [triangle.indices[0], triangle.indices[1]],
      [triangle.indices[1], triangle.indices[2]],
      [triangle.indices[2], triangle.indices[0]],
    ]) {
      const edge = left < right ? `${left}:${right}` : `${right}:${left}`;
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
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
    duplicateTriangleCount,
    connected: visited.size === used.size,
    minimumTriangleArea: Number(minimumTriangleArea.toFixed(14)),
    signedVolume: rounded(signedVolume(vertices, triangles)),
  });
}

function primaryContour(paths, family, sourceId, pathIndex = 0) {
  const contour = paths[pathIndex]?.subpaths.find(({ points }) => points.length >= 3)?.points;
  if (!contour) throw new TypeError(`FacesJS ${family}.${sourceId} has no primary contour.`);
  return contour;
}

function spanAtY(contour, sourceY) {
  const minimumY = Math.min(...contour.map((point) => point[1]));
  const maximumY = Math.max(...contour.map((point) => point[1]));
  const range = maximumY - minimumY;
  const inset = Math.min(1e-4, range / 10000);
  const clamped = sourceY <= minimumY
    ? minimumY + inset
    : sourceY >= maximumY ? maximumY - inset : sourceY;
  return horizontalSpanAtY(contour, clamped);
}

function profileRows(contour) {
  const minimumY = Math.min(...contour.map((point) => point[1]));
  const maximumY = Math.max(...contour.map((point) => point[1]));
  const rows = [...new Set([
    minimumY,
    maximumY,
    ...contour.map((point) => point[1]),
    ...Array.from(
      { length: Math.ceil((maximumY - minimumY) / BODY_ROW_STEP) - 1 },
      (_, index) => minimumY + ((index + 1) * BODY_ROW_STEP),
    ).filter((value) => value < maximumY),
  ])].sort((left, right) => left - right)
    .filter((value, index, values) => index === 0 || value - values[index - 1] > 0.05)
    .map((sourceY) => {
      if (Math.abs(sourceY - minimumY) <= 1e-7) {
        const edgeXs = contour
          .filter((point) => Math.abs(point[1] - minimumY) <= 1e-7)
          .map((point) => point[0]);
        if (edgeXs.length && Math.max(...edgeXs) - Math.min(...edgeXs) <= 0.01) {
          return {
            sourceY,
            centerX: edgeXs.reduce((sum, value) => sum + value, 0) / edgeXs.length,
            radius: 0,
          };
        }
      }
      const span = spanAtY(contour, sourceY);
      if (!span) throw new RangeError(`FacesJS body contour has no span at y=${sourceY}.`);
      return {
        sourceY,
        centerX: (span[0] + span[1]) * 0.5,
        radius: (span[1] - span[0]) * 0.5,
      };
    });
  return rows;
}

function bodySilhouetteError(contour, rows) {
  let maximum = 0;
  for (let index = 0; index < rows.length - 1; index += 1) {
    const first = rows[index];
    const second = rows[index + 1];
    for (const amount of [0.25, 0.5, 0.75]) {
      const sourceY = first.sourceY + ((second.sourceY - first.sourceY) * amount);
      const span = spanAtY(contour, sourceY);
      if (!span) continue;
      for (const side of [-1, 1]) {
        const firstEdge = first.centerX + (side * first.radius);
        const expected = firstEdge + (((second.centerX + (side * second.radius)) - firstEdge) * amount);
        maximum = Math.max(maximum, Math.abs(expected - span[side < 0 ? 0 : 1]));
      }
    }
  }
  return rounded(maximum * SVG_X_SCALE * MODEL_SCALE);
}

function bodyVertex(source, depth) {
  const x = sourceX(source[0]);
  const position = [x * BODY_SIZE_MINIMUM, depth, sourceZ(source[1])];
  return Object.freeze({
    source: roundedPoint(source),
    position: roundedPoint(position),
    states: Object.freeze({
      "body-size": roundedPoint([x * BODY_SIZE_MAXIMUM, depth, position[2]]),
    }),
  });
}

function buildBodyShell(contour) {
  const rows = profileRows(contour);
  const vertices = [];
  const rowIndices = [];
  for (const row of rows) {
    if (row.radius <= 1e-5) {
      rowIndices.push([vertices.length]);
      vertices.push(bodyVertex([row.centerX, row.sourceY], 0));
      continue;
    }
    const indices = [];
    for (let segment = 0; segment < BODY_RADIAL_SEGMENTS; segment += 1) {
      const angle = (segment / BODY_RADIAL_SEGMENTS) * Math.PI * 2;
      const sourcePoint = [
        row.centerX + (Math.cos(angle) * row.radius),
        row.sourceY,
      ];
      const depth = Math.sin(angle) * row.radius * SVG_X_SCALE * BODY_DEPTH_RATIO;
      indices.push(vertices.length);
      vertices.push(bodyVertex(sourcePoint, depth));
    }
    rowIndices.push(indices);
  }

  const triangles = [];
  const append = (indices, surface) => triangles.push({ indices, materialRole: "skin", surface });
  const connect = (first, second) => {
    if (first.length === 1 && second.length === 1) return;
    if (first.length === 1) {
      for (let segment = 0; segment < second.length; segment += 1) {
        append([first[0], second[segment], second[(segment + 1) % second.length]], "surface");
      }
      return;
    }
    if (second.length === 1) {
      for (let segment = 0; segment < first.length; segment += 1) {
        append([first[segment], second[0], first[(segment + 1) % first.length]], "surface");
      }
      return;
    }
    for (let segment = 0; segment < first.length; segment += 1) {
      const next = (segment + 1) % first.length;
      append([first[segment], second[segment], second[next]], "surface");
      append([first[segment], second[next], first[next]], "surface");
    }
  };
  for (let index = 0; index < rowIndices.length - 1; index += 1) {
    connect(rowIndices[index], rowIndices[index + 1]);
  }
  for (const [indices, surface] of [
    [rowIndices[0], "top-cap"],
    [rowIndices.at(-1), "bottom-cap"],
  ]) {
    if (indices.length === 1) continue;
    const row = surface === "top-cap" ? rows[0] : rows.at(-1);
    const center = vertices.length;
    vertices.push(bodyVertex([row.centerX, row.sourceY], 0));
    for (let segment = 0; segment < indices.length; segment += 1) {
      append([center, indices[segment], indices[(segment + 1) % indices.length]], surface);
    }
  }
  return Object.freeze({
    vertices: Object.freeze(vertices),
    triangles: orientClosedMesh(vertices, triangles),
    sourceRows: rows.length,
    frontSilhouetteErrorCssPx: bodySilhouetteError(contour, rows),
  });
}

function sourceIntersections(contour, sourceY) {
  const values = [];
  for (let index = 0; index < contour.length; index += 1) {
    const start = contour[index];
    const end = contour[(index + 1) % contour.length];
    if (Math.abs(start[1] - end[1]) <= 1e-7) continue;
    if (!((start[1] <= sourceY && end[1] > sourceY)
      || (end[1] <= sourceY && start[1] > sourceY))) continue;
    const amount = (sourceY - start[1]) / (end[1] - start[1]);
    values.push(start[0] + ((end[0] - start[0]) * amount));
  }
  return [...new Set(values.map((value) => rounded(value)))].sort((left, right) => left - right);
}

function simplifyContour(contour) {
  const output = contour.filter((point, index) => index === 0
    || Math.hypot(
      point[0] - contour[index - 1][0],
      point[1] - contour[index - 1][1],
    ) > 0.05).map((point) => [...point]);
  if (output.length > 2 && Math.hypot(
    output[0][0] - output.at(-1)[0],
    output[0][1] - output.at(-1)[1],
  ) <= 0.05) output.pop();
  let changed = true;
  while (changed && output.length > 3) {
    changed = false;
    for (let index = 0; index < output.length; index += 1) {
      const previous = output[(index - 1 + output.length) % output.length];
      const current = output[index];
      const next = output[(index + 1) % output.length];
      const twiceArea = Math.abs(
        ((current[0] - previous[0]) * (next[1] - previous[1]))
        - ((current[1] - previous[1]) * (next[0] - previous[0])),
      );
      if (twiceArea > 0.02) continue;
      output.splice(index, 1);
      changed = true;
      break;
    }
  }
  return Object.freeze(output.map(roundedPoint));
}

function baseballEnvelope(paths, sourceId) {
  const contours = [0, 1, 2].map((pathIndex) =>
    primaryContour(paths, "jersey", sourceId, pathIndex));
  const minimumY = Math.min(...contours.flatMap((contour) => contour.map((point) => point[1])));
  const maximumY = Math.max(...contours.flatMap((contour) => contour.map((point) => point[1])));
  const sourceRows = [...new Set([
    minimumY,
    maximumY,
    ...contours.flatMap((contour) => contour.map((point) => point[1])),
    ...Array.from(
      { length: Math.ceil((maximumY - minimumY) / 1.5) - 1 },
      (_, index) => minimumY + ((index + 1) * 1.5),
    ).filter((value) => value < maximumY),
  ])].sort((left, right) => left - right);
  const rows = sourceRows.flatMap((sourceY) => {
    const spans = contours.map((contour) => spanAtY(contour, sourceY)).filter(Boolean);
    return spans.length === 0 ? [] : [{
      sourceY,
      left: Math.min(...spans.map((span) => span[0])),
      right: Math.max(...spans.map((span) => span[1])),
    }];
  });
  const points = [
    ...rows.map(({ left, sourceY }) => [left, sourceY]),
    ...rows.slice().reverse().map(({ right, sourceY }) => [right, sourceY]),
  ];
  return simplifyContour(points);
}

function paintRole(value, family) {
  const color = value.trim().toLowerCase();
  if (color === "none") return null;
  if (color === "$[skincolor]") return "skin";
  if (color === "$[primary]") return "team-primary";
  if (color === "$[secondary]") return "team-secondary";
  if (color === "$[accent]") return "team-accent";
  if (color === "#fff" || color === "#ffffff") {
    return family === "jersey" ? "jersey-white" : "highlight";
  }
  if (color === "#000" || color === "#000000") return "ink";
  throw new TypeError(`FacesJS ${family} region has unsupported paint ${value}.`);
}

function garmentDepth(sourceValue) {
  const normalized = Math.min(1 - 1e-7, Math.abs(sourceValue - 200) / JERSEY_RADIUS);
  return -(JERSEY_RADIUS * SVG_X_SCALE * JERSEY_DEPTH_RATIO
    * Math.sqrt(1 - (normalized * normalized)));
}

function regionVertex(source, depth) {
  const x = sourceX(source[0]);
  const position = [x * BODY_SIZE_MINIMUM, depth, sourceZ(source[1])];
  return Object.freeze({
    source: roundedPoint(source),
    position: roundedPoint(position),
    states: Object.freeze({
      "body-size": roundedPoint([x * BODY_SIZE_MAXIMUM, depth, position[2]]),
    }),
  });
}

function buildGarmentShell(contour, materialRole) {
  const vertices = [];
  const front = contour.map((source) => {
    const index = vertices.length;
    vertices.push(regionVertex(source, garmentDepth(source[0]) + JERSEY_FRONT_OFFSET));
    return index;
  });
  const rear = contour.map((source) => {
    const index = vertices.length;
    vertices.push(regionVertex(source, garmentDepth(source[0]) + JERSEY_REAR_OFFSET));
    return index;
  });
  const indices = triangulateSvgContour(contour);
  const triangles = [];
  for (let offset = 0; offset < indices.length; offset += 3) {
    const row = indices.slice(offset, offset + 3);
    triangles.push({
      indices: row.map((index) => front[index]),
      materialRole,
      surface: "front",
    }, {
      indices: row.map((index) => rear[index]),
      materialRole,
      surface: "rear",
    });
  }
  for (let index = 0; index < contour.length; index += 1) {
    const next = (index + 1) % contour.length;
    triangles.push({
      indices: [front[index], front[next], rear[next]],
      materialRole,
      surface: "side",
    }, {
      indices: [front[index], rear[next], rear[index]],
      materialRole,
      surface: "side",
    });
  }
  return Object.freeze({
    vertices: Object.freeze(vertices),
    triangles: orientClosedMesh(vertices, triangles),
  });
}

function bodySurfaceDepth(contour, source) {
  const minimumY = Math.min(...contour.map((point) => point[1]));
  const maximumY = Math.max(...contour.map((point) => point[1]));
  if (source[1] < minimumY || source[1] > maximumY) return null;
  const span = spanAtY(contour, source[1]);
  if (!span || source[0] < span[0] || source[0] > span[1]) return null;
  const center = (span[0] + span[1]) * 0.5;
  const radius = (span[1] - span[0]) * 0.5;
  if (radius <= 1e-6) return 0;
  const normalized = Math.min(1 - 1e-7, Math.abs(source[0] - center) / radius);
  return -(radius * SVG_X_SCALE * BODY_DEPTH_RATIO
    * Math.sqrt(1 - (normalized * normalized)));
}

function mappedPaintTriangles(paths, family, filter, depthFor) {
  return Object.freeze(triangulateFacesJsPaint(paths, {}, family)
    .filter(filter)
    .filter((triangle) => {
      const path = paths[triangle.pathIndex];
      return triangle.kind !== "stroke"
        || path.strokeWidth > 1
        || path.fill.trim().toLowerCase() !== path.stroke.trim().toLowerCase();
    })
    .map((triangle) => {
      const lift = ((triangle.pathIndex + 1) * PAINT_PATH_LIFT)
        + (triangle.kind === "stroke" ? PAINT_STROKE_LIFT : 0);
      return Object.freeze({
        kind: triangle.kind,
        material: triangle.material,
        pathIndex: triangle.pathIndex,
        surfaceLiftCssPx: rounded(lift * MODEL_SCALE),
        vertices: Object.freeze(triangle.points.map((source) =>
          regionVertex(source, depthFor(source) - lift))),
      });
    }));
}

function validateClosedMesh(label, mesh) {
  const topology = topologyMetrics(mesh.vertices, mesh.triangles);
  if (!topology.connected || topology.nonManifoldEdgeCount !== 0
    || topology.duplicateTriangleCount !== 0 || topology.minimumTriangleArea <= 0
    || topology.signedVolume <= 0 || signedVolume(mesh.vertices, mesh.triangles, "body-size") <= 0) {
    throw new RangeError(`${label} shell topology is invalid: ${JSON.stringify(topology)}.`);
  }
  return topology;
}

function compileBody({ sourceId, paths, compatibleJerseyIds }) {
  const contour = primaryContour(paths, "body", sourceId);
  const mesh = buildBodyShell(contour);
  const details = mappedPaintTriangles(
    paths,
    "body",
    ({ pathIndex }) => pathIndex > 0,
    (source) => bodySurfaceDepth(contour, source) ?? -0.002,
  );
  const topology = validateClosedMesh(`FacesJS body.${sourceId}`, mesh);
  return {
    layer: 1,
    attachment: "body-shell",
    materialRoles: [...new Set(["skin", ...details.map(({ material }) => material.role)])].sort(),
    empty: false,
    stateIds: ["body-size"],
    provenance: {
      frontSilhouette: "facesjs-svg-contour",
      depthProfile: "adapter-authored-elliptic-sweep",
      rearClosure: "adapter-authored-elliptic-sweep",
    },
    attachmentProfile: {
      id: "facesjs-body-region-v1",
      bodySizeRange: [BODY_SIZE_MINIMUM, BODY_SIZE_MAXIMUM],
      compatibleJerseyIds,
    },
    outlinePolicy: {
      silhouetteStroke: "omitted-shell-boundary",
      retainedDetailPathIndexes: [...new Set(details.map(({ pathIndex }) => pathIndex))],
    },
    mesh,
    surfaceDetails: details,
    metrics: {
      vertexCount: mesh.vertices.length,
      triangleCount: mesh.triangles.length + details.length,
      shellTriangleCount: mesh.triangles.length,
      detailTriangleCount: details.length,
      frontSilhouetteErrorCssPx: mesh.frontSilhouetteErrorCssPx,
      ...topology,
    },
  };
}

function garmentContour(paths, sourceId) {
  return sourceId.startsWith("baseball")
    ? baseballEnvelope(paths, sourceId)
    : simplifyContour(primaryContour(paths, "jersey", sourceId));
}

function garmentShellPathIndexes(sourceId) {
  return sourceId.startsWith("baseball") ? [1, 2] : [0];
}

function clearanceByBody(contour, bodyProfiles) {
  const indices = triangulateSvgContour(contour);
  const samples = [...contour];
  for (let offset = 0; offset < indices.length; offset += 3) {
    const points = indices.slice(offset, offset + 3).map((index) => contour[index]);
    samples.push([
      points.reduce((sum, point) => sum + point[0], 0) / 3,
      points.reduce((sum, point) => sum + point[1], 0) / 3,
    ]);
  }
  return Object.fromEntries(Object.entries(bodyProfiles).sort(([left], [right]) =>
    left.localeCompare(right)).map(([sourceId, bodyContour]) => {
    let minimum = Infinity;
    for (const source of samples) {
      const bodyDepth = bodySurfaceDepth(bodyContour, source);
      if (bodyDepth === null) continue;
      const jerseyRear = garmentDepth(source[0]) + JERSEY_REAR_OFFSET;
      minimum = Math.min(minimum, bodyDepth - jerseyRear);
    }
    if (!Number.isFinite(minimum)) {
      throw new RangeError(`FacesJS jersey has no attachment samples on body.${sourceId}.`);
    }
    return [sourceId, rounded(minimum * MODEL_SCALE)];
  }));
}

function compileJersey({ sourceId, paths, bodyProfiles }) {
  const contour = garmentContour(paths, sourceId);
  const shellPathIndexes = garmentShellPathIndexes(sourceId);
  const shellRole = paintRole(paths[shellPathIndexes[0]].fill, "jersey");
  if (!shellRole) throw new TypeError(`FacesJS jersey.${sourceId} has no shell fill.`);
  const mesh = buildGarmentShell(contour, shellRole);
  const paint = mappedPaintTriangles(
    paths,
    "jersey",
    ({ pathIndex }) => !shellPathIndexes.includes(pathIndex),
    (source) => garmentDepth(source[0]) + JERSEY_FRONT_OFFSET,
  );
  const topology = validateClosedMesh(`FacesJS jersey.${sourceId}`, mesh);
  const clearances = clearanceByBody(contour, bodyProfiles);
  const minimumClearanceCssPx = Math.min(...Object.values(clearances));
  if (minimumClearanceCssPx < 0.72) {
    throw new RangeError(
      `FacesJS jersey.${sourceId} body clearance ${minimumClearanceCssPx}px is below 0.72px.`,
    );
  }
  const maximumHorizontalRegions = Math.max(...Array.from(
    { length: 25 },
    (_, index) => {
      const ys = contour.map((point) => point[1]);
      const sourceY = Math.min(...ys) + ((Math.max(...ys) - Math.min(...ys)) * index / 24);
      return Math.floor(sourceIntersections(contour, sourceY).length / 2);
    },
  ));
  return {
    layer: 2,
    attachment: "body-shell",
    materialRoles: [...new Set([shellRole, ...paint.map(({ material }) => material.role)])].sort(),
    empty: false,
    stateIds: ["body-size"],
    provenance: {
      frontSilhouette: sourceId.startsWith("baseball")
        ? "facesjs-svg-fill-union-envelope"
        : "facesjs-svg-contour",
      depthProfile: "adapter-authored-raised-torso-surface",
      rearClosure: "adapter-authored-thin-shell",
    },
    attachmentProfile: {
      id: "facesjs-body-region-v1",
      bodySizeRange: [BODY_SIZE_MINIMUM, BODY_SIZE_MAXIMUM],
      compatibleBodyIds: Object.keys(bodyProfiles).sort(),
      clearanceByBodyCssPx: clearances,
    },
    openingSemantics: {
      kind: sourceId.startsWith("jersey") ? "tank-top" : "closed-shoulder",
      sourceContourPreserved: !sourceId.startsWith("baseball"),
      maximumHorizontalRegions,
    },
    outlinePolicy: {
      silhouetteStroke: "omitted-shell-boundary",
      omittedPathIndexes: shellPathIndexes,
      retainedPaintPathIndexes: [...new Set(paint.map(({ pathIndex }) => pathIndex))],
    },
    mesh,
    surfacePaint: paint,
    metrics: {
      vertexCount: mesh.vertices.length,
      triangleCount: mesh.triangles.length + paint.length,
      shellTriangleCount: mesh.triangles.length,
      paintTriangleCount: paint.length,
      minimumBodyClearanceCssPx: rounded(minimumClearanceCssPx),
      ...topology,
    },
  };
}

export function compileFacesJsBodyRegion({
  family,
  sourceId,
  fragment,
  sourceSha256,
  bodyFragments,
  jerseySourceIds,
}) {
  if (!FACES_JS_BODY_REGION_FAMILIES.includes(family)) {
    throw new TypeError(`FacesJS body-region family ${family} is unsupported.`);
  }
  if (sha256(fragment) !== sourceSha256) {
    throw new TypeError(`FacesJS ${family}.${sourceId} source hash is stale.`);
  }
  const paths = parseSvgFragment(fragment);
  const bodyProfiles = Object.fromEntries(Object.entries(bodyFragments).map(([id, source]) => [
    id,
    primaryContour(parseSvgFragment(source), "body", id),
  ]));
  const compiled = family === "body"
    ? compileBody({
      sourceId,
      paths,
      compatibleJerseyIds: [...jerseySourceIds].sort(),
    })
    : compileJersey({ sourceId, paths, bodyProfiles });
  const payload = {
    schema: FACES_JS_BODY_REGION_SCHEMA,
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
