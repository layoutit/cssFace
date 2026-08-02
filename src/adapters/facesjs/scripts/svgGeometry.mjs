import earcut from "earcut";
import svgpath from "svgpath";

const PATH_TAG = /<path\b([^>]*)\/?\s*>/giu;
const ATTRIBUTE = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
const POINT_EPSILON = 1e-7;

function distance(left, right) {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

function samePoint(left, right) {
  return distance(left, right) <= POINT_EPSILON;
}

function cubicPoint(start, controlA, controlB, end, amount) {
  const inverse = 1 - amount;
  return [0, 1].map((axis) =>
    (inverse ** 3 * start[axis])
    + (3 * inverse ** 2 * amount * controlA[axis])
    + (3 * inverse * amount ** 2 * controlB[axis])
    + (amount ** 3 * end[axis]));
}

function quadraticPoint(start, control, end, amount) {
  const inverse = 1 - amount;
  return [0, 1].map((axis) =>
    (inverse ** 2 * start[axis])
    + (2 * inverse * amount * control[axis])
    + (amount ** 2 * end[axis]));
}

function curveSteps(points) {
  let length = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    length += distance(points[index], points[index + 1]);
  }
  return Math.max(3, Math.min(48, Math.ceil(length / 5)));
}

function appendPoint(points, point) {
  if (!points.length || !samePoint(points.at(-1), point)) points.push(point);
}

function flattenPathData(data) {
  const parsed = svgpath(data).abs().unshort().unarc();
  if (parsed.err) throw new TypeError(`FacesJS SVG path is invalid: ${parsed.err}`);
  const subpaths = [];
  let points = [];
  let current = [0, 0];
  let start = null;
  let closed = false;

  const flush = () => {
    if (points.length > 1 && samePoint(points[0], points.at(-1))) points.pop();
    if (points.length > 1) subpaths.push(Object.freeze({
      points: Object.freeze(points.map((point) => Object.freeze(point))),
      closed,
    }));
    points = [];
    start = null;
    closed = false;
  };

  for (const segment of parsed.segments) {
    const command = segment[0];
    if (command === "M") {
      flush();
      current = [segment[1], segment[2]];
      start = current;
      appendPoint(points, current);
      continue;
    }
    if (command === "Z") {
      closed = true;
      if (start) current = start;
      continue;
    }
    if (!start) throw new TypeError("FacesJS SVG path draws before its first move command.");
    if (command === "L") {
      current = [segment[1], segment[2]];
      appendPoint(points, current);
      continue;
    }
    if (command === "H") {
      current = [segment[1], current[1]];
      appendPoint(points, current);
      continue;
    }
    if (command === "V") {
      current = [current[0], segment[1]];
      appendPoint(points, current);
      continue;
    }
    if (command === "C") {
      const controlA = [segment[1], segment[2]];
      const controlB = [segment[3], segment[4]];
      const end = [segment[5], segment[6]];
      const steps = curveSteps([current, controlA, controlB, end]);
      for (let step = 1; step <= steps; step += 1) {
        appendPoint(points, cubicPoint(current, controlA, controlB, end, step / steps));
      }
      current = end;
      continue;
    }
    if (command === "Q") {
      const control = [segment[1], segment[2]];
      const end = [segment[3], segment[4]];
      const steps = curveSteps([current, control, end]);
      for (let step = 1; step <= steps; step += 1) {
        appendPoint(points, quadraticPoint(current, control, end, step / steps));
      }
      current = end;
      continue;
    }
    throw new TypeError(`FacesJS SVG path command ${command} is unsupported.`);
  }
  flush();
  return Object.freeze(subpaths);
}

function attributes(source) {
  const result = {};
  for (const match of source.matchAll(ATTRIBUTE)) {
    result[match[1]] = match[2] ?? match[3] ?? "";
  }
  return result;
}

function styleProperties(source = "") {
  return Object.fromEntries(source.split(";").flatMap((declaration) => {
    const separator = declaration.indexOf(":");
    if (separator < 0) return [];
    return [[
      declaration.slice(0, separator).trim(),
      declaration.slice(separator + 1).trim(),
    ]];
  }));
}

export function parseSvgFragment(fragment) {
  const paths = [];
  for (const match of fragment.matchAll(PATH_TAG)) {
    const row = attributes(match[1]);
    const style = styleProperties(row.style);
    if (!row.d) throw new TypeError("FacesJS SVG path has no d attribute.");
    paths.push(Object.freeze({
      data: row.d,
      fill: row.fill ?? style.fill ?? "#000",
      stroke: row.stroke ?? style.stroke ?? "none",
      strokeWidth: Number.parseFloat(row["stroke-width"] ?? style["stroke-width"] ?? "1"),
      subpaths: flattenPathData(row.d),
    }));
  }
  if (!paths.length && fragment.trim()) {
    throw new TypeError("FacesJS SVG fragment contains no path geometry.");
  }
  return Object.freeze(paths);
}

export function boundsOfPaths(paths) {
  const points = paths.flatMap((path) => path.subpaths.flatMap((subpath) => subpath.points));
  if (!points.length) return null;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minimumX = Math.min(...xs);
  const maximumX = Math.max(...xs);
  const minimumY = Math.min(...ys);
  const maximumY = Math.max(...ys);
  return Object.freeze({
    minimumX,
    maximumX,
    minimumY,
    maximumY,
    centerX: (minimumX + maximumX) / 2,
    centerY: (minimumY + maximumY) / 2,
  });
}

export function transformSvgPoint(point, bounds, options = {}) {
  const {
    position = [bounds.centerX, bounds.centerY],
    scale = 1,
    scaleX = 1,
    mirrorX = false,
    angle = 0,
  } = options;
  const radians = angle * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const localX = (point[0] - bounds.centerX) * scale * scaleX * (mirrorX ? -1 : 1);
  const localY = (point[1] - bounds.centerY) * scale;
  return [
    position[0] + (localX * cosine) - (localY * sine),
    position[1] + (localX * sine) + (localY * cosine),
  ];
}

export function transformSvgPaths(paths, options = {}) {
  const bounds = boundsOfPaths(paths);
  if (!bounds) return Object.freeze([]);
  return Object.freeze(paths.map((path) => Object.freeze({
    ...path,
    subpaths: Object.freeze(path.subpaths.map((subpath) => Object.freeze({
      ...subpath,
      points: Object.freeze(subpath.points.map((point) =>
        Object.freeze(transformSvgPoint(point, bounds, options)))),
    }))),
  })));
}

function intersections(points, value, vertical) {
  const rows = [];
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const fixedStart = start[vertical ? 0 : 1];
    const fixedEnd = end[vertical ? 0 : 1];
    const changingStart = start[vertical ? 1 : 0];
    const changingEnd = end[vertical ? 1 : 0];
    if (Math.abs(fixedStart - fixedEnd) <= POINT_EPSILON) {
      if (Math.abs(value - fixedStart) <= POINT_EPSILON) {
        rows.push(changingStart, changingEnd);
      }
      continue;
    }
    const crosses = (fixedStart <= value && fixedEnd > value)
      || (fixedEnd <= value && fixedStart > value);
    if (!crosses) continue;
    const amount = (value - fixedStart) / (fixedEnd - fixedStart);
    rows.push(changingStart + ((changingEnd - changingStart) * amount));
  }
  return [...new Set(rows.map((row) => Math.round(row * 1e6) / 1e6))]
    .sort((left, right) => left - right);
}

export function horizontalSpanAtY(points, y) {
  const values = intersections(points, y, false);
  if (values.length < 2) return null;
  return Object.freeze([values[0], values.at(-1)]);
}

export function verticalSpanAtX(points, x) {
  const values = intersections(points, x, true);
  if (values.length < 2) return null;
  return Object.freeze([values[0], values.at(-1)]);
}

export function triangulateSvgContour(points) {
  if (points.length < 3) return Object.freeze([]);
  return Object.freeze(earcut(points.flat(), undefined, 2));
}
