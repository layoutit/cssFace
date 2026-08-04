export const FACES_JS_MATERIAL_ROLES = Object.freeze([
  "accessory-red",
  "accessory-translucent-ink",
  "accessory-white",
  "blush",
  "eye-off-white",
  "eye-white",
  "face-shave",
  "frame-dark",
  "freckle",
  "hair-fade",
  "skin",
  "hair",
  "head-shave",
  "highlight",
  "ink",
  "jersey-white",
  "lens",
  "mouth-dark",
  "team-primary",
  "team-secondary",
  "team-accent",
] as const);

export type FacesJsMaterialRole = typeof FACES_JS_MATERIAL_ROLES[number];

export interface FacesJsMaterialColorInput {
  readonly skin: string;
  readonly hair: string;
  readonly headShave: string;
  readonly teamColors: readonly [string, string, string];
}

export type FacesJsMaterialColors = Readonly<Record<FacesJsMaterialRole, string>>;

interface FacesJsStylePropertyTarget {
  setProperty(name: string, value: string): void;
}

const TRANSPARENT_SHAVE = "rgba(0, 0, 0, 0)";
const SHAVE_PATTERN = /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*\)$/iu;

export function validateFacesJsHexColor(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/iu.test(value)) {
    throw new TypeError(`${label} must be a six-digit hex color.`);
  }
  return value.toLowerCase();
}

export function validateFacesJsShaveColor(value: unknown, label: string): string {
  if (typeof value === "string") {
    const match = SHAVE_PATTERN.exec(value);
    if (match) {
      const alpha = Number(match[1]);
      if (alpha >= 0 && alpha <= 1) return `rgba(0, 0, 0, ${alpha})`;
    }
  }
  try {
    return validateFacesJsHexColor(value, label);
  } catch {
    throw new TypeError(`${label} must be a six-digit hex or black rgba color.`);
  }
}

export function facesJsShaveOpacity(value: string): number {
  if (value === TRANSPARENT_SHAVE) return 0;
  const match = SHAVE_PATTERN.exec(value);
  return match ? Number(match[1]) : 1;
}

export function resolveFacesJsMaterialRole(materialId: string): FacesJsMaterialRole {
  for (const role of FACES_JS_MATERIAL_ROLES) {
    if (materialId.endsWith(`-${role}`)) return role;
  }
  if (materialId.endsWith("-skin-base") || materialId.endsWith("-skin-shadow")
    || materialId.endsWith("-ear-cap")) return "skin";
  if (materialId.endsWith("-hair-base") || materialId.endsWith("-facial-hair")) {
    return "hair";
  }
  if (materialId.endsWith("-head-shave")) return "head-shave";
  if (materialId.endsWith("-jersey-base") || materialId.endsWith("-team-primary")) {
    return "team-primary";
  }
  if (materialId.endsWith("-team-secondary")) return "team-secondary";
  if (materialId.endsWith("-team-accent")) return "team-accent";
  if (materialId.endsWith("-eye-white")) return "eye-white";
  if (materialId.endsWith("-ink")) return "ink";
  throw new TypeError(`FacesJS material ${materialId} has no material role.`);
}

export function resolveFacesJsMaterialColors(
  input: FacesJsMaterialColorInput,
): FacesJsMaterialColors {
  if (!Array.isArray(input.teamColors) || input.teamColors.length !== 3) {
    throw new TypeError("FacesJS teamColors must contain exactly three colors.");
  }
  const headShave = validateFacesJsShaveColor(
    input.headShave,
    "FacesJS head shave color",
  );
  return Object.freeze({
    "accessory-red": "#e50002",
    "accessory-translucent-ink": "#000000",
    "accessory-white": "#eeeaef",
    blush: "#a15757",
    "eye-off-white": "#f5f2ed",
    "eye-white": "#ffffff",
    "face-shave": headShave.startsWith("rgba(") ? "#000000" : headShave,
    "frame-dark": "#333333",
    freckle: "#8b6135",
    "hair-fade": validateFacesJsHexColor(input.hair, "FacesJS hair color"),
    skin: validateFacesJsHexColor(input.skin, "FacesJS skin color"),
    hair: validateFacesJsHexColor(input.hair, "FacesJS hair color"),
    "head-shave": headShave.startsWith("rgba(") ? "#000000" : headShave,
    highlight: "#ffffff",
    ink: "#000000",
    "jersey-white": "#ffffff",
    lens: "#9696b0",
    "mouth-dark": "#501414",
    "team-primary": validateFacesJsHexColor(
      input.teamColors[0],
      "FacesJS primary team color",
    ),
    "team-secondary": validateFacesJsHexColor(
      input.teamColors[1],
      "FacesJS secondary team color",
    ),
    "team-accent": validateFacesJsHexColor(
      input.teamColors[2],
      "FacesJS accent team color",
    ),
  });
}

export function facesJsMaterialVariable(role: FacesJsMaterialRole): string {
  return `--cssface-material-${role}`;
}

export function writeFacesJsMaterialVariables(
  target: FacesJsStylePropertyTarget,
  colors: FacesJsMaterialColors,
  headShaveOpacity = 1,
): void {
  for (const role of FACES_JS_MATERIAL_ROLES) {
    target.setProperty(facesJsMaterialVariable(role), colors[role]);
  }
  target.setProperty("--cssface-material-head-shave-opacity", String(headShaveOpacity));
}
