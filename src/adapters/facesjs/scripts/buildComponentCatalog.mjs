import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createFacesJsComponentCatalog,
  validateFacesJsComponentCatalog,
  validateFacesJsComponentBaseManifest,
  validateFacesJsComponentManifest,
} from "../../../../.build/prepare/src/adapters/facesjs/model-package/componentPackage.js";
import {
  FACES_JS_PROJECTED_FAMILIES,
} from "./projectedComponentCompiler.mjs";
import {
  FACES_JS_BODY_REGION_FAMILIES,
} from "./bodyRegionCompiler.mjs";
import {
  FACES_JS_SHELL_FAMILIES,
} from "./shellComponentCompiler.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../../../..");
const compatibilityPath = resolve(repoRoot, "src/adapters/facesjs/compatibility.json");
const presetsPath = resolve(repoRoot, "src/adapters/facesjs/presets.json");
const targetPath = resolve(repoRoot, "src/adapters/facesjs/component-catalog.json");
const publicRoot = resolve(repoRoot, "public/facesjs-components");
const publicCatalogPath = resolve(publicRoot, "catalog.json");
const BASE_ID = "bust";
const baseManifestPath = `bases/${BASE_ID}/manifest.json`;
const projectedFamilies = new Set([
  "accessories",
  ...FACES_JS_BODY_REGION_FAMILIES,
  ...FACES_JS_PROJECTED_FAMILIES,
  ...FACES_JS_SHELL_FAMILIES,
  "hair",
  "hairBg",
]);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function sourceIndex(compatibility) {
  return Object.fromEntries(Object.entries(compatibility.families).map(([family, row]) => [
    family,
    Object.fromEntries(row.ids.map((entry) => [entry.id, entry.sourceSha256])),
  ]));
}

function sourceSelection(index, family, sourceId) {
  const sourceSha256 = index[family]?.[sourceId];
  if (!sourceSha256) throw new Error(`FacesJS source ${family}.${sourceId} is absent.`);
  return { family, sourceId, sourceSha256 };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function projectedComponentRows(compatibility, index) {
  const rows = [];
  for (const family of [...projectedFamilies].sort()) {
    for (const entry of compatibility.families[family].ids
      .filter(({ support }) => support === "supported")) {
      const manifestPath = `components/${family}/${entry.id}/manifest.json`;
      const bytes = await readFile(resolve(publicRoot, manifestPath));
      const manifest = await validateFacesJsComponentManifest(
        JSON.parse(bytes.toString("utf8")),
        index,
      );
      if (manifest.family !== family || manifest.sourceId !== entry.id
        || manifest.sourceSha256 !== entry.sourceSha256) {
        throw new Error(`FacesJS component ${family}.${entry.id} manifest is stale.`);
      }
      for (const asset of Object.values(manifest.assets)) {
        const assetBytes = await readFile(resolve(publicRoot, `components/${family}/${entry.id}`, asset.path));
        if (assetBytes.byteLength !== asset.bytes || sha256(assetBytes) !== asset.sha256) {
          throw new Error(`FacesJS component ${family}.${entry.id} asset ${asset.path} is stale.`);
        }
      }
      rows.push({
        family,
        sourceId: entry.id,
        sourceSha256: entry.sourceSha256,
        manifestPath,
        manifestSha256: sha256(bytes),
        layer: manifest.layer,
        dependencies: manifest.dependencies,
      });
    }
  }
  return rows.sort((left, right) => {
    const leftKey = `${left.family}:${left.sourceId}`;
    const rightKey = `${right.family}:${right.sourceId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

export async function buildFacesJsComponentCatalog() {
  const [compatibility, presets, baseManifestBytes] = await Promise.all([
    readJson(compatibilityPath),
    readJson(presetsPath),
    readFile(resolve(publicRoot, baseManifestPath)),
  ]);
  const index = sourceIndex(compatibility);
  const components = await projectedComponentRows(compatibility, index);
  const baseManifest = await validateFacesJsComponentBaseManifest(
    JSON.parse(baseManifestBytes.toString("utf8")),
  );
  if (baseManifest.id !== BASE_ID
    || baseManifest.sourceRevision !== compatibility.facesJs.sourceRevision) {
    throw new Error(`FacesJS component base ${BASE_ID} is stale.`);
  }
  const compatibilityFixtures = presets.map((preset) => {
    return {
      id: preset.id,
      baseId: BASE_ID,
      selections: compatibility.display.order.map((family) =>
        sourceSelection(index, family, preset.face[family].id)),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const catalog = await createFacesJsComponentCatalog({
    facesJsVersion: compatibility.facesJs.version,
    sourceRevision: compatibility.facesJs.sourceRevision,
    layers: compatibility.display.order,
    bases: [{
      id: BASE_ID,
      manifestPath: baseManifestPath,
      manifestSha256: sha256(baseManifestBytes),
    }],
    components,
    compatibilityFixtures,
  }, index);
  return { catalog, index };
}

const write = process.argv.includes("--write");
const check = process.argv.includes("--check") || !write;
const isEntryPoint = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const built = await buildFacesJsComponentCatalog();
  if (write) {
    const bytes = `${JSON.stringify(built.catalog, null, 2)}\n`;
    await Promise.all([
      writeFile(targetPath, bytes),
      writeFile(publicCatalogPath, bytes),
    ]);
  }
  if (check) {
    for (const [label, path] of [
      ["Tracked", targetPath],
      ["Public", publicCatalogPath],
    ]) {
      const document = await readJson(path);
      const validated = await validateFacesJsComponentCatalog(document, built.index);
      if (JSON.stringify(validated) !== JSON.stringify(built.catalog)) {
        throw new Error(`${label} FacesJS component catalog is stale.`);
      }
    }
    console.log(
      `FacesJS component catalog check passed: ${built.catalog.compatibilityFixtures.length} ` +
      `compatibility fixtures, ${built.catalog.bases.length} reusable bases, ` +
      `${built.catalog.components.length} reusable components.`,
    );
  }
}
