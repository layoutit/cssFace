import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const SCHEMA = "cssface.facelines@1";

function finite(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be finite.`);
  }
  return value;
}

function integer(value, path) {
  const output = finite(value, path);
  if (!Number.isInteger(output)) throw new TypeError(`${path} must be an integer.`);
  return output;
}

function numberArray(value, length, path) {
  if (!Array.isArray(value) || (length !== undefined && value.length !== length)) {
    throw new TypeError(`${path} has an invalid length.`);
  }
  return value.map((entry, index) => finite(entry, `${path}[${index}]`));
}

function validateFaceline(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`facelines[${index}] must be an object.`);
  }
  if (integer(value.index, `facelines[${index}].index`) !== index) {
    throw new TypeError(`facelines[${index}] has the wrong index.`);
  }
  const positions = numberArray(value.positions, undefined, `facelines[${index}].positions`);
  if (positions.length === 0 || positions.length % 3 !== 0) {
    throw new TypeError(`facelines[${index}].positions must contain vec3 rows.`);
  }
  const vertexCount = positions.length / 3;
  const triangles = numberArray(value.triangles, undefined, `facelines[${index}].triangles`)
    .map((entry, triangleIndex) => {
      const vertex = integer(entry, `facelines[${index}].triangles[${triangleIndex}]`);
      if (vertex < 0 || vertex >= vertexCount) {
        throw new RangeError(`facelines[${index}] triangle vertex ${vertex} is invalid.`);
      }
      return vertex;
    });
  if (triangles.length === 0 || triangles.length % 3 !== 0) {
    throw new TypeError(`facelines[${index}].triangles must contain triangle rows.`);
  }
  if (!Array.isArray(value.boundaryLoops) || value.boundaryLoops.length !== 1) {
    throw new TypeError(`facelines[${index}] must be one connected open mask.`);
  }
  const boundaryLoops = value.boundaryLoops.map((loop, loopIndex) =>
    numberArray(loop, undefined, `facelines[${index}].boundaryLoops[${loopIndex}]`)
      .map((entry, vertexIndex) => {
        const vertex = integer(
          entry,
          `facelines[${index}].boundaryLoops[${loopIndex}][${vertexIndex}]`,
        );
        if (vertex < 0 || vertex >= vertexCount) {
          throw new RangeError(`facelines[${index}] boundary vertex ${vertex} is invalid.`);
        }
        return vertex;
      }));
  const adjacency = new Map();
  for (let offset = 0; offset < triangles.length; offset += 3) {
    const row = triangles.slice(offset, offset + 3);
    for (const [left, right] of [[row[0], row[1]], [row[1], row[2]], [row[2], row[0]]]) {
      adjacency.set(left, new Set([...(adjacency.get(left) ?? []), right]));
      adjacency.set(right, new Set([...(adjacency.get(right) ?? []), left]));
    }
  }
  const usedVertices = new Set(triangles);
  const visited = new Set();
  const pending = [triangles[0]];
  while (pending.length > 0) {
    const vertex = pending.pop();
    if (visited.has(vertex)) continue;
    visited.add(vertex);
    pending.push(...(adjacency.get(vertex) ?? []));
  }
  if (visited.size !== usedVertices.size) {
    throw new TypeError(`facelines[${index}] contains disconnected geometry.`);
  }
  return Object.freeze({
    index,
    positions: Object.freeze(positions),
    triangles: Object.freeze(triangles),
    boundaryLoops: Object.freeze(boundaryLoops.map(Object.freeze)),
  });
}

export async function loadBakedFaceline(path, index) {
  const bytes = await readFile(path);
  const document = JSON.parse(bytes.toString("utf8"));
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new TypeError("Baked faceline geometry must be an object.");
  }
  if (document.schema !== SCHEMA) {
    throw new TypeError(`Expected ${SCHEMA}, received ${document.schema}.`);
  }
  if (!Array.isArray(document.facelines) || document.facelines.length !== 8) {
    throw new TypeError("Baked faceline geometry must contain eight facelines.");
  }
  const facelines = document.facelines.map(validateFaceline);
  const facelineIndex = integer(index, "faceline index");
  if (facelineIndex < 0 || facelineIndex >= facelines.length) {
    throw new RangeError(`Faceline index ${facelineIndex} is outside 0..7.`);
  }
  return Object.freeze({
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    shape: facelines[facelineIndex],
  });
}

function barycentricDepth(a, b, c, x, z) {
  const denominator = ((b[2] - c[2]) * (a[0] - c[0]))
    + ((c[0] - b[0]) * (a[2] - c[2]));
  if (Math.abs(denominator) <= 1e-10) return null;
  const first = (((b[2] - c[2]) * (x - c[0]))
    + ((c[0] - b[0]) * (z - c[2]))) / denominator;
  const second = (((c[2] - a[2]) * (x - c[0]))
    + ((a[0] - c[0]) * (z - c[2]))) / denominator;
  const third = 1 - first - second;
  const epsilon = 1e-6;
  if (first < -epsilon || second < -epsilon || third < -epsilon) return null;
  return (first * a[1]) + (second * b[1]) + (third * c[1]);
}

export function normalizeBakedFaceline(
  faceline,
  { bottom, frontDepth, halfWidth, top },
) {
  const rawPoints = Array.from(
    { length: faceline.shape.positions.length / 3 },
    (_, index) => faceline.shape.positions.slice(index * 3, index * 3 + 3),
  );
  const xs = rawPoints.map((point) => point[0]);
  const ys = rawPoints.map((point) => point[1]);
  const zs = rawPoints.map((point) => point[2]);
  const minimumX = Math.min(...xs);
  const maximumX = Math.max(...xs);
  const minimumY = Math.min(...ys);
  const maximumY = Math.max(...ys);
  const maximumZ = Math.max(...zs);
  const centerX = (minimumX + maximumX) / 2;
  const horizontalScale = halfWidth / Math.max(maximumX - centerX, centerX - minimumX);
  const verticalScale = (top - bottom) / (maximumY - minimumY);
  const depthScale = frontDepth / maximumZ;
  const points = rawPoints.map(([x, y, z]) => Object.freeze([
    (x - centerX) * horizontalScale,
    -z * depthScale,
    bottom + ((y - minimumY) * verticalScale),
  ]));
  const triangles = [];
  for (let offset = 0; offset < faceline.shape.triangles.length; offset += 3) {
    triangles.push(Object.freeze(faceline.shape.triangles
      .slice(offset, offset + 3)
      .map((vertex) => points[vertex])));
  }
  const boundaryLoops = faceline.shape.boundaryLoops.map((loop) => Object.freeze(
    loop.map((vertex) => points[vertex]),
  ));
  const boundary = boundaryLoops.toSorted((left, right) => {
    const averageZ = (loop) => loop.reduce((sum, point) => sum + point[2], 0) / loop.length;
    return averageZ(right) - averageZ(left);
  })[0];
  if (!boundary) throw new TypeError(`Faceline ${faceline.shape.index} has no boundary.`);
  return Object.freeze({
    index: faceline.shape.index,
    artifactSha256: faceline.artifactSha256,
    points: Object.freeze(points),
    triangles: Object.freeze(triangles),
    boundary,
    surfaceY(x, z, width = 1) {
      const sourceX = x / width;
      let front = Infinity;
      for (const [a, b, c] of triangles) {
        const depth = barycentricDepth(a, b, c, sourceX, z);
        if (depth !== null) front = Math.min(front, depth);
      }
      return Number.isFinite(front) ? front : null;
    },
  });
}
