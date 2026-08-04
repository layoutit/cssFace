import {
  cssGraphicsContentHash,
} from "../../../model-package/modelPackage.mjs";

export const FACES_JS_COMPONENT_MANIFEST_SCHEMA =
  "cssface.facesjs-component@1";
export const FACES_JS_COMPONENT_CATALOG_SCHEMA =
  "cssface.facesjs-component-catalog@1";
export const FACES_JS_COMPONENT_BASE_MANIFEST_SCHEMA =
  "cssface.facesjs-component-base@1";

export const FACES_JS_COMPONENT_FAMILIES = Object.freeze([
  "accessories",
  "body",
  "ear",
  "eye",
  "eyeLine",
  "eyebrow",
  "facialHair",
  "glasses",
  "hair",
  "hairBg",
  "head",
  "jersey",
  "miscLine",
  "mouth",
  "nose",
  "smileLine",
] as const);

export const FACES_JS_DISPLAY_LAYERS = Object.freeze([
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
] as const);

export type FacesJsComponentFamily =
  (typeof FACES_JS_COMPONENT_FAMILIES)[number];
export type FacesJsComponentAttachment =
  | "body-shell"
  | "face-surface"
  | "head-shell"
  | "raised"
  | "rear-layer";

export interface FacesJsComponentSelection {
  readonly family: FacesJsComponentFamily;
  readonly sourceId: string;
  readonly sourceSha256: string;
}

export interface FacesJsComponentDependency {
  readonly family: FacesJsComponentFamily;
  readonly sourceId: string;
}

export interface FacesJsComponentAssetDescriptor {
  readonly path: string;
  readonly mediaType:
    | "application/gzip"
    | "application/json"
    | "image/png"
    | "image/webp"
    | "text/css";
  readonly bytes: number;
  readonly sha256: string;
}

export interface FacesJsComponentBaseManifest {
  readonly schema: typeof FACES_JS_COMPONENT_BASE_MANIFEST_SCHEMA;
  readonly id: string;
  readonly profile: "morph-regions";
  readonly sourceRevision: string;
  readonly modelScale: number;
  readonly modelMatrix: readonly number[];
  readonly contentHash: string;
}

export interface FacesJsComponentManifest {
  readonly schema: typeof FACES_JS_COMPONENT_MANIFEST_SCHEMA;
  readonly id: string;
  readonly family: FacesJsComponentFamily;
  readonly sourceId: string;
  readonly sourceSha256: string;
  readonly layer: number;
  readonly attachment: FacesJsComponentAttachment;
  readonly materialRoles: readonly string[];
  readonly dependencies: readonly FacesJsComponentDependency[];
  readonly assets: Readonly<Record<string, FacesJsComponentAssetDescriptor>>;
  readonly contentHash: string;
}

export interface FacesJsComponentCatalogBaseRow {
  readonly id: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
}

export interface FacesJsComponentCatalogRow extends FacesJsComponentSelection {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly layer: number;
  readonly dependencies: readonly FacesJsComponentDependency[];
}

export interface FacesJsCompatibilityFixtureRow {
  readonly id: string;
  readonly baseId: string;
  readonly selections: readonly FacesJsComponentSelection[];
}

export interface FacesJsComponentCatalog {
  readonly schema: typeof FACES_JS_COMPONENT_CATALOG_SCHEMA;
  readonly facesJsVersion: string;
  readonly sourceRevision: string;
  readonly layers: readonly FacesJsComponentFamily[];
  readonly bases: readonly FacesJsComponentCatalogBaseRow[];
  readonly components: readonly FacesJsComponentCatalogRow[];
  readonly compatibilityFixtures: readonly FacesJsCompatibilityFixtureRow[];
  readonly contentHash: string;
}

export type FacesJsSourceIndex = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

type JsonRecord = Record<string, unknown>;
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_REVISION = /^[0-9a-f]{40}$/u;
const NORMALIZED_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SOURCE_ID = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MEDIA_TYPES = new Set([
  "application/gzip",
  "application/json",
  "image/png",
  "image/webp",
  "text/css",
]);
const ATTACHMENTS = new Set<FacesJsComponentAttachment>([
  "body-shell",
  "face-surface",
  "head-shell",
  "raised",
  "rear-layer",
]);

export class FacesJsComponentPackageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FacesJsComponentPackageError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new FacesJsComponentPackageError(code, message);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-contract", `${label} must be an object.`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("invalid-contract", `${label} has missing or unsupported fields.`);
  }
}

function normalizedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !NORMALIZED_ID.test(value)) {
    fail("invalid-id", `${label} must be a normalized id.`);
  }
  return value;
}

function sourceId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SOURCE_ID.test(value)) {
    fail("invalid-source-id", `${label} is not a FacesJS source id.`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("invalid-hash", `${label} must be a SHA-256 hash.`);
  }
  return value;
}

function safePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.startsWith("/")
    || value.endsWith("/") || value.includes("\\") || value.includes("?")
    || value.includes("#") || value.includes("%")
    || value.split("/").some((segment) => !SAFE_SEGMENT.test(segment))) {
    fail("unsafe-path", `${label} must be a safe relative path.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("invalid-number", `${label} must be a positive integer.`);
  }
  return value as number;
}

function family(value: unknown, label: string): FacesJsComponentFamily {
  if (typeof value !== "string"
    || !FACES_JS_COMPONENT_FAMILIES.includes(value as FacesJsComponentFamily)) {
    fail("invalid-family", `${label} is not a FacesJS component family.`);
  }
  return value as FacesJsComponentFamily;
}

function layer(value: unknown, selectedFamily: FacesJsComponentFamily, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("invalid-layer", `${label} must be a non-negative integer.`);
  }
  const expected = FACES_JS_DISPLAY_LAYERS.indexOf(selectedFamily);
  if (value !== expected) {
    fail("invalid-layer", `${label} must be ${expected} for ${selectedFamily}.`);
  }
  return value as number;
}

function canonicalOrderKey(value: FacesJsComponentDependency): string {
  return `${value.family}:${value.sourceId}`;
}

function parseDependency(value: unknown, label: string): FacesJsComponentDependency {
  const input = record(value, label);
  exactKeys(input, ["family", "sourceId"], label);
  return Object.freeze({
    family: family(input.family, `${label}.family`),
    sourceId: sourceId(input.sourceId, `${label}.sourceId`),
  });
}

function parseDependencies(value: unknown, label: string): readonly FacesJsComponentDependency[] {
  if (!Array.isArray(value)) fail("invalid-contract", `${label} must be an array.`);
  const output = value.map((entry, index) => parseDependency(entry, `${label}[${index}]`));
  const keys = output.map(canonicalOrderKey);
  if (new Set(keys).size !== keys.length) fail("duplicate-dependency", `${label} has duplicates.`);
  const sorted = [...keys].sort();
  if (keys.some((key, index) => key !== sorted[index])) {
    fail("noncanonical-order", `${label} must be sorted.`);
  }
  return Object.freeze(output);
}

function assertSource(
  sourceIndex: FacesJsSourceIndex | undefined,
  selectedFamily: FacesJsComponentFamily,
  selectedSourceId: string,
  selectedSha256: string,
  label: string,
): void {
  if (!sourceIndex) return;
  const expected = sourceIndex[selectedFamily]?.[selectedSourceId];
  if (!expected) fail("unknown-source", `${label} is not in the FacesJS source index.`);
  if (expected !== selectedSha256) fail("source-hash-mismatch", `${label} has stale source bytes.`);
}

function parseSelection(
  value: unknown,
  label: string,
  sourceIndex?: FacesJsSourceIndex,
): FacesJsComponentSelection {
  const input = record(value, label);
  exactKeys(input, ["family", "sourceId", "sourceSha256"], label);
  const selectedFamily = family(input.family, `${label}.family`);
  const selectedSourceId = sourceId(input.sourceId, `${label}.sourceId`);
  const selectedSha256 = sha256(input.sourceSha256, `${label}.sourceSha256`);
  assertSource(sourceIndex, selectedFamily, selectedSourceId, selectedSha256, label);
  return Object.freeze({
    family: selectedFamily,
    sourceId: selectedSourceId,
    sourceSha256: selectedSha256,
  });
}

function parseAsset(value: unknown, role: string, label: string): FacesJsComponentAssetDescriptor {
  normalizedId(role, `${label} role`);
  const input = record(value, label);
  exactKeys(input, ["path", "mediaType", "bytes", "sha256"], label);
  const path = safePath(input.path, `${label}.path`);
  if (!path.startsWith("assets/")) fail("unsafe-path", `${label}.path must be under assets/.`);
  if (typeof input.mediaType !== "string" || !MEDIA_TYPES.has(input.mediaType)) {
    fail("invalid-media-type", `${label}.mediaType is unsupported.`);
  }
  return Object.freeze({
    path,
    mediaType: input.mediaType as FacesJsComponentAssetDescriptor["mediaType"],
    bytes: positiveInteger(input.bytes, `${label}.bytes`),
    sha256: sha256(input.sha256, `${label}.sha256`),
  });
}

function parseAssets(value: unknown): Readonly<Record<string, FacesJsComponentAssetDescriptor>> {
  const input = record(value, "component.assets");
  const roles = Object.keys(input);
  const sorted = [...roles].sort();
  if (roles.some((role, index) => role !== sorted[index])) {
    fail("noncanonical-order", "component.assets must be sorted by role.");
  }
  const output: Record<string, FacesJsComponentAssetDescriptor> = {};
  const paths = new Set<string>();
  for (const role of roles) {
    const asset = parseAsset(input[role], role, `component.assets.${role}`);
    if (paths.has(asset.path)) fail("duplicate-path", `component asset path ${asset.path} is duplicated.`);
    paths.add(asset.path);
    output[role] = asset;
  }
  return Object.freeze(output);
}

function parseMaterialRoles(value: unknown): readonly string[] {
  if (!Array.isArray(value)) fail("invalid-contract", "component.materialRoles must be an array.");
  const roles = value.map((entry, index) => normalizedId(entry, `component.materialRoles[${index}]`));
  if (new Set(roles).size !== roles.length) fail("duplicate-id", "component.materialRoles has duplicates.");
  const sorted = [...roles].sort();
  if (roles.some((role, index) => role !== sorted[index])) {
    fail("noncanonical-order", "component.materialRoles must be sorted.");
  }
  return Object.freeze(roles);
}

export async function createFacesJsComponentBaseManifest(
  value: Omit<FacesJsComponentBaseManifest, "schema" | "contentHash">,
): Promise<FacesJsComponentBaseManifest> {
  const payload = {
    schema: FACES_JS_COMPONENT_BASE_MANIFEST_SCHEMA,
    id: value.id,
    profile: value.profile,
    sourceRevision: value.sourceRevision,
    modelScale: value.modelScale,
    modelMatrix: value.modelMatrix,
  };
  return validateFacesJsComponentBaseManifest({
    ...payload,
    contentHash: await cssGraphicsContentHash(payload),
  });
}

export async function validateFacesJsComponentBaseManifest(
  value: unknown,
): Promise<FacesJsComponentBaseManifest> {
  const input = record(value, "base");
  exactKeys(input, [
    "schema",
    "id",
    "profile",
    "sourceRevision",
    "modelScale",
    "modelMatrix",
    "contentHash",
  ], "base");
  if (input.schema !== FACES_JS_COMPONENT_BASE_MANIFEST_SCHEMA) {
    fail("invalid-schema", `base.schema must be ${FACES_JS_COMPONENT_BASE_MANIFEST_SCHEMA}.`);
  }
  if (input.profile !== "morph-regions") {
    fail("invalid-profile", "base.profile must be morph-regions.");
  }
  if (typeof input.sourceRevision !== "string" || !GIT_REVISION.test(input.sourceRevision)) {
    fail("invalid-revision", "base.sourceRevision must be a full git revision.");
  }
  if (typeof input.modelScale !== "number" || !Number.isFinite(input.modelScale)
    || input.modelScale <= 0) {
    fail("invalid-number", "base.modelScale must be positive and finite.");
  }
  if (!Array.isArray(input.modelMatrix) || input.modelMatrix.length !== 16
    || input.modelMatrix.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    fail("invalid-matrix", "base.modelMatrix must contain sixteen finite numbers.");
  }
  const contentHash = sha256(input.contentHash, "base.contentHash");
  const { contentHash: _contentHash, ...payload } = input;
  if (await cssGraphicsContentHash(payload) !== contentHash) {
    fail("content-hash-mismatch", "base.contentHash does not match its payload.");
  }
  return Object.freeze({
    schema: FACES_JS_COMPONENT_BASE_MANIFEST_SCHEMA,
    id: normalizedId(input.id, "base.id"),
    profile: "morph-regions",
    sourceRevision: input.sourceRevision,
    modelScale: input.modelScale,
    modelMatrix: Object.freeze([...input.modelMatrix]),
    contentHash,
  });
}

export async function createFacesJsComponentManifest(
  value: Omit<FacesJsComponentManifest, "schema" | "contentHash">,
): Promise<FacesJsComponentManifest> {
  const payload = {
    schema: FACES_JS_COMPONENT_MANIFEST_SCHEMA,
    id: value.id,
    family: value.family,
    sourceId: value.sourceId,
    sourceSha256: value.sourceSha256,
    layer: value.layer,
    attachment: value.attachment,
    materialRoles: value.materialRoles,
    dependencies: value.dependencies,
    assets: value.assets,
  };
  return validateFacesJsComponentManifest({
    ...payload,
    contentHash: await cssGraphicsContentHash(payload),
  });
}

export async function validateFacesJsComponentManifest(
  value: unknown,
  sourceIndex?: FacesJsSourceIndex,
): Promise<FacesJsComponentManifest> {
  const input = record(value, "component");
  exactKeys(input, [
    "schema",
    "id",
    "family",
    "sourceId",
    "sourceSha256",
    "layer",
    "attachment",
    "materialRoles",
    "dependencies",
    "assets",
    "contentHash",
  ], "component");
  if (input.schema !== FACES_JS_COMPONENT_MANIFEST_SCHEMA) {
    fail("invalid-schema", `component.schema must be ${FACES_JS_COMPONENT_MANIFEST_SCHEMA}.`);
  }
  const selectedFamily = family(input.family, "component.family");
  const selectedSourceId = sourceId(input.sourceId, "component.sourceId");
  const selectedSha256 = sha256(input.sourceSha256, "component.sourceSha256");
  assertSource(sourceIndex, selectedFamily, selectedSourceId, selectedSha256, "component source");
  if (typeof input.attachment !== "string"
    || !ATTACHMENTS.has(input.attachment as FacesJsComponentAttachment)) {
    fail("invalid-attachment", "component.attachment is unsupported.");
  }
  const contentHash = sha256(input.contentHash, "component.contentHash");
  const { contentHash: _contentHash, ...payload } = input;
  if (await cssGraphicsContentHash(payload) !== contentHash) {
    fail("content-hash-mismatch", "component.contentHash does not match its payload.");
  }
  return Object.freeze({
    schema: FACES_JS_COMPONENT_MANIFEST_SCHEMA,
    id: normalizedId(input.id, "component.id"),
    family: selectedFamily,
    sourceId: selectedSourceId,
    sourceSha256: selectedSha256,
    layer: layer(input.layer, selectedFamily, "component.layer"),
    attachment: input.attachment as FacesJsComponentAttachment,
    materialRoles: parseMaterialRoles(input.materialRoles),
    dependencies: parseDependencies(input.dependencies, "component.dependencies"),
    assets: parseAssets(input.assets),
    contentHash,
  });
}

function parseBaseRow(value: unknown, index: number): FacesJsComponentCatalogBaseRow {
  const label = `catalog.bases[${index}]`;
  const input = record(value, label);
  exactKeys(input, ["id", "manifestPath", "manifestSha256"], label);
  const id = normalizedId(input.id, `${label}.id`);
  const manifestPath = safePath(input.manifestPath, `${label}.manifestPath`);
  if (manifestPath !== `bases/${id}/manifest.json`) {
    fail("invalid-path", `${label}.manifestPath does not match its id.`);
  }
  return Object.freeze({
    id,
    manifestPath,
    manifestSha256: sha256(input.manifestSha256, `${label}.manifestSha256`),
  });
}

function parseComponentRow(
  value: unknown,
  index: number,
  sourceIndex?: FacesJsSourceIndex,
): FacesJsComponentCatalogRow {
  const label = `catalog.components[${index}]`;
  const input = record(value, label);
  exactKeys(input, [
    "family",
    "sourceId",
    "sourceSha256",
    "manifestPath",
    "manifestSha256",
    "layer",
    "dependencies",
  ], label);
  const selection = parseSelection({
    family: input.family,
    sourceId: input.sourceId,
    sourceSha256: input.sourceSha256,
  }, label, sourceIndex);
  const manifestPath = safePath(input.manifestPath, `${label}.manifestPath`);
  const expectedPath = `components/${selection.family}/${selection.sourceId}/manifest.json`;
  if (manifestPath !== expectedPath) {
    fail("invalid-path", `${label}.manifestPath must be ${expectedPath}.`);
  }
  return Object.freeze({
    ...selection,
    manifestPath,
    manifestSha256: sha256(input.manifestSha256, `${label}.manifestSha256`),
    layer: layer(input.layer, selection.family, `${label}.layer`),
    dependencies: parseDependencies(input.dependencies, `${label}.dependencies`),
  });
}

function parseFixtureRow(
  value: unknown,
  index: number,
  sourceIndex?: FacesJsSourceIndex,
): FacesJsCompatibilityFixtureRow {
  const label = `catalog.compatibilityFixtures[${index}]`;
  const input = record(value, label);
  exactKeys(input, [
    "id",
    "baseId",
    "selections",
  ], label);
  const id = normalizedId(input.id, `${label}.id`);
  const baseId = normalizedId(input.baseId, `${label}.baseId`);
  if (!Array.isArray(input.selections)) {
    fail("invalid-contract", `${label}.selections must be an array.`);
  }
  const selections = input.selections.map((selection, selectionIndex) =>
    parseSelection(selection, `${label}.selections[${selectionIndex}]`, sourceIndex));
  const families = selections.map((selection) => selection.family);
  if (new Set(families).size !== families.length) {
    fail("duplicate-family", `${label}.selections selects one family more than once.`);
  }
  if (families.length !== FACES_JS_DISPLAY_LAYERS.length
    || families.some((selectedFamily, familyIndex) =>
      selectedFamily !== FACES_JS_DISPLAY_LAYERS[familyIndex])) {
    fail("invalid-layer-order", `${label}.selections must follow the complete display order.`);
  }
  return Object.freeze({
    id,
    baseId,
    selections: Object.freeze(selections),
  });
}

function assertCanonicalRows(
  rows: readonly unknown[],
  keys: readonly string[],
  label: string,
): void {
  if (new Set(keys).size !== keys.length) fail("duplicate-id", `${label} has duplicate keys.`);
  const sorted = [...keys].sort();
  if (keys.some((key, index) => key !== sorted[index])) {
    fail("noncanonical-order", `${label} must be sorted.`);
  }
  if (rows.length !== keys.length) fail("invalid-contract", `${label} row count changed.`);
}

export async function createFacesJsComponentCatalog(
  value: Omit<FacesJsComponentCatalog, "schema" | "contentHash">,
  sourceIndex?: FacesJsSourceIndex,
): Promise<FacesJsComponentCatalog> {
  const payload = {
    schema: FACES_JS_COMPONENT_CATALOG_SCHEMA,
    facesJsVersion: value.facesJsVersion,
    sourceRevision: value.sourceRevision,
    layers: value.layers,
    bases: value.bases,
    components: value.components,
    compatibilityFixtures: value.compatibilityFixtures,
  };
  return validateFacesJsComponentCatalog({
    ...payload,
    contentHash: await cssGraphicsContentHash(payload),
  }, sourceIndex);
}

export async function validateFacesJsComponentCatalog(
  value: unknown,
  sourceIndex?: FacesJsSourceIndex,
): Promise<FacesJsComponentCatalog> {
  const input = record(value, "catalog");
  exactKeys(input, [
    "schema",
    "facesJsVersion",
    "sourceRevision",
    "layers",
    "bases",
    "components",
    "compatibilityFixtures",
    "contentHash",
  ], "catalog");
  if (input.schema !== FACES_JS_COMPONENT_CATALOG_SCHEMA) {
    fail("invalid-schema", `catalog.schema must be ${FACES_JS_COMPONENT_CATALOG_SCHEMA}.`);
  }
  if (typeof input.facesJsVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(input.facesJsVersion)) {
    fail("invalid-version", "catalog.facesJsVersion must be exact semver.");
  }
  if (typeof input.sourceRevision !== "string" || !GIT_REVISION.test(input.sourceRevision)) {
    fail("invalid-revision", "catalog.sourceRevision must be a full git revision.");
  }
  const sourceRevision = input.sourceRevision;
  if (!Array.isArray(input.layers)
    || input.layers.length !== FACES_JS_DISPLAY_LAYERS.length
    || input.layers.some((entry, index) => entry !== FACES_JS_DISPLAY_LAYERS[index])) {
    fail("invalid-layer-order", "catalog.layers must equal the FacesJS display order.");
  }
  if (!Array.isArray(input.bases) || !Array.isArray(input.components)
    || !Array.isArray(input.compatibilityFixtures)) {
    fail("invalid-contract", "catalog row collections must be arrays.");
  }
  const bases = input.bases.map(parseBaseRow);
  const components = input.components.map((row, index) =>
    parseComponentRow(row, index, sourceIndex));
  const fixtures = input.compatibilityFixtures.map((row, index) =>
    parseFixtureRow(row, index, sourceIndex));
  assertCanonicalRows(bases, bases.map((row) => row.id), "catalog.bases");
  assertCanonicalRows(
    components,
    components.map((row) => `${row.family}:${row.sourceId}`),
    "catalog.components",
  );
  assertCanonicalRows(fixtures, fixtures.map((row) => row.id), "catalog.compatibilityFixtures");
  const componentKeys = new Set(components.map((row) => `${row.family}:${row.sourceId}`));
  const baseIds = new Set(bases.map((row) => row.id));
  for (const row of components) {
    for (const dependency of row.dependencies) {
      const key = canonicalOrderKey(dependency);
      if (!componentKeys.has(key)) {
        fail("broken-dependency", `${row.family}:${row.sourceId} requires missing ${key}.`);
      }
    }
  }
  for (const fixture of fixtures) {
    if (!baseIds.has(fixture.baseId)) {
      fail("broken-base", `catalog compatibility fixture ${fixture.id} requires missing base ${fixture.baseId}.`);
    }
    for (const selection of fixture.selections) {
      const selectedKey = `${selection.family}:${selection.sourceId}`;
      if (!componentKeys.has(selectedKey)) {
        fail("broken-selection", `catalog compatibility fixture ${fixture.id} requires missing ${selectedKey}.`);
      }
    }
  }
  const contentHash = sha256(input.contentHash, "catalog.contentHash");
  const { contentHash: _contentHash, ...payload } = input;
  if (await cssGraphicsContentHash(payload) !== contentHash) {
    fail("content-hash-mismatch", "catalog.contentHash does not match its payload.");
  }
  return Object.freeze({
    schema: FACES_JS_COMPONENT_CATALOG_SCHEMA,
    facesJsVersion: input.facesJsVersion,
    sourceRevision,
    layers: FACES_JS_DISPLAY_LAYERS,
    bases: Object.freeze(bases),
    components: Object.freeze(components),
    compatibilityFixtures: Object.freeze(fixtures),
    contentHash,
  });
}
