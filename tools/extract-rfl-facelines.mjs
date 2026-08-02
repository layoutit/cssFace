import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const FACELINE_ARCHIVE = 3;
const FACELINE_COUNT = 8;
const GX = Object.freeze({
  quads: 0x80,
  triangles: 0x90,
  triangleStrip: 0x98,
  triangleFan: 0xa0,
});

const [inputArgument, outputArgument] = process.argv.slice(2);
if (!inputArgument || !outputArgument) {
  throw new TypeError("Usage: node tools/extract-rfl-facelines.mjs RFL_Res.dat output.json");
}

const inputPath = resolve(inputArgument);
const outputPath = resolve(outputArgument);
const bytes = await readFile(inputPath);

function requireRange(offset, length, label) {
  if (!Number.isInteger(offset) || !Number.isInteger(length)
    || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new RangeError(`${label} exceeds RFL_Res.dat (${offset}+${length}).`);
  }
}

function readU16(offset, label) {
  requireRange(offset, 2, label);
  return bytes.readUInt16BE(offset);
}

function readS16(offset, label) {
  requireRange(offset, 2, label);
  return bytes.readInt16BE(offset);
}

function readU32(offset, label) {
  requireRange(offset, 4, label);
  return bytes.readUInt32BE(offset);
}

function shapeRange(index) {
  const archiveOffset = readU32(4 + (FACELINE_ARCHIVE * 4), "faceline archive offset");
  const count = readU16(archiveOffset, "faceline count");
  if (count !== FACELINE_COUNT) {
    throw new TypeError(`Expected ${FACELINE_COUNT} facelines, found ${count}.`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new RangeError(`Faceline index ${index} is outside 0..${count - 1}.`);
  }
  const offsetsOffset = archiveOffset + 4;
  const dataOffset = archiveOffset + 8 + (count * 4);
  const start = dataOffset + readU32(offsetsOffset + (index * 4), `faceline ${index} offset`);
  const end = dataOffset + readU32(offsetsOffset + ((index + 1) * 4), `faceline ${index + 1} offset`);
  requireRange(start, end - start, `faceline ${index}`);
  return { start, end };
}

function triangleBoundaryLoops(triangles) {
  const edgeRows = new Map();
  const edgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
  for (let offset = 0; offset < triangles.length; offset += 3) {
    const row = triangles.slice(offset, offset + 3);
    for (const [a, b] of [[row[0], row[1]], [row[1], row[2]], [row[2], row[0]]]) {
      const key = edgeKey(a, b);
      const entry = edgeRows.get(key) ?? { a, b, count: 0 };
      entry.count += 1;
      edgeRows.set(key, entry);
    }
  }
  const boundaryEdges = [...edgeRows.values()].filter(({ count }) => count === 1);
  const adjacency = new Map();
  for (const { a, b } of boundaryEdges) {
    adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
  }
  const remaining = new Set(boundaryEdges.map(({ a, b }) => edgeKey(a, b)));
  const loops = [];
  while (remaining.size) {
    const firstKey = remaining.values().next().value;
    const [start, firstNext] = firstKey.split(":").map(Number);
    const loop = [start];
    let previous = start;
    let current = firstNext;
    remaining.delete(firstKey);
    while (current !== start) {
      loop.push(current);
      const next = (adjacency.get(current) ?? []).find((candidate) =>
        candidate !== previous && remaining.has(edgeKey(current, candidate)));
      if (next === undefined) break;
      remaining.delete(edgeKey(current, next));
      previous = current;
      current = next;
    }
    if (loop.length >= 3 && current === start) loops.push(loop);
  }
  return loops;
}

function parseFaceline(index) {
  const { start, end } = shapeRange(index);
  let cursor = start;
  const take = (length, label) => {
    requireRange(cursor, length, label);
    if (cursor + length > end) throw new RangeError(`${label} exceeds faceline ${index}.`);
    const offset = cursor;
    cursor += length;
    return offset;
  };
  const identifier = bytes.toString("ascii", take(4, "shape identifier"), cursor);
  if (identifier !== "face") throw new TypeError(`Faceline ${index} identifier is ${identifier}.`);
  take(9 * 4, "faceline transforms");

  const positionCount = readU16(take(2, "position count"), "position count");
  const positions = [];
  for (let position = 0; position < positionCount * 3; position += 1) {
    positions.push(readS16(take(2, "position"), "position"));
  }
  const normalCount = readU16(take(2, "normal count"), "normal count");
  take(normalCount * 3 * 2, "normals");
  const texcoordCount = readU16(take(2, "texcoord count"), "texcoord count");
  take(texcoordCount * 2 * 2, "texcoords");

  const primitiveCountOffset = take(1, "primitive count");
  const primitiveCount = bytes[primitiveCountOffset];
  const triangles = [];
  const append = (vertices, a, b, c) => {
    const indices = [vertices[a], vertices[b], vertices[c]].map(({ position }) => position);
    if (indices.some((position) => position < 0 || position >= positionCount)) {
      throw new RangeError(`Faceline ${index} references an invalid position.`);
    }
    if (new Set(indices).size === 3) triangles.push(...indices);
  };
  for (let primitive = 0; primitive < primitiveCount; primitive += 1) {
    const vertexCountOffset = take(1, "primitive vertex count");
    const primitiveTypeOffset = take(1, "primitive type");
    const vertexCount = bytes[vertexCountOffset];
    const primitiveType = bytes[primitiveTypeOffset];
    const vertices = [];
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const positionOffset = take(1, "position index");
      take(1, "normal index");
      take(1, "texcoord index");
      vertices.push({ position: bytes[positionOffset] });
    }
    if (primitiveType === GX.triangles) {
      for (let vertex = 0; vertex + 2 < vertices.length; vertex += 3) {
        append(vertices, vertex + 2, vertex + 1, vertex);
      }
    } else if (primitiveType === GX.triangleStrip) {
      for (let vertex = 0; vertex + 2 < vertices.length; vertex += 1) {
        if (vertex % 2 === 0) append(vertices, vertex + 2, vertex + 1, vertex);
        else append(vertices, vertex + 1, vertex + 2, vertex);
      }
    } else if (primitiveType === GX.triangleFan) {
      for (let vertex = 1; vertex + 1 < vertices.length; vertex += 1) {
        append(vertices, vertex + 1, vertex, 0);
      }
    } else if (primitiveType === GX.quads) {
      for (let vertex = 0; vertex + 3 < vertices.length; vertex += 4) {
        append(vertices, vertex + 2, vertex + 1, vertex);
        append(vertices, vertex + 3, vertex + 2, vertex);
      }
    } else {
      throw new TypeError(`Faceline ${index} uses unsupported GX primitive 0x${primitiveType.toString(16)}.`);
    }
  }
  if (cursor !== end) {
    throw new TypeError(`Faceline ${index} left ${end - cursor} unread bytes.`);
  }
  const axes = [0, 1, 2].map((axis) => {
    const values = Array.from({ length: positionCount }, (_, position) =>
      positions[(position * 3) + axis]);
    return { minimum: Math.min(...values), maximum: Math.max(...values) };
  });
  return {
    index,
    positions,
    triangles,
    boundaryLoops: triangleBoundaryLoops(triangles),
    bounds: {
      minimum: axes.map(({ minimum }) => minimum),
      maximum: axes.map(({ maximum }) => maximum),
    },
  };
}

const archiveCount = readU16(0, "archive count");
const version = readU16(2, "resource version");
if (archiveCount !== 18) throw new TypeError(`Expected 18 RFL archives, found ${archiveCount}.`);

const output = {
  schema: "cssface.rfl-facelines@1",
  source: {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    version,
  },
  facelines: Array.from({ length: FACELINE_COUNT }, (_, index) => parseFaceline(index)),
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output)}\n`);
console.log(JSON.stringify({
  output: outputPath,
  source: output.source,
  facelines: output.facelines.map(({ index, positions, triangles, boundaryLoops }) => ({
    index,
    vertices: positions.length / 3,
    triangles: triangles.length / 3,
    boundaryLoops: boundaryLoops.length,
  })),
}, null, 2));
