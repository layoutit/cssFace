import {
  installLoadedModelStyles,
  type LoadedCssGraphicsModel,
} from "../../../runtime/shared/loader.js";
import {
  wrapCssGraphicsClient,
} from "../../../runtime/shared/driver.js";
import type {
  CssGraphicsRuntimeAdapter,
  LoadedCssGraphicsModelBinding,
} from "../../../runtime/shared/session.js";
import {
  decodeFacesJsProgram,
  FACES_JS_PROFILE,
} from "./model.js";
import {
  mountFacesJsScene,
} from "./scene.js";

function bindFacesJs(
  loaded: LoadedCssGraphicsModel,
): LoadedCssGraphicsModelBinding {
  let program;
  try {
    program = decodeFacesJsProgram(loaded);
  } catch (error) {
    loaded.assetOwner.destroy();
    throw error;
  }
  let started = false;
  let discarded = false;
  return Object.freeze({
    modelId: loaded.manifest.id,
    profile: FACES_JS_PROFILE,
    start(host: HTMLElement) {
      if (discarded) throw new Error("The loaded FacesJS model was discarded.");
      if (started) throw new Error("The loaded FacesJS model was already started.");
      started = true;

      const hadModelAttribute = host.hasAttribute("data-cssgraphics-model");
      const previousModelId = host.getAttribute("data-cssgraphics-model");
      let styles;
      try {
        styles = installLoadedModelStyles(loaded, host);
      } catch (error) {
        loaded.assetOwner.destroy();
        throw error;
      }
      host.dataset.cssgraphicsModel = loaded.manifest.id;
      const release = (): void => {
        styles.destroy();
        loaded.assetOwner.destroy();
        if (hadModelAttribute && previousModelId !== null) {
          host.setAttribute("data-cssgraphics-model", previousModelId);
        } else {
          host.removeAttribute("data-cssgraphics-model");
        }
      };
      try {
        const mounted = mountFacesJsScene(host, program);
        return wrapCssGraphicsClient({
          modelId: loaded.manifest.id,
          kind: "prepared-playback",
          generationHash: loaded.manifest.generationHash,
          experienceModes: ["interaction"],
          client: {
            tick: 0,
            stop: mounted.stop,
            scene: { destroy: mounted.destroy },
            presentation: { destroy: release },
          },
        });
      } catch (error) {
        release();
        throw error;
      }
    },
    discard(): void {
      if (started || discarded) return;
      discarded = true;
      loaded.assetOwner.destroy();
    },
  });
}

export const facesJsPlayerAdapter: CssGraphicsRuntimeAdapter = Object.freeze({
  profile: FACES_JS_PROFILE,
  bind: bindFacesJs,
});
