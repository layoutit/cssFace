import {
  cssPositionToWorld,
} from "@layoutit/polycss";

import {
  horizontalSpanAtY,
  parseSvgFragment,
} from "./svgGeometry.mjs";

const MODEL_SCALE = 120;
const SVG_X_SCALE = 1.07 / 150;
const SVG_Z_SCALE = (1.48 - -0.99) / 400;
const BODY_DEPTH_RATIO = 0.46;

function rounded(value) {
  const output = Number(value.toFixed(10));
  return Object.is(output, -0) ? 0 : output;
}

function transformCssPoint(matrix, point) {
  const [x, y, z] = point;
  return [
    rounded(matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]),
    rounded(matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]),
    rounded(matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]),
  ];
}

function primaryContour(fragment, label) {
  const contour = parseSvgFragment(fragment)
    .flatMap((path) => path.subpaths)
    .find(({ points }) => points.length >= 3)?.points;
  if (!contour) throw new TypeError(`${label} has no primary contour.`);
  return contour;
}

function horizontalIntersections(contour, sourceY) {
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
  return [...new Set(values.map((value) => rounded(value)))]
    .sort((left, right) => left - right);
}

function bodyRow(bodyContour, sourceY) {
  const span = horizontalSpanAtY(bodyContour, sourceY);
  if (!span) throw new RangeError(`FacesJS body contour has no row at y=${sourceY}.`);
  return {
    sourceY,
    bodyLeft: span[0],
    bodyRight: span[1],
  };
}

function tankTopRow(bodyContour, jerseyContour, sourceY) {
  const row = bodyRow(bodyContour, sourceY);
  const intersections = horizontalIntersections(jerseyContour, sourceY);
  const clamp = (value) => Math.max(row.bodyLeft, Math.min(row.bodyRight, value));
  if (sourceY <= 510) {
    if (intersections.length < 2) {
      throw new RangeError(`FacesJS jersey contour has no strap roots at y=${sourceY}.`);
    }
    const left = clamp(intersections[0]);
    const right = clamp(intersections.at(-1));
    return {
      ...row,
      outerLeft: left,
      innerLeft: left,
      innerRight: right,
      outerRight: right,
    };
  }
  if (sourceY < 590) {
    if (intersections.length !== 4) {
      throw new RangeError(`FacesJS jersey contour expected four crossings at y=${sourceY}.`);
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
    throw new RangeError(`FacesJS jersey contour has no torso span at y=${sourceY}.`);
  }
  return {
    ...row,
    outerLeft: clamp(intersections[0]),
    innerLeft: 200,
    innerRight: 200,
    outerRight: clamp(intersections.at(-1)),
  };
}

function contains(contour, [x, y]) {
  let inside = false;
  for (let index = 0, previousIndex = contour.length - 1;
    index < contour.length;
    previousIndex = index, index += 1) {
    const point = contour[index];
    const previous = contour[previousIndex];
    if ((point[1] > y) !== (previous[1] > y)
      && x < ((previous[0] - point[0]) * (y - point[1])
        / (previous[1] - point[1])) + point[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function localBodyPoint(bodyContour, [sourceX, sourceY], side) {
  const span = horizontalSpanAtY(bodyContour, sourceY);
  if (!span) throw new RangeError(`FacesJS body contour has no point at y=${sourceY}.`);
  const center = (span[0] + span[1]) * 0.5;
  const sourceRadius = (span[1] - span[0]) * 0.5;
  const normalized = sourceRadius <= 1e-9
    ? 0
    : Math.max(-1, Math.min(1, (sourceX - center) / sourceRadius));
  const radialSquared = Math.max(0, 1 - (normalized * normalized));
  return [
    (sourceX - 200) * SVG_X_SCALE,
    side * sourceRadius * SVG_X_SCALE * BODY_DEPTH_RATIO
      * (radialSquared <= 1e-12 ? 0 : Math.sqrt(radialSquared)),
    1.48 - ((sourceY - 100) * SVG_Z_SCALE),
  ];
}

function sourceInterval(left, right, sourceY, subdivisions) {
  return Array.from({ length: subdivisions + 1 }, (_, index) => [
    left + ((right - left) * index / subdivisions),
    sourceY,
  ]);
}

function appendRegion(rows, bodyContour, role, upper, lower, subdivisions, side) {
  const upperPoints = sourceInterval(
    upper.left,
    upper.right,
    upper.sourceY,
    subdivisions,
  ).map((point) => localBodyPoint(bodyContour, point, side));
  const lowerPoints = sourceInterval(
    lower.left,
    lower.right,
    lower.sourceY,
    subdivisions,
  ).map((point) => localBodyPoint(bodyContour, point, side));
  const upperCollapsed = Math.abs(upper.right - upper.left) <= 1e-7;
  const lowerCollapsed = Math.abs(lower.right - lower.left) <= 1e-7;
  if (upperCollapsed && lowerCollapsed) return;
  if (upperCollapsed || lowerCollapsed) {
    const apex = upperCollapsed ? upperPoints[0] : lowerPoints[0];
    const edge = upperCollapsed ? lowerPoints : upperPoints;
    for (let index = 0; index < subdivisions; index += 1) {
      rows.push({
        role,
        localVertices: upperCollapsed
          ? [apex, edge[index], edge[index + 1]]
          : [edge[index], apex, edge[index + 1]],
      });
    }
    return;
  }
  for (let index = 0; index < subdivisions; index += 1) {
    const topLeft = upperPoints[index];
    const topRight = upperPoints[index + 1];
    const bottomLeft = lowerPoints[index];
    const bottomRight = lowerPoints[index + 1];
    const centerX = (topLeft[0] + topRight[0] + bottomLeft[0] + bottomRight[0]) * 0.25;
    const triangles = centerX < 0
      ? [
          [topLeft, bottomLeft, topRight],
          [bottomLeft, bottomRight, topRight],
        ]
      : [
          [topLeft, bottomLeft, bottomRight],
          [topLeft, bottomRight, topRight],
        ];
    rows.push(...triangles.map((localVertices) => ({ role, localVertices })));
  }
}

function appendBand(rows, bodyContour, upper, lower, keys, roles, subdivisions, side) {
  for (let index = 0; index < roles.length; index += 1) {
    appendRegion(
      rows,
      bodyContour,
      roles[index],
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
    );
  }
}

function subdividedRow(row, keys, subdivisions) {
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

function toWorld(local, bodySize, modelMatrix) {
  const prepared = [
    local[0] * bodySize * MODEL_SCALE,
    -local[2] * MODEL_SCALE,
    -local[1] * MODEL_SCALE,
  ];
  return cssPositionToWorld(transformCssPoint(modelMatrix, prepared)).map(rounded);
}

export function compileFacesJsPaintedTankTop({
  bodyFragment,
  jerseyFragment,
  bodySize,
  modelMatrix,
}) {
  const bodyContour = primaryContour(bodyFragment, "FacesJS body");
  const jerseyContour = primaryContour(jerseyFragment, "FacesJS jersey");
  const rows = [];
  const sourceRows = new Map([510, 530, 550, 570, 585, 590, 600].map((sourceY) => [
    sourceY,
    tankTopRow(bodyContour, jerseyContour, sourceY),
  ]));
  const splitKeys = [
    "bodyLeft",
    "outerLeft",
    "innerLeft",
    "innerRight",
    "outerRight",
    "bodyRight",
  ];
  const splitRoles = ["skin", "team-primary", "skin", "team-primary", "skin"];
  const splitSubdivisions = [1, 1, 4, 1, 1];
  const torsoKeys = ["bodyLeft", "outerLeft", "outerRight", "bodyRight"];
  const torsoRoles = ["skin", "team-primary", "skin"];
  const torsoSubdivisions = [1, 2, 1];
  for (const side of [-1, 1]) {
    for (const [upperY, lowerY] of [
      [510, 530],
      [530, 550],
      [550, 570],
      [570, 585],
      [585, 590],
    ]) {
      appendBand(
        rows,
        bodyContour,
        sourceRows.get(upperY),
        sourceRows.get(lowerY),
        splitKeys,
        splitRoles,
        splitSubdivisions,
        side,
      );
    }
    appendBand(
      rows,
      bodyContour,
      sourceRows.get(590),
      sourceRows.get(600),
      torsoKeys,
      torsoRoles,
      torsoSubdivisions,
      side,
    );
  }

  const bottomRow = sourceRows.get(600);
  const bottomSourcePoints = subdividedRow(
    bottomRow,
    torsoKeys,
    torsoSubdivisions,
  );
  const front = bottomSourcePoints.map((source) => ({
    local: localBodyPoint(bodyContour, source, -1),
    sourceX: source[0],
  }));
  const back = [...bottomSourcePoints].reverse().slice(1, -1).map((source) => ({
    local: localBodyPoint(bodyContour, source, 1),
    sourceX: source[0],
  }));
  const loop = [...front, ...back];
  const bottom = [0, 0, 1.48 - ((600 - 100) * SVG_Z_SCALE)];
  for (let index = 0; index < loop.length; index += 1) {
    const next = (index + 1) % loop.length;
    const sourceX = (200 + loop[index].sourceX + loop[next].sourceX) / 3;
    rows.push({
      role: contains(jerseyContour, [sourceX, 599.5]) ? "team-primary" : "skin",
      localVertices: [bottom, loop[next].local, loop[index].local],
    });
  }

  const compiled = rows.map(({ role, localVertices }) => Object.freeze({
    family: "body",
    role,
    vertices: Object.freeze(localVertices.map((vertex) =>
      Object.freeze(toWorld(vertex, bodySize, modelMatrix)))),
  }));
  return Object.freeze({
    rows: Object.freeze(compiled),
    metrics: Object.freeze({
      polygonCount: compiled.length,
      jerseyPolygonCount: compiled.filter(({ role }) => role === "team-primary").length,
      skinPolygonCount: compiled.filter(({ role }) => role === "skin").length,
      openingSourceY: 510,
    }),
  });
}
