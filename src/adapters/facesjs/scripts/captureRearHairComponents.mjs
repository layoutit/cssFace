import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import sharp from "sharp";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../../../..");
const componentRoot = resolve(repoRoot, "public/facesjs-components/components");
const outputRoot = resolve(repoRoot, ".local/facesjs-hair");
const outputPath = resolve(outputRoot, "b12-contact-sheet.png");
const reportPath = resolve(outputRoot, "b12-contact-sheet.json");
const WIDTH = 360;
const HEIGHT = 390;
const LABEL_HEIGHT = 30;

const cases = Object.freeze([
  Object.freeze({ head: "head1", body: "body", hair: "female1", hairBg: "female1", state: null }),
  Object.freeze({ head: "head7", body: "body2", hair: "female2", hairBg: "female2", state: "fatness" }),
  Object.freeze({ head: "head1", body: "body3", hair: "longHair", hairBg: "longHair", state: null }),
  Object.freeze({ head: "head17", body: "body4", hair: "shaggy1", hairBg: "shaggy", state: "fatness" }),
  Object.freeze({ head: "head1", body: "body5", hair: "female7", hairBg: null, state: null }),
  Object.freeze({ head: "head18", body: "body2", hair: "female10", hairBg: null, state: "fatness" }),
]);
const views = Object.freeze([
  Object.freeze({ id: "front", axes: [0, 2], depthAxis: 1, depthDirection: 1, mirror: 1 }),
  Object.freeze({ id: "side", axes: [1, 2], depthAxis: 0, depthDirection: -1, mirror: 1 }),
  Object.freeze({ id: "rear", axes: [0, 2], depthAxis: 1, depthDirection: -1, mirror: -1 }),
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function loadComponent(family, sourceId) {
  const root = resolve(componentRoot, family, sourceId);
  const manifestBytes = await readFile(resolve(root, "manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  const geometryBytes = await readFile(resolve(root, manifest.assets.geometry.path));
  return {
    geometry: JSON.parse(gunzipSync(geometryBytes)),
    manifestSha256: sha256(manifestBytes),
  };
}

function position(vertex, state) {
  return state && vertex.states[state] ? vertex.states[state] : vertex.position;
}

function projectedMesh(component, state, view, fill) {
  return component.mesh.triangles.map((triangle) => {
    const points = triangle.indices.map((index) => position(component.mesh.vertices[index], state));
    return projectedPolygon(points, view, fill);
  });
}

function projectedPaint(component, state, view, fill) {
  return (component.frontPaint ?? []).map((triangle) =>
    projectedPolygon(triangle.vertices.map((vertex) => position(vertex, state)), view, fill));
}

function projectedPolygon(points, view, fill) {
  return {
    fill,
    depth: points.reduce((sum, point) => sum + point[view.depthAxis], 0)
      * view.depthDirection / points.length,
    points: points.map((point) => [point[view.axes[0]] * view.mirror, point[view.axes[1]]]),
  };
}

function renderCell(components, state, view, offsetX, offsetY) {
  const byDepth = (left, right) => right.depth - left.depth;
  const background = components.hairBg
    ? [
      ...projectedMesh(components.hairBg, state, view, "#292424"),
      ...projectedPaint(components.hairBg, state, view, "#211d1d"),
    ].sort(byDepth)
    : [];
  const body = projectedMesh(components.body, state === "fatness" ? "body-size" : null, view, "#b86d58")
    .sort(byDepth);
  const head = projectedMesh(components.head, state, view, "#b86d58").sort(byDepth);
  const closure = projectedMesh(components.hair, state, view, "#292424").sort(byDepth);
  const paint = projectedPaint(components.hair, state, view, "#171515").sort(byDepth);
  const polygons = view.id === "front"
    ? [...background, ...closure, ...body, ...head, ...paint]
    : [...body, ...head, ...background, ...closure, ...paint];
  const points = polygons.flatMap((polygon) => polygon.points);
  const bounds = {
    minimumX: Math.min(...points.map((point) => point[0])),
    maximumX: Math.max(...points.map((point) => point[0])),
    minimumY: Math.min(...points.map((point) => point[1])),
    maximumY: Math.max(...points.map((point) => point[1])),
  };
  const scale = Math.min(
    (WIDTH - 40) / (bounds.maximumX - bounds.minimumX),
    (HEIGHT - LABEL_HEIGHT - 40) / (bounds.maximumY - bounds.minimumY),
  );
  const centerX = (bounds.minimumX + bounds.maximumX) * 0.5;
  const centerY = (bounds.minimumY + bounds.maximumY) * 0.5;
  const targetX = offsetX + (WIDTH * 0.5);
  const targetY = offsetY + LABEL_HEIGHT + ((HEIGHT - LABEL_HEIGHT) * 0.5);
  const shapes = polygons.map((polygon) => {
    const value = polygon.points.map((point) => [
      targetX + ((point[0] - centerX) * scale),
      targetY - ((point[1] - centerY) * scale),
    ].map((number) => number.toFixed(2)).join(",")).join(" ");
    return `<polygon points="${value}" fill="${polygon.fill}" stroke="#141313" stroke-width="0.25"/>`;
  }).join("");
  return `<g>${shapes}<text x="${offsetX + 14}" y="${offsetY + 21}" fill="#e8e4dc" font-family="monospace" font-size="14">${view.id}</text></g>`;
}

const loaded = new Map();
for (const row of cases) {
  for (const [family, sourceId] of [
    ["head", row.head],
    ["body", row.body],
    ["hair", row.hair],
    ["hairBg", row.hairBg],
  ]) {
    if (!sourceId) continue;
    const key = `${family}:${sourceId}`;
    if (!loaded.has(key)) loaded.set(key, await loadComponent(family, sourceId));
  }
}

const sheetWidth = WIDTH * views.length;
const sheetHeight = HEIGHT * cases.length;
const cells = [];
for (const [rowIndex, row] of cases.entries()) {
  const components = {
    head: loaded.get(`head:${row.head}`).geometry,
    body: loaded.get(`body:${row.body}`).geometry,
    hair: loaded.get(`hair:${row.hair}`).geometry,
    hairBg: row.hairBg ? loaded.get(`hairBg:${row.hairBg}`).geometry : null,
  };
  for (const [columnIndex, view] of views.entries()) {
    cells.push(renderCell(
      components,
      row.state,
      view,
      columnIndex * WIDTH,
      rowIndex * HEIGHT,
    ));
  }
  const pair = row.hairBg ? `${row.hairBg} + ${row.hair}` : row.hair;
  cells.push(`<text x="${sheetWidth - 14}" y="${(rowIndex * HEIGHT) + 21}" text-anchor="end" fill="#9aa09a" font-family="monospace" font-size="13">${pair} ${row.state ?? "base"}</text>`);
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetWidth}" height="${sheetHeight}" viewBox="0 0 ${sheetWidth} ${sheetHeight}"><rect width="100%" height="100%" fill="#1e1e1e"/>${cells.join("")}</svg>`;
await mkdir(outputRoot, { recursive: true });
const png = await sharp(Buffer.from(svg)).png().toBuffer();
await writeFile(outputPath, png);
const report = {
  schema: "cssface.facesjs-rear-hair-capture@1",
  cases,
  views: views.map(({ id }) => id),
  components: Object.fromEntries([...loaded].map(([key, value]) => [key, value.manifestSha256])),
  image: { path: outputPath, bytes: png.byteLength, sha256: sha256(png) },
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`FacesJS B12 rear-hair contact sheet: ${outputPath} (${png.byteLength} bytes).`);
