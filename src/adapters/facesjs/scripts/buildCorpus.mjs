import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { faceToSvgString, svgs } from "facesjs";

import {
  createFacesJsComponentGraph,
} from "../../../../.build/prepare/src/adapters/facesjs/model-package/componentCatalog.js";
import {
  validateFacesJsComponentCatalog,
} from "../../../../.build/prepare/src/adapters/facesjs/model-package/componentPackage.js";
import {
  collectCssFaceCoverageSeeds,
  generateCssFaceConfig,
  resolveFacesJsFaceConfig,
} from "../../../../.build/prepare/src/adapters/facesjs/player/faceConfigResolver.js";
import {
  FACES_JS_TRANSFORM_BOUNDS,
  resolveFacesJsDisplayTransforms,
  validateFacesJsFaceConfig,
} from "../../../../.build/prepare/src/adapters/facesjs/player/configTransforms.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../../../..");
const compatibilityPath = resolve(repoRoot, "src/adapters/facesjs/compatibility.json");
const catalogPath = resolve(repoRoot, "public/facesjs-components/catalog.json");
const componentRoot = resolve(repoRoot, "public/facesjs-components");
const corpusPath = resolve(
  repoRoot,
  "test/fixtures/facesjs-corpus/corpus.json",
);
const prepareScriptPath = resolve(
  repoRoot,
  "src/adapters/facesjs/scripts/prepareProjectedComponents.mjs",
);
const SCHEMA = "cssface.facesjs-differential-corpus@1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function faceWith(base, overrides) {
  const face = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    face[key] = value && typeof value === "object" && !Array.isArray(value)
      ? { ...face[key], ...value }
      : value;
  }
  return validateFacesJsFaceConfig(face);
}

function wrapperGroups(svg) {
  const lines = svg.split("\n");
  const groups = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^<g(?: transform="([^"]*)")?>$/u.exec(lines[index]);
    if (!match) continue;
    const end = lines.indexOf("</g>", index + 1);
    if (end < 0) throw new Error("FacesJS upstream SVG has an unclosed display group.");
    const rendered = lines.slice(index, end + 1).join("\n");
    groups.push(Object.freeze({
      transform: match[1] ?? "",
      renderedSha256: sha256(rendered),
    }));
    index = end;
  }
  return groups;
}

function sourceEntry(compatibility, family, sourceId) {
  const entry = compatibility.families[family].ids.find(({ id }) => id === sourceId);
  if (!entry) throw new Error(`FacesJS source ${family}.${sourceId} is absent.`);
  return entry;
}

function upstreamEvidence(compatibility, config, resolved) {
  const renderedConfig = structuredClone(config);
  const svg = faceToSvgString(renderedConfig);
  const wrappers = wrapperGroups(svg);
  const transforms = resolveFacesJsDisplayTransforms(config);
  const groups = [];
  let wrapperIndex = 0;
  for (const family of compatibility.display.order) {
    const sourceId = resolved.effectiveIds[family];
    const fragment = svgs[family]?.[sourceId];
    if (typeof fragment !== "string") {
      throw new Error(`FacesJS source fragment ${family}.${sourceId} is absent.`);
    }
    if (fragment.length === 0) continue;
    const familyTransforms = transforms.filter((row) => row.family === family);
    for (const transform of familyTransforms) {
      const wrapper = wrappers[wrapperIndex];
      if (!wrapper) {
        throw new Error(`FacesJS upstream SVG lost ${family}.${sourceId} instance ${transform.instance}.`);
      }
      const source = sourceEntry(compatibility, family, sourceId);
      groups.push(Object.freeze({
        displayIndex: wrapperIndex,
        family,
        instance: transform.instance,
        sourceId,
        sourceSha256: source.sourceSha256,
        transform: wrapper.transform,
        renderedSha256: wrapper.renderedSha256,
      }));
      wrapperIndex += 1;
    }
  }
  if (wrapperIndex !== wrappers.length) {
    throw new Error(
      `FacesJS upstream SVG has ${wrappers.length - wrapperIndex} unmapped display groups.`,
    );
  }
  return Object.freeze({
    svgSha256: sha256(svg),
    groups: Object.freeze(groups),
  });
}

async function componentEvidence(catalog) {
  const output = {};
  for (const row of [...catalog.components].sort((left, right) =>
    `${left.family}:${left.sourceId}`.localeCompare(`${right.family}:${right.sourceId}`))) {
    const key = `${row.family}:${row.sourceId}`;
    const manifestPath = resolve(componentRoot, row.manifestPath);
    const manifestBytes = await readFile(manifestPath);
    if (sha256(manifestBytes) !== row.manifestSha256) {
      throw new Error(`FacesJS component ${key} manifest bytes are stale.`);
    }
    const manifest = JSON.parse(manifestBytes);
    const preparedAsset = manifest.assets.prepared;
    if (!preparedAsset) throw new Error(`FacesJS component ${key} is not runtime prepared.`);
    const packageDirectory = dirname(manifestPath);
    const preparedBytes = await readFile(resolve(packageDirectory, preparedAsset.path));
    if (sha256(preparedBytes) !== preparedAsset.sha256) {
      throw new Error(`FacesJS component ${key} prepared bytes are stale.`);
    }
    const prepared = JSON.parse(gunzipSync(preparedBytes));
    if (prepared.family !== row.family || prepared.sourceId !== row.sourceId
      || prepared.sourceSha256 !== row.sourceSha256) {
      throw new Error(`FacesJS component ${key} prepared provenance is stale.`);
    }
    output[key] = Object.freeze({
      family: row.family,
      sourceId: row.sourceId,
      sourceSha256: row.sourceSha256,
      layer: row.layer,
      dependencies: row.dependencies,
      manifestSha256: row.manifestSha256,
      manifestContentHash: manifest.contentHash,
      preparedSha256: preparedAsset.sha256,
      preparedContentHash: prepared.contentHash,
      materialRoles: manifest.materialRoles,
      empty: prepared.empty,
      leaves: prepared.model?.render?.leaves?.length ?? 0,
    });
  }
  return Object.freeze(output);
}

function addCase(rows, ids, id, kind, face, properties = []) {
  if (ids.has(id)) throw new Error(`FacesJS corpus case ${id} is duplicated.`);
  ids.add(id);
  rows.push(Object.freeze({ id, kind, face, properties: Object.freeze(properties) }));
}

function authoredCases(catalog, graph) {
  const rows = [];
  const ids = new Set();
  const coverageSeeds = collectCssFaceCoverageSeeds(graph);
  for (const seed of coverageSeeds) {
    addCase(
      rows,
      ids,
      `catalog-seed-${String(seed).padStart(4, "0")}`,
      "catalog-coverage",
      generateCssFaceConfig(catalog, seed),
    );
  }
  const neutral = generateCssFaceConfig(catalog, 0);
  addCase(rows, ids, "transform-minimum", "transform-boundary", faceWith(neutral, {
    fatness: FACES_JS_TRANSFORM_BOUNDS.fatness[0],
    body: { size: FACES_JS_TRANSFORM_BOUNDS["body.size"][0] },
    ear: { size: FACES_JS_TRANSFORM_BOUNDS["ear.size"][0] },
    eye: { angle: FACES_JS_TRANSFORM_BOUNDS["eye.angle"][0] },
    eyebrow: { angle: FACES_JS_TRANSFORM_BOUNDS["eyebrow.angle"][0] },
    smileLine: { size: FACES_JS_TRANSFORM_BOUNDS["smileLine.size"][0] },
    hair: { flip: false },
    mouth: { flip: false },
    nose: { flip: false, size: FACES_JS_TRANSFORM_BOUNDS["nose.size"][0] },
  }), [
    "fatness", "body.size", "ear.size", "eye.angle", "eyebrow.angle",
    "smileLine.size", "hair.flip", "mouth.flip", "nose.flip", "nose.size",
  ]);
  addCase(rows, ids, "transform-maximum", "transform-boundary", faceWith(neutral, {
    fatness: FACES_JS_TRANSFORM_BOUNDS.fatness[1],
    body: { size: FACES_JS_TRANSFORM_BOUNDS["body.size"][1] },
    ear: { size: FACES_JS_TRANSFORM_BOUNDS["ear.size"][1] },
    eye: { angle: FACES_JS_TRANSFORM_BOUNDS["eye.angle"][1] },
    eyebrow: { angle: FACES_JS_TRANSFORM_BOUNDS["eyebrow.angle"][1] },
    smileLine: { size: FACES_JS_TRANSFORM_BOUNDS["smileLine.size"][1] },
    hair: { flip: true },
    mouth: { flip: true },
    nose: { flip: true, size: FACES_JS_TRANSFORM_BOUNDS["nose.size"][1] },
  }), [
    "fatness", "body.size", "ear.size", "eye.angle", "eyebrow.angle",
    "smileLine.size", "hair.flip", "mouth.flip", "nose.flip", "nose.size",
  ]);
  addCase(rows, ids, "color-contract", "color-boundary", faceWith(neutral, {
    teamColors: ["#112233", "#445566", "#778899"],
    body: { color: "#a1b2c3" },
    head: { shave: "rgba(0, 0, 0, 0.25)" },
    hair: { color: "#123456" },
  }), ["teamColors", "body.color", "head.shave", "hair.color"]);
  addCase(rows, ids, "layer-collision", "layer-collision", faceWith(neutral, {
    accessories: { id: "eye-black" },
    eyeLine: { id: "line6" },
    facialHair: { id: "beard6" },
    glasses: { id: "glasses2-primary" },
    miscLine: { id: "blush" },
    smileLine: { id: "line4" },
  }));
  const dependencyHairRows = catalog.components.filter(({ family, dependencies }) =>
    family === "hair" && dependencies.some((row) => row.family === "hairBg"));
  for (const row of dependencyHairRows) {
    const background = row.dependencies.find(({ family }) => family === "hairBg").sourceId;
    addCase(rows, ids, `hair-pair-${row.sourceId}`, "hair-background-pair", faceWith(neutral, {
      accessories: { id: "none" },
      hair: { id: row.sourceId },
      hairBg: { id: background },
    }));
  }
  const bodyIds = catalog.components.filter(({ family }) => family === "body");
  const jerseyIds = catalog.components.filter(({ family }) => family === "jersey");
  for (const [index, body] of bodyIds.entries()) {
    const jersey = jerseyIds[index % jerseyIds.length];
    addCase(rows, ids, `body-jersey-${body.sourceId}-${jersey.sourceId}`, "body-jersey-pair", faceWith(neutral, {
      body: { id: body.sourceId },
      jersey: { id: jersey.sourceId },
    }));
  }
  for (const row of catalog.components.filter(({ family }) => family === "glasses")) {
    addCase(rows, ids, `glasses-${row.sourceId}`, "glasses", faceWith(neutral, {
      glasses: { id: row.sourceId },
    }));
  }
  for (const hat of ["hat", "hat2", "hat3", "santa-hat"]) {
    for (const [outcome, hair] of [
      ["short", "afro"],
      ["short-fade", "dreads"],
      ["hidden", "cornrows"],
    ]) {
      addCase(rows, ids, `hat-${hat}-${outcome}`, "hat-substitution", faceWith(neutral, {
        accessories: { id: hat },
        hair: { id: hair },
        hairBg: { id: "none" },
      }));
    }
  }
  return Object.freeze({ rows, coverageSeeds });
}

function propertyCoverage(compatibility, cases, resolvedCases) {
  const byId = new Map(cases.map((row) => [row.id, row]));
  const output = Object.fromEntries(compatibility.display.faceConfigProperties.map((path) => [path, []]));
  for (const row of cases) {
    for (const property of row.properties) output[property].push(row.id);
  }
  const familyProperty = {
    accessories: "accessories.id",
    body: "body.id",
    ear: "ear.id",
    eye: "eye.id",
    eyeLine: "eyeLine.id",
    eyebrow: "eyebrow.id",
    facialHair: "facialHair.id",
    glasses: "glasses.id",
    hair: "hair.id",
    hairBg: "hairBg.id",
    head: "head.id",
    jersey: "jersey.id",
    miscLine: "miscLine.id",
    mouth: "mouth.id",
    nose: "nose.id",
    smileLine: "smileLine.id",
  };
  const seen = new Set();
  for (const row of resolvedCases) {
    for (const key of row.selectedKeys) {
      if (seen.has(key)) continue;
      seen.add(key);
      const family = key.slice(0, key.indexOf(":"));
      const property = familyProperty[family];
      if (property && !output[property].includes(row.id)) output[property].push(row.id);
    }
  }
  for (const [path, caseIds] of Object.entries(output)) {
    if (caseIds.length === 0 || caseIds.some((id) => !byId.has(id))) {
      throw new Error(`FacesJS FaceConfig property ${path} has no named corpus case.`);
    }
    output[path] = Object.freeze(caseIds);
  }
  return Object.freeze(output);
}

function unsupportedEvidence(compatibility, graph, neutral) {
  const output = [];
  for (const [family, document] of Object.entries(compatibility.families)) {
    for (const entry of document.ids.filter(({ support }) => support === "unsupported")) {
      const config = faceWith(neutral, { [family]: { id: entry.id } });
      let failure;
      try {
        resolveFacesJsFaceConfig(graph, config);
      } catch (error) {
        failure = error;
      }
      if (!failure?.code) {
        throw new Error(`FacesJS unsupported ${family}.${entry.id} did not fail structurally.`);
      }
      output.push(Object.freeze({
        family,
        sourceId: entry.id,
        reason: entry.reason,
        errorCode: failure.code,
      }));
    }
  }
  return Object.freeze(output);
}

async function buildCorpus() {
  const [compatibility, catalogInput] = await Promise.all([
    readJson(compatibilityPath),
    readJson(catalogPath),
  ]);
  const catalog = await validateFacesJsComponentCatalog(catalogInput);
  const graph = createFacesJsComponentGraph(catalog);
  const components = await componentEvidence(catalog);
  const authored = authoredCases(catalog, graph);
  const resolvedCases = authored.rows.map((row) => {
    const resolved = resolveFacesJsFaceConfig(graph, row.face);
    return Object.freeze({
      id: row.id,
      kind: row.kind,
      properties: row.properties,
      face: resolved.config,
      selectedKeys: resolved.selectedKeys,
      upstream: upstreamEvidence(compatibility, resolved.config, resolved),
    });
  });
  const reached = new Set(resolvedCases.flatMap(({ selectedKeys }) => selectedKeys));
  const expected = new Set(catalog.components.map(
    ({ family, sourceId }) => `${family}:${sourceId}`,
  ));
  const missing = [...expected].filter((key) => !reached.has(key));
  if (missing.length > 0) {
    throw new Error(`FacesJS corpus misses ${missing.join(", ")}.`);
  }
  const componentInventorySha256 = sha256(JSON.stringify(components));
  const payload = Object.freeze({
    schema: SCHEMA,
    facesJs: Object.freeze({
      version: compatibility.facesJs.version,
      sourceRevision: compatibility.facesJs.sourceRevision,
      componentCatalogContentHash: catalog.contentHash,
    }),
    displayOrder: compatibility.display.order,
    componentCount: catalog.components.length,
    caseCount: resolvedCases.length,
    coverageSeeds: authored.coverageSeeds,
    propertyCoverage: propertyCoverage(compatibility, authored.rows, resolvedCases),
    unsupportedExpectedFailures: unsupportedEvidence(
      compatibility,
      graph,
      generateCssFaceConfig(catalog, 0),
    ),
    components,
    cases: Object.freeze(resolvedCases),
    determinism: Object.freeze({
      componentInventorySha256,
      comparison: "tracked-public-output-vs-clean-recomputed-check",
    }),
  });
  const document = Object.freeze({
    ...payload,
    contentHash: sha256(JSON.stringify(payload)),
  });
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
}

const write = process.argv.includes("--write");
const check = process.argv.includes("--check") || !write;
const first = await buildCorpus();
const second = await buildCorpus();
if (!first.equals(second)) {
  throw new Error("FacesJS differential corpus is not byte-deterministic.");
}
if (write) {
  await mkdir(dirname(corpusPath), { recursive: true });
  await writeFile(corpusPath, first);
}
if (check) {
  if (!(await readFile(corpusPath)).equals(first)) {
    throw new Error("FacesJS differential corpus is stale.");
  }
  execFileSync(process.execPath, [prepareScriptPath, "--check"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}
const document = JSON.parse(first);
console.log(
  `FacesJS corpus check passed: ${document.caseCount} cases, ` +
  `${document.componentCount} components, ${document.coverageSeeds.length} coverage seeds, ` +
  `${Object.keys(document.propertyCoverage).length} FaceConfig properties.`,
);
