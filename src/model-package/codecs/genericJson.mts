import {
  defineCssGraphicsModelCodec,
  type CssGraphicsModelCodec,
} from "../transport.mjs";
import type {
  CssGraphicsModelData,
} from "../modelPackage.mjs";

export const CSSGRAPHICS_GENERIC_JSON_CODEC_ID =
  "cssgraphics.generic-json@1";

function modelData(value: unknown, label: string): CssGraphicsModelData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const model = value as Partial<CssGraphicsModelData>;
  if (
    model.schema !== "cssgraphics.model-data@1"
    || typeof model.id !== "string"
    || !model.sections
    || typeof model.sections !== "object"
    || Array.isArray(model.sections)
  ) {
    throw new TypeError(`${label} must be complete cssGraphics model data.`);
  }
  return model as CssGraphicsModelData;
}

export const cssGraphicsGenericJsonCodec: CssGraphicsModelCodec =
defineCssGraphicsModelCodec({
  id: CSSGRAPHICS_GENERIC_JSON_CODEC_ID,
  async encode(model) {
    return Object.freeze({
      parts: Object.freeze([Object.freeze({
        id: "model",
        value: modelData(model, "Generic JSON codec input"),
      })]),
    });
  },
  async decode(parts) {
    if (!(parts instanceof Map) || parts.size !== 1 || !parts.has("model")) {
      throw new TypeError("Generic JSON codec requires one model part.");
    }
    return modelData(parts.get("model"), "Generic JSON codec model");
  },
});
