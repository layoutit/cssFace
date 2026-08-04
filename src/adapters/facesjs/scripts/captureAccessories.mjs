import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import sharp from "sharp";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../../../..");
const componentRoot = resolve(repoRoot, "public/facesjs-components/components");
const outputRoot = resolve(repoRoot, ".local/facesjs-accessories");
const outputPath = resolve(outputRoot, "b13-contact-sheet.png");
const reportPath = resolve(outputRoot, "b13-contact-sheet.json");
const WIDTH = 340;
const HEIGHT = 350;

const cases = Object.freeze([
  Object.freeze({ head: "head1", hair: "short", accessory: "eye-black", state: null }),
  Object.freeze({ head: "head7", hair: "short", accessory: "headband", state: "fatness" }),
  Object.freeze({ head: "head17", hair: "short-fade", accessory: "headband-high", state: null }),
  Object.freeze({ head: "head1", hair: "short", accessory: "hat", state: null }),
  Object.freeze({ head: "head18", hair: "short", accessory: "hat3", state: "fatness" }),
  Object.freeze({ head: "head7", hair: "short-fade", accessory: "santa-hat", state: null }),
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

function projected(points, view, fill) {
  return {
    fill,
    depth: points.reduce((sum, point) => sum + point[view.depthAxis], 0)
      * view.depthDirection / points.length,
    points: points.map((point) => [point[view.axes[0]] * view.mirror, point[view.axes[1]]]),
  };
}

function meshRows(component, state, view, fill) {
  return component.mesh.triangles.map((triangle) => projected(
    triangle.indices.map((index) => position(component.mesh.vertices[index], state)),
    view,
    fill,
  ));
}

function paintRows(component, state, view, fill) {
  return (component.frontPaint ?? []).map((triangle) => projected(
    triangle.vertices.map((vertex) => position(vertex, state)),
    view,
    fill,
  ));
}

function renderCell(components, state, view, offsetX, offsetY) {
  const byDepth = (left, right) => right.depth - left.depth;
  const head = meshRows(components.head, state, view, "#b86d58").sort(byDepth);
  const hairMesh = meshRows(components.hair, state, view, "#282323").sort(byDepth);
  const hairPaint = paintRows(components.hair, state, view, "#171515").sort(byDepth);
  const accessoryMesh = meshRows(components.accessory, state, view, "#778f48").sort(byDepth);
  const accessoryPaint = paintRows(components.accessory, state, view, "#b7d95c").sort(byDepth);
  const polygons = view.id === "front"
    ? [...hairMesh, ...accessoryMesh, ...head, ...hairPaint, ...accessoryPaint]
    : view.id === "rear"
      ? [...accessoryPaint, ...hairPaint, ...head, ...hairMesh, ...accessoryMesh]
      : [...head, ...hairMesh, ...hairPaint, ...accessoryMesh, ...accessoryPaint];
  const points = polygons.flatMap((polygon) => polygon.points);
  const bounds = {
    minimumX: Math.min(...points.map((point) => point[0])),
    maximumX: Math.max(...points.map((point) => point[0])),
    minimumY: Math.min(...points.map((point) => point[1])),
    maximumY: Math.max(...points.map((point) => point[1])),
  };
  const scale = Math.min(
    (WIDTH - 40) / (bounds.maximumX - bounds.minimumX),
    (HEIGHT - 60) / (bounds.maximumY - bounds.minimumY),
  );
  const centerX = (bounds.minimumX + bounds.maximumX) * 0.5;
  const centerY = (bounds.minimumY + bounds.maximumY) * 0.5;
  const targetX = offsetX + (WIDTH * 0.5);
  const targetY = offsetY + (HEIGHT * 0.53);
  const shapes = polygons.map((polygon) => {
    const value = polygon.points.map((point) => [
      targetX + ((point[0] - centerX) * scale),
      targetY - ((point[1] - centerY) * scale),
    ].map((number) => number.toFixed(2)).join(",")).join(" ");
    return `<polygon points="${value}" fill="${polygon.fill}" stroke="#141313" stroke-width="0.25"/>`;
  }).join("");
  return `<g>${shapes}<text x="${offsetX + 12}" y="${offsetY + 20}" fill="#e8e4dc" font-family="monospace" font-size="14">${view.id}</text></g>`;
}

const loaded = new Map();
for (const row of cases) {
  for (const [family, sourceId] of [
    ["head", row.head],
    ["hair", row.hair],
    ["accessories", row.accessory],
  ]) {
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
    hair: loaded.get(`hair:${row.hair}`).geometry,
    accessory: loaded.get(`accessories:${row.accessory}`).geometry,
  };
  for (const [columnIndex, view] of views.entries()) {
    cells.push(renderCell(components, row.state, view, columnIndex * WIDTH, rowIndex * HEIGHT));
  }
  cells.push(`<text x="${sheetWidth - 12}" y="${(rowIndex * HEIGHT) + 20}" text-anchor="end" fill="#9aa09a" font-family="monospace" font-size="13">${row.accessory} ${row.state ?? "base"}</text>`);
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetWidth}" height="${sheetHeight}" viewBox="0 0 ${sheetWidth} ${sheetHeight}"><rect width="100%" height="100%" fill="#1e1e1e"/>${cells.join("")}</svg>`;
await mkdir(outputRoot, { recursive: true });
const png = await sharp(Buffer.from(svg)).png().toBuffer();
await writeFile(outputPath, png);
const report = {
  schema: "cssface.facesjs-accessory-capture@1",
  cases,
  views: views.map(({ id }) => id),
  components: Object.fromEntries([...loaded].map(([key, value]) => [key, value.manifestSha256])),
  image: { path: outputPath, bytes: png.byteLength, sha256: sha256(png) },
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`FacesJS B13 accessory contact sheet: ${outputPath} (${png.byteLength} bytes).`);
