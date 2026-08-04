import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { svgs, svgsIndex } from "facesjs";

import {
  boundsOfPaths,
  parseSvgFragment,
} from "./svgGeometry.mjs";

const SCHEMA = "cssface.facesjs-hair-strategies@1";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../../../..");
const compatibilityPath = resolve(repoRoot, "src/adapters/facesjs/compatibility.json");
const strategyPath = resolve(repoRoot, "src/adapters/facesjs/hairStrategies.json");
const displayPath = resolve(repoRoot, "node_modules/facesjs/build/display.js");

const CLASSIFICATIONS = Object.freeze({
  "empty-bald": Object.freeze([
    "hair:bald",
    "hairBg:none",
  ]),
  fade: Object.freeze([
    "hair:blowoutFade",
    "hair:cornrows",
    "hair:crop-fade",
    "hair:crop-fade2",
    "hair:curlyFade1",
    "hair:curlyFade2",
    "hair:dreads",
    "hair:fauxhawk-fade",
    "hair:short-fade-2",
    "hair:short-fade",
    "hair:tall-fade",
  ]),
  "background-coupled": Object.freeze([
    "hair:female1",
    "hair:female2",
    "hair:female3",
    "hair:female4",
    "hair:female5",
    "hair:longHair",
    "hair:shaggy1",
    "hair:shaggy2",
    "hairBg:female1",
    "hairBg:female2",
    "hairBg:female3",
    "hairBg:female4",
    "hairBg:female5",
    "hairBg:longHair",
    "hairBg:shaggy",
  ]),
  "rear-long": Object.freeze([
    "hair:female6",
    "hair:female7",
    "hair:female8",
    "hair:female9",
    "hair:female10",
    "hair:female11",
    "hair:female12",
  ]),
  "raised-mass": Object.freeze([
    "hair:afro",
    "hair:afro2",
    "hair:curly",
    "hair:curly2",
    "hair:curly3",
    "hair:faux-hawk",
    "hair:high",
    "hair:juice",
    "hair:messy-short",
    "hair:messy",
    "hair:spike",
    "hair:spike2",
    "hair:spike3",
    "hair:spike4",
  ]),
  cap: Object.freeze([
    "hair:crop",
    "hair:emo",
    "hair:hair",
    "hair:middle-part",
    "hair:parted",
    "hair:short-bald",
    "hair:short",
    "hair:short2",
    "hair:short3",
    "hair:shortBangs",
  ]),
});

const COUPLED_BACKGROUNDS = Object.freeze({
  female1: Object.freeze(["female1"]),
  female2: Object.freeze(["female2"]),
  female3: Object.freeze(["female3"]),
  female4: Object.freeze(["female4"]),
  female5: Object.freeze(["female5"]),
  longHair: Object.freeze(["longHair"]),
  shaggy1: Object.freeze(["shaggy"]),
  shaggy2: Object.freeze(["shaggy"]),
});

const COUPLED_FRONTS = Object.freeze(Object.fromEntries(
  svgsIndex.hairBg.map((sourceId) => [
    sourceId,
    Object.entries(COUPLED_BACKGROUNDS)
      .filter(([, backgroundIds]) => backgroundIds.includes(sourceId))
      .map(([frontId]) => frontId)
      .sort(),
  ]),
));

const CONTRACTS = Object.freeze([
  Object.freeze({
    id: "hair-background-coupled-v1",
    strategy: "background-coupled",
    families: Object.freeze(["hair", "hairBg"]),
    representativeSources: Object.freeze([
      Object.freeze({ family: "hair", sourceId: "female1" }),
      Object.freeze({ family: "hair", sourceId: "longHair" }),
      Object.freeze({ family: "hairBg", sourceId: "female1" }),
      Object.freeze({ family: "hairBg", sourceId: "shaggy" }),
    ]),
    frontContour: "source-fill-contours",
    rearClosure: "adapter-authored-separated-front-and-behind-head-shells",
    headWeldBoundary: "source-front-intersection-with-selected-head-plus-rear-shoulder-clearance",
  }),
  Object.freeze({
    id: "hair-cap-v1",
    strategy: "cap",
    families: Object.freeze(["hair"]),
    representativeSources: Object.freeze([
      Object.freeze({ family: "hair", sourceId: "short" }),
      Object.freeze({ family: "hair", sourceId: "crop" }),
    ]),
    frontContour: "source-fill-contours",
    rearClosure: "adapter-authored-head-conforming-side-and-rear-shell",
    headWeldBoundary: "source-contour-intersection-with-selected-head",
  }),
  Object.freeze({
    id: "hair-empty-v1",
    strategy: "empty-bald",
    families: Object.freeze(["hair", "hairBg"]),
    representativeSources: Object.freeze([
      Object.freeze({ family: "hair", sourceId: "bald" }),
      Object.freeze({ family: "hairBg", sourceId: "none" }),
    ]),
    frontContour: "empty-source",
    rearClosure: "none",
    headWeldBoundary: "none",
  }),
  Object.freeze({
    id: "hair-fade-v1",
    strategy: "fade",
    families: Object.freeze(["hair"]),
    representativeSources: Object.freeze([
      Object.freeze({ family: "hair", sourceId: "short-fade" }),
      Object.freeze({ family: "hair", sourceId: "curlyFade1" }),
    ]),
    frontContour: "source-fill-contours-and-gradient-stops",
    rearClosure: "adapter-authored-head-conforming-side-and-rear-shell-with-opacity-bands",
    headWeldBoundary: "source-contour-intersection-with-selected-head",
  }),
  Object.freeze({
    id: "hair-raised-mass-v1",
    strategy: "raised-mass",
    families: Object.freeze(["hair"]),
    representativeSources: Object.freeze([
      Object.freeze({ family: "hair", sourceId: "afro" }),
      Object.freeze({ family: "hair", sourceId: "faux-hawk" }),
    ]),
    frontContour: "source-fill-contours",
    rearClosure: "adapter-authored-offset-volume-and-rear-shell",
    headWeldBoundary: "source-lower-contour-intersection-with-selected-head",
  }),
  Object.freeze({
    id: "hair-rear-long-v1",
    strategy: "rear-long",
    families: Object.freeze(["hair"]),
    representativeSources: Object.freeze([
      Object.freeze({ family: "hair", sourceId: "female7" }),
      Object.freeze({ family: "hair", sourceId: "female10" }),
    ]),
    frontContour: "source-fill-contours",
    rearClosure: "adapter-authored-separated-front-and-rear-shell",
    headWeldBoundary: "source-head-intersection-with-explicit-shoulder-clearance",
  }),
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function strategyIndex() {
  const output = new Map();
  for (const [strategy, keys] of Object.entries(CLASSIFICATIONS)) {
    for (const key of keys) {
      if (output.has(key)) throw new Error(`FacesJS hair strategy duplicates ${key}.`);
      output.set(key, strategy);
    }
  }
  return output;
}

function displayArrays(source) {
  const rows = [...source.matchAll(/\[(?:\s*"[^"]+"\s*,?)+\]/gu)]
    .map((match) => JSON.parse(match[0]));
  const hats = rows.find((row) => row.includes("santa-hat"));
  const substituteShort = rows.find((row) => row.includes("afro"));
  const substituteFade = rows.find((row) => row.includes("blowoutFade"));
  if (!hats || !substituteShort || !substituteFade
    || !source.includes('face.hair.id = "short";')
    || !source.includes('face.hair.id = "short-fade";')) {
    throw new Error("FacesJS upstream hat/hair substitution rules are unavailable.");
  }
  return {
    hats: [...hats].sort(),
    substituteShort: new Set(substituteShort),
    substituteFade: new Set(substituteFade),
  };
}

function sourceAnalysis(fragment) {
  if (!fragment.trim()) {
    return Object.freeze({
      pathCount: 0,
      sourceBounds: null,
      hasGradient: false,
    });
  }
  const paths = parseSvgFragment(fragment);
  const bounds = boundsOfPaths(paths);
  return Object.freeze({
    pathCount: paths.length,
    sourceBounds: Object.freeze({
      minimumX: Number(bounds.minimumX.toFixed(4)),
      maximumX: Number(bounds.maximumX.toFixed(4)),
      minimumY: Number(bounds.minimumY.toFixed(4)),
      maximumY: Number(bounds.maximumY.toFixed(4)),
    }),
    hasGradient: fragment.includes("<linearGradient"),
  });
}

function geometryContract(strategy) {
  const contract = CONTRACTS.find((row) => row.strategy === strategy);
  if (!contract) throw new Error(`FacesJS hair strategy ${strategy} has no contract.`);
  return contract;
}

function strategyReason(family, strategy) {
  if (strategy === "empty-bald") return "the upstream SVG fragment is explicitly empty";
  if (family === "hairBg") return "the upstream family is painted behind the body and head";
  if (strategy === "fade") return "the source includes a linear-gradient fade plus its opaque contour";
  if (strategy === "background-coupled") return "the source id has an explicit catalog counterpart in hairBg";
  if (strategy === "rear-long") return "the source foreground extends below the nominal head hairline without a hairBg counterpart";
  if (strategy === "raised-mass") return "the source outer contour requires visible offset volume above the selected head";
  return "the source remains within a head-conforming front-cap envelope";
}

function entryFor(
  compatibility,
  strategies,
  hats,
  family,
  sourceId,
) {
  const key = `${family}:${sourceId}`;
  const strategy = strategies.get(key);
  if (!strategy) throw new Error(`FacesJS hair source ${key} is unclassified.`);
  const source = svgs[family][sourceId];
  const matrix = compatibility.families[family].ids.find((row) => row.id === sourceId);
  if (!matrix || sha256(source) !== matrix.sourceSha256) {
    throw new Error(`FacesJS hair source ${key} has stale provenance.`);
  }
  const contract = geometryContract(strategy);
  const accessorySubstitution = family === "hairBg"
    ? { action: "unaffected", replacementSourceId: null }
    : hats.substituteShort.has(sourceId)
      ? { action: "substitute", replacementSourceId: "short" }
      : hats.substituteFade.has(sourceId)
        ? { action: "substitute", replacementSourceId: "short-fade" }
        : { action: "hide", replacementSourceId: null };
  return Object.freeze({
    family,
    sourceId,
    sourceSha256: matrix.sourceSha256,
    sourceEmpty: source.trim() === "",
    strategy,
    geometryContract: contract.id,
    outcome: "planned-supported",
    strategyReason: strategyReason(family, strategy),
    frontContour: contract.frontContour,
    rearClosure: contract.rearClosure,
    headWeldBoundary: contract.headWeldBoundary,
    compatibleBackgroundSourceIds: family === "hair"
      ? [...(COUPLED_BACKGROUNDS[sourceId] ?? [])]
      : [],
    compatibleFrontSourceIds: family === "hairBg"
      ? [...(COUPLED_FRONTS[sourceId] ?? [])]
      : [],
    accessorySubstitution,
    sourceAnalysis: sourceAnalysis(source),
    unsupported: null,
  });
}

async function expectedDocument() {
  const [compatibility, displaySource] = await Promise.all([
    JSON.parse(await readFile(compatibilityPath, "utf8")),
    readFile(displayPath, "utf8"),
  ]);
  const strategies = strategyIndex();
  const catalogKeys = ["hair", "hairBg"].flatMap((family) =>
    svgsIndex[family].map((sourceId) => `${family}:${sourceId}`));
  if (strategies.size !== catalogKeys.length
    || catalogKeys.some((key) => !strategies.has(key))) {
    throw new Error(
      `FacesJS hair strategy coverage is ${strategies.size}/${catalogKeys.length}.`,
    );
  }
  const hats = displayArrays(displaySource);
  const entries = ["hair", "hairBg"].flatMap((family) =>
    [...svgsIndex[family]].sort().map((sourceId) =>
      entryFor(compatibility, strategies, hats, family, sourceId)));
  return Object.freeze({
    schema: SCHEMA,
    facesJsVersion: compatibility.facesJs.version,
    sourceRevision: compatibility.facesJs.sourceRevision,
    hatAccessories: hats.hats,
    geometryContracts: CONTRACTS,
    entries,
  });
}

function validateSemantics(document) {
  const entryByKey = new Map(document.entries.map((row) => [`${row.family}:${row.sourceId}`, row]));
  for (const row of document.entries) {
    if (row.outcome === "unsupported") {
      if (!row.unsupported?.sourceLimitation || !row.unsupported?.counterexampleTarget) {
        throw new Error(`FacesJS unsupported hair ${row.family}.${row.sourceId} lacks evidence.`);
      }
    } else if (row.unsupported !== null) {
      throw new Error(`FacesJS supported hair ${row.family}.${row.sourceId} has unsupported evidence.`);
    }
    if (row.sourceEmpty !== (row.strategy === "empty-bald")) {
      throw new Error(`FacesJS hair ${row.family}.${row.sourceId} has an invalid empty strategy.`);
    }
    if (row.strategy === "fade" && !row.sourceAnalysis.hasGradient) {
      throw new Error(`FacesJS fade ${row.sourceId} has no source gradient.`);
    }
    if (row.strategy === "cap" && row.sourceAnalysis.sourceBounds.maximumY > 341) {
      throw new Error(`FacesJS cap ${row.sourceId} extends below the cap envelope.`);
    }
    if (row.strategy === "rear-long"
      && row.sourceAnalysis.sourceBounds.maximumY <= 310) {
      throw new Error(`FacesJS rear/long ${row.sourceId} lacks a source rear extension.`);
    }
    for (const backgroundId of row.compatibleBackgroundSourceIds) {
      const background = entryByKey.get(`hairBg:${backgroundId}`);
      if (!background || !background.compatibleFrontSourceIds.includes(row.sourceId)) {
        throw new Error(`FacesJS hair coupling ${row.sourceId}/${backgroundId} is asymmetric.`);
      }
    }
    for (const frontId of row.compatibleFrontSourceIds) {
      const front = entryByKey.get(`hair:${frontId}`);
      if (!front || !front.compatibleBackgroundSourceIds.includes(row.sourceId)) {
        throw new Error(`FacesJS hair coupling ${frontId}/${row.sourceId} is asymmetric.`);
      }
    }
  }
  for (const contract of document.geometryContracts) {
    if (!contract.representativeSources.length) {
      throw new Error(`FacesJS hair contract ${contract.id} has no representative.`);
    }
    for (const representative of contract.representativeSources) {
      const row = entryByKey.get(`${representative.family}:${representative.sourceId}`);
      if (!row || row.geometryContract !== contract.id) {
        throw new Error(`FacesJS hair contract ${contract.id} has a stale representative.`);
      }
    }
  }
}

const write = process.argv.includes("--write");
const check = process.argv.includes("--check") || !write;
const expected = await expectedDocument();
validateSemantics(expected);
const bytes = `${JSON.stringify(expected, null, 2)}\n`;
if (write) await writeFile(strategyPath, bytes);
if (check) {
  const actual = await readFile(strategyPath, "utf8");
  if (actual !== bytes) throw new Error(`FacesJS hair strategy catalog ${strategyPath} is stale.`);
  validateSemantics(JSON.parse(actual));
}
const counts = Object.fromEntries(Object.keys(CLASSIFICATIONS).sort().map((strategy) => [
  strategy,
  expected.entries.filter((row) => row.strategy === strategy).length,
]));
console.log(
  `FacesJS hair strategy check passed: ${expected.entries.length} ids, `
  + `${JSON.stringify(counts)}.`,
);
