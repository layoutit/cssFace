import {
  createCssGraphicsModelCodecRegistry,
} from "../transport.mjs";
import {
  cssGraphicsGenericJsonCodec,
} from "./genericJson.mjs";
import {
  cssGraphicsPreparedPlaybackJsonCodec,
} from "./preparedPlayback.mjs";

export const cssGraphicsModelCodecRegistry =
  createCssGraphicsModelCodecRegistry([
    cssGraphicsGenericJsonCodec,
    cssGraphicsPreparedPlaybackJsonCodec,
  ]);
