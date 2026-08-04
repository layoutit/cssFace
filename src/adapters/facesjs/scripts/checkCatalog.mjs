import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { svgs, svgsIndex } from "facesjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../../../..");
const compatibilityPath = resolve(repoRoot, "src/adapters/facesjs/compatibility.json");
const presetsPath = resolve(repoRoot, "src/adapters/facesjs/presets.json");
const facesJsEntry = fileURLToPath(import.meta.resolve("facesjs"));
const facesJsPackagePath = resolve(dirname(facesJsEntry), "../package.json");

const SCHEMA = "cssface.facesjs-compatibility@1";
const SOURCE_REVISION = "92c91d4b67893dbeef4053c25c04cc01fdd5419a";
const EXPECTED_VERSION = "5.0.3";
const SUPPORT_STATES = new Set([
  "baseline-allowlisted",
  "planned",
  "supported",
  "empty",
  "unsupported",
]);

const DISPLAY_ORDER = Object.freeze([
  "hairBg",
  "body",
  "jersey",
  "ear",
  "head",
  "eyeLine",
  "smileLine",
  "miscLine",
  "facialHair",
  "eye",
  "eyebrow",
  "mouth",
  "nose",
  "hair",
  "glasses",
  "accessories",
]);

const FACE_CONFIG_PROPERTIES = Object.freeze([
  "fatness",
  "teamColors",
  "hairBg.id",
  "body.id",
  "body.color",
  "body.size",
  "jersey.id",
  "ear.id",
  "ear.size",
  "head.id",
  "head.shave",
  "eyeLine.id",
  "smileLine.id",
  "smileLine.size",
  "miscLine.id",
  "facialHair.id",
  "eye.id",
  "eye.angle",
  "eyebrow.id",
  "eyebrow.angle",
  "hair.id",
  "hair.color",
  "hair.flip",
  "mouth.id",
  "mouth.flip",
  "nose.id",
  "nose.flip",
  "nose.size",
  "glasses.id",
  "accessories.id",
]);

const TARGET_STRATEGIES = Object.freeze({
  accessories: "accessory-classification",
  body: "connected-region",
  ear: "head-attached-shell",
  eye: "projected-feature",
  eyeLine: "surface-overlay",
  eyebrow: "projected-feature",
  facialHair: "surface-overlay",
  glasses: "raised-component",
  hair: "hair-classification",
  hairBg: "rear-hair-classification",
  head: "source-contour-shell",
  jersey: "connected-region",
  miscLine: "surface-overlay",
  mouth: "projected-feature",
  nose: "projected-feature",
  smileLine: "surface-overlay",
});

const HAT_RULES = Object.freeze({
  hats: Object.freeze(["hat", "hat2", "hat3", "santa-hat"]),
  replaceWithShort: Object.freeze([
    "afro",
    "afro2",
    "curly",
    "curly2",
    "curly3",
    "faux-hawk",
    "hair",
    "high",
    "juice",
    "messy-short",
    "messy",
    "middle-part",
    "parted",
    "shaggy1",
    "shaggy2",
    "short3",
    "spike",
    "spike2",
    "spike3",
    "spike4",
  ]),
  replaceWithShortFade: Object.freeze([
    "blowoutFade",
    "curlyFade1",
    "curlyFade2",
    "dreads",
    "fauxhawk-fade",
    "tall-fade",
  ]),
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameValues(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function currentAllowlist() {
  return Object.freeze({
    body: new Set(["body"]),
    ear: new Set(["ear1"]),
    eye: new Set(["eye1", "eye2"]),
    eyebrow: new Set(["eyebrow1"]),
    hair: new Set(["afro", "bald", "short", "short2"]),
    head: new Set(svgsIndex.head),
    jersey: new Set(["jersey"]),
    mouth: new Set(["closed", "smile"]),
    nose: new Set(["nose1", "nose3"]),
  });
}

function presetUsage(presets) {
  const usage = new Map();
  for (const preset of presets) {
    for (const family of Object.keys(svgsIndex)) {
      const id = preset.face?.[family]?.id;
      if (typeof id !== "string") continue;
      const key = `${family}:${id}`;
      const ids = usage.get(key) ?? [];
      ids.push(preset.id);
      usage.set(key, ids);
    }
  }
  return usage;
}

async function sourceFacts() {
  const [facesJsPackage, presets] = await Promise.all([
    readJson(facesJsPackagePath),
    readJson(presetsPath),
  ]);
  const allowlist = currentAllowlist();
  const usage = presetUsage(presets);
  const families = {};
  let totalIds = 0;
  let allowlistedIds = 0;
  for (const family of Object.keys(svgsIndex)) {
    const ids = sorted(svgsIndex[family]);
    totalIds += ids.length;
    families[family] = {
      count: ids.length,
      targetStrategy: TARGET_STRATEGIES[family],
      ids: ids.map((id) => {
        const fragment = svgs[family]?.[id];
        assert(typeof fragment === "string", `FacesJS is missing ${family}.${id}.`);
        const currentAllowlisted = allowlist[family]?.has(id) ?? false;
        if (currentAllowlisted) allowlistedIds += 1;
        return {
          id,
          sourceSha256: sha256(fragment),
          sourceEmpty: fragment.length === 0,
          currentAllowlisted,
          currentPresetIds: sorted(usage.get(`${family}:${id}`) ?? []),
          support: currentAllowlisted ? "baseline-allowlisted" : "planned",
          intendedStrategy: TARGET_STRATEGIES[family],
          evidence: [],
        };
      }),
    };
  }
  const presetSelectedIds = [...usage.keys()].length;
  const presetExercisedIds = [...usage.keys()].filter((key) => {
    const [family, id] = key.split(":");
    return allowlist[family]?.has(id) ?? false;
  }).length;
  const randomPresetIds = presets
    .filter((preset) => preset.random !== false)
    .map((preset) => preset.id);
  return {
    facesJsVersion: facesJsPackage.version,
    presets,
    totalIds,
    allowlistedIds,
    presetSelectedIds,
    presetExercisedIds,
    randomPresetIds,
    families,
  };
}

function generatedCompatibility(facts) {
  return {
    schema: SCHEMA,
    facesJs: {
      version: facts.facesJsVersion,
      sourceRevision: SOURCE_REVISION,
      catalogTotal: facts.totalIds,
    },
    baseline: {
      allowlistedIds: facts.allowlistedIds,
      presetSelectedIds: facts.presetSelectedIds,
      presetExercisedIds: facts.presetExercisedIds,
      presetIds: facts.presets.map((preset) => preset.id),
      randomPresetIds: facts.randomPresetIds,
    },
    display: {
      order: DISPLAY_ORDER,
      faceConfigProperties: FACE_CONFIG_PROPERTIES,
      hatRules: HAT_RULES,
    },
    families: facts.families,
  };
}

function validateMutableEntries(document, facts) {
  for (const [family, expectedFamily] of Object.entries(facts.families)) {
    const actualFamily = document.families?.[family];
    assert(actualFamily, `Compatibility matrix is missing family ${family}.`);
    assert(actualFamily.count === expectedFamily.count, `${family} count changed.`);
    assert(typeof actualFamily.targetStrategy === "string", `${family} needs a target strategy.`);
    assert(Array.isArray(actualFamily.ids), `${family}.ids must be an array.`);
    const expectedById = new Map(expectedFamily.ids.map((entry) => [entry.id, entry]));
    const seen = new Set();
    for (const entry of actualFamily.ids) {
      assert(entry && typeof entry === "object", `${family} has an invalid entry.`);
      assert(!seen.has(entry.id), `${family}.${entry.id} is duplicated.`);
      seen.add(entry.id);
      const expected = expectedById.get(entry.id);
      assert(expected, `${family}.${entry.id} is not in facesjs@${EXPECTED_VERSION}.`);
      assert(entry.sourceSha256 === expected.sourceSha256, `${family}.${entry.id} source hash changed.`);
      assert(entry.sourceEmpty === expected.sourceEmpty, `${family}.${entry.id} empty state changed.`);
      assert(entry.currentAllowlisted === expected.currentAllowlisted, `${family}.${entry.id} baseline allowlist changed.`);
      assert(sameValues(entry.currentPresetIds, expected.currentPresetIds), `${family}.${entry.id} preset usage changed.`);
      assert(SUPPORT_STATES.has(entry.support), `${family}.${entry.id} has invalid support state ${entry.support}.`);
      assert(typeof entry.intendedStrategy === "string" && entry.intendedStrategy.length > 0, `${family}.${entry.id} needs an intended strategy.`);
      assert(Array.isArray(entry.evidence), `${family}.${entry.id}.evidence must be an array.`);
      if (entry.support === "unsupported") {
        assert(typeof entry.reason === "string" && entry.reason.length > 0, `${family}.${entry.id} needs an unsupported reason.`);
      }
    }
    assert(seen.size === expectedById.size, `${family} does not represent every upstream id.`);
  }
  const actualFamilies = sorted(Object.keys(document.families ?? {}));
  const expectedFamilies = sorted(Object.keys(facts.families));
  assert(sameValues(actualFamilies, expectedFamilies), "Compatibility family set changed.");
}

async function check() {
  const [document, facts] = await Promise.all([
    readJson(compatibilityPath),
    sourceFacts(),
  ]);
  assert(document.schema === SCHEMA, `Expected schema ${SCHEMA}.`);
  assert(facts.facesJsVersion === EXPECTED_VERSION, `Expected facesjs@${EXPECTED_VERSION}, found ${facts.facesJsVersion}.`);
  assert(document.facesJs?.version === facts.facesJsVersion, "Tracked FacesJS version changed.");
  assert(document.facesJs?.sourceRevision === SOURCE_REVISION, "Tracked FacesJS source revision changed.");
  assert(document.facesJs?.catalogTotal === facts.totalIds, "Tracked catalog total changed.");
  assert(facts.totalIds === 326, `Expected 326 SVG ids, found ${facts.totalIds}.`);
  assert(facts.allowlistedIds === 35, `Expected 35 baseline allowlisted ids, found ${facts.allowlistedIds}.`);
  assert(facts.presetExercisedIds === 20, `Expected 20 preset-exercised ids, found ${facts.presetExercisedIds}.`);
  assert(facts.presetSelectedIds === 35, `Expected 35 selected config ids, found ${facts.presetSelectedIds}.`);
  assert(facts.randomPresetIds.length === 3, `Expected 3 random presets, found ${facts.randomPresetIds.length}.`);
  assert(sameValues(document.baseline?.randomPresetIds, facts.randomPresetIds), "Random preset baseline changed.");
  assert(sameValues(document.display?.order, DISPLAY_ORDER), "FacesJS display order changed.");
  assert(sameValues(document.display?.faceConfigProperties, FACE_CONFIG_PROPERTIES), "FaceConfig property contract changed.");
  assert(sameValues(document.display?.hatRules, HAT_RULES), "Hat/hair substitution contract changed.");
  validateMutableEntries(document, facts);
  return facts;
}

const write = process.argv.includes("--write");
const shouldCheck = process.argv.includes("--check") || !write;
if (write) {
  const facts = await sourceFacts();
  await writeFile(compatibilityPath, `${JSON.stringify(generatedCompatibility(facts), null, 2)}\n`);
}
if (shouldCheck) {
  const facts = await check();
  console.log(
    `FacesJS catalog check passed: ${facts.totalIds} ids, ${facts.allowlistedIds} baseline allowlisted, ` +
    `${facts.presetSelectedIds} preset-selected, ${facts.presetExercisedIds} allowlisted/exercised, ` +
    `${facts.randomPresetIds.length} random presets.`,
  );
}
