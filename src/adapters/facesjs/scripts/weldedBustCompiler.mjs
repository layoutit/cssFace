export const FACES_JS_HEAD_NECK_JUNCTION_SOURCE_Y = 480;

const MODEL_SCALE = 120;
const SVG_Z_SCALE = (1.48 - -0.99) / 400;
const POSITION_EPSILON = 1e-7;

function rounded(value) {
  const output = Number(value.toFixed(10));
  return Object.is(output, -0) ? 0 : output;
}

export const FACES_JS_HEAD_NECK_JUNCTION_MODEL_Y = rounded(
  -(1.48 - ((FACES_JS_HEAD_NECK_JUNCTION_SOURCE_Y - 100) * SVG_Z_SCALE)) * MODEL_SCALE,
);

function pointKey(point) {
  return point.map(rounded).join(",");
}

function edgeKey(first, second) {
  const left = pointKey(first);
  const right = pointKey(second);
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function polygonEdges(vertices) {
  return vertices.map((vertex, index) => [
    vertex,
    vertices[(index + 1) % vertices.length],
  ]);
}

function squaredDistance(left, right) {
  return left.reduce((sum, value, axis) => {
    const delta = value - right[axis];
    return sum + (delta * delta);
  }, 0);
}

function loopPerimeter(loop) {
  return polygonEdges(loop).reduce((sum, [first, second]) =>
    sum + Math.sqrt(squaredDistance(first, second)), 0);
}

function triangleAreaSquared(vertices) {
  const [origin, middle, end] = vertices;
  const first = middle.map((value, axis) => value - origin[axis]);
  const second = end.map((value, axis) => value - origin[axis]);
  const cross = [
    (first[1] * second[2]) - (first[2] * second[1]),
    (first[2] * second[0]) - (first[0] * second[2]),
    (first[0] * second[1]) - (first[1] * second[0]),
  ];
  return cross.reduce((sum, value) => sum + (value * value), 0) * 0.25;
}

function rotated(values, offset) {
  return values.map((_, index) => values[(index + offset) % values.length]);
}

function normalizedLoop(loop) {
  let rearIndex = 0;
  for (let index = 1; index < loop.length; index += 1) {
    if (loop[index][2] < loop[rearIndex][2]) rearIndex = index;
  }
  let output = rotated(loop, rearIndex);
  if (output[1][1] < output.at(-1)[1]) {
    output = [output[0], ...output.slice(1).reverse()];
  }
  return output;
}

function loopAmounts(loop) {
  const lengths = polygonEdges(loop).map(([first, second]) =>
    Math.sqrt(squaredDistance(first, second)));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total <= POSITION_EPSILON) {
    throw new RangeError("FacesJS welded neck boundary has no perimeter.");
  }
  const amounts = [0];
  for (let index = 1; index < loop.length; index += 1) {
    amounts.push(amounts.at(-1) + (lengths[index - 1] / total));
  }
  return amounts;
}

function edgeOwners(rows) {
  const owners = new Map();
  for (const row of rows) {
    for (const [first, second] of polygonEdges(row.vertices)) {
      const key = edgeKey(first, second);
      const ownerRows = owners.get(key) ?? [];
      ownerRows.push(row);
      owners.set(key, ownerRows);
    }
  }
  return owners;
}

function assertBoundaryOwnership(boundary, surfaceRows, neckRows, label) {
  const surfaceOwners = edgeOwners(surfaceRows);
  const neckOwners = edgeOwners(neckRows);
  for (const [first, second] of polygonEdges(boundary)) {
    const key = edgeKey(first, second);
    if (surfaceOwners.get(key)?.length !== 1 || neckOwners.get(key)?.length !== 1) {
      throw new RangeError(`FacesJS ${label} boundary is not welded exactly once.`);
    }
  }
}

function contractedNeckBoundary(bodyBoundary) {
  const horizontal = bodyBoundary.map((point) => point[1]);
  const depth = bodyBoundary.map((point) => point[2]);
  const centerHorizontal = (Math.min(...horizontal) + Math.max(...horizontal)) * 0.5;
  const centerDepth = (Math.min(...depth) + Math.max(...depth)) * 0.5;
  return bodyBoundary.map((point) => Object.freeze([
    point[0],
    rounded(centerHorizontal + ((point[1] - centerHorizontal) * 0.52)),
    rounded(centerDepth + ((point[2] - centerDepth) * 0.76)),
  ]));
}

function compileLoopStrip(upperBoundary, lowerBoundary) {
  const upper = normalizedLoop(upperBoundary);
  const lower = normalizedLoop(lowerBoundary);
  const upperAmounts = loopAmounts(upper);
  const lowerAmounts = loopAmounts(lower);
  const rows = [];
  let upperIndex = 0;
  let lowerIndex = 0;
  const append = (vertices) => {
    if (triangleAreaSquared(vertices) <= 1e-16) {
      throw new RangeError("FacesJS welded neck produced a degenerate cell.");
    }
    rows.push(Object.freeze({
      family: "body",
      role: "skin",
      vertices: Object.freeze(vertices.map((vertex) => Object.freeze([...vertex]))),
    }));
  };
  while (upperIndex < upper.length || lowerIndex < lower.length) {
    const upperPoint = upper[upperIndex % upper.length];
    const lowerPoint = lower[lowerIndex % lower.length];
    const nextUpperAmount = upperIndex + 1 === upper.length
      ? 1
      : upperAmounts[upperIndex + 1];
    const nextLowerAmount = lowerIndex + 1 === lower.length
      ? 1
      : lowerAmounts[lowerIndex + 1];
    if (Math.abs(nextUpperAmount - nextLowerAmount) <= 1e-12) {
      const nextUpper = upper[(upperIndex + 1) % upper.length];
      const nextLower = lower[(lowerIndex + 1) % lower.length];
      append([upperPoint, lowerPoint, nextLower]);
      append([upperPoint, nextLower, nextUpper]);
      upperIndex += 1;
      lowerIndex += 1;
    } else if (nextUpperAmount < nextLowerAmount) {
      append([upperPoint, lowerPoint, upper[(upperIndex + 1) % upper.length]]);
      upperIndex += 1;
    } else {
      append([upperPoint, lowerPoint, lower[(lowerIndex + 1) % lower.length]]);
      lowerIndex += 1;
    }
  }
  return rows;
}

export function isFacesJsHeadUndersidePolygon(vertices) {
  const belowJunction = vertices.some(
    (vertex) => vertex[1] > FACES_JS_HEAD_NECK_JUNCTION_MODEL_Y + POSITION_EPSILON,
  );
  const atOrBelowJunction = vertices.every(
    (vertex) => vertex[1] >= FACES_JS_HEAD_NECK_JUNCTION_MODEL_Y - POSITION_EPSILON,
  );
  const behindFace = vertices.every((vertex) => vertex[2] <= POSITION_EPSILON)
    && vertices.some((vertex) => vertex[2] < -POSITION_EPSILON);
  return belowJunction && atOrBelowJunction && behindFace;
}

export function extractFacesJsBoundaryLoop(rows, label) {
  const owners = edgeOwners(rows);
  const boundaryEdges = [...owners.entries()].filter(([, ownerRows]) => ownerRows.length === 1);
  if (boundaryEdges.length < 3) {
    throw new RangeError(`FacesJS ${label} has no open boundary.`);
  }
  const points = new Map();
  const adjacency = new Map();
  for (const [key, [owner]] of boundaryEdges) {
    const edge = polygonEdges(owner.vertices).find(([first, second]) => edgeKey(first, second) === key);
    if (!edge) throw new RangeError(`FacesJS ${label} boundary edge is absent.`);
    const [first, second] = edge;
    const firstKey = pointKey(first);
    const secondKey = pointKey(second);
    points.set(firstKey, first);
    points.set(secondKey, second);
    adjacency.set(firstKey, new Set([...(adjacency.get(firstKey) ?? []), secondKey]));
    adjacency.set(secondKey, new Set([...(adjacency.get(secondKey) ?? []), firstKey]));
  }
  if ([...adjacency.values()].some((neighbors) => neighbors.size !== 2)) {
    throw new RangeError(`FacesJS ${label} boundary is not one manifold loop.`);
  }
  const pending = new Set(adjacency.keys());
  const loops = [];
  while (pending.size) {
    const start = [...pending].sort()[0];
    const loop = [];
    let previous = null;
    let current = start;
    while (loop.length <= boundaryEdges.length) {
      loop.push(Object.freeze([...points.get(current)]));
      pending.delete(current);
      const next = [...adjacency.get(current)].find((candidate) => candidate !== previous);
      if (next === start) break;
      previous = current;
      current = next;
    }
    if (loop.length < 3 || current === start) {
      throw new RangeError(`FacesJS ${label} has an incomplete boundary loop.`);
    }
    loops.push(loop);
  }
  const loop = loops.sort((left, right) => loopPerimeter(right) - loopPerimeter(left))[0];
  return Object.freeze(loop);
}

export function compileFacesJsWeldedNeck({ headBoundary, bodyBoundary }) {
  if (headBoundary.length < 3 || bodyBoundary.length < 3) {
    throw new RangeError("FacesJS welded neck requires two manifold boundary loops.");
  }
  const neckBoundary = contractedNeckBoundary(bodyBoundary);
  const headRows = compileLoopStrip(headBoundary, neckBoundary);
  const shoulderRows = compileLoopStrip(neckBoundary, bodyBoundary);
  const rows = [...headRows, ...shoulderRows];
  assertBoundaryOwnership(headBoundary, [{ vertices: headBoundary }], headRows, "head-neck");
  assertBoundaryOwnership(bodyBoundary, [{ vertices: bodyBoundary }], shoulderRows, "neck-body");
  const rowOwners = edgeOwners(rows);
  for (const [first, second] of polygonEdges(neckBoundary)) {
    if (rowOwners.get(edgeKey(first, second))?.length !== 2) {
      throw new RangeError("FacesJS neck ring is not welded between neck and shoulders.");
    }
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    metrics: Object.freeze({
      topology: "shared-boundary-loft",
      headBoundaryEdges: headBoundary.length,
      neckBoundaryEdges: neckBoundary.length,
      bodyBoundaryEdges: bodyBoundary.length,
      polygonCount: rows.length,
      fatnessEndpoint: "head",
      bodySizeEndpoint: "body",
    }),
  });
}

export function assertFacesJsWeldedJunction({
  headRows,
  bodyRows,
  neckRows,
  headBoundary,
  bodyBoundary,
}) {
  assertBoundaryOwnership(headBoundary, headRows, neckRows, "head-neck");
  assertBoundaryOwnership(bodyBoundary, bodyRows, neckRows, "neck-body");
}
