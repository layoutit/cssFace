import { writeFile, readFile, readdir, stat, mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import sharp from "sharp";
import { createServer } from "vite";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../../../..");
const fixturePath = resolve(repoRoot, "test/fixtures/facesjs-baseline.json");
const outputDirectory = resolve(repoRoot, "output");
const rawTracePath = resolve(outputDirectory, "facesjs-baseline.trace.json");
const MODEL_IDS = Object.freeze([
  "facesjs-lowpoly-head",
  "facesjs-lowpoly-head-afro",
  "facesjs-lowpoly-head-bald",
  "facesjs-lowpoly-head-short2",
]);
const FIXTURE_IDS = Object.freeze(["classic", "afro", "bald", "short2"]);
const VIEWPORT = Object.freeze({ width: 1280, height: 900 });
const TRACE_CATEGORIES = [
  "blink",
  "blink.user_timing",
  "cc",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "gpu",
  "renderer.scheduler",
  "toplevel",
  "viz",
].join(",");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function percentile(sortedValues, quantile) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * quantile) - 1),
  );
  return sortedValues[index];
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

async function foregroundMask(path) {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const colors = new Map();
  for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
    const offset = pixel * info.channels;
    if (data[offset + 3] < 250) continue;
    const key = `${data[offset]},${data[offset + 1]},${data[offset + 2]}`;
    colors.set(key, (colors.get(key) ?? 0) + 1);
  }
  const backgroundEntry = [...colors.entries()].sort((left, right) => right[1] - left[1])[0];
  assert(backgroundEntry, `${path} has no opaque background color.`);
  const background = backgroundEntry[0].split(",").map(Number);
  const mask = new Uint8Array(info.width * info.height);
  let count = 0;
  let minimumX = info.width;
  let minimumY = info.height;
  let maximumX = -1;
  let maximumY = -1;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const pixel = (y * info.width) + x;
      const offset = pixel * info.channels;
      const difference = Math.max(
        Math.abs(data[offset] - background[0]),
        Math.abs(data[offset + 1] - background[1]),
        Math.abs(data[offset + 2] - background[2]),
      );
      if (difference <= 8 || data[offset + 3] === 0) continue;
      mask[pixel] = 1;
      count += 1;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
      sumX += x;
      sumY += y;
    }
  }
  assert(count > 0, `${path} has no foreground pixels.`);
  return {
    width: info.width,
    height: info.height,
    channels: info.channels,
    data,
    mask,
    count,
    bounds: { minimumX, minimumY, maximumX, maximumY },
    centroid: { x: sumX / count, y: sumY / count },
  };
}

async function compareCompatibilityImages(expectedPath, actualPath) {
  const [expected, actual] = await Promise.all([
    foregroundMask(expectedPath),
    foregroundMask(actualPath),
  ]);
  assert(expected.width === actual.width && expected.height === actual.height,
    "Component-equivalence captures have different dimensions.");
  let intersection = 0;
  let union = 0;
  let colorDifference = 0;
  let colorSamples = 0;
  for (let pixel = 0; pixel < expected.mask.length; pixel += 1) {
    const left = expected.mask[pixel] === 1;
    const right = actual.mask[pixel] === 1;
    if (left || right) union += 1;
    if (!left || !right) continue;
    intersection += 1;
    const leftOffset = pixel * expected.channels;
    const rightOffset = pixel * actual.channels;
    for (let channel = 0; channel < 3; channel += 1) {
      colorDifference += Math.abs(
        expected.data[leftOffset + channel] - actual.data[rightOffset + channel],
      );
      colorSamples += 1;
    }
  }
  const foregroundRatio = actual.count / expected.count;
  const intersectionOverUnion = intersection / union;
  const boundsDelta = Object.fromEntries(
    Object.keys(expected.bounds).map((key) => [
      key,
      actual.bounds[key] - expected.bounds[key],
    ]),
  );
  const centroidDelta = {
    x: actual.centroid.x - expected.centroid.x,
    y: actual.centroid.y - expected.centroid.y,
  };
  const failures = [];
  if (foregroundRatio < 0.88 || foregroundRatio > 1.12) {
    failures.push(`foreground ratio ${round(foregroundRatio)} is outside compatibility tolerance`);
  }
  if (intersectionOverUnion < 0.82) {
    failures.push(`silhouette IoU ${round(intersectionOverUnion)} is outside compatibility tolerance`);
  }
  if (!Object.values(boundsDelta).every((delta) => Math.abs(delta) <= 14)) {
    failures.push("bounds moved outside compatibility tolerance");
  }
  if (Math.abs(centroidDelta.x) > 8 || Math.abs(centroidDelta.y) > 8) {
    failures.push("centroid moved outside compatibility tolerance");
  }
  const result = {
    expectedPath: relative(repoRoot, expectedPath),
    actualPath: relative(repoRoot, actualPath),
    passed: failures.length === 0,
    failures,
    foregroundRatio: round(foregroundRatio),
    intersectionOverUnion: round(intersectionOverUnion),
    boundsDelta,
    centroidDelta: {
      x: round(centroidDelta.x),
      y: round(centroidDelta.y),
    },
    intersectionRgbMae: round(colorDifference / colorSamples),
  };
  return result;
}

async function captureComponentEquivalence() {
  const presets = JSON.parse(await readFile(
    resolve(repoRoot, "src/adapters/facesjs/presets.json"),
    "utf8",
  ));
  const presetById = new Map(presets.map((preset) => [preset.id, preset]));
  const vite = await createServer({
    configFile: resolve(repoRoot, "vite.config.ts"),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  let browser;
  try {
    await vite.listen();
    const url = vite.resolvedUrls?.local?.[0];
    assert(url, "Vite did not publish a local URL.");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT });
    await context.addInitScript(() => {
      const original = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
      Object.defineProperty(globalThis.crypto, "getRandomValues", {
        configurable: true,
        value(array) {
          if (array instanceof Uint32Array && array.length === 1) {
            array[0] = 0;
            return array;
          }
          return original(array);
        },
      });
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() =>
      document.documentElement.dataset.prototypeReady === "true"
      && document.querySelector("#stage")?.dataset.facesJsReady === "true",
    );
    await page.evaluate(() => {
      const stage = document.querySelector("#stage");
      if (!(stage instanceof HTMLElement)) throw new Error("FacesJS stage is absent.");
      document.body.replaceChildren(stage);
      stage.className = "cssgraphics-host";
      document.documentElement.style.background = "#111";
      document.body.style.cssText = "margin:0;background:#111;overflow:hidden";
      stage.style.setProperty("width", "640px", "important");
      stage.style.setProperty("height", "640px", "important");
      stage.style.setProperty("margin", "100px auto", "important");
      stage.style.setProperty("position", "relative", "important");
      stage.style.setProperty("overflow", "hidden", "important");
      stage.style.setProperty("background", "#1a6b68", "important");
      globalThis.dispatchEvent(new Event("resize"));
    });
    await mkdir(resolve(outputDirectory, "playwright"), { recursive: true });
    const results = [];
    for (const id of FIXTURE_IDS) {
      const preset = presetById.get(id);
      assert(preset, `FacesJS compatibility preset ${id} is absent.`);
      await page.evaluate(async ({ face }) => {
        await globalThis.__facesJsPrototype.setFaceConfig(face);
        globalThis.__facesJsPrototype.setOrbit(0);
      }, { face: preset.face });
      await page.evaluate(() => new Promise((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
      await page.waitForTimeout(450);
      const actualPath = resolve(outputDirectory, "playwright", `b19-component-${id}.png`);
      const expectedPath = resolve(outputDirectory, "playwright", `b19-monolith-${id}.png`);
      assert(await exists(expectedPath), `Missing outgoing B19 golden ${expectedPath}.`);
      await page.locator("#stage").screenshot({ path: actualPath });
      results.push({
        id,
        snapshot: await page.evaluate(() => globalThis.__facesJsPrototype.snapshot()),
        comparison: await compareCompatibilityImages(expectedPath, actualPath),
      });
    }
    await context.close();
    assert(consoleErrors.length === 0, `Browser console errors:\n${consoleErrors.join("\n")}`);
    const report = {
      schema: "cssface.facesjs-component-equivalence@1",
      capturedAt: new Date().toISOString(),
      results,
    };
    const reportPath = resolve(
      outputDirectory,
      "playwright",
      "b19-component-equivalence.json",
    );
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const failures = results.flatMap(({ id, comparison }) =>
      comparison.failures.map((failure) => `${id}: ${failure}`));
    assert(failures.length === 0,
      `FacesJS component equivalence failed:\n${failures.join("\n")}`);
    console.log(
      `FacesJS component equivalence passed: ${results.map(({ id, comparison }) =>
        `${id} IoU ${comparison.intersectionOverUnion}`).join(", ")}.`,
    );
  } finally {
    await browser?.close();
    await vite.close();
  }
}

async function listFiles(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  await visit(root);
  return output.sort((left, right) => left.localeCompare(right));
}

async function packageBytes(root, modelId) {
  const directory = resolve(root, "models", modelId);
  const files = await listFiles(directory);
  const entries = [];
  let bytes = 0;
  for (const path of files) {
    const size = (await stat(path)).size;
    bytes += size;
    entries.push({ path: relative(directory, path), bytes: size });
  }
  return { modelId, bytes, files: entries };
}

async function staticPackages() {
  const morphRoot = resolve(repoRoot, "public/faces");
  const runtimeRoot = resolve(repoRoot, "public/cssgraphics");
  const morph = [];
  const runtime = [];
  for (const modelId of MODEL_IDS) {
    morph.push(await packageBytes(morphRoot, modelId));
    runtime.push(await packageBytes(runtimeRoot, modelId));
  }
  return {
    morph: {
      totalBytes: morph.reduce((sum, entry) => sum + entry.bytes, 0),
      models: morph,
    },
    runtime: {
      totalBytes: runtime.reduce((sum, entry) => sum + entry.bytes, 0),
      models: runtime,
    },
  };
}

function traceWindow(events) {
  const marker = (message) => events.find((event) =>
    event.name === "TimeStamp" && event.args?.data?.message === message
  );
  const start = marker("cssface-baseline-start");
  const end = marker("cssface-baseline-end");
  assert(start && end, "Chrome trace is missing the baseline action markers.");
  assert(end.ts > start.ts, "Chrome trace markers are reversed.");
  return { start: start.ts, end: end.ts };
}

function traceGroup(name) {
  if (["FunctionCall", "EventDispatch", "FireAnimationFrame", "RunTask", "TimerFire"].includes(name)) return "scripting";
  if (["UpdateLayoutTree", "RecalculateStyles"].includes(name)) return "style";
  if (name === "Layout") return "layout";
  if (["PrePaint", "Paint", "PaintArtifactCompositor::Update", "Layerize"].includes(name)) return "paint";
  if (/Raster|Decode Image/u.test(name)) return "raster";
  if (/Composite|Compositor|LayerTree|DrawFrame|DrawRenderPass|SubmitCompositorFrame|Graphics.Pipeline/u.test(name)) return "compositor";
  return null;
}

function analyzeTrace(events) {
  const window = traceWindow(events);
  const groups = new Map();
  const names = new Map();
  let completeEvents = 0;
  for (const event of events) {
    if (event.ph !== "X" || typeof event.dur !== "number") continue;
    if (event.ts > window.end || event.ts + event.dur < window.start) continue;
    const overlap = Math.max(
      0,
      Math.min(window.end, event.ts + event.dur) - Math.max(window.start, event.ts),
    );
    if (overlap === 0) continue;
    completeEvents += 1;
    names.set(event.name, (names.get(event.name) ?? 0) + overlap / 1000);
    const group = traceGroup(event.name);
    if (group) groups.set(group, (groups.get(group) ?? 0) + overlap / 1000);
  }
  return {
    actionDurationMs: round((window.end - window.start) / 1000),
    traceEventCount: events.length,
    actionCompleteEventCount: completeEvents,
    groupsMs: Object.fromEntries(
      [...groups.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => [name, round(value)]),
    ),
    topEvents: [...names.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 12)
      .map(([name, durationMs]) => ({ name, durationMs: round(durationMs) })),
  };
}

async function captureBrowserBaseline() {
  const vite = await createServer({
    configFile: resolve(repoRoot, "vite.config.ts"),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  let browser;
  try {
    await vite.listen();
    const url = vite.resolvedUrls?.local?.[0];
    assert(url, "Vite did not publish a local URL.");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT });
    await context.addInitScript(() => {
      const original = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
      Object.defineProperty(globalThis.crypto, "getRandomValues", {
        configurable: true,
        value(array) {
          if (array instanceof Uint32Array && array.length === 1) {
            array[0] = 0;
            return array;
          }
          return original(array);
        },
      });
    });
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    await client.send("Network.enable");
    await client.send("Network.setCacheDisabled", { cacheDisabled: true });
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() =>
      document.documentElement.dataset.prototypeReady === "true" &&
      document.querySelector("#stage")?.dataset.facesJsReady === "true" &&
      globalThis.__facesJsPrototype?.snapshot().modelId === "facesjs-lowpoly-head"
    );
    await page.evaluate(() => new Promise((resolveFrame) =>
      requestAnimationFrame(() => requestAnimationFrame(resolveFrame))
    ));
    const before = await page.evaluate(() => globalThis.__facesJsPrototype.snapshot());
    const resources = await page.evaluate(() =>
      performance.getEntriesByType("resource")
        .map((entry) => ({
          name: entry.name,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
        }))
        .filter((entry) => entry.name.includes("/cssgraphics/"))
    );
    const transferBytes = resources.reduce(
      (sum, entry) => sum + (entry.transferSize || entry.encodedBodySize),
      0,
    );

    const traceEvents = [];
    client.on("Tracing.dataCollected", ({ value }) => traceEvents.push(...value));
    const traceComplete = new Promise((resolveComplete) => {
      client.once("Tracing.tracingComplete", resolveComplete);
    });
    await client.send("Tracing.start", {
      categories: TRACE_CATEGORIES,
      options: "sampling-frequency=10000",
      transferMode: "ReportEvents",
    });
    await page.evaluate(() => {
      const state = { active: true, frames: [] };
      globalThis.__cssFaceBaselineFrames = state;
      const sample = (timestamp) => {
        if (!state.active) return;
        state.frames.push(timestamp);
        requestAnimationFrame(sample);
      };
      performance.mark("cssface-baseline-start");
      console.timeStamp("cssface-baseline-start");
      requestAnimationFrame(sample);
    });
    const box = await page.locator("#stage").boundingBox();
    assert(box, "The PolyCSS stage has no browser bounds.");
    const startX = box.x + box.width * 0.22;
    const endX = box.x + box.width * 0.78;
    const y = box.y + box.height * 0.5;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    const steps = 90;
    for (let index = 1; index <= steps; index += 1) {
      await page.mouse.move(startX + (endX - startX) * index / steps, y);
      await page.waitForTimeout(10);
    }
    await page.mouse.up();
    await page.waitForTimeout(220);
    const frameTimestamps = await page.evaluate(() => {
      console.timeStamp("cssface-baseline-end");
      performance.mark("cssface-baseline-end");
      globalThis.__cssFaceBaselineFrames.active = false;
      return globalThis.__cssFaceBaselineFrames.frames;
    });
    await client.send("Tracing.end");
    await traceComplete;
    const after = await page.evaluate(() => globalThis.__facesJsPrototype.snapshot());
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const frameTimes = frameTimestamps
      .slice(1)
      .map((timestamp, index) => timestamp - frameTimestamps[index])
      .filter((value) => value > 0 && value < 250)
      .sort((left, right) => left - right);
    assert(frameTimes.length >= 30, `Expected at least 30 sampled frames, found ${frameTimes.length}.`);
    const trace = analyzeTrace(traceEvents);
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(rawTracePath, JSON.stringify({ traceEvents }));
    await context.close();
    assert(consoleErrors.length === 0, `Browser console errors:\n${consoleErrors.join("\n")}`);
    return {
      page: {
        viewport: VIEWPORT,
        userAgent,
        urlPath: "/",
        readySelector: "html[data-prototype-ready=true] #stage[data-faces-js-ready=true]",
      },
      action: {
        type: "real-pointer-drag",
        selector: "#stage",
        steps: 90,
        settleMs: 220,
      },
      network: {
        selectedModelId: before.modelId,
        transferBytes,
        resources: resources.map((entry) => ({
          path: new URL(entry.name).pathname,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
        })),
      },
      runtime: {
        before,
        after,
        rotationLightingWrites: after.rotationLightingWrites - before.rotationLightingWrites,
        rotationLightingPublications:
          after.rotationLightingPublications - before.rotationLightingPublications,
      },
      frames: {
        sampleCount: frameTimes.length,
        p50Ms: round(percentile(frameTimes, 0.5)),
        p95Ms: round(percentile(frameTimes, 0.95)),
        p99Ms: round(percentile(frameTimes, 0.99)),
        maximumMs: round(frameTimes.at(-1)),
        slowFramesOver20Ms: frameTimes.filter((value) => value > 20).length,
      },
      trace,
      rawTracePath: relative(repoRoot, rawTracePath),
    };
  } finally {
    await browser?.close();
    await vite.close();
  }
}

function compareExact(actual, expected, label) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} changed from the frozen baseline.`);
}

function checkBrowser(actual, expected) {
  compareExact(actual.network.selectedModelId, expected.network.selectedModelId, "Selected model");
  compareExact(actual.runtime.before.leaves, expected.runtime.before.leaves, "Leaf count");
  compareExact(actual.runtime.before.canvases, expected.runtime.before.canvases, "Canvas count");
  compareExact(actual.runtime.before.solidQuads, expected.runtime.before.solidQuads, "Solid quad count");
  compareExact(actual.runtime.before.solidTriangles, expected.runtime.before.solidTriangles, "Solid triangle count");
  compareExact(actual.runtime.before.topologyConstructions, 1, "Topology construction count");
  assert(actual.runtime.rotationLightingWrites > 0, "The drag did not update prepared rotation lighting.");
  assert(actual.runtime.rotationLightingPublications > 0, "The drag did not publish prepared lighting transitions.");
  assert(actual.trace.traceEventCount > 0, "The Chrome trace is empty.");
  const transferCeiling = Math.max(expected.network.transferBytes * 1.1, expected.network.transferBytes + 4096);
  assert(actual.network.transferBytes <= transferCeiling, `Selected-face transfer ${actual.network.transferBytes} exceeds ${Math.round(transferCeiling)}.`);
  const p95Ceiling = Math.max(
    expected.frames.p95Ms * 2,
    expected.frames.p95Ms + 50,
    120,
  );
  assert(actual.frames.p95Ms <= p95Ceiling, `p95 frame time ${actual.frames.p95Ms}ms exceeds ${round(p95Ceiling)}ms.`);
}

async function capture() {
  const packages = await staticPackages();
  const browser = await captureBrowserBaseline();
  return {
    schema: "cssface.facesjs-baseline@1",
    capturedAt: new Date().toISOString(),
    packages,
    browser,
  };
}

if (process.argv.includes("--component-equivalence")) {
  await captureComponentEquivalence();
  process.exit(0);
}

const write = process.argv.includes("--write");
const check = process.argv.includes("--check") || !write;
const actual = await capture();
if (write) {
  await mkdir(dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, `${JSON.stringify(actual, null, 2)}\n`);
}
if (check) {
  const expected = JSON.parse(await readFile(fixturePath, "utf8"));
  assert(expected.schema === "cssface.facesjs-baseline@1", "Baseline fixture schema changed.");
  compareExact(actual.packages, expected.packages, "Generated package bytes");
  checkBrowser(actual.browser, expected.browser);
  console.log(
    `FacesJS baseline check passed: ${actual.packages.morph.totalBytes} morph bytes, ` +
    `${actual.browser.runtime.before.leaves} leaves, ${actual.browser.frames.p95Ms}ms p95, ` +
    `${actual.browser.runtime.rotationLightingWrites} lighting writes.`,
  );
}
