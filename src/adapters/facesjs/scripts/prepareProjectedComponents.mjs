import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { svgs, svgsIndex } from "facesjs";

import {
  createFacesJsComponentBaseManifest,
  createFacesJsComponentManifest,
} from "../../../../.build/prepare/src/adapters/facesjs/model-package/componentPackage.js";
import {
  buildFacesJsComponentCatalog,
} from "./buildComponentCatalog.mjs";
import {
  FACES_JS_BODY_REGION_FAMILIES,
  compileFacesJsBodyRegion,
} from "./bodyRegionCompiler.mjs";
import {
  compileFacesJsAccessoryComponent,
} from "./accessoryComponentCompiler.mjs";
import {
  FACES_JS_OVERLAY_FAMILIES,
  FACES_JS_PROJECTED_FAMILIES,
  FACES_JS_RAISED_PROJECTED_FAMILIES,
  compileFacesJsProjectedComponent,
} from "./projectedComponentCompiler.mjs";
import {
  FACES_JS_SHELL_FAMILIES,
  compileFacesJsShellComponent,
} from "./shellComponentCompiler.mjs";
import {
  FACES_JS_HAIR_STRATEGIES,
  compileFacesJsHairComponent,
} from "./hairComponentCompiler.mjs";
import {
  compileFacesJsPreparedComponent,
} from "./componentPreparedCompiler.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../../../..");
const compatibilityPath = resolve(repoRoot, "src/adapters/facesjs/compatibility.json");
const hairStrategyPath = resolve(repoRoot, "src/adapters/facesjs/hairStrategies.json");
const trackedCatalogPath = resolve(repoRoot, "src/adapters/facesjs/component-catalog.json");
const publicRoot = resolve(repoRoot, "public/facesjs-components");
const publicCatalogPath = resolve(publicRoot, "catalog.json");
const BASE_ID = "bust";
const BASE_RELATIVE_PATH = `bases/${BASE_ID}/manifest.json`;
const BASE_MODEL_MATRIX = Object.freeze([
  0.9, 0, 0, 0,
  0, 0.98, 0, 0,
  0, 0, 1, 0,
  0, 23.9, 0, 1,
]);
const projectedEvidence = Object.freeze([
  "contract:cssface.facesjs-projected-component@1",
  "test:facesjs-projected-components",
]);
const overlayEvidence = Object.freeze([
  "contract:cssface.facesjs-projected-component@1",
  "test:facesjs-overlays",
]);
const overlayFamilies = new Set(FACES_JS_OVERLAY_FAMILIES);
const raisedFamilies = new Set(FACES_JS_RAISED_PROJECTED_FAMILIES);
const shellFamilies = new Set(FACES_JS_SHELL_FAMILIES);
const bodyRegionFamilies = new Set(FACES_JS_BODY_REGION_FAMILIES);
const accessoryFamilies = new Set(["accessories"]);
const hairFamilies = new Set(["hair", "hairBg"]);
const preparedFamilies = Object.freeze([
  ...FACES_JS_BODY_REGION_FAMILIES,
  "accessories",
  ...FACES_JS_PROJECTED_FAMILIES,
  ...FACES_JS_SHELL_FAMILIES,
  "hair",
  "hairBg",
]);
const raisedEvidence = Object.freeze([
  "contract:cssface.facesjs-projected-component@1",
  "test:facesjs-glasses",
]);
const shellEvidence = Object.freeze([
  "contract:cssface.facesjs-shell-component@1",
  "test:facesjs-shells",
]);
const bodyRegionEvidence = Object.freeze([
  "contract:cssface.facesjs-body-region@1",
  "test:facesjs-body-regions",
]);
const accessoryEvidence = Object.freeze([
  "contract:cssface.facesjs-accessory-component@1",
  "test:facesjs-accessories",
]);
const hairEvidence = Object.freeze([
  "contract:cssface.facesjs-hair-component@1",
  "test:facesjs-hair-components",
]);

function evidenceFor(family) {
  if (accessoryFamilies.has(family)) return accessoryEvidence;
  if (hairFamilies.has(family)) return hairEvidence;
  if (bodyRegionFamilies.has(family)) return bodyRegionEvidence;
  if (shellFamilies.has(family)) return shellEvidence;
  if (raisedFamilies.has(family)) return raisedEvidence;
  return overlayFamilies.has(family) ? overlayEvidence : projectedEvidence;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function normalizedId(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase();
}

function componentRelativeRoot(family, sourceId) {
  return `components/${family}/${sourceId}`;
}

async function expectedPackage(
  compatibility,
  family,
  sourceId,
  headFragments,
  bodyFragments,
  jerseySourceIds,
  hairStrategies,
  prepareRuntime,
) {
  const entry = compatibility.families[family].ids.find(({ id }) => id === sourceId);
  if (!entry) throw new Error(`FacesJS compatibility source ${family}.${sourceId} is absent.`);
  const fragment = svgs[family][sourceId];
  let geometry;
  try {
    geometry = accessoryFamilies.has(family)
      ? compileFacesJsAccessoryComponent({
        sourceId,
        fragment,
        sourceSha256: entry.sourceSha256,
        headFragments,
        hairStrategyDocument: { entries: [...hairStrategies.values()] },
      })
      : hairFamilies.has(family)
      ? compileFacesJsHairComponent({
        family,
        sourceId,
        fragment,
        sourceSha256: entry.sourceSha256,
        strategyRow: hairStrategies.get(`${family}:${sourceId}`),
        headFragments,
        bodyFragments,
      })
      : bodyRegionFamilies.has(family)
      ? compileFacesJsBodyRegion({
        family,
        sourceId,
        fragment,
        sourceSha256: entry.sourceSha256,
        bodyFragments,
        jerseySourceIds,
      })
      : shellFamilies.has(family)
      ? compileFacesJsShellComponent({
        family,
        sourceId,
        fragment,
        sourceSha256: entry.sourceSha256,
        headFragments,
      })
      : compileFacesJsProjectedComponent({
        family,
        sourceId,
        fragment,
        sourceSha256: entry.sourceSha256,
        headFragments,
      });
  } catch (error) {
    throw new Error(
      `FacesJS component ${family}.${sourceId} geometry compilation failed.`,
      { cause: error },
    );
  }
  const explicitEmpty = fragment.trim() === "";
  if (geometry.empty !== explicitEmpty
    || geometry.metrics.triangleCount === 0 !== explicitEmpty) {
    throw new Error(
      `FacesJS projected source ${family}.${sourceId} has an invalid empty outcome.`,
    );
  }
  if (!geometry.empty && geometry.metrics.minimumClearanceCssPx !== undefined
    && geometry.metrics.minimumClearanceCssPx < 0.72) {
    throw new Error(`FacesJS projected source ${family}.${sourceId} lost face clearance.`);
  }
  const geometryBytes = gzipSync(Buffer.from(JSON.stringify(geometry)), {
    level: 9,
    mtime: 0,
  });
  const runtime = prepareRuntime
    ? await compileFacesJsPreparedComponent({
      geometry,
      headFragment: headFragments.head1,
    })
    : null;
  const packageAssets = [["geometry", {
    path: "assets/geometry.json.gz",
    mediaType: "application/gzip",
    bytes: geometryBytes,
  }]];
  if (runtime) {
    packageAssets.push(["prepared", {
      path: "assets/prepared.bin",
      mediaType: "application/gzip",
      bytes: runtime.preparedBytes,
    }]);
    packageAssets.push(...Object.entries(runtime.assets));
  }
  const assets = Object.fromEntries(packageAssets
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, asset]) => [role, {
      path: asset.path,
      mediaType: asset.mediaType,
      bytes: asset.bytes.byteLength,
      sha256: sha256(asset.bytes),
    }]));
  const manifest = await createFacesJsComponentManifest({
    id: `${normalizedId(family)}-${normalizedId(sourceId)}`,
    family,
    sourceId,
    sourceSha256: entry.sourceSha256,
    layer: geometry.layer,
    attachment: geometry.attachment,
    materialRoles: geometry.materialRoles,
    dependencies: geometry.dependencies ?? [],
    assets,
  });
  return {
    geometry,
    packageAssets: Object.freeze(Object.fromEntries(packageAssets)),
    manifest,
    manifestBytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    runtime,
  };
}

async function writePackage(root, family, sourceId, prepared) {
  const target = resolve(root, componentRelativeRoot(family, sourceId));
  await Promise.all(Object.values(prepared.packageAssets).map(async (asset) => {
    const path = resolve(target, asset.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, asset.bytes);
  }));
  await writeFile(resolve(target, "manifest.json"), prepared.manifestBytes);
}

async function checkPackage(root, family, sourceId, prepared) {
  const target = resolve(root, componentRelativeRoot(family, sourceId));
  const manifestBytes = await readFile(resolve(target, "manifest.json"));
  for (const asset of Object.values(prepared.packageAssets)) {
    const actual = await readFile(resolve(target, asset.path));
    if (!actual.equals(asset.bytes)) {
      throw new Error(`FacesJS projected asset ${family}.${sourceId} ${asset.path} is stale.`);
    }
  }
  if (!manifestBytes.equals(prepared.manifestBytes)) {
    throw new Error(`FacesJS projected manifest ${family}.${sourceId} is stale.`);
  }
}

async function expectedBaseManifest(compatibility) {
  const manifest = await createFacesJsComponentBaseManifest({
    id: BASE_ID,
    profile: "morph-regions",
    sourceRevision: compatibility.facesJs.sourceRevision,
    modelScale: 120,
    modelMatrix: BASE_MODEL_MATRIX,
  });
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

async function writeBase(root, bytes) {
  const path = resolve(root, BASE_RELATIVE_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

async function checkBase(root, bytes) {
  if (!(await readFile(resolve(root, BASE_RELATIVE_PATH))).equals(bytes)) {
    throw new Error(`FacesJS component base ${BASE_ID} is stale.`);
  }
}

function updateCompatibility(compatibility, preparedSourceIds) {
  const document = structuredClone(compatibility);
  for (const family of preparedFamilies) {
    const included = new Set(preparedSourceIds[family]);
    for (const entry of document.families[family].ids.filter(({ id }) => included.has(id))) {
      entry.support = "supported";
      entry.evidence = [...evidenceFor(family)];
      delete entry.reason;
    }
  }
  return document;
}

function assertCompatibility(document, preparedSourceIds) {
  for (const family of preparedFamilies) {
    const included = new Set(preparedSourceIds[family]);
    for (const entry of document.families[family].ids.filter(({ id }) => included.has(id))) {
      if (entry.support !== "supported"
        || JSON.stringify(entry.evidence) !== JSON.stringify(evidenceFor(family))) {
        throw new Error(`FacesJS support evidence ${family}.${entry.id} is stale.`);
      }
    }
  }
}

async function writeCatalogs() {
  const { catalog } = await buildFacesJsComponentCatalog();
  const bytes = `${JSON.stringify(catalog, null, 2)}\n`;
  await Promise.all([
    writeFile(trackedCatalogPath, bytes),
    writeFile(publicCatalogPath, bytes),
  ]);
  return catalog;
}

async function checkCatalogs() {
  const { catalog } = await buildFacesJsComponentCatalog();
  const expected = `${JSON.stringify(catalog, null, 2)}\n`;
  for (const path of [trackedCatalogPath, publicCatalogPath]) {
    if (await readFile(path, "utf8") !== expected) {
      throw new Error(`FacesJS projected catalog ${path} is stale.`);
    }
  }
  return catalog;
}

const write = process.argv.includes("--write");
const check = process.argv.includes("--check") || !write;
const compatibility = await readJson(compatibilityPath);
const hairStrategyDocument = await readJson(hairStrategyPath);
const hairStrategies = new Map(hairStrategyDocument.entries.map((entry) => [
  `${entry.family}:${entry.sourceId}`,
  entry,
]));
const headFragments = Object.fromEntries(
  svgsIndex.head.map((sourceId) => [sourceId, svgs.head[sourceId]]),
);
const bodyFragments = Object.fromEntries(
  svgsIndex.body.map((sourceId) => [sourceId, svgs.body[sourceId]]),
);
const jerseySourceIds = Object.freeze([...svgsIndex.jersey]);
const preparedSourceIds = Object.freeze(Object.fromEntries(preparedFamilies.map((family) => [
  family,
  Object.freeze((hairFamilies.has(family)
    ? hairStrategyDocument.entries
      .filter((entry) => entry.family === family
        && FACES_JS_HAIR_STRATEGIES.includes(entry.strategy))
      .map(({ sourceId }) => sourceId)
    : [...svgsIndex[family]]).sort()),
])));
const baseManifestBytes = await expectedBaseManifest(compatibility);
const stagingRoot = write
  ? await mkdtemp(resolve(repoRoot, "public/.facesjs-components-"))
  : null;
let componentCount = 0;
let triangleCount = 0;
try {
  if (write) await writeBase(stagingRoot, baseManifestBytes);
  else await checkBase(publicRoot, baseManifestBytes);
  for (const family of preparedFamilies) {
    for (const sourceId of preparedSourceIds[family]) {
      const prepared = await expectedPackage(
        compatibility,
        family,
        sourceId,
        headFragments,
        bodyFragments,
        jerseySourceIds,
        hairStrategies,
        true,
      );
      if (write) await writePackage(stagingRoot, family, sourceId, prepared);
      else await checkPackage(publicRoot, family, sourceId, prepared);
      componentCount += 1;
      triangleCount += prepared.geometry.metrics.triangleCount;
    }
  }
  if (write) {
    await rm(publicRoot, { recursive: true, force: true });
    await rename(stagingRoot, publicRoot);
    await writeFile(
      compatibilityPath,
      `${JSON.stringify(updateCompatibility(compatibility, preparedSourceIds), null, 2)}\n`,
    );
    await writeCatalogs();
  }
  if (check) {
    assertCompatibility(await readJson(compatibilityPath), preparedSourceIds);
    await checkCatalogs();
  }
} catch (error) {
  if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
  throw error;
}

console.log(
  `FacesJS projected component check passed: ${componentCount} components, `
  + `${triangleCount} prepared triangles.`,
);
