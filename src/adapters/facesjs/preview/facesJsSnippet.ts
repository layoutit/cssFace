import type { FaceConfig } from "facesjs";

const OMITTED_FEATURE_DEFAULTS = Object.freeze({
  angle: 0,
  flip: false,
  shave: "",
  size: 1,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function minimalFacesJsFaceConfig(
  face: FaceConfig,
): Readonly<Record<string, unknown>> {
  const minimal: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(face)) {
    if (!isRecord(value)) {
      minimal[key] = value;
      continue;
    }
    if (value.id === "none" && key !== "accessories") continue;

    minimal[key] = Object.fromEntries(
      Object.entries(value).filter(([property, entry]) =>
        !(property in OMITTED_FEATURE_DEFAULTS)
        || entry !== OMITTED_FEATURE_DEFAULTS[
          property as keyof typeof OMITTED_FEATURE_DEFAULTS
        ]),
    );
  }
  return Object.freeze(minimal);
}

function compactSourceValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => compactSourceValue(entry)).join(", ")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).map(
      ([key, entry]) => `${key}: ${compactSourceValue(entry)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function faceDeclaration(
  face: FaceConfig,
  variableName = "face",
): readonly string[] {
  const properties = Object.entries(minimalFacesJsFaceConfig(face)).map(
    ([key, value]) => `  ${key}: ${compactSourceValue(value)},`,
  );
  return [`const ${variableName} = {`, ...properties, "};"];
}

export function facesJsSnippetBody(
  face: FaceConfig,
  variableName = "face",
  targetId = "face",
): string {
  return [
    ...faceDeclaration(face, variableName),
    "",
    `display(${JSON.stringify(targetId)}, ${variableName});`,
  ].join("\n");
}

export function facesJsSnippet(face: FaceConfig, moduleUrl = "facesjs"): string {
  return [
    `import { display } from ${JSON.stringify(moduleUrl)};`,
    "",
    facesJsSnippetBody(face),
  ].join("\n");
}
