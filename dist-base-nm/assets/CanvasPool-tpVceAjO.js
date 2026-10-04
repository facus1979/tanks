import { m as Shader, n as State, G as GpuProgram, o as GlProgram, p as ScreenSizeRegistry, q as deprecation, v as v8_21_0, s as DOMAdapter, w as warn, t as nextPow2, u as isPow2, x as GlobalResourceRegistry } from "./index-D63Ehq9n.js";
const _Filter = class _Filter2 extends Shader {
  /**
   * @param options - The optional parameters of this filter.
   */
  constructor(options) {
    options = { ..._Filter2.defaultOptions, ...options };
    super(options);
    this.enabled = true;
    this._state = State.for2d();
    this.blendMode = options.blendMode;
    this.padding = options.padding;
    if (typeof options.antialias === "boolean") {
      this.antialias = options.antialias ? "on" : "off";
    } else {
      this.antialias = options.antialias;
    }
    this.resolution = options.resolution;
    this.blendRequired = options.blendRequired;
    this.clipToViewport = options.clipToViewport;
    this.addResource("uTexture", 0, 1);
    if (options.blendRequired) {
      this.addResource("uBackTexture", 0, 3);
    }
  }
  /**
   * Applies the filter
   * @param filterManager - The renderer to retrieve the filter from
   * @param input - The input render target.
   * @param output - The target to output to.
   * @param clearMode - Should the output be cleared before rendering to it
   */
  apply(filterManager, input, output, clearMode) {
    filterManager.applyFilter(this, input, output, clearMode);
  }
  /**
   * Get the blend mode of the filter.
   * @default "normal"
   */
  get blendMode() {
    return this._state.blendMode;
  }
  /** Sets the blend mode of the filter. */
  set blendMode(value) {
    this._state.blendMode = value;
  }
  /**
   * A short hand function to create a filter based of a vertex and fragment shader src.
   * @param options
   * @returns A shiny new PixiJS filter!
   */
  static from(options) {
    const { gpu, gl, ...rest } = options;
    let gpuProgram;
    let glProgram;
    if (gpu) {
      gpuProgram = GpuProgram.from(gpu);
    }
    if (gl) {
      glProgram = GlProgram.from(gl);
    }
    return new _Filter2({
      gpuProgram,
      glProgram,
      ...rest
    });
  }
};
_Filter.defaultOptions = {
  blendMode: "normal",
  resolution: 1,
  padding: 0,
  antialias: "off",
  blendRequired: false,
  clipToViewport: true
};
let Filter = _Filter;
const maxKeyDimension = 32767;
function bucketKey(width, height) {
  return (width << 17) + (height << 2);
}
class CanvasPoolClass {
  constructor(canvasOptions) {
    this._buckets = /* @__PURE__ */ new Map();
    this._screens = new ScreenSizeRegistry();
    this._enableFullScreen = false;
    this.canvasOptions = canvasOptions || {};
  }
  /**
   * Has no effect. The pool sizes canvases to the screens registered with
   * {@link CanvasPoolClass#setScreenSize|setScreenSize}.
   * @deprecated since 8.21.0
   */
  get enableFullScreen() {
    deprecation(v8_21_0, "CanvasPool.enableFullScreen is no longer used, the pool sizes canvases to the screens registered with setScreenSize.");
    return this._enableFullScreen;
  }
  set enableFullScreen(value) {
    deprecation(v8_21_0, "CanvasPool.enableFullScreen is no longer used, the pool sizes canvases to the screens registered with setScreenSize.");
    this._enableFullScreen = value;
  }
  /**
   * Creates texture with params that were specified in pool constructor.
   * @param pixelWidth - Width of texture in pixels.
   * @param pixelHeight - Height of texture in pixels.
   */
  _createCanvasAndContext(pixelWidth, pixelHeight) {
    const canvas = DOMAdapter.get().createCanvas();
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const context = canvas.getContext("2d");
    return { canvas, context };
  }
  /**
   * Gets a Power-of-Two canvas or screen sized canvas
   * @param minWidth - The minimum width of the canvas.
   * @param minHeight - The minimum height of the canvas.
   * @param resolution - The resolution of the canvas.
   * @returns The new canvas and its context.
   */
  getOptimalCanvasAndContext(minWidth, minHeight, resolution = 1) {
    const { width: canvasWidth, height: canvasHeight } = this.getOptimalSize(minWidth, minHeight, resolution);
    if (canvasWidth > maxKeyDimension || canvasHeight > maxKeyDimension) {
      warn(`CanvasPool: ${canvasWidth}x${canvasHeight} is larger than the ${maxKeyDimension}px pool key limit, canvases of this size may be pooled together`);
    }
    const key = bucketKey(canvasWidth, canvasHeight);
    let bucket = this._buckets.get(key);
    if (!bucket) {
      bucket = [];
      this._buckets.set(key, bucket);
    }
    let canvasAndContext = bucket.pop();
    if (!canvasAndContext) {
      canvasAndContext = this._createCanvasAndContext(canvasWidth, canvasHeight);
    }
    return canvasAndContext;
  }
  /**
   * The backing size, in physical pixels, that
   * {@link CanvasPoolClass#getOptimalCanvasAndContext|getOptimalCanvasAndContext} would allocate for a request,
   * without taking a canvas from the pool.
   *
   * Each axis is the next power of two, or the smallest registered screen the request fits inside
   * (see {@link CanvasPoolClass#setScreenSize|setScreenSize}).
   * @param minWidth - The minimum width of the canvas.
   * @param minHeight - The minimum height of the canvas.
   * @param resolution - The resolution of the canvas.
   * @returns The width and height the pooled canvas would have, in physical pixels.
   */
  getOptimalSize(minWidth, minHeight, resolution = 1) {
    const pixelWidth = Math.ceil(minWidth * resolution - 1e-6);
    const pixelHeight = Math.ceil(minHeight * resolution - 1e-6);
    const po2Width = nextPow2(pixelWidth);
    const screenWidth = this._screens.getFittingWidth(pixelWidth);
    const po2Height = nextPow2(pixelHeight);
    const screenHeight = this._screens.getFittingHeight(pixelHeight);
    return {
      width: screenWidth !== void 0 ? Math.min(screenWidth, po2Width) : po2Width,
      height: screenHeight !== void 0 ? Math.min(screenHeight, po2Height) : po2Height
    };
  }
  /**
   * Place a canvas back into the pool.
   * @param canvasAndContext
   */
  returnCanvasAndContext(canvasAndContext) {
    const canvas = canvasAndContext.canvas;
    const { width, height } = canvas;
    const canvases = this._buckets.get(bucketKey(width, height));
    if (!canvases) return;
    canvasAndContext.context.resetTransform();
    canvasAndContext.context.clearRect(0, 0, width, height);
    canvases.push(canvasAndContext);
  }
  /**
   * Registers the screen size of a renderer with the pool, in physical pixels.
   *
   * While a screen is registered, a request that fits inside it on an axis is given that screen's size on
   * that axis instead of the next power of two, which stops a full screen canvas from being allocated far
   * larger than the screen. Requests larger than every registered screen on an axis keep the power of two
   * size - the pool never rounds a request up to a screen it does not fit in.
   * @param rendererUid - The uid of the renderer, used to update or remove this screen later.
   * @param pixelWidth - The width of the screen in physical pixels.
   * @param pixelHeight - The height of the screen in physical pixels.
   */
  setScreenSize(rendererUid, pixelWidth, pixelHeight) {
    if (!this._screens.set(rendererUid, pixelWidth, pixelHeight)) return;
    this._pruneScreenCanvases();
  }
  /**
   * Removes a screen previously registered with
   * {@link CanvasPoolClass#setScreenSize|setScreenSize}, dropping any idle canvases that were
   * only being kept for it.
   * @param rendererUid - The uid the screen was registered with.
   */
  removeScreen(rendererUid) {
    if (!this._screens.remove(rendererUid)) return;
    this._pruneScreenCanvases();
  }
  /** Clears the pool. */
  clear() {
    this._buckets.clear();
  }
  /**
   * Drops the idle canvases in every bucket that has a non power of two dimension matching no live
   * screen. Power of two buckets are always kept, as any request can fall back to them.
   */
  _pruneScreenCanvases() {
    for (const [key] of this._buckets) {
      const width = key >>> 17;
      const height = key >>> 2 & 32767;
      if ((isPow2(width) || this._screens.hasWidth(width)) && (isPow2(height) || this._screens.hasHeight(height))) continue;
      this._buckets.delete(key);
    }
  }
}
const CanvasPool = new CanvasPoolClass();
GlobalResourceRegistry.register(CanvasPool);
export {
  CanvasPool as C,
  Filter as F
};
