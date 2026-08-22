// shims.js — browser environment for QuickJS running RMMZ/PixiJS
(function () {
  "use strict";

  // RMMZ percent-encodes asset URLs (Utils.encodeURI): spaces -> %20, $
  // -> %24, etc. Decode them back to real filesystem paths before loading.
  function safePath(url) {
    if (!url || typeof url !== "string") return url;
    try {
      return decodeURIComponent(url);
    } catch (e) {
      return url;
    }
  }

  // Effekseer stub — we don't use WASM effekseer, we use legacy MV PNG animations
  globalThis.effekseer = {
    // Confirmed needed by trace: RMMZ's standard initEffekseerRuntime()
    // calls effekseer.initRuntime(wasmPath, onLoad, onError) at boot. Since
    // this project never actually plays a WASM effect (MV-style PNG
    // animations only), we just report success asynchronously without
    // loading anything — real signature is callback-based, not Promise,
    // so call onLoad directly rather than returning a Promise.
    initRuntime: function (wasmPath, onLoad, onError) {
      Promise.resolve().then(function () {
        try {
          if (onLoad) onLoad();
        } catch (e) {
          print("[effekseer onLoad error] " + e + (e && e.stack ? "\nStack:\n" + e.stack : ""));
        }
      });
    },
    createContext: function() {
      return {
        init: function() { return true; },
        // Confirmed root cause of "Failed to initialize graphics.": this
        // was missing. Graphics._createEffekseerContext() calls it right
        // after init() with no guard, and its own try/catch silently sets
        // Graphics._app = null on any error, so Graphics.initialize()
        // returns false and SceneManager.initGraphics throws its generic
        // error — no trace of the real TypeError ever surfaces.
        setRestorationOfStatesFlag: function() {},
        update: function() {},
        draw: function() {},
        release: function() {},
        // loadEffect's returned object's isLoaded never flips to true, so
        // Sprite_Animation.update() (rmmz_sprites.js) never takes the
        // Graphics.effekseer.play(...) branch — it falls through to
        // EffectManager.checkErrors(), which is a no-op as long as
        // onError below is never called. That keeps play/beginDraw/
        // drawHandle/endDraw and the handle's stop/setLocation/
        // setRotation/setScale/setSpeed/exists all unreachable, which is
        // fine since this project only uses legacy MV PNG animations.
        loadEffect: function (url, scale, onLoad, onError) {
          return { url: url, isLoaded: false };
        },
        releaseEffect: function() {},
        stopAll: function() {},
        beginDraw: function() {},
        drawHandle: function() {},
        endDraw: function() {},
        play: function() {
          return {
            handle: 0,
            exists: false,
            stop: function() {},
            setLocation: function() {},
            setRotation: function() {},
            setScale: function() {},
            setSpeed: function() {},
          };
        },
        stop: function() {},
        setProjectionMatrix: function() {},
        setCameraMatrix: function() {},
        setViewProjectionMatrix: function() {}
      };
    }
  };

  // WebAssembly stub — make all WASM inert. Emscripten modules
// (effekseer.min.js, vorbisdecoder.js) bootstrap by looping over exported
// functions calling func.apply; with no real bytecode, that hits undefined.
// Rejecting at the instantiate boundary lets Emscripten abort cleanly via its
// onError path instead of crashing on undefined.apply.
  globalThis.WebAssembly = {
    Memory: function(opts) {
      var pages = (opts && opts.initial) || 256;
      this.buffer = new ArrayBuffer(pages * 64 * 1024);
    },
    Table: function(opts) {
      this.length = (opts && opts.initial) || 0;
      this.get = function(i) { return function() { return 0; }; };
      this.set = function() {};
      this.grow = function() { return 0; };
    },
    Module: function(bytes) { this.bytes = bytes; },
    Instance: function(module, imports) {
      this.exports = {};
    },
    instantiate: function() {
      return Promise.reject(new Error("WASM inert"));
    },
    instantiateStreaming: function() {
      return Promise.reject(new Error("WASM inert"));
    },
    compile: function() {
      return Promise.reject(new Error("WASM inert"));
    },
    compileStreaming: function() {
      return Promise.reject(new Error("WASM inert"));
    },
    validate: function() { return false; }
  };

  // Worker stubs — vorbisdecoder.js is a worker script loaded in main context
  globalThis.Worker = function(scriptURL) {
    this.scriptURL = scriptURL;
  };
  globalThis.Worker.prototype.postMessage = function() {};
  globalThis.Worker.prototype.terminate = function() {};
  globalThis.Worker.prototype.onmessage = null;
  globalThis.Worker.prototype.onerror = null;
  // Confirmed needed: vorbisdecoder.js calls worker.addEventListener("message", ...)
  globalThis.Worker.prototype.addEventListener = function() {};
  globalThis.Worker.prototype.removeEventListener = function() {};

  // Worker-context functions that vorbisdecoder.js might call when loaded as non-worker
  globalThis.postMessage = function() {};
  globalThis.importScripts = function() {};
  globalThis.close = function() {};

  // URL stub (vorbisdecoder may use createObjectURL for worker blobs)
  globalThis.URL = globalThis.URL || {
    createObjectURL: function() { return ""; },
    revokeObjectURL: function() {}
  };

  // Blob stub — only exercised if the project has encrypted images/audio
  // enabled (System.json hasEncryptedImages/hasEncryptedAudio), in which
  // case Bitmap._onXhrLoad does `new Blob([arrayBuffer])`. We don't need
  // real blob semantics since URL.createObjectURL above is already a
  // no-op stub; this just needs to exist and not throw.
  globalThis.Blob = globalThis.Blob || function (parts, opts) {
    this._parts = parts || [];
    this.type = (opts && opts.type) || "";
  };

  const native = globalThis.__native__;
  if (!native) throw new Error("shims.js: no __native__ bridge");

  // Some third-party plugins reference $gameLighting (ShoraLighting)
  // unconditionally and even call methods on it ($gameLighting.setOffset()).
  // When ShoraLighting is disabled we provide a no-op Proxy: every property
  // read returns a callable no-op, every numeric coercion yields 0. If
  // ShoraLighting actually loads, it replaces this with the real object.
  if (typeof globalThis.$gameLighting === 'undefined') {
    globalThis.$gameLighting = new Proxy(function () {}, {
      get: function (target, prop) {
        if (prop === Symbol.toPrimitive) return function () { return 0; };
        if (prop === 'valueOf') return function () { return 0; };
        if (prop === 'toString') return function () { return ''; };
        return function () {};
      },
      apply: function () { return undefined; }
    });
  }

  // Cache whether per-call Tracy profiling is on (SONAR_TRACY=1) so __tick__
  // never pays a JS->C bridge hop every frame just to ask. Off by default:
  // the per-call GL zones are the #1 measured overhead at high call counts.
  const tracyOn = !!(native.tracyEnabled && native.tracyEnabled());

  // ----------------------------------------------------------------
  // ACCUMULATOR OPTIMIZATION (opt-in, SONAR_BATCH_UPLOADS=1): batch
  // bufferSubData uploads and flush them once per draw in a single C-side
  // loop, collapsing many JS->C boundary crossings into one call.
  //
  // Correctness notes vs. the naive version:
  // ----------------------------------------------------------------
  // bufferSubData: direct native passthrough (no JS allocation overhead)
  // ----------------------------------------------------------------
  if (native.getEnv && native.getEnv("SONAR_BATCH_UPLOADS") === "1" &&
      native.gl && native.gl.batchBufferSubData) {
    const _origBindBuffer = native.gl.bindBuffer;
    const _origBufferSubData = native.gl.bufferSubData;
    const _origDrawElements = native.gl.drawElements;
    const _origDrawArrays = native.gl.drawArrays;
    const _origDrawElementsInstanced = native.gl.drawElementsInstanced;
    const _origDrawArraysInstanced = native.gl.drawArraysInstanced;

    const _pendingUploads = [];
    let _needsFlush = false;
    const _boundBuffers = {};

    function snapshotBytes(data) {
      if (data && typeof data === "object" && data.buffer && data.byteLength !== undefined) {
        const copy = new ArrayBuffer(data.byteLength);
        new Uint8Array(copy).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        return copy;
      }
      return data;
    }

    native.gl.bindBuffer = function (target, buffer) {
      _boundBuffers[target] = buffer;
      return _origBindBuffer.call(this, target, buffer);
    };

    native.gl.bufferSubData = function (target, offset, data) {
      _pendingUploads.push({
        target: target,
        offset: offset,
        data: snapshotBytes(data),
        buffer: _boundBuffers[target] || 0
      });
      _needsFlush = true;
    };

    function flushPendingUploads() {
      if (!_needsFlush) return;
      _needsFlush = false;
      if (_pendingUploads.length === 0) return;
      native.gl.batchBufferSubData(_pendingUploads);
      _pendingUploads.length = 0;
      for (const target in _boundBuffers) {
        if (Object.prototype.hasOwnProperty.call(_boundBuffers, target)) {
          _origBindBuffer.call(native.gl, target, _boundBuffers[target]);
        }
      }
    }
    native.gl.flushPendingUploads = flushPendingUploads;

    native.gl.drawElements = function (mode, count, type, offset) {
      flushPendingUploads();
      return _origDrawElements.call(this, mode, count, type, offset);
    };
    native.gl.drawArrays = function (mode, first, count) {
      flushPendingUploads();
      return _origDrawArrays.call(this, mode, first, count);
    };
    native.gl.drawElementsInstanced = function (mode, count, type, offset, primcount) {
      flushPendingUploads();
      return _origDrawElementsInstanced.call(this, mode, count, type, offset, primcount);
    };
    native.gl.drawArraysInstanced = function (mode, first, count, primcount) {
      flushPendingUploads();
      return _origDrawArraysInstanced.call(this, mode, first, count, primcount);
    };
    print("[Shim] bufferSubData accumulator enabled (SONAR_BATCH_UPLOADS=1)");
  }

  // ----------------------------------------------------------------
  // WebGL detection globals — confirmed required by tracing pixi.js:
  //   - line ~3999: isWebGLSupported() returns false immediately if
  //     window.WebGLRenderingContext doesn't exist, before it even tries
  //     creating a context. Without this, Renderer.create() throws
  //     "WebGL unsupported in this browser" unconditionally.
  //   - line ~17287: ContextSystem.validateContext() does
  //     `gl instanceof window.WebGL2RenderingContext` to decide WebGL
  //     version. native.gl is a plain object with no prototype chain, so
  //     this needs the prototype set explicitly (done in getContext below)
  //     or Pixi silently runs in WebGL1-compat mode despite a full GL2
  //     bridge underneath.
  //   - lines ~20022/20106: a couple of PixiJS system classes read
  //     WebGLRenderingContext.SCISSOR_TEST / .STENCIL_TEST as *static*
  //     properties on the constructor itself, not off a gl instance.
  // ----------------------------------------------------------------
  globalThis.WebGLRenderingContext = function () {};
  globalThis.WebGL2RenderingContext = function () {};
  // Populated below once native.gl's constants are known — see the end
  // of the getContext() setup where native.gl is first touched.

  // indexedDB / document.hasFocus — RMMZ's SceneManager boot-time checks
  // reference these; harmless stubs if unused, prevents ReferenceError/
  // TypeError if they are.
  globalThis.indexedDB = globalThis.indexedDB || {
    open: function () { return { onsuccess: null, onerror: null, onupgradeneeded: null }; },
    deleteDatabase: function () {},
  };

  // ----------------------------------------------------------------
  // Globals
  // ----------------------------------------------------------------
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.navigator = {
    userAgent: "rmmz-native/0.1 (QuickJS)",
    platform: "native",
    language: "en-US",
  };
  globalThis.location = {
    href: "file:///game/index.html",
    origin: "file://",
    search: "",
    reload: function () {},
    replace: function (url) {
      print("[Shim] Blocked window.location.replace to: " + url + " (native runtime handles plugin loading directly)");
    },
  };
  globalThis.devicePixelRatio = 1;
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 720;
  globalThis.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080 };
  globalThis.focus = function () {};
  globalThis.blur = function () {};
  globalThis.scrollTo = function () {};
  globalThis.scrollBy = function () {};
  globalThis.scrollX = 0;
  globalThis.scrollY = 0;
  globalThis.pageXOffset = 0;
  globalThis.pageYOffset = 0;
  globalThis.resizeTo = function (w, h) {
    globalThis.innerWidth = w;
    globalThis.innerHeight = h;
    native.setWindowSize(w, h);
  };
  globalThis.resizeBy = function (dw, dh) {
    globalThis.resizeTo((globalThis.innerWidth || 816) + dw, (globalThis.innerHeight || 624) + dh);
  };
  globalThis.moveBy = function () {};
  globalThis.moveTo = function () {};

  // quickjs-ng defines a built-in `performance` object whose `now` is
  // read-only, so replace the whole object rather than patching the method.
  globalThis.performance = {
    now: function () { return native.now(); },
  };

  // console stubs (RMMZ uses console.warn for oversized saves)
  globalThis.console = globalThis.console || {};
  if (!globalThis.console.warn) {
    globalThis.console.warn = function () {
      print("[WARN] " + Array.prototype.slice.call(arguments).join(" "));
    };
  }
  if (!globalThis.console.error) {
    globalThis.console.error = function () {
      print("[ERROR] " + Array.prototype.slice.call(arguments).join(" "));
    };
  }
  if (!globalThis.console.log) {
    globalThis.console.log = function () {
      print(Array.prototype.slice.call(arguments).join(" "));
    };
  }

  // ----------------------------------------------------------------
  // localStorage
  // ----------------------------------------------------------------
  globalThis.localStorage = {
    getItem(key) {
      const v = native.storageGet(key);
      return v === null || v === undefined ? null : v;
    },
    setItem(key, value) {
      native.storageSet(key, String(value));
    },
    removeItem(key) {
      native.storageSet(key, "");
    },
  };

  // ----------------------------------------------------------------
  // Timers
  // ----------------------------------------------------------------
  let timers = [];
  let timerId = 0;
  globalThis.setTimeout = function (cb, delay) {
    timerId++;
    timers.push({ id: timerId, cb: cb, deadline: performance.now() + (delay || 0), repeat: false, interval: 0 });
    return timerId;
  };
  globalThis.setInterval = function (cb, delay) {
    timerId++;
    timers.push({ id: timerId, cb: cb, deadline: performance.now() + (delay || 0), repeat: true, interval: delay || 0 });
    return timerId;
  };
  globalThis.clearTimeout = globalThis.clearInterval = function (id) {
    timers = timers.filter(function (t) { return t.id !== id; });
  };

  // ----------------------------------------------------------------
  // requestAnimationFrame
  // ----------------------------------------------------------------
  let rafCallbacks = [];
  let rafHandle = 0;
  globalThis.requestAnimationFrame = function (cb) {
    rafHandle += 1;
    rafCallbacks.push({ id: rafHandle, cb: cb });
    return rafHandle;
  };
  globalThis.cancelAnimationFrame = function (id) {
    rafCallbacks = rafCallbacks.filter(function (e) { return e.id !== id; });
  };
  globalThis.__tick__ = function (timestamp) {
    globalThis.__currentTimestamp = timestamp;
    // GC pressure watch — OPT-IN (SONAR_GC_WATCH=1). Disabled by default:
    // JS_ComputeMemoryUsage walks the whole heap and costs real ms.
    if (globalThis.__gcWatch_ === undefined) {
      globalThis.__gcWatch_ = !!(native.getEnv && native.getEnv("SONAR_GC_WATCH") === "1");
    }
    if (globalThis.__gcWatch_ && native.memoryUsage && (globalThis.__gcFrame_ = ((globalThis.__gcFrame_ || 0) + 1)) % 30 === 0) {
      const mu = native.memoryUsage();
      if (globalThis.__gcLastUsed_ === undefined) globalThis.__gcLastUsed_ = mu.usedSize;
      else if (globalThis.__gcLastUsed_ - mu.usedSize > 262144) {
        print("[gc] freed ~" + Math.round((globalThis.__gcLastUsed_ - mu.usedSize) / 1024) +
              "KB, now " + Math.round(mu.usedSize / 1024) + "KB frame=" + timestamp);
        globalThis.__gcLastUsed_ = mu.usedSize;
      } else if (mu.usedSize > globalThis.__gcLastUsed_) {
        globalThis.__gcLastUsed_ = mu.usedSize;
      }
    }
    if (globalThis.__installInterpreterErrorTolerances__) {
      globalThis.__installInterpreterErrorTolerances__();
    }
    if (tracyOn) {
      if (globalThis.__patchRMMZProfiling__) globalThis.__patchRMMZProfiling__();
      native.tracyZoneStart("JS tick internals");
    }

    const now = performance.now();
    const timersArr = timers;

    // Profile timer processing
    if (tracyOn) native.tracyZoneStart("Timers processing");
    let write = 0;
    let dueHead = null;
    let dueTail = null;
    for (let i = 0; i < timersArr.length; i++) {
      const t = timersArr[i];
      if (now >= t.deadline) {
        if (dueTail) dueTail._next = t; else dueHead = t;
        dueTail = t;
        t._next = null;
        if (t.repeat) {
          t.deadline = now + t.interval;
          timersArr[write++] = t;
        }
      } else {
        timersArr[write++] = t;
      }
    }
    if (write < timersArr.length) timersArr.length = write;
    if (tracyOn) native.tracyZoneEnd();

    // Profile timer execution
    if (tracyOn) native.tracyZoneStart("Timers execution");
    for (let t = dueHead; t; t = t._next) {
      try { t.cb(); } catch (e) { print("[timer error] " + e + (e && e.stack ? "\nStack:\n" + e.stack : "")); }
    }
    if (tracyOn) native.tracyZoneEnd();

    // Profile rAF callbacks
    const frameCbs = rafCallbacks;
    rafCallbacks = [];
    if (tracyOn) native.tracyZoneStart("RAF callbacks");
    for (let i = 0; i < frameCbs.length; i++) {
      // Label built ONCE per callback and cached — building it here every
      // frame allocated thousands of throwaway strings/sec, driving periodic
      // major GC cycles (the ~50ms spikes every couple of seconds).
      const entry = frameCbs[i];
      let label = entry.__label;
      if (label === undefined) {
        label = entry.__label = "rAF " + (entry.cb.name || "anon");
      }
      native.tracyZoneStart(label);
      try {
        entry.cb(timestamp);
      } catch (e) {
        print("[rAF error] " + e + "\n  e.stack=[" + (e && e.stack ? e.stack : "(none)") + "]");
      } finally {
        native.tracyZoneEnd();
      }
    }
    if (tracyOn) native.tracyZoneEnd();

    if (tracyOn) native.tracyZoneEnd();
  };

  // Profile common RMMZ/PixiJS functions to identify the anon rAF callback.
  // shims.js runs BEFORE the game's scripts define SceneManager/PIXI/etc., so
  // we retry on each tick until the globals exist, then stop retrying.
  if (tracyOn) {
    let rmmzPatched = false;
    globalThis.__patchRMMZProfiling__ = function () {
      if (rmmzPatched) return;
      // Profile SceneManager if it exists
      if (typeof SceneManager !== 'undefined' && SceneManager.update && !SceneManager.update.__tracyWrapped) {
        const originalSceneUpdate = SceneManager.update;
        SceneManager.update = function () {
          native.tracyZoneStart("SceneManager.update");
          try {
            return originalSceneUpdate.call(this);
          } finally {
            native.tracyZoneEnd();
          }
        };
        SceneManager.update.__tracyWrapped = true;
      }

      // Profile PixiJS ticker - DETAILED VERSION: wrap each registered
      // listener fn so the ORIGINAL update() still drives everything exactly
      // once; we only add a Tracy zone around each listener invocation.
      if (typeof PIXI !== 'undefined' && PIXI.Ticker && PIXI.Ticker.prototype.update && !PIXI.Ticker.prototype.update.__tracyWrapped) {
        const nativeObj = native;
        const originalTickerUpdate = PIXI.Ticker.prototype.update;
        PIXI.Ticker.prototype.update = function (time) {
          nativeObj.tracyZoneStart("PIXI.Ticker.update");
          try {
            for (let listener = this._head; listener; listener = listener.next) {
              if (!listener.fn || listener.fn.__tracyWrapped) continue;
              const orig = listener.fn;
              const label = "Ticker listener " + (orig.name || "anon");
              const wrapped = function (delta) {
                nativeObj.tracyZoneStart(label);
                try {
                  return orig.apply(this, arguments);
                } finally {
                  nativeObj.tracyZoneEnd();
                }
              };
              wrapped.__tracyWrapped = true;
              wrapped.__tracyOrig = orig;
              listener.fn = wrapped;
            }
            return originalTickerUpdate.call(this, time);
          } finally {
            nativeObj.tracyZoneEnd();
          }
        };
        PIXI.Ticker.prototype.update.__tracyWrapped = true;
      }

      // Profile Scene updates if they exist
      if (typeof Scene_Base !== 'undefined' && Scene_Base.prototype.update && !Scene_Base.prototype.update.__tracyWrapped) {
        const originalSceneBaseUpdate = Scene_Base.prototype.update;
        Scene_Base.prototype.update = function () {
          native.tracyZoneStart("Scene_Base.update");
          try {
            return originalSceneBaseUpdate.call(this);
          } finally {
            native.tracyZoneEnd();
          }
        };
        Scene_Base.prototype.update.__tracyWrapped = true;
      }

      // ----------------------------------------------------------------
      // (Interpreter tolerances are installed by __installInterpreterErrorTolerances__)
      // ----------------------------------------------------------------

      // Profile RMMZ core functions that plugins monkey-patch
      const wrapProto = function (ctor, name, label, argNames) {
        const proto = ctor && ctor.prototype;
        if (!proto || typeof proto[name] !== 'function' || proto[name].__tracyWrapped) return;
        const original = proto[name];
        const nativeObj = native;
        proto[name] = function () {
          nativeObj.tracyZoneStart(label);
          try {
            return original.apply(this, arguments);
          } finally {
            nativeObj.tracyZoneEnd();
          }
        };
        proto[name].__tracyWrapped = true;
      };

      // Game_Map.update / Game_Player.update (hooked by UltraMode7, Tyruswoo)
      if (typeof Game_Map !== 'undefined') wrapProto(Game_Map, 'update', 'Game_Map.update');
      if (typeof Game_Player !== 'undefined') wrapProto(Game_Player, 'update', 'Game_Player.update');

      // Vanilla RMMZ Tilemap internals called from Tilemap.updateTransform
      // (_addAllSpots = map tile repaint, _sortChildren = z sort).
      if (typeof Tilemap !== 'undefined' && Tilemap.prototype) {
        // Counter layer: if inner count exceeds the incremental wrapper's
        // count, something calls a SAVED pre-shim reference directly.
        const innerOrig = Tilemap.prototype._addAllSpots;
        Tilemap.prototype._addAllSpots = function () {
          globalThis.__incInner_ = (globalThis.__incInner_ || 0) + 1;
          return innerOrig.apply(this, arguments);
        };
        wrapProto(Tilemap, '_addAllSpots', 'Tilemap._addAllSpots');
        wrapProto(Tilemap, '_sortChildren', 'Tilemap._sortChildren');
      }

      // ------------------------------------------------------------------
      // INCREMENTAL TILEMAP REPAINT (opt-in, SONAR_TILEMAP_INCREMENTAL=1)
      //
      // Stock RMMZ _addAllSpots clears BOTH layers and repaints every
      // visible tile spot (~cols*rows*_readMapData calls + autotile math)
      // every time the scroll origin moves one tile. Under QuickJS this
      // measured 55ms/frame while scrolling.
      //
      // This shim reuses the previously painted element rects: shift them by
      // the tile delta, drop rects that fell out of the (margin-expanded)
      // viewport, and paint only the newly exposed rows/columns. Autotile
      // shapes of surviving tiles stay valid because their neighbors did not
      // change; only fresh strips compute neighbors anew.
      //
      // Full repaint still happens when: first frame, explicit refresh
      // (_needsRepaint), autotile animation frame change (shapes may differ),
      // or a jump larger than the whole viewport.
      // ------------------------------------------------------------------
      // Enabled by default unless explicitly disabled with SONAR_TILEMAP_INCREMENTAL=0
      if (typeof Tilemap !== 'undefined' && Tilemap.prototype &&
          (!native.getEnv || native.getEnv("SONAR_TILEMAP_INCREMENTAL") !== "0") &&
          !Tilemap.prototype.__tracyIncremental) {
        Tilemap.prototype.__tracyIncremental = true;
        print("[inc] INCREMENTAL SHIM INSTALLED ok");
        const nativeObj = native;
        const origAddAllSpots = Tilemap.prototype._addAllSpots;

        // Snapshot/restore helpers. Each slot holds one animation frame's
        // painted element arrays plus the scroll origin it was built for.
        // Swapping slots on autotile frame changes replaces a full repaint
        // with an array swap + incremental shift.
        const takeSnapshot = function (tilemap) {
          const layers = [];
          for (const combined of [tilemap._lowerLayer, tilemap._upperLayer]) {
            if (!combined || !combined.children) continue;
            for (const layer of combined.children) {
              const src = layer._elements || [];
              const copy = new Array(src.length);
              for (let i = 0; i < src.length; i++) {
                const e = src[i];
                copy[i] = [e[0], e[1], e[2], e[3], e[4], e[5], e[6]];
              }
              layers.push(copy);
            }
          }
          const bbLayers = [];
          if (tilemap._billboards) {
            for (let b = 0; b < tilemap._billboards.length; b++) {
              const bLayer = tilemap._billboards[b];
              const src = bLayer ? (bLayer._elements || []) : [];
              const copy = new Array(src.length);
              for (let i = 0; i < src.length; i++) {
                const e = src[i];
                copy[i] = [e[0], e[1], e[2], e[3], e[4], e[5], e[6]];
              }
              bbLayers.push(copy);
            }
          }
          return { startX: 0, startY: 0, animFrame: -1, layers: layers, bbLayers: bbLayers };
        };

        const restoreSlot = function (tilemap, slot) {
          let li = 0;
          for (const combined of [tilemap._lowerLayer, tilemap._upperLayer]) {
            if (!combined || !combined.children) continue;
            for (const layer of combined.children) {
              const el = slot.layers[li++];
              if (el) {
                layer._elements = el;
                layer._needsVertexUpdate = true;
              }
            }
          }
          if (tilemap._billboards && slot.bbLayers) {
            for (let b = 0; b < tilemap._billboards.length; b++) {
              const bLayer = tilemap._billboards[b];
              const el = slot.bbLayers[b];
              if (bLayer && el) {
                bLayer._elements = el;
                bLayer._needsVertexUpdate = true;
              }
            }
          }
        };

        Tilemap.prototype._addAllSpots = function (startX, startY) {
          const timestamp = globalThis.__currentTimestamp || (typeof Graphics !== 'undefined' && Graphics.frameCount ? Graphics.frameCount : 0);
          globalThis.__incOuter_ = (globalThis.__incOuter_ || 0) + 1;
          if ((globalThis.__incOuter_ || 0) % 600 === 1) {
            print("[inc] calls outer(incremental)=" + (globalThis.__incOuter_ || 0) +
                  " inner(direct/saved-ref)=" + (globalThis.__incInner_ || 0));
          }
          const tw = this.tileWidth;
          const th = this.tileHeight;
          const widthWithMargin = this.width + this._margin * 2;
          const heightWithMargin = this.height + this._margin * 2;
          const cols = Math.ceil(widthWithMargin / tw) + 1;
          const rows = Math.ceil(heightWithMargin / th) + 1;

          if (this._needsRepaint) {
            if (!globalThis.__incFullCount_) globalThis.__incFullCount_ = [0, 0];
            globalThis.__incFullCount_[0]++;
            if (globalThis.__incFullCount_[0] % 5 === 1) {
              print("[inc] FULL REPAIR reason=_needsRepaint (count=" +
                    globalThis.__incFullCount_[0] + ") frame=" + timestamp);
            }
            // Detach live arrays BEFORE repainting
            for (const combined of [this._lowerLayer, this._upperLayer]) {
              if (combined && combined.children) {
                for (const layer of combined.children) {
                  layer._elements = [];
                  layer._needsVertexUpdate = true;
                }
              }
            }
            if (this._billboards) {
              for (let b = 0; b < this._billboards.length; b++) {
                if (this._billboards[b]) {
                  this._billboards[b]._elements = [];
                  this._billboards[b]._needsVertexUpdate = true;
                }
              }
            }
            origAddAllSpots.call(this, startX, startY);
            // Map content changed: every anim-frame snapshot is stale.
            this.__incSlots = null;
            return;
          }

          if (!this.__incSlots) this.__incSlots = [null, null, null];
          const af = ((this.animationFrame % 3) + 3) % 3;
          let slot = this.__incSlots[af];

          // Fast slot reuse if animation frame changed while stationary
          if (slot && slot.startX === startX && slot.startY === startY) {
            restoreSlot(this, slot);
            return;
          }

          // TF_LayeredMap compat: billboards are indexed per-row. For maps with
          // billboards, run full fast repaint whenever scroll position changes
          // and cache into slot[af].
          const hasBillboards = (this._billboards && this._billboards.length > 0);
          if (hasBillboards) {
            for (const combined of [this._lowerLayer, this._upperLayer]) {
              if (combined && combined.children) {
                for (const layer of combined.children) {
                  layer._elements = [];
                  layer._needsVertexUpdate = true;
                }
              }
            }
            for (let b = 0; b < this._billboards.length; b++) {
              if (this._billboards[b]) {
                this._billboards[b]._elements = [];
                this._billboards[b]._needsVertexUpdate = true;
              }
            }
            origAddAllSpots.call(this, startX, startY);
            slot = this.__incSlots[af] = takeSnapshot(this);
            slot.startX = startX;
            slot.startY = startY;
            return;
          }

          const jumpTooBig = !slot ||
            Math.abs(startX - slot.startX) >= cols ||
            Math.abs(startY - slot.startY) >= rows;

          if (jumpTooBig) {
            if (!globalThis.__incFullCount_) globalThis.__incFullCount_ = [0, 0];
            globalThis.__incFullCount_[1]++;
            if (globalThis.__incFullCount_[1] % 5 === 1 || !slot) {
              print("[inc] FULL REPAIR reason=" + (!slot ? "new-anim-slot" : "camera-jump") +
                    " af=" + af + " start=" + startX + "," + startY +
                    " slotStart=" + (slot && slot.startX) + "," + (slot && slot.startY) +
                    " (count=" + globalThis.__incFullCount_[1] + ") frame=" + timestamp);
            }
            // Same aliasing hazard as above: detach before clear+repaint so
            // other slots' snapshots survive intact.
            for (const combined of [this._lowerLayer, this._upperLayer]) {
              for (const layer of combined.children) {
                layer._elements = [];
                layer._needsVertexUpdate = true;
              }
            }
            origAddAllSpots.call(this, startX, startY);
            if (!slot) slot = this.__incSlots[af] = takeSnapshot(this);
            slot.startX = startX;
            slot.startY = startY;
            return;
          }

          const ddx = startX - slot.startX;
          const ddy = startY - slot.startY;
          const offx = ddx * tw;
          const offy = ddy * th;

          // Diagnostics are opt-in (SONAR_TILEMAP_DEBUG=1)
          const incDebug = nativeObj.getEnv && nativeObj.getEnv("SONAR_TILEMAP_DEBUG") === "1";
          if (incDebug && (!Tilemap.__incDebug || Tilemap.__incDebug !== ddx + "," + ddy)) {
            Tilemap.__incDebug = ddx + "," + ddy;
            print("[inc] shift d=" + ddx + "," + ddy +
                  " start=" + startX + "," + startY +
                  " cols=" + cols + " rows=" + rows +
                  " tw=" + tw + " th=" + th +
                  " w+m=" + widthWithMargin + " h+m=" + heightWithMargin);
          }

          // Shift retained rects and cull ones now fully outside.
          let li = 0;
          for (const combined of [this._lowerLayer, this._upperLayer]) {
            for (const layer of combined.children) {
              const el = slot.layers[li++];
              if (incDebug && layer._elements !== el) {
                print("[inc] MISMATCH: live elements are NOT slot[" + af + "] layer[" + (li - 1) + "]! " +
                      "live=" + (layer._elements && layer._elements.length) +
                      " slot=" + (el && el.length) +
                      " ctor=" + (layer.constructor && layer.constructor.name));
              }
              layer._elements = el;
              let w2 = 0;
              for (let i = 0; i < el.length; i++) {
                const e = el[i];
                const ndx = e[3] - offx;
                const ndy = e[4] - offy;
                if (ndx + e[5] <= 0 || ndy + e[6] <= 0 || ndx >= widthWithMargin || ndy >= heightWithMargin) continue;
                e[3] = ndx;
                e[4] = ndy;
                el[w2++] = e;
              }
              el.length = w2;
              layer._needsVertexUpdate = true;
            }
          }

          // Paint only cells that were not covered by the previous viewport.
          for (let y = 0; y < rows; y++) {
            const my = startY + y;
            const rowCached = my >= slot.startY && my < slot.startY + rows;
            for (let x = 0; x < cols; x++) {
              const mx = startX + x;
              if (rowCached && mx >= slot.startX && mx < slot.startX + cols) continue;
              this._addSpot(startX, startY, x, y);
            }
          }

          slot.startX = startX;
          slot.startY = startY;
          if (nativeObj.tracyZoneText) nativeObj.tracyZoneText("incremental d=" + ddx + "," + ddy);
        };

        // Fast inlined map data reader (avoids Number.prototype.mod function calls)
        Tilemap.prototype._readMapData = function(x, y, z) {
          const gm = globalThis.$gameMap;
          if (!gm) return 0;
          const w = gm.width();
          const h = gm.height();
          if (gm.isLoopHorizontal()) x = (x % w + w) % w;
          if (gm.isLoopVertical()) y = (y % h + h) % h;
          if (x >= 0 && x < w && y >= 0 && y < h) {
            const d = gm.data();
            return d ? (d[(z * h + y) * w + x] || 0) : 0;
          }
          return 0;
        };
      }

      // Tilemap.updateTransform - DETAILED VERSION. We do NOT duplicate the
      // original's work; instead we lazily wrap each child display object's
      // own updateTransform (per-instance, guarded) so the original call
      // still drives everything exactly once, with a zone per child.
      if (typeof Tilemap !== 'undefined' && !Tilemap.__tracyDetailedChildWrap) {
        Tilemap.__tracyDetailedChildWrap = true;
        const nativeObj = native;
        const origTT = Tilemap.prototype.updateTransform;
        if (!origTT.__tracyWrapped) {
          Tilemap.prototype.updateTransform = function () {
            nativeObj.tracyZoneStart("Tilemap.updateTransform");
            try {
              const kids = this.children;
              if (!Tilemap.__tracyDumpedKids) {
                Tilemap.__tracyDumpedKids = true;
                let names = [];
                for (let k = 0; k < kids.length; k++) {
                  const c = kids[k];
                  names.push(k + ":" + (c.constructor && c.constructor.name || "?") +
                    " ownTT=" + Object.prototype.hasOwnProperty.call(c, 'updateTransform') +
                    " protoTT=" + (c.constructor && c.constructor.prototype && c.constructor.prototype.hasOwnProperty('updateTransform')));
                }
                print("[shims.js] Tilemap ctor=" + (this.constructor && this.constructor.name) +
                      " kids=[" + names.join(", ") + "]" +
                      " Tilemap.Layer=" + typeof Tilemap.Layer +
                      " LayerProtoOwnTT=" + (Tilemap.Layer && Tilemap.Layer.prototype ? Tilemap.Layer.prototype.hasOwnProperty('updateTransform') : "n/a"));
                print("[shims.js] Tilemap.prototype.updateTransform source:\n" + String(origTT).slice(0, 800));
              }
              for (let i = 0; i < kids.length; i++) {
                const c = kids[i];
                const m = c && c.updateTransform;
                if (typeof m === 'function' && !m.__tracyChildWrapped) {
                  const orig = m;
                  const label = "Tilemap child[" + i + "] " + (c.constructor && c.constructor.name || "obj");
                  const wrapped = function () {
                    nativeObj.tracyZoneStart(label);
                    try {
                      return orig.apply(this, arguments);
                    } finally {
                      nativeObj.tracyZoneEnd();
                    }
                  };
                  wrapped.__tracyChildWrapped = true;
                  c.updateTransform = wrapped;
                }
              }
              // Zone the ORIGINAL call specifically: if a plugin re-patched
              // Tilemap.updateTransform on top of ours, its work shows up
              // here instead of as unattributed self time.
              nativeObj.tracyZoneStart("Tilemap ORIGINAL updateTransform");
              try {
                return origTT.apply(this, arguments);
              } finally {
                nativeObj.tracyZoneEnd();
              }
            } finally {
              nativeObj.tracyZoneEnd();
            }
          };
          Tilemap.prototype.updateTransform.__tracyWrapped = true;
        }
      }

      // Profile Tilemap.Layer.updateTransform (lower vs upper layer) so we
      // know WHICH layer's per-tile math is expensive. NOTE: Layer inherits
      // updateTransform from PIXI.Container, so we must resolve it through
      // the prototype chain and install a shadowing wrapper.
      if (typeof Tilemap !== 'undefined' && Tilemap.Layer && Tilemap.Layer.prototype &&
          !Tilemap.Layer.prototype.hasOwnProperty('updateTransform')) {
        const layerTT = PIXI.Container.prototype.updateTransform;
        if (typeof layerTT === 'function') {
          const nativeObj = native;
          Tilemap.Layer.prototype.updateTransform = function () {
            let which = "?";
            if (this.parent && this === this.parent._lowerLayer) which = "LOWER";
            else if (this.parent && this === this.parent._upperLayer) which = "UPPER";
            else if (this.layerIndex !== undefined) which = "idx" + this.layerIndex;
            nativeObj.tracyZoneStart("Tilemap.Layer[" + which + "] updateTransform");
            try {
              return layerTT.apply(this, arguments);
            } finally {
              nativeObj.tracyZoneEnd();
            }
          };
        }
      }

      // Emit map dimensions into the Tilemap.updateTransform zone text so
      // huge-map issues are visible directly in Tracy.
      if (typeof Tilemap !== 'undefined' && !Tilemap.__tracyMapSizeText && typeof globalThis.$gameMap !== 'undefined' && globalThis.$gameMap && native.tracyZoneText) {
        Tilemap.__tracyMapSizeText = true;
        print("[shims.js] Map size: " + globalThis.$gameMap.width() + "x" + globalThis.$gameMap.height() +
              " tiles, display " + globalThis.$gameMap.displayX().toFixed(2) + "," + globalThis.$gameMap.displayY().toFixed(2));
      }

      // Game_Character.update (hooked by ShoraLighting, Tyruswoo)
      if (typeof Game_Character !== 'undefined') wrapProto(Game_Character, 'update', 'Game_Character.update');

      // Sprite_Character.update (hooked by UltraMode7)
      if (typeof Sprite_Character !== 'undefined') wrapProto(Sprite_Character, 'update', 'Sprite_Character.update');

      // Spriteset_Map.update (hooked by ShoraLighting)
      if (typeof Spriteset_Map !== 'undefined') wrapProto(Spriteset_Map, 'update', 'Spriteset_Map.update');

      // ----------------------------------------------------------------
      // CC_FontTexture diagnostic: verify the tinted-atlas composite.
      // colored() tints via multiply + destination-in on a 2D canvas; if
      // either op misbehaves in the shim the whole atlas stays opaque and
      // every glyph gets a solid color box behind it. A correct atlas is
      // mostly transparent, so report the opaque-pixel ratio + corner pixel
      // (corner should be alpha 0) once per generated bitmap.
      // ----------------------------------------------------------------
      if (!globalThis.__sonarCCFontDebug && typeof CC !== "undefined" &&
          CC.FontTexture && typeof CC.FontTexture.colored === "function" &&
          typeof Bitmap !== "undefined") {
        globalThis.__sonarCCFontDebug = true;
        const origColored = CC.FontTexture.colored;
        CC.FontTexture.colored = function (font, color) {
          const b = origColored.apply(this, arguments);
          if (b && b.canvas && !b.__sonarDumped) {
            b.__sonarDumped = true;
            try {
              const ctx2d = b.context;
              const w = b.width, h = b.height;
              const d = ctx2d.getImageData(0, 0, w, h).data;
              let opaque = 0, total = w * h;
              for (let i = 3; i < d.length; i += 4) if (d[i] === 255) opaque++;
              print("[CC_FontTexture] atlas " + font + " color=" + color +
                    " " + w + "x" + h +
                    " opaqueRatio=" + (opaque / total).toFixed(3) +
                    " corner=[" + d[0] + "," + d[1] + "," + d[2] + "," + d[3] + "]");
            } catch (e) {
              print("[CC_FontTexture] diag error: " + e);
            }
          }
          return b;
        };

        print("[shims.js] CC_FontTexture diagnostic installed");
      }

      if (typeof SceneManager !== 'undefined' && typeof PIXI !== 'undefined' && typeof Scene_Base !== 'undefined') {
        rmmzPatched = true;
        print("[shims.js] RMMZ/PixiJS Tracy profiling hooks installed." +
              " incremental=" + (Tilemap && Tilemap.prototype.__tracyIncremental ? "ON" : "OFF") +
              " env=" + JSON.stringify(native.getEnv ? native.getEnv("SONAR_TILEMAP_INCREMENTAL") : null));
      }
    };
  }

  // ----------------------------------------------------------------
  // Events
  // ----------------------------------------------------------------
  function EventShim(type, opts) {
    opts = opts || {};
    this.type = type;
    this.bubbles = !!opts.bubbles;
    this.cancelable = !!opts.cancelable;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
  }
  EventShim.prototype.preventDefault = function () { this.defaultPrevented = true; };
  EventShim.prototype.stopPropagation = function () {};
  EventShim.prototype.stopImmediatePropagation = function () {};

  function KeyboardEventShim(type, opts) {
    opts = opts || {};
    EventShim.call(this, type, opts);
    this.keyCode = opts.keyCode || 0;
    this.key = opts.key || "";
    this.code = opts.code || "";
    this.repeat = !!opts.repeat;
    this.ctrlKey = !!opts.ctrlKey;
    this.shiftKey = !!opts.shiftKey;
    this.altKey = !!opts.altKey;
    this.metaKey = !!opts.metaKey;
  }
  KeyboardEventShim.prototype = Object.create(EventShim.prototype);

  function MouseEventShim(type, opts) {
    opts = opts || {};
    EventShim.call(this, type, opts);
    this.clientX = opts.clientX || 0;
    this.clientY = opts.clientY || 0;
    this.button = opts.button || 0;
    this.buttons = opts.buttons || 0;
  }
  MouseEventShim.prototype = Object.create(EventShim.prototype);

  function WheelEventShim(type, opts) {
    opts = opts || {};
    MouseEventShim.call(this, type, opts);
    this.deltaX = opts.deltaX || 0;
    this.deltaY = opts.deltaY || 0;
    this.deltaZ = opts.deltaZ || 0;
  }
  WheelEventShim.prototype = Object.create(MouseEventShim.prototype);

  globalThis.Event = EventShim;
  globalThis.KeyboardEvent = KeyboardEventShim;
  globalThis.MouseEvent = MouseEventShim;
  globalThis.WheelEvent = WheelEventShim;

  // ----------------------------------------------------------------
  // EventTarget
  // ----------------------------------------------------------------
  const listenersMap = new WeakMap();
  function EventTargetShim() {
    listenersMap.set(this, {});
  }
  EventTargetShim.prototype.addEventListener = function (type, cb) {
    const map = listenersMap.get(this);
    (map[type] = map[type] || []).push(cb);
  };
  EventTargetShim.prototype.removeEventListener = function (type, cb) {
    const map = listenersMap.get(this);
    if (!map[type]) return;
    map[type] = map[type].filter(function (f) { return f !== cb; });
  };
  EventTargetShim.prototype.dispatchEvent = function (evt) {
    evt.target = this;
    evt.currentTarget = this;
    const map = listenersMap.get(this);
    const cbs = map[evt.type];
    if (cbs) {
      for (let i = 0; i < cbs.length; i++) {
        try { cbs[i](evt); } catch (e) { print("[event error] " + e + (e && e.stack ? "\nStack:\n" + e.stack : "")); }
      }
    }
    const handler = this["on" + evt.type];
    if (typeof handler === "function") {
      try { handler(evt); } catch (e) { print("[event handler error] " + e + (e && e.stack ? "\nStack:\n" + e.stack : "")); }
    }
    return !evt.defaultPrevented;
  };

  // ----------------------------------------------------------------
  // DOM / Canvas / Image
  // ----------------------------------------------------------------
  function makeStyleObject() {
    return new Proxy({}, { set: function () { return true; }, get: function () { return ""; } });
  }

  // CanvasElementShim IS HTMLCanvasElement so instanceof checks work.
  // Must carry real _pixelData (an ArrayBuffer) sized to width*height*4, or
  // native_gl.c's is_image_like_source() rejects it and PixiJS canvas
  // uploads fall through to the raw-buffer branch, misreading format/type
  // (0x1908/0x1401) as width/height — that's the w=6408 h=5121 in the log.
  function CanvasElementShim(width, height) {
    EventTargetShim.call(this);
    this._width = width || 0;
    this._height = height || 0;
    this.style = makeStyleObject();
    this._allocPixels();
  }
  CanvasElementShim.prototype = Object.create(EventTargetShim.prototype);
  CanvasElementShim.prototype._allocPixels = function () {
    const n = this._width * this._height * 4;
    if (n > 0) {
      this._pixelData = new ArrayBuffer(n);
      new Uint8Array(this._pixelData).fill(0);
    } else {
      this._pixelData = null;
    }
  };
  // width/height as accessors so resizing the canvas reallocates its
  // backing buffer; _pixelData stays in sync with the reported dimensions.
  Object.defineProperty(CanvasElementShim.prototype, "width", {
    get: function () { return this._width; },
    set: function (v) { this._width = v >>> 0; this._allocPixels(); },
  });
  Object.defineProperty(CanvasElementShim.prototype, "height", {
    get: function () { return this._height; },
    set: function (v) { this._height = v >>> 0; this._allocPixels(); },
  });
// ----------------------------------------------------------------
  // CanvasRenderingContext2D — a real software rasterizer that draws into
  // the canvas's _pixelData ArrayBuffer (so the WebGL texImage2D image-src
  // upload path picks it up). RMMZ renders every window, menu item and
  // text string onto a 2D canvas; with the old all-noop stub those canvases
  // stayed blank, which is why only the window-skin frame (an image
  // texture) was visible. Text glyphs come from native.rasterizeText
  // (stb_truetype). Solid fills, linear gradients, transforms, paths,
  // image blits and get/putImageData are implemented.
  // ----------------------------------------------------------------
  function parseColor(str) {
    if (str && typeof str === "object" && str.__gradient) return str;
    if (typeof str !== "string") return { r: 0, g: 0, b: 0, a: 255 };
    const s = str.trim().toLowerCase();
    if (s[0] === "#") {
      let hex = s.slice(1);
      if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
      const n = parseInt(hex, 16);
      if (!isNaN(n)) return { r:(n>>16)&255, g:(n>>8)&255, b:n&255, a:255 };
    }
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(",").map(function (x) { return parseFloat(x); });
      const r = parts[0]|0, g = parts[1]|0, b = parts[2]|0;
      const a = parts.length > 3 ? Math.round(parts[3] * 255) : 255;
      return { r: r, g: g, b: b, a: a };
    }
    const named = { black:[0,0,0], white:[255,255,255], gray:[128,128,128],
      grey:[128,128,128], transparent:[0,0,0,0], red:[255,0,0], green:[0,128,0],
      blue:[0,0,255], yellow:[255,255,0] };
    if (named[s]) return { r:named[s][0], g:named[s][1], b:named[s][2],
      a:named[s][3] !== undefined ? named[s][3] : 255 };
    return { r: 0, g: 0, b: 0, a: 255 };
  }

  function parseFont(fontStr) {
    const s = String(fontStr || "");
    let size = 12, bold = false, family = "sans-serif";
    let m = s.match(/(\d+(?:\.\d+)?)px/);
    if (m) size = parseFloat(m[1]);
    if (/\bbold\b/i.test(s)) bold = true;
    m = s.match(/px\s*([^;]*)$/);
    if (m) {
      const f = m[1].replace(/["']/g, "").trim().split(",")[0].trim();
      if (f) family = f;
    }
    return { size: size, bold: bold, family: family };
  }

  function makeGradient(x0, y0, x1, y1) {
    const stops = [];
    return {
      __gradient: true, x0: x0, y0: y0, x1: x1, y1: y1,
      addColorStop: function (offset, color) {
        stops.push({ offset: offset, color: parseColor(color) });
        stops.sort(function (a, b) { return a.offset - b.offset; });
      },
      colorAt: function (t) {
        if (!stops.length) return { r: 0, g: 0, b: 0, a: 255 };
        if (t <= 0) return stops[0].color;
        if (t >= 1) return stops[stops.length - 1].color;
        for (let i = 0; i < stops.length - 1; i++) {
          const s0 = stops[i], s1 = stops[i + 1];
          if (t >= s0.offset && t <= s1.offset) {
            const f = (t - s0.offset) / ((s1.offset - s0.offset) || 1);
            const c0 = s0.color, c1 = s1.color;
            return { r:c0.r+(c1.r-c0.r)*f, g:c0.g+(c1.g-c0.g)*f,
                     b:c0.b+(c1.b-c0.b)*f, a:c0.a+(c1.a-c0.a)*f };
          }
        }
        return { r: 0, g: 0, b: 0, a: 255 };
      },
    };
  }

  function Canvas2DContextShim(canvas) {
    this._canvas = canvas;
    this.fillStyle = "#000";
    this.strokeStyle = "#000";
    this.font = "10px sans-serif";
    this.textAlign = "left";
    this.textBaseline = "alphabetic";
    this.globalAlpha = 1;
    this.globalCompositeOperation = "source-over";
    this.lineWidth = 1;
    this._transform = { a:1, b:0, c:0, d:1, e:0, f:0 };
    this._stack = [];
    this._path = [];
    this._pixview = null;
    this._pixviewBuf = null;
  }

  Canvas2DContextShim.prototype._pix = function () {
    // Cache the view by ArrayBuffer IDENTITY, not byte length — the prior
    // bug here (see history) was caching by byte-length, which silently
    // kept using a stale view when _allocPixels() replaced the buffer with
    // a new one of the SAME length (e.g. a window resizing back to a size
    // it was already at). Comparing the buffer reference itself catches
    // every replacement, same-length or not, while still letting repeated
    // _pix() calls within a frame skip re-wrapping the buffer.
    if (!this._canvas._pixelData) this._canvas._allocPixels();
    const buf = this._canvas._pixelData;
    if (this._pixview && this._pixviewBuf === buf) return this._pixview;
    this._pixview = new Uint8ClampedArray(buf);
    this._pixviewBuf = buf;
    return this._pixview;
  };

  Canvas2DContextShim.prototype._apply = function (x, y) {
    const t = this._transform;
    return [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
  };
  Canvas2DContextShim.prototype._inverse = function () {
    const t = this._transform;
    const det = t.a * t.d - t.c * t.b;
    if (det === 0) return { a:1, b:0, c:0, d:1, e:0, f:0 };
    const ia = t.d / det, ib = -t.b / det, ic = -t.c / det, id = t.a / det;
    return { a:ia, b:ib, c:ic, d:id, e:-(ia*t.e+ic*t.f), f:-(ib*t.e+id*t.f) };
  };
  Canvas2DContextShim.prototype._blendPixel = function (data, x, y, r, g, b, a) {
    const W = this._canvas.width;
    const idx = (y * W + x) * 4;
    const op = this.globalCompositeOperation;
    // NOTE: a zero-alpha source pixel must NOT early-return for
    // "destination-in" — erasing the dest (k = sA * dA = 0) IS its job.
    // CC_FontTexture's atlas masking depends on it.
    if (a <= 0 && op !== "destination-in") return;

    // "multiply": co = aS*aB*B(Cb,Cs) + aS*(1-aB)*Cs + aB*(1-aS)*Cb,
    //              ao = aS + aB*(1-aS). Opaque source replaces like normal;
    //              over transparent dest regions the source shows through,
    //              and overlapping region is componentwise multiplied.
    if (op === "multiply") {
      const sA = a / 255, dA = data[idx + 3] / 255;
      const oA = sA + dA * (1 - sA);
      if (oA <= 0) { data[idx] = data[idx+1] = data[idx+2] = data[idx+3] = 0; return; }
      const sR = r / 255, sG = g / 255, sB = b / 255;
      const dR = data[idx] / 255, dG = data[idx + 1] / 255, dB = data[idx + 2] / 255;
      const mix = function (cs, cb) { return sA * dA * cs * cb + sA * (1 - dA) * cs + dA * (1 - sA) * cb; };
      data[idx]     = Math.round(mix(sR, dR) / oA * 255);
      data[idx + 1] = Math.round(mix(sG, dG) / oA * 255);
      data[idx + 2] = Math.round(mix(sB, dB) / oA * 255);
      data[idx + 3] = Math.round(oA * 255);
      return;
    }

    // "destination-in": keep dest only where the source has alpha,
    // scaled by the source alpha. Everything else becomes transparent.
    if (op === "destination-in") {
      const k = (a / 255) * (data[idx + 3] / 255);
      data[idx]     = Math.round(data[idx]     * k);
      data[idx + 1] = Math.round(data[idx + 1] * k);
      data[idx + 2] = Math.round(data[idx + 2] * k);
      data[idx + 3] = Math.round(k * 255);
      return;
    }

    const sa = a / 255, dA = data[idx + 3] / 255;
    const oa = sa + dA * (1 - sa);
    if (oa <= 0) { data[idx] = r; data[idx+1] = g; data[idx+2] = b; data[idx+3] = a; return; }
    data[idx]     = Math.round((r * sa + data[idx]     * dA * (1 - sa)) / oa);
    data[idx + 1] = Math.round((g * sa + data[idx + 1] * dA * (1 - sa)) / oa);
    data[idx + 2] = Math.round((b * sa + data[idx + 2] * dA * (1 - sa)) / oa);
    data[idx + 3] = Math.round(oa * 255);
  };
  Canvas2DContextShim.prototype._colorAt = function (lx, ly) {
    const fs = this.fillStyle;
    if (fs && fs.__gradient) {
      const g = fs, dx = g.x1 - g.x0, dy = g.y1 - g.y0, len2 = dx * dx + dy * dy;
      let t = 0;
      if (len2 > 0) t = ((lx - g.x0) * dx + (ly - g.y0) * dy) / len2;
      return g.colorAt(t);
    }
    const c = parseColor(fs);
    return { r: c.r, g: c.g, b: c.b, a: c.a };
  };

  // Fast 32-bit RGBA row-copy / alpha blitter
  Canvas2DContextShim.prototype._blit = function (srcData, sw, sh, x, y, dw, dh) {
    if (!dw || !dh || sw <= 0 || sh <= 0) return;
    const destBuf = this._pix();
    const W = this._canvas.width;
    const H = this._canvas.height;
    const t = this._transform;
    const alpha = this.globalAlpha;

    // FAST PATH: Identity or pure translation with 1:1 scale (e.g. Bitmap.snap, drawImage)
    if (t.a === 1 && t.b === 0 && t.c === 0 && t.d === 1 && dw === sw && dh === sh) {
      const dx = Math.round(x + t.e);
      const dy = Math.round(y + t.f);
      const sx0 = Math.max(0, -dx);
      const sy0 = Math.max(0, -dy);
      const sx1 = Math.min(sw, W - dx);
      const sy1 = Math.min(sh, H - dy);
      if (sx0 >= sx1 || sy0 >= sy1) return;

      const copyW = sx1 - sx0;
      const src32 = new Uint32Array(srcData.buffer, srcData.byteOffset, srcData.byteLength >> 2);
      const dst32 = new Uint32Array(destBuf.buffer, destBuf.byteOffset, destBuf.byteLength >> 2);

      if (alpha >= 0.999 && this.globalCompositeOperation === "source-over") {
        for (let row = sy0; row < sy1; row++) {
          const srcIdx = row * sw + sx0;
          const dstIdx = (dy + row) * W + (dx + sx0);
          dst32.set(src32.subarray(srcIdx, srcIdx + copyW), dstIdx);
        }
        return;
      }

      // CC_FontTexture compat: with "destination-in", a ZERO-alpha source
      // pixel must still erase the destination (k = sA * dA = 0). Skipping
      // sa==0 pixels here left the opaque color from the plugin's "multiply"
      // fillRect pass unmasked, rendering a solid colored box behind every
      // glyph drawn from its tinted atlas.
      for (let row = sy0; row < sy1; row++) {
        for (let col = sx0; col < sx1; col++) {
          const sidx = (row * sw + col) * 4;
          const sa = Math.round(srcData[sidx + 3] * alpha);
          if (sa > 0 || this.globalCompositeOperation === "destination-in") {
            this._blendPixel(destBuf, dx + col, dy + row, srcData[sidx], srcData[sidx + 1], srcData[sidx + 2], sa);
          }
        }
      }
      return;
    }

    // GENERAL PATH: Scaled or rotated drawing
    const inv = this._inverse();
    const minx = Math.max(0, Math.floor(x));
    const maxx = Math.min(W - 1, Math.ceil(x + dw));
    const miny = Math.max(0, Math.floor(y));
    const maxy = Math.min(H - 1, Math.ceil(y + dh));

    for (let yy = miny; yy <= maxy; yy++) {
      for (let xx = minx; xx <= maxx; xx++) {
        const lx = inv.a * xx + inv.c * yy + inv.e;
        const ly = inv.b * xx + inv.d * yy + inv.f;
        const ux = (lx - x) / dw;
        const uy = (ly - y) / dh;
        if (ux < 0 || ux >= 1 || uy < 0 || uy >= 1) continue;
        const si = (uy * sh) | 0;
        const sj = (ux * sw) | 0;
        const sidx = (si * sw + sj) * 4;
        const sa = srcData[sidx + 3];
        if (!sa && this.globalCompositeOperation !== "destination-in") continue;
        this._blendPixel(destBuf, xx, yy, srcData[sidx], srcData[sidx + 1], srcData[sidx + 2], Math.round(sa * alpha));
      }
    }
  };

  Canvas2DContextShim.prototype.fillRect = function (x, y, w, h) {
    if (w <= 0 || h <= 0) return;
    const t = this._transform;
    const data = this._pix();
    const W = this._canvas.width;
    const H = this._canvas.height;
    const alpha = this.globalAlpha;

    // FAST PATH: Identity or pure translation with solid fill
    if (t.a === 1 && t.b === 0 && t.c === 0 && t.d === 1 && (!this.fillStyle || !this.fillStyle.__gradient)) {
      const c = this._colorAt(0, 0);
      const ca = Math.round(c.a * alpha);
      if (ca <= 0) return;
      const x0 = Math.max(0, Math.floor(x + t.e));
      const y0 = Math.max(0, Math.floor(y + t.f));
      const x1 = Math.min(W, Math.ceil(x + w + t.e));
      const y1 = Math.min(H, Math.ceil(y + h + t.f));
      if (x0 >= x1 || y0 >= y1) return;

      const fillW = x1 - x0;
      const dst32 = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
      if (ca >= 255 && this.globalCompositeOperation === "source-over") {
        const pixel32 = (255 << 24) | (c.b << 16) | (c.g << 8) | c.r;
        for (let yy = y0; yy < y1; yy++) {
          const rowStart = yy * W + x0;
          dst32.fill(pixel32, rowStart, rowStart + fillW);
        }
      } else {
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            this._blendPixel(data, xx, yy, c.r, c.g, c.b, ca);
          }
        }
      }
      return;
    }

    // General transformed fill
    const corners = [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].map(p => this._apply(p[0], p[1]));
    const xs = corners.map(p => p[0]);
    const ys = corners.map(p => p[1]);
    const minx = Math.max(0, Math.floor(Math.min.apply(null, xs)));
    const maxx = Math.min(W - 1, Math.ceil(Math.max.apply(null, xs)));
    const miny = Math.max(0, Math.floor(Math.min.apply(null, ys)));
    const maxy = Math.min(H - 1, Math.ceil(Math.max.apply(null, ys)));
    const inv = this._inverse();
    for (let yy = miny; yy <= maxy; yy++) {
      for (let xx = minx; xx <= maxx; xx++) {
        const lx = inv.a * xx + inv.c * yy + inv.e;
        const ly = inv.b * xx + inv.d * yy + inv.f;
        if (lx >= x && lx < x + w && ly >= y && ly < y + h) {
          const c = this._colorAt(lx, ly);
          this._blendPixel(data, xx, yy, c.r, c.g, c.b, Math.round(c.a * alpha));
        }
      }
    }
  };
  Canvas2DContextShim.prototype.strokeRect = function (x, y, w, h) { this.fillRect(x, y, w, h); };
  Canvas2DContextShim.prototype.clearRect = function (x, y, w, h) {
    const data = this._pix(), W = this._canvas.width, H = this._canvas.height;
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(W - 1, Math.ceil(x + w)), y1 = Math.min(H - 1, Math.ceil(y + h));
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const idx = (yy * W + xx) * 4;
        data[idx] = data[idx+1] = data[idx+2] = data[idx+3] = 0;
      }
    }
  };

  // ----------------------------------------------------------------
  // Text rendering caches. RMMZ redraws HUD numbers, menu labels, and
  // window contents very frequently, often with unchanged text — and
  // separately calls measureText many times per frame during word-wrap.
  // Without caching, every one of those calls crossed into native code
  // and re-ran stb_truetype (measureText was even doing a FULL glyph
  // bitmap rasterization just to read the width off the result — see
  // the native.measureText split below). Bounded so a message window's
  // scrolling/typewriter text (which produces many one-off strings)
  // can't grow these unboundedly; oldest entry is evicted on overflow,
  // and a cache hit re-inserts to move it to the MRU end.
  function makeBoundedCache(maxSize) {
    const map = new Map();
    return {
      get: function (key) {
        if (!map.has(key)) return undefined;
        const v = map.get(key);
        map.delete(key);
        map.set(key, v);
        return v;
      },
      set: function (key, value) {
        if (map.has(key)) map.delete(key);
        map.set(key, value);
        if (map.size > maxSize) {
          map.delete(map.keys().next().value);
        }
      }
    };
  }
  // Rasterized glyph bitmaps (bigger entries, smaller cap).
  const _textRasterCache = makeBoundedCache(600);
  // Measured widths (tiny entries, can hold a lot more).
  const _textMeasureCache = makeBoundedCache(4000);

  Canvas2DContextShim.prototype.fillText = function (text, x, y) {
    const f = parseFont(this.font), c = parseColor(this.fillStyle);
    const key = String(text) + "\u0001" + f.family + "\u0001" + f.size + "\u0001" + f.bold + "\u0001" + c.r + "," + c.g + "," + c.b + "," + c.a;
    let bmp = _textRasterCache.get(key);
    if (bmp === undefined) {
      bmp = native.rasterizeText(String(text), f.family, f.size, f.bold, c.r, c.g, c.b, c.a);
      _textRasterCache.set(key, bmp);
    }
    if (!bmp) return;
    let px = x, py = y;
    if (this.textAlign === "center") px = x - bmp.width / 2;
    else if (this.textAlign === "right" || this.textAlign === "end") px = x - bmp.width;
    if (this.textBaseline === "top" || this.textBaseline === "hanging") py = y;
    else if (this.textBaseline === "middle") py = y - bmp.height / 2;
    else if (this.textBaseline === "bottom" || this.textBaseline === "ideographic") py = y - bmp.height;
    else py = y - bmp.ascent; // alphabetic
    this._blit(new Uint8ClampedArray(bmp.data), bmp.width, bmp.height, px, py, bmp.width, bmp.height);
  };
  Canvas2DContextShim.prototype.strokeText = function (text, x, y) {
    const f = parseFont(this.font);
    const c = parseColor(this.strokeStyle);
    const lw = Math.max(1, Math.round(this.lineWidth || 1));
    const key = String(text) + "\u0001" + f.family + "\u0001" + f.size + "\u0001" + f.bold + "\u0001" + c.r + "," + c.g + "," + c.b + "," + c.a;
    let bmp = _textRasterCache.get(key);
    if (bmp === undefined) {
      bmp = native.rasterizeText(String(text), f.family, f.size, f.bold, c.r, c.g, c.b, c.a);
      _textRasterCache.set(key, bmp);
    }
    if (!bmp) return;
    let px = x, py = y;
    if (this.textAlign === "center") px = x - bmp.width / 2;
    else if (this.textAlign === "right" || this.textAlign === "end") px = x - bmp.width;
    if (this.textBaseline === "top" || this.textBaseline === "hanging") py = y;
    else if (this.textBaseline === "middle") py = y - bmp.height / 2;
    else if (this.textBaseline === "bottom" || this.textBaseline === "ideographic") py = y - bmp.height;
    else py = y - bmp.ascent;
    const src = new Uint8ClampedArray(bmp.data);
    for (let dy = -lw; dy <= lw; dy++) {
      for (let dx = -lw; dx <= lw; dx++) {
        if (dx !== 0 || dy !== 0) {
          this._blit(src, bmp.width, bmp.height, px + dx, py + dy, bmp.width, bmp.height);
        }
      }
    }
  };
  Canvas2DContextShim.prototype.measureText = function (text) {
    const f = parseFont(this.font);
    const key = String(text) + "\u0001" + f.family + "\u0001" + f.size + "\u0001" + f.bold;
    let w = _textMeasureCache.get(key);
    if (w === undefined) {
      // Lightweight width-only native call — does NOT rasterize glyph
      // bitmaps (see native.measureText in main.c). Previously this called
      // native.rasterizeText, which fully rendered every glyph just to
      // read bmp.width off the result and discard the pixels.
      const m = native.measureText(String(text), f.family, f.size, f.bold);
      w = m ? m.width : 0;
      _textMeasureCache.set(key, w);
    }
    return { width: w };
  };

  Canvas2DContextShim.prototype.drawImage = function (img) {
    if (!img || !img._pixelData) return;
    const iw = img.width || 0, ih = img.height || 0;
    if (!iw || !ih) return;
    const fullSrc = new Uint8ClampedArray(img._pixelData);
    const args = Array.prototype.slice.call(arguments, 1);

    if (args.length >= 8) {
      // 9-arg cropped form: drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
      // Crop the requested source rect out of the full image buffer into a
      // tightly-packed buffer, then hand that off to the existing _blit
      // (which only knows how to blit a whole buffer starting at 0,0).
      // Without this, the crop was silently ignored and the entire source
      // image (e.g. a full font atlas) got stamped into every glyph cell.
      const sx = args[0] | 0, sy = args[1] | 0, sw = args[2] | 0, sh = args[3] | 0;
      const dx = args[4], dy = args[5], dw = args[6], dh = args[7];
      if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;

      // Clamp the source rect to the actual image bounds (handles both a
      // negative sx/sy and a crop that runs past the image's far edge —
      // e.g. the last glyph cell packed against the right edge of an atlas).
      const clippedSx = Math.max(0, sx);
      const clippedSy = Math.max(0, sy);
      const clippedEx = Math.min(iw, sx + sw);
      const clippedEy = Math.min(ih, sy + sh);
      const cw = clippedEx - clippedSx;
      const ch = clippedEy - clippedSy;
      if (cw <= 0 || ch <= 0) return;

      const cropped = new Uint8ClampedArray(cw * ch * 4);
      for (let row = 0; row < ch; row++) {
        const srcOff = ((clippedSy + row) * iw + clippedSx) * 4;
        const dstOff = row * cw * 4;
        cropped.set(fullSrc.subarray(srcOff, srcOff + cw * 4), dstOff);
      }

      // If the crop got clipped against an image edge, shrink/offset the
      // dest rect proportionally instead of stretching the smaller cropped
      // chunk to fill the originally-requested dest size — that stretch is
      // what produces smeared/doubled-looking glyphs at atlas edges.
      const scaleX = dw / sw, scaleY = dh / sh;
      const outDx = dx + (clippedSx - sx) * scaleX;
      const outDy = dy + (clippedSy - sy) * scaleY;
      const outDw = cw * scaleX;
      const outDh = ch * scaleY;

      this._blit(cropped, cw, ch, outDx, outDy, outDw, outDh);
      return;
    }

    let dx, dy, dw, dh;
    if (args.length >= 4) { dx = args[0]; dy = args[1]; dw = args[2]; dh = args[3]; }
    else { dx = args[0]; dy = args[1]; dw = iw; dh = ih; }
    this._blit(fullSrc, iw, ih, dx, dy, dw, dh);
  };

  Canvas2DContextShim.prototype.getImageData = function (x, y, w, h) {
    const data = this._pix(), W = this._canvas.width, H = this._canvas.height;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const sx = Math.floor(x) + xx, sy = Math.floor(y) + yy;
        const di = (yy * w + xx) * 4;
        if (sx >= 0 && sx < W && sy >= 0 && sy < H) {
          const si = (sy * W + sx) * 4;
          out[di] = data[si]; out[di+1] = data[si+1]; out[di+2] = data[si+2]; out[di+3] = data[si+3];
        }
      }
    }
    return { data: out, width: w, height: h };
  };
  Canvas2DContextShim.prototype.putImageData = function (img, x, y) {
    const data = this._pix(), W = this._canvas.width, H = this._canvas.height;
    const src = img.data;
    for (let yy = 0; yy < img.height; yy++) {
      for (let xx = 0; xx < img.width; xx++) {
        const sx = Math.floor(x) + xx, sy = Math.floor(y) + yy;
        if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
        const di = (sy * W + sx) * 4, si = (yy * img.width + xx) * 4;
        data[di] = src[si]; data[di+1] = src[si+1]; data[di+2] = src[si+2]; data[di+3] = src[si+3];
      }
    }
  };

  Canvas2DContextShim.prototype.save = function () {
    this._stack.push({ transform: Object.assign({}, this._transform), fillStyle: this.fillStyle,
      font: this.font, globalAlpha: this.globalAlpha, textAlign: this.textAlign,
      textBaseline: this.textBaseline });
  };
  Canvas2DContextShim.prototype.restore = function () {
    const s = this._stack.pop();
    if (!s) return;
    this._transform = s.transform; this.fillStyle = s.fillStyle; this.font = s.font;
    this.globalAlpha = s.globalAlpha; this.textAlign = s.textAlign; this.textBaseline = s.textBaseline;
  };
  Canvas2DContextShim.prototype.translate = function (x, y) {
    const t = this._transform;
    t.e += t.a * x + t.c * y; t.f += t.b * x + t.d * y;
  };
  Canvas2DContextShim.prototype.scale = function (x, y) {
    const t = this._transform;
    t.a *= x; t.b *= x; t.c *= y; t.d *= y;
  };
  Canvas2DContextShim.prototype.rotate = function (rad) {
    const c = Math.cos(rad), s = Math.sin(rad), t = this._transform;
    const a = t.a, b = t.b, cc = t.c, d = t.d;
    t.a = a * c + cc * s; t.b = b * c + d * s;
    t.c = -a * s + cc * c; t.d = -b * s + d * c;
  };
  Canvas2DContextShim.prototype.setTransform = function (a, b, c, d, e, f) {
    this._transform = { a: a, b: b, c: c, d: d, e: e, f: f };
  };
  Canvas2DContextShim.prototype.resetTransform = function () {
    this._transform = { a:1, b:0, c:0, d:1, e:0, f:0 };
  };

  Canvas2DContextShim.prototype.beginPath = function () { this._path = []; };
  Canvas2DContextShim.prototype.closePath = function () {};
  Canvas2DContextShim.prototype.moveTo = function (x, y) { this._path.push([[x, y]]); };
  Canvas2DContextShim.prototype.lineTo = function (x, y) {
    if (this._path.length) this._path[this._path.length - 1].push([x, y]);
  };
  Canvas2DContextShim.prototype.rect = function (x, y, w, h) {
    this._path.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
  };
  Canvas2DContextShim.prototype.arc = function (x, y, radius, startAngle, endAngle, counterclockwise) {
    if (radius <= 0) return;
    const sweep = endAngle - startAngle;
    const n = Math.max(16, Math.ceil(Math.abs(sweep) * radius / 2));
    const step = sweep / n;
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = startAngle + i * step;
      pts.push([x + Math.cos(a) * radius, y + Math.sin(a) * radius]);
    }
    if (!this._path.length) {
      this._path.push(pts);
    } else {
      const curr = this._path[this._path.length - 1];
      for (let i = 0; i < pts.length; i++) curr.push(pts[i]);
    }
  };
  Canvas2DContextShim.prototype.ellipse = function (x, y, radiusX, radiusY, rotation, startAngle, endAngle, counterclockwise) {
    if (radiusX <= 0 || radiusY <= 0) return;
    const sweep = endAngle - startAngle;
    const n = Math.max(16, Math.ceil(Math.abs(sweep) * Math.max(radiusX, radiusY) / 2));
    const step = sweep / n;
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = startAngle + i * step;
      const lx = Math.cos(a) * radiusX;
      const ly = Math.sin(a) * radiusY;
      pts.push([x + lx * cosR - ly * sinR, y + lx * sinR + ly * cosR]);
    }
    if (!this._path.length) {
      this._path.push(pts);
    } else {
      const curr = this._path[this._path.length - 1];
      for (let i = 0; i < pts.length; i++) curr.push(pts[i]);
    }
  };
  Canvas2DContextShim.prototype.quadraticCurveTo = function (cpx, cpy, x, y) {
    const curr = this._path.length ? this._path[this._path.length - 1] : null;
    const fromX = curr && curr.length ? curr[curr.length - 1][0] : 0;
    const fromY = curr && curr.length ? curr[curr.length - 1][1] : 0;
    const n = 16;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const inv = 1 - t;
      const px = inv * inv * fromX + 2 * inv * t * cpx + t * t * x;
      const py = inv * inv * fromY + 2 * inv * t * cpy + t * t * y;
      this.lineTo(px, py);
    }
  };
  Canvas2DContextShim.prototype.bezierCurveTo = function (cp1x, cp1y, cp2x, cp2y, x, y) {
    const curr = this._path.length ? this._path[this._path.length - 1] : null;
    const fromX = curr && curr.length ? curr[curr.length - 1][0] : 0;
    const fromY = curr && curr.length ? curr[curr.length - 1][1] : 0;
    const n = 20;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const inv = 1 - t;
      const px = inv * inv * inv * fromX + 3 * inv * inv * t * cp1x + 3 * inv * t * t * cp2x + t * t * t * x;
      const py = inv * inv * inv * fromY + 3 * inv * inv * t * cp1y + 3 * inv * t * t * cp2y + t * t * t * y;
      this.lineTo(px, py);
    }
  };
  Canvas2DContextShim.prototype.clip = function () {};
  Canvas2DContextShim.prototype.isPointInPath = function () { return true; };
  Canvas2DContextShim.prototype.setLineDash = function () {};
  Canvas2DContextShim.prototype.getLineDash = function () { return []; };
  Canvas2DContextShim.prototype._fillPath = function () {
    const data = this._pix(), W = this._canvas.width, H = this._canvas.height;
    const alpha = this.globalAlpha;
    for (let p = 0; p < this._path.length; p++) {
      const poly = this._path[p];
      if (poly.length < 2) continue;
      const pts = poly.map(function (pt) { return this._apply(pt[0], pt[1]); }, this);
      const ys = pts.map(function (pt) { return pt[1]; });
      const miny = Math.max(0, Math.floor(Math.min.apply(null, ys)));
      const maxy = Math.min(H - 1, Math.ceil(Math.max.apply(null, ys)));
      for (let yy = miny; yy <= maxy; yy++) {
        const xs = [];
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          if ((a[1] <= yy && b[1] > yy) || (b[1] <= yy && a[1] > yy)) {
            const t = (yy - a[1]) / ((b[1] - a[1]) || 1);
            xs.push(a[0] + t * (b[0] - a[0]));
          }
        }
        xs.sort(function (p, q) { return p - q; });
        const c = this._colorAt(0, 0);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const x0 = Math.max(0, Math.floor(xs[i]));
          const x1 = Math.min(W - 1, Math.ceil(xs[i + 1]));
          for (let xx = x0; xx <= x1; xx++) {
            this._blendPixel(data, xx, yy, Math.round(c.r), Math.round(c.g), Math.round(c.b),
                             Math.round(c.a * alpha));
          }
        }
      }
    }
  };
  Canvas2DContextShim.prototype.fill = function () { this._fillPath(); };
  Canvas2DContextShim.prototype.stroke = function () { this._fillPath(); };
  Canvas2DContextShim.prototype.createLinearGradient = function (x0, y0, x1, y1) {
    return makeGradient(x0, y0, x1, y1);
  };
  Canvas2DContextShim.prototype.createRadialGradient = function (x0, y0, r0, x1, y1, r1) {
    return makeGradient(x0, y0, x1, y1);
  };
  Canvas2DContextShim.prototype.createPattern = function () { return { __pattern: true }; };

CanvasElementShim.prototype.getContext = function (type) {
    if (type === "webgl2" || type === "webgl" || type === "experimental-webgl") {
      if (!native.gl.__protoSet__) {
        Object.setPrototypeOf(native.gl, WebGL2RenderingContext.prototype);
        WebGLRenderingContext.SCISSOR_TEST = native.gl.SCISSOR_TEST;
        WebGLRenderingContext.STENCIL_TEST = native.gl.STENCIL_TEST;

        // 1. Polyfill missing WebGL constants
        // Prevents PixiJS from falling back to its broken regex parser
        const glConstants = {
            ACTIVE_UNIFORMS: 0x8B86,
            ACTIVE_ATTRIBUTES: 0x8B89,
            LINK_STATUS: 0x8B82,
            COMPILE_STATUS: 0x8B81,
            TRANSFORM_FEEDBACK_VARYINGS: 0x8C83
        };
        for (const key in glConstants) {
            if (native.gl[key] === undefined) {
                native.gl[key] = glConstants[key];
            }
        }

        // 2. Wrap getActiveUniform/Attrib to fix C-bridge objects and strip Intel's \0 null byte
        const wrapActiveInfo = function(origFn) {
          if (!origFn) return null;
          return function(program, index) {
            const res = origFn.call(this, program, index);
            if (!res) return res;
            
            let fSize = res.size !== undefined ? res.size : res[0];
            let fType = res.type !== undefined ? res.type : res[1];
            let fName = res.name !== undefined ? res.name : res[2];
            
            // Return a brand-new JS object so string operations stick
            return {
              size: fSize,
              type: fType,
              name: String(fName || "").replace(/\0/g, '')
            };
          };
        };

        native.gl.getActiveUniform = wrapActiveInfo(native.gl.getActiveUniform) || native.gl.getActiveUniform;
        native.gl.getActiveAttrib = wrapActiveInfo(native.gl.getActiveAttrib) || native.gl.getActiveAttrib;

        // 3. Desktop OpenGL compatibility: safely strip 'precision' keywords
        const origShaderSource = native.gl.shaderSource;
        if (origShaderSource) {
            native.gl.shaderSource = function(shader, source) {
                let s = String(source || "");
                // Safely erase any line defining WebGL precision so Desktop GL accepts the shader
                s = s.replace(/precision\s+[^;]+;/g, "");
                return origShaderSource.call(this, shader, s);
            };
        }

        native.gl.__protoSet__ = true;
      }
      return native.gl;
    }
  
    if (type === "2d") {
      if (!this._ctx2d) this._ctx2d = new Canvas2DContextShim(this);
      return this._ctx2d;
    }
    return null;
  };
  globalThis.HTMLCanvasElement = CanvasElementShim;

  function ImageShim() {
    EventTargetShim.call(this);
    this.width = 0;
    this.height = 0;
    this._src = "";
    this.complete = false;
  }
  ImageShim.prototype = Object.create(EventTargetShim.prototype);
  Object.defineProperty(ImageShim.prototype, "src", {
    get: function () { return this._src; },
    set: function (value) {
      this._src = value;
      this.complete = false;
      const self = this;
      // Decode EAGERLY + synchronously so width/_pixelData are valid the
      // moment `img.src = ...` returns. Web/NW.js code assumes image
      // metadata is synchronously available; deferring a microtask produces
      // zero-size bitmaps at use time (text-atlas bakes cache garbage).
      // Only the `load` EVENT stays async, as onload-waiting code expects.
      const info = native.decodeImage(safePath(value));
      if (info) {
        self.width = info.width;
        self.height = info.height;
        self._pixelData = info.data;
        self.complete = true;
      } else {
        // CC_FontTexture compat: a failed decode previously left width=0 and
        // NO _pixelData, so every drawImage of this image silently no-oped.
        // The plugin's multiply fillRect then tinted an empty canvas,
        // producing the solid color box behind every glyph. Log it loudly
        // and keep going.
        print("[Shim] IMAGE DECODE FAILED: " + safePath(value) +
              " (drawImage of this image will be a no-op)");
        self.complete = true;
      }
      Promise.resolve().then(function () {
        if (!self._pixelData) {
          const evt = new EventShim("error");
          self.dispatchEvent(evt);
          if (self.onerror) self.onerror(evt);
          return;
        }
        const evt = new EventShim("load");
        self.dispatchEvent(evt);
        if (self.onload) self.onload(evt);
      });
    },
  });
  globalThis.Image = ImageShim;
  globalThis.HTMLImageElement = ImageShim;

  // HTMLVideoElement — RMMZ managers check for video support
  globalThis.HTMLVideoElement = function() {};
  globalThis.HTMLVideoElement.prototype = {};

  // FontFace — used by FontManager when loading custom fonts
  globalThis.FontFace = function(family, source) {
    this.family = family;
    this.source = source;
    this.loaded = Promise.resolve(this);
  };
  globalThis.FontFace.prototype.load = function() {
    return Promise.resolve(this);
  };

  // Generic DOM element — confirmed needed: main.js's showLoadingSpinner()
  // does document.createElement("div") then loadingSpinner.appendChild(...),
  // and the previous generic stub had no appendChild at all (TypeError: not
  // a function, per the traced stack). RMMZ's Graphics.js builds several
  // other elements the same way (FPS meter, mode box, canvas containers),
  // so this needs to be a real minimal element, not another one-off patch.
  function ElementShim(tag) {
    EventTargetShim.call(this);
    this.tagName = String(tag || "div").toUpperCase();
    this.style = makeStyleObject();
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this._attributes = {};
    this.className = "";
    this._innerHTML = "";
    this.textContent = "";
    // Confirmed needed: Video._onLoad/_onUserGesture/_onError treat this
    // element as a real HTMLVideoElement (.play(), .load(), .paused,
    // .src, .volume). We don't decode/play actual video, so these are
    // inert stubs — enough that RMMZ's video-gesture-unlock and movie
    // playback code paths don't throw "play is not a function" on every
    // keydown/mousedown/touchend once Video.initialize() creates its
    // <video> element via document.createElement("video").
    this.paused = true;
    this.volume = 1;
    this.src = "";
  }
  ElementShim.prototype = Object.create(EventTargetShim.prototype);
  ElementShim.prototype.play = function () {
    this.paused = false;
    return Promise.resolve();
  };
  ElementShim.prototype.pause = function () {
    this.paused = true;
  };
  ElementShim.prototype.load = function () {};
  ElementShim.prototype.canPlayType = function (type) {
    return ""; // Safely fallback to VorbisDecoder/WebAudio logic
  };
  // Confirmed via real RMMZ source: Graphics.printError() writes the
  // actual error name+message into _errorPrinter.innerHTML, intended to
  // render visibly on-screen in a real browser. We don't render DOM
  // content, so that text was being silently dropped — only the separate
  // console.error(e.stack) call (stack frames, no message) was ever
  // reaching our logs. Surfacing innerHTML writes through print() closes
  // that gap generally, not just for this one error path.
  Object.defineProperty(ElementShim.prototype, "innerHTML", {
    get: function () { return this._innerHTML; },
    set: function (value) {
      this._innerHTML = value;
      if (value) print("[innerHTML] " + value);
    }
  });
  ElementShim.prototype.appendChild = function (child) {
    this.children.push(child);
    child.parentNode = this;
    if (child && child.tagName === "SCRIPT" && child.src) {
      loadAndEvalScript(child);
    }
    return child;
  };
  ElementShim.prototype.removeChild = function (child) {
    const i = this.children.indexOf(child);
    if (i !== -1) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  };
  ElementShim.prototype.insertBefore = function (child, ref) {
    const i = this.children.indexOf(ref);
    if (i === -1) this.children.push(child);
    else this.children.splice(i, 0, child);
    child.parentNode = this;
    if (child && child.tagName === "SCRIPT" && child.src) {
      loadAndEvalScript(child);
    }
    return child;
  };
  ElementShim.prototype.setAttribute = function (name, value) {
    this._attributes[name] = String(value);
  };
  ElementShim.prototype.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(this._attributes, name) ? this._attributes[name] : null;
  };
  // Confirmed needed: Graphics._disableContextMenu() calls
  // document.body.getElementsByTagName("*") during Graphics.initialize(),
  // unconditionally and outside any try/catch. We don't maintain a real
  // DOM tree to walk, and the only thing the caller does with the result
  // is set oncontextmenu = false on each element, so an empty list is a
  // safe, side-effect-free stand-in.
  ElementShim.prototype.getElementsByTagName = function (tag) {
    return [];
  };
  ElementShim.prototype.removeAttribute = function (name) {
    delete this._attributes[name];
  };
  ElementShim.prototype.focus = function () {};
  ElementShim.prototype.blur = function () {};

  // ----------------------------------------------------------------
  // Dynamic Plugin & Script Loader
  // ----------------------------------------------------------------
  // RMMZ's PluginManager.loadScript creates a <script src="..."> element and
  // appends it to document.body. In a real browser that triggers a fetch +
  // global eval; our element stubs previously did nothing, so plugin .js
  // files under js/plugins/ were never executed. When a SCRIPT element with
  // a src is attached, read the file via native.readFile and eval it in the
  // global scope, firing onload/onerror like a browser would.
  // Real <script> tags don't scope top-level var into a local eval frame
  // based on their own "use strict" directive — only indirect eval() does
  // that. Since plugins are executed via indirect eval() here (not a native
  // per-script JS_Eval with global scope type), a leading "use strict"
  // silently breaks any plugin that expects its top-level var declarations
  // to land on the global object, which several plugin authors' namespace
  // patterns rely on (e.g. "var Eli = Eli || {}" shared across a plugin
  // family). Stripping the directive keeps eval's scoping behavior matching
  // what a real browser <script> tag would actually do.
  function stripLeadingUseStrict(src) {
    // Scan linearly past BOM, whitespace, and leading // and /* */ comments
    // (a quantifier-heavy regex like /^(...)*\s*(['"])use strict\2;?/ can
    // catastrophically backtrack on large plugin sources and hang the eval).
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n' ||
          c === '\f' || c === '\v' || c === '\ufeff') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') {
        i += 2;
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        i = end === -1 ? n : end + 2;
        continue;
      }
      break;
    }
    const m = /^(['"])(use strict)\1;?/.exec(src.slice(i));
    if (!m) return src;
    return src.slice(0, i) + src.slice(i + m[0].length);
  }
  function loadAndEvalScript(scriptElem) {
    if (!scriptElem || !scriptElem.src || scriptElem._executed) return;
    scriptElem._executed = true;
    const url = safePath(scriptElem.src);
    // WASM-wrapped libraries are inert by design here: effekseer.min.js and
    // vorbisdecoder.js are Emscripten modules whose bootstrap runs the WebAssembly
    // function table. Our native stack handles particles (effekseer stub below)
    // and Ogg audio (miniaudio) directly, so evaluating them would only crash on
    // their internal func.apply. Skip them but still fire onload so main.js's
    // loadCount/PluginManager.setup sequencing is unaffected.
    if (url.indexOf("effekseer.min.js") !== -1 || url.indexOf("vorbisdecoder.js") !== -1) {
      if (scriptElem.onload) scriptElem.onload();
      return;
    }
    const code = native.readFile(url);
    if (code) {
      // document.currentScript must point at the script currently executing.
      // Real browsers set this during script evaluation, and many plugins
      // (EliMZ_Book, PluginCommonBase, etc.) derive their own plugin name
      // from document.currentScript.src. A stale value here makes those
      // plugins read the wrong name and get {} back from
      // PluginManager.parameters(), which then crashes on JSON.parse(undefined).
      const prevCurrentScript = document.currentScript;
      document.currentScript = scriptElem;
      let evalError = null;
      try {
        const evalFn = globalThis.eval || eval;
        // sourceURL gives real file names in QuickJS stack traces instead of <input>
        evalFn(stripLeadingUseStrict(code) + "\n//# sourceURL=" + url);
      } catch (e) {
        evalError = e;
      } finally {
        document.currentScript = prevCurrentScript;
      }
      if (evalError) {
        print("[Plugin Error in " + url + "]: " + evalError + (evalError && evalError.stack ? "\n" + evalError.stack : ""));
        if (scriptElem.onerror) scriptElem.onerror(evalError);
      } else {
        print("[Plugin OK]: " + url);
        if (scriptElem.onload) scriptElem.onload();
      }
    } else {
      print("[Plugin Not Found]: " + url);
      if (scriptElem.onerror) scriptElem.onerror(new Error("File not found: " + url));
    }
  }

  const documentShim = Object.create(EventTargetShim.prototype);
  // Confirmed root cause of the "load" crash: Object.create() gives
  // documentShim the EventTargetShim methods via the prototype chain, but
  // never runs the EventTargetShim *constructor*, which is the only place
  // listenersMap.set(this, {}) happens. Same issue applies to globalThis
  // below (wired via .bind() instead of inheritance, same gap). Without
  // this, listenersMap.get(document/window) is undefined and the first
  // addEventListener call on either throws.
  EventTargetShim.call(documentShim);
  Object.assign(documentShim, {
    createElement: function (tag) {
      const t = String(tag).toLowerCase();
      if (t === "canvas") return new CanvasElementShim(0, 0);
      return new ElementShim(t);
    },
    body: new ElementShim("body"),
    head: new ElementShim("head"),
    documentElement: new ElementShim("html"),
    getElementById: function () { return null; },
    hasFocus: function () { return true; },
    currentScript: { src: "js/libs/vorbisdecoder.js" },
    fonts: {
      add: function(font) {},
      delete: function(font) {},
      clear: function() {},
      load: function() { return Promise.resolve([]); },
      ready: Promise.resolve()
    }
  });
  globalThis.document = documentShim;
  documentShim.body.clientWidth = 1280;
  documentShim.body.clientHeight = 720;
  documentShim.dispatchEvent = EventTargetShim.prototype.dispatchEvent.bind(documentShim);
  documentShim.addEventListener = EventTargetShim.prototype.addEventListener.bind(documentShim);
  documentShim.removeEventListener = EventTargetShim.prototype.removeEventListener.bind(documentShim);

  EventTargetShim.call(globalThis);
  globalThis.addEventListener = EventTargetShim.prototype.addEventListener.bind(globalThis);
  globalThis.removeEventListener = EventTargetShim.prototype.removeEventListener.bind(globalThis);
  globalThis.dispatchEvent = EventTargetShim.prototype.dispatchEvent.bind(globalThis);

  // ----------------------------------------------------------------
  // Keyboard events from native
  // ----------------------------------------------------------------
  globalThis.__dispatchKeyboardEvent__ = function (type, keyCode, key, repeat, ctrl, shift, alt, meta) {
    const evt = new KeyboardEventShim(type, {
      keyCode: keyCode,
      key: key,
      repeat: repeat,
      ctrlKey: ctrl,
      shiftKey: shift,
      altKey: alt,
      metaKey: meta,
    });
    document.dispatchEvent(evt);
    window.dispatchEvent(evt);
  };

  globalThis.__dispatchMouseEvent__ = function (type, clientX, clientY, button, buttons) {
    const evt = new MouseEventShim(type, {
      clientX: clientX,
      clientY: clientY,
      button: button,
      buttons: buttons,
    });
    document.dispatchEvent(evt);
    window.dispatchEvent(evt);
  };

  globalThis.__dispatchWheelEvent__ = function (deltaX, deltaY) {
    const evt = new WheelEventShim("wheel", {
      deltaX: deltaX,
      deltaY: deltaY,
    });
    document.dispatchEvent(evt);
    window.dispatchEvent(evt);
  };

  // ----------------------------------------------------------------
  // XMLHttpRequest
  // ----------------------------------------------------------------
  function XMLHttpRequestShim() {
    this.readyState = 0;
    this.status = 0;
    this.responseText = null;
    this.response = null;
    this.onload = null;
    this.onerror = null;
    this._url = null;
    this._responseType = "";
  }
  XMLHttpRequestShim.prototype.open = function (method, url) {
    this._url = url;
    this.readyState = 1;
  };
  XMLHttpRequestShim.prototype.overrideMimeType = function () {};
  Object.defineProperty(XMLHttpRequestShim.prototype, "responseType", {
    get: function () { return this._responseType; },
    set: function (v) { this._responseType = v; },
  });
  XMLHttpRequestShim.prototype.send = function () {
    const path = safePath(this._url);
    print("[XHR SEND] " + this._url + " -> " + path);

    // Wrap the handlers that are already assigned at send() time so any error
    // thrown inside onload/onerror (e.g. JSON.parse) is surfaced.
    const origOnload = this.onload;
    const origOnerror = this.onerror;
    this.onload = function () {
      print("[XHR OK] " + path + " (status=" + this.status + ")");
      if (origOnload) {
        try {
          origOnload.call(this);
        } catch (e) {
          print("[XHR ONLOAD ERROR] " + e + (e.stack ? "\n" + e.stack : ""));
          throw e;
        }
      }
    };
    this.onerror = function () {
      print("[XHR ERROR] " + path);
      if (origOnerror) {
        try {
          origOnerror.call(this);
        } catch (e) {
          print("[XHR ONERROR ERROR] " + e + (e.stack ? "\n" + e.stack : ""));
          throw e;
        }
      }
    };

    // Resolve asynchronously (next tick) like a real browser. RMMZ's
    // DataManager assigns its onload handler BEFORE send(), but Scene_Boot
    // polls isDatabaseLoaded() every frame, so the data (e.g. $dataSystem)
    // is populated before onDatabaseLoaded runs. Some plugins (FOSSIL) assign
    // their handler AFTER send() and rely on the async timing to finish
    // defining methods before the handler fires — a synchronous send() breaks
    // those (e.g. FOSSIL sets xhr.onload at line 7696 but only defines
    // Fossil.onXhrLoad at line 7710). So always defer.
    const doLoad = function () {
      if (this._responseType === "arraybuffer" || this._responseType === "blob") {
        const data = native.readFileBinary ? native.readFileBinary(path) : native.readFile(path);
        if (data == null) {
          print("[XHR 404] MISSING BINARY FILE: " + path);
          this.status = 404;
          if (this.onerror) this.onerror();
          return;
        }
        this.status = 200;
        this.readyState = 4;
        this.response = data;
        if (this.onload) this.onload();
      } else {
        const data = native.readFile(path);
        if (data == null) {
          print("[XHR 404] MISSING TEXT FILE: " + path);
          this.status = 404;
          if (this.onerror) this.onerror();
          return;
        }
        if (data.trim() === "") {
          print("[XHR ERROR] File is empty (JSON.parse will fail): " + path);
        }
        this.status = 200;
        this.readyState = 4;
        this.responseText = data;
        this.response = data;
        if (this.onload) this.onload();
      }
    };

    setTimeout(function () { doLoad.call(this); }.bind(this), 0);
  };
  globalThis.XMLHttpRequest = XMLHttpRequestShim;

  // ----------------------------------------------------------------
  // fetch
  // ----------------------------------------------------------------
  globalThis.fetch = function (url, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      try {
        const path = safePath(url);
        const isBinary = opts.responseType === "arraybuffer" || (opts.headers && opts.headers["Content-Type"] === "application/octet-stream");
        if (isBinary) {
          const data = native.readFileBinary(path);
          const ok = data != null;
          resolve({
            ok: ok,
            status: ok ? 200 : 404,
            text: function () { return Promise.resolve(""); },
            json: function () { return Promise.resolve({}); },
            arrayBuffer: function () { return Promise.resolve(data); },
          });
        } else {
          const data = native.readFile(path);
          const ok = data != null;
          resolve({
            ok: ok,
            status: ok ? 200 : 404,
            text: function () { return Promise.resolve(data || ""); },
            json: function () { return Promise.resolve(JSON.parse(data || "{}")); },
            arrayBuffer: function () { return Promise.resolve(null); },
          });
        }
      } catch (e) {
        reject(e);
      }
    });
  };

  // ----------------------------------------------------------------
  // Audio
  // ----------------------------------------------------------------
  function AudioContextShim() {
    this.destination = {};
    this.state = "running";
    native.audioInit();
  }
  Object.defineProperty(AudioContextShim.prototype, "currentTime", {
    get: function () {
      return native.now() / 1000.0;
    }
  });
  AudioContextShim.prototype.createGain = function () {
    return { 
      gain: { 
        value: 1, 
        setValueAtTime: function () {},
        linearRampToValueAtTime: function () {} 
      }, 
      connect: function () {}, 
      disconnect: function () {} 
    };
  };
  AudioContextShim.prototype.createPanner = function () {
    return {
      panningModel: "equalpower",
      setPosition: function (x, y, z) {},
      connect: function () {},
      disconnect: function () {}
    };
  };
  AudioContextShim.prototype.createBufferSource = function () {
    return {
      buffer: null,
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      playbackRate: { 
        value: 1,
        setValueAtTime: function () {} 
      },
      connect: function () {},
      disconnect: function () {},
      start: function () {},
      stop: function () {},
      onended: null
    };
  };
  AudioContextShim.prototype.decodeAudioData = function (arrayBuffer, successCb) {
    return new Promise(function(resolve) {
      Promise.resolve().then(function () {
        var dummyBuffer = { duration: 1.0, numberOfChannels: 2, sampleRate: 44100 }; 
        if (successCb) successCb(dummyBuffer);
        resolve(dummyBuffer);
      });
    });
  };
  AudioContextShim.prototype.resume = function () {
    this.state = "running";
    return Promise.resolve();
  };
  AudioContextShim.prototype.suspend = function () {
    this.state = "suspended";
    return Promise.resolve();
  };
  globalThis.AudioContext = AudioContextShim;
  globalThis.webkitAudioContext = AudioContextShim;

  // ----------------------------------------------------------------
  // Misc
  // ----------------------------------------------------------------
  globalThis.alert = function (msg) { print("[ALERT] " + msg); };
  globalThis.confirm = function () { return true; };
  globalThis.prompt = function () { return null; };

  // ----------------------------------------------------------------
  // Common plugin / VisuStella environment stubs
  // ----------------------------------------------------------------
  // Some plugins sniff Node/NW.js globals or call require(). Provide inert
  // stand-ins routed through the native bridge so they don't throw.
  // ----------------------------------------------------------------
  // Node / NW.js Stubs for RMMZ & VisuStella
  // ----------------------------------------------------------------
  // RMMZ's Utils.isNwjs() returns true once require+process exist, so it
  // enters the NW.js init branch and calls require("nw.gui").Window.get().
  // Provide full no-op handlers so that path doesn't throw. path.join must
  // also strip leading slashes or save files resolve to /save/... (root).
  const nwWindowTarget = {
    x: 0,
    y: 0,
    width: 1280,
    height: 720,
    title: "RPG Maker MZ",
    zoomLevel: 0,
    isDevToolsOpen: function () { return false; },
    showDevTools: function () {},
    closeDevTools: function () {},
    // Confirmed bug: this was a pure no-op, so RMMZ's "Exit to Desktop"
    // command (shown because Utils.isNwjs() is true) did nothing when
    // clicked. native.quit() stops the C main loop for a real, clean exit.
    close: function () {
      if (typeof native !== "undefined" && native.quit) native.quit();
    },
    on: function (evt, fn) {},
    removeListener: function () {},
    removeAllListeners: function () {},
    focus: function () {},
    blur: function () {},
    show: function () {},
    hide: function () {},
    maximize: function () {},
    minimize: function () {},
    restore: function () {},
    enterFullscreen: function () {},
    leaveFullscreen: function () {},
    toggleFullscreen: function () {},
    setAlwaysOnTop: function () {},
    setShowInTaskbar: function () {},
    requestAttention: function () {},
    setResizable: function () {},
    setMinimumSize: function (w, h) {},
    setMaximumSize: function (w, h) {},
    setPosition: function (pos) {},
    moveTo: function (x, y) {},
    moveBy: function (dx, dy) {},
    resizeTo: function (w, h) {
      globalThis.innerWidth = w;
      globalThis.innerHeight = h;
      if (typeof native !== "undefined" && native.setWindowSize) {
        native.setWindowSize(w, h);
      }
    },
    resizeBy: function (dw, dh) {
      const nw = (globalThis.innerWidth || 816) + dw;
      const nh = (globalThis.innerHeight || 624) + dh;
      this.resizeTo(nw, nh);
    }
  };

  // Proxy intercepts ANY unlisted NW.js method so VisuStella can never crash
  const nwWindowProxy = new Proxy(nwWindowTarget, {
    get: function (target, prop) {
      if (prop in target) return target[prop];
      // Return a safe no-op function for any missing NW.js method
      if (typeof prop === "string" && !prop.startsWith("_")) {
        return function () { return undefined; };
      }
      return undefined;
    }
  });

  const nwAppStub = {
    argv: [],
    dataPath: ".",
    manifest: { name: "RMMZ", main: "index.html" },
    // Confirmed bug: this is the function RMMZ's "Exit to Desktop" command
    // actually calls (nw.App.quit()), and it was a pure no-op — the
    // window just sat there. native.quit() stops the C main loop, which
    // reaches the same code path as closing the window normally.
    quit: function () {
      if (typeof native !== "undefined" && native.quit) native.quit();
    },
    closeAllWindows: function () {},
    clearCache: function () {}
  };

  globalThis.nw = globalThis.nw || {
    App: new Proxy(nwAppStub, {
      get: function (target, prop) {
        if (prop in target) return target[prop];
        return function () { return undefined; };
      }
    }),
    Window: {
      get: function () { return nwWindowProxy; }
    },
    Shell: {
      openExternal: function () {},
      openItem: function () {},
      showItemInFolder: function () {}
    },
    Menu: function () {
      return {
        append: function () {},
        insert: function () {},
        remove: function () {},
        popup: function () {}
      };
    },
    MenuItem: function (opts) { return opts || {}; },
    Tray: function () {
      return {
        remove: function () {},
        on: function () {}
      };
    },
    Clipboard: {
      get: function () {
        return {
          get: function () { return ""; },
          set: function () {},
          clear: function () {}
        };
      }
    }
  };

  globalThis.process = {
    platform: "win32",
    env: {},
    argv: ["rmmz_native.exe"],
    mainModule: {
      filename: "index.html",
      paths: ["."]
    },
    cwd: function () { return "."; },
    versions: { node: "18.0.0" }
  };

  // Robust path module matching Node.js spec
  const pathStub = {
    join: function () {
      const parts = [];
      for (let i = 0; i < arguments.length; i++) {
        const arg = arguments[i];
        if (arg && typeof arg === "string") {
          const clean = arg.replace(/^[\\\/]+|[\\\/]+$/g, "");
          if (clean.length > 0) parts.push(clean);
        }
      }
      let res = parts.join("/");
      const lastArg = arguments[arguments.length - 1];
      if (lastArg && typeof lastArg === "string" && (lastArg.endsWith("/") || lastArg.endsWith("\\"))) {
        res += "/";
      }
      return res;
    },
    dirname: function (p) {
      if (!p || p === "." || (p.indexOf("/") === -1 && p.indexOf("\\") === -1)) return ".";
      const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
      return idx <= 0 ? "." : p.substring(0, idx);
    },
    basename: function (p) {
      if (!p) return "";
      const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
      return idx < 0 ? p : p.substring(idx + 1);
    },
    extname: function (p) {
      if (!p) return "";
      const base = pathStub.basename(p);
      const idx = base.lastIndexOf(".");
      return idx < 0 ? "" : base.substring(idx);
    },
    resolve: function () {
      return pathStub.join.apply(null, arguments);
    }
  };

  // ----------------------------------------------------------------
  // Complete Node.js `fs` module for StorageManager & VisuStella
  // ----------------------------------------------------------------
  const fsStub = {
    existsSync: function (p) {
      return native.readFile(safePath(p)) !== null;
    },
    readFileSync: function (p, opts) {
      const data = native.readFile(safePath(p));
      if (data === null || data === undefined) {
        const err = new Error("ENOENT: no such file or directory, open '" + p + "'");
        err.code = "ENOENT";
        throw err;
      }
      return data;
    },
    writeFileSync: function (p, data, opts) {
      native.storageSet(safePath(p), String(data));
    },
    readFile: function (p, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      cb = cb || function () {};
      setTimeout(function () {
        const data = native.readFile(safePath(p));
        if (data === null || data === undefined) {
          const err = new Error("ENOENT: no such file or directory, open '" + p + "'");
          err.code = "ENOENT";
          cb(err, null);
        } else {
          cb(null, data);
        }
      }, 0);
    },
    writeFile: function (p, data, opts, cb) {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      cb = cb || function () {};
      setTimeout(function () {
        native.storageSet(safePath(p), String(data));
        cb(null);
      }, 0);
    },
    statSync: function (p) {
      const exists = native.readFile(safePath(p)) !== null;
      if (!exists) {
        const err = new Error("ENOENT: no such file or directory, stat '" + p + "'");
        err.code = "ENOENT";
        throw err;
      }
      return {
        isDirectory: function () { return false; },
        isFile: function () { return true; },
        size: 0,
        mtime: new Date()
      };
    },
    stat: function (p, cb) {
      cb = cb || function () {};
      setTimeout(function () {
        const exists = native.readFile(safePath(p)) !== null;
        if (!exists) {
          const err = new Error("ENOENT: no such file or directory, stat '" + p + "'");
          err.code = "ENOENT";
          cb(err, null);
        } else {
          cb(null, {
            isDirectory: function () { return false; },
            isFile: function () { return true; },
            size: 0,
            mtime: new Date()
          });
        }
      }, 0);
    },
    mkdirSync: function (p, opts) {},
    mkdir: function (p, opts, cb) {
      if (typeof opts === "function") { cb = opts; }
      if (cb) setTimeout(function () { cb(null); }, 0);
    },
    readdirSync: function (p) { return []; },
    readdir: function (p, cb) {
      if (cb) setTimeout(function () { cb(null, []); }, 0);
    },
    unlinkSync: function (p) {},
    unlink: function (p, cb) {
      if (cb) setTimeout(function () { cb(null); }, 0);
    },
    rmdirSync: function (p) {},
    rmdir: function (p, cb) {
      if (cb) setTimeout(function () { cb(null); }, 0);
    },
    promises: {
      readFile: function (p) {
        return new Promise(function (resolve, reject) {
          fsStub.readFile(p, function (err, data) {
            if (err) reject(err); else resolve(data);
          });
        });
      },
      writeFile: function (p, data) {
        return new Promise(function (resolve, reject) {
          fsStub.writeFile(p, data, function (err) {
            if (err) reject(err); else resolve();
          });
        });
      },
      stat: function (p) {
        return new Promise(function (resolve, reject) {
          fsStub.stat(p, function (err, stats) {
            if (err) reject(err); else resolve(stats);
          });
        });
      },
      mkdir: function (p) { return Promise.resolve(); },
      readdir: function (p) { return Promise.resolve([]); },
      unlink: function (p) { return Promise.resolve(); }
    }
  };

  // Robust require dispatcher
  globalThis.require = function (mod) {
    if (mod === "fs") return fsStub;
    if (mod === "path") return pathStub;
    if (mod === "nw.gui" || mod === "nw") {
      return globalThis.nw;
    }
    if (mod === "os") {
      return {
        platform: function () { return "win32"; },
        arch: function () { return "x64"; },
        release: function () { return "10.0.0"; },
        homedir: function () { return "."; },
        tmpdir: function () { return "."; }
      };
    }
    if (mod === "crypto") {
      return {
        createHash: function () {
          return {
            update: function () { return this; },
            digest: function () { return "0000000000000000"; }
          };
        }
      };
    }
    return {};
  };

  // ----------------------------------------------------------------
  // Browser DOM / Focus / Navigator Compatibility for Plugins
  // ----------------------------------------------------------------
  // VisuStella and MZ's boot routines query Chromium/NW.js helper functions;
  // missing ones throw "TypeError: not a function". Satisfy them all with
  // inert stand-ins.
  documentShim.hasFocus = function () { return true; };
  documentShim.hidden = false;
  documentShim.visibilityState = "visible";
  documentShim.cookie = "";
  documentShim.elementFromPoint = function () { return documentShim.body; };
  documentShim.getSelection = function () {
    return {
      removeAllRanges: function () {},
      addRange: function () {},
      getRangeAt: function () { return {}; },
      rangeCount: 0
    };
  };

  globalThis.getSelection = documentShim.getSelection;
  globalThis.focus = function () {};
  globalThis.blur = function () {};

  globalThis.navigator = globalThis.navigator || {};
  globalThis.navigator.userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  globalThis.navigator.platform = "Win32";
  globalThis.navigator.language = "en-US";
  globalThis.navigator.languages = ["en-US", "en"];
  globalThis.navigator.onLine = true;
  globalThis.navigator.getGamepads = function () { return []; };
  globalThis.crypto = globalThis.crypto || {
    getRandomValues: function (arr) {
      for (var i = 0; i < arr.length; i++) arr[i] = (Math.random() * 256) | 0;
      return arr;
    }
  };

  // ----------------------------------------------------------------
  // Layout, DOM Queries, & ComputedStyle for Pixi & VisuStella
  // ----------------------------------------------------------------
  // Scene_Boot.prototype.resizeScreen -> Graphics.resize -> Pixi/VisuStella
  // layout queries. Missing getComputedStyle / getBoundingClientRect /
  // querySelector were throwing "TypeError: not a function" during boot.

  globalThis.screen = {
    width: 1920,
    height: 1080,
    availWidth: 1920,
    availHeight: 1080,
    colorDepth: 24,
    pixelDepth: 24,
    orientation: { type: "landscape-primary", angle: 0 }
  };
  globalThis.devicePixelRatio = 1.0;

  globalThis.getComputedStyle = function (elem) {
    if (!elem) {
      return {
        getPropertyValue: function () { return ""; },
        setProperty: function () {},
        removeProperty: function () {}
      };
    }
    return elem.style || {
      getPropertyValue: function () { return ""; },
      setProperty: function () {},
      removeProperty: function () {}
    };
  };

  ElementShim.prototype.getBoundingClientRect = function () {
    const w = this.width || globalThis.innerWidth || 816;
    const h = this.height || globalThis.innerHeight || 624;
    return {
      top: 0,
      left: 0,
      right: w,
      bottom: h,
      width: w,
      height: h,
      x: 0,
      y: 0
    };
  };

  ElementShim.prototype.setAttribute = function (k, v) { this[k] = v; };
  ElementShim.prototype.getAttribute = function (k) { return this[k] !== undefined ? this[k] : null; };
  ElementShim.prototype.removeAttribute = function (k) { delete this[k]; };
  ElementShim.prototype.hasAttribute = function (k) { return k in this; };
  ElementShim.prototype.contains = function (other) { return false; };

  documentShim.querySelector = function (sel) {
    if (sel === "canvas" || sel === "#gameCanvas" || sel === "#canvas") {
      return documentShim.getElementById("gameCanvas");
    }
    if (sel === "body") return documentShim.body;
    if (sel === "head") return documentShim.head;
    return documentShim.getElementById(sel.replace(/^[#\.]/, "")) || new ElementShim("div");
  };

  // Dynamic element tracking by id. #gameCanvas always resolves to the real
  // WebGL canvas (Graphics._canvas) once created; any other id is created and
  // cached on first lookup so plugins never get null back.
  const elementsById = Object.create(null);

  documentShim.getElementById = function (id) {
    if ((id === "gameCanvas" || id === "canvas") && typeof Graphics !== "undefined" && Graphics._canvas) {
      return Graphics._canvas;
    }
    if (elementsById[id]) return elementsById[id];
    const el = documentShim.createElement("div");
    el.id = id;
    elementsById[id] = el;
    return el;
  };

  Object.defineProperty(ElementShim.prototype, "id", {
    get: function () { return this._id || ""; },
    set: function (v) {
      this._id = String(v || "");
      if (this._id) elementsById[this._id] = this;
    }
  });

  // classList for VisuStella UI helpers
  Object.defineProperty(ElementShim.prototype, "classList", {
    get: function () {
      const self = this;
      return {
        add: function () {
          for (let i = 0; i < arguments.length; i++) {
            if (!self.className.includes(arguments[i])) {
              self.className = (self.className + " " + arguments[i]).trim();
            }
          }
        },
        remove: function () {
          for (let i = 0; i < arguments.length; i++) {
            self.className = self.className.replace(new RegExp("\\b" + arguments[i] + "\\b", "g"), "").trim();
          }
        },
        contains: function (c) {
          return self.className.includes(c);
        },
        toggle: function (c) {
          if (this.contains(c)) this.remove(c); else this.add(c);
        }
      };
    }
  });

  documentShim.querySelectorAll = function (sel) {
    const el = documentShim.querySelector(sel);
    return el ? [el] : [];
  };

  documentShim.getElementsByTagName = function (tag) {
    const t = (tag || "").toLowerCase();
    if (t === "canvas") return [documentShim.getElementById("gameCanvas")];
    if (t === "body") return [documentShim.body];
    if (t === "head") return [documentShim.head];
    return [];
  };

  documentShim.getElementsByClassName = function (cls) {
    return [];
  };

  documentShim.documentElement = documentShim.documentElement || new ElementShim("html");
  documentShim.documentElement.clientWidth = 1280;
  documentShim.documentElement.clientHeight = 720;
  documentShim.documentElement.style = {};

  // ----------------------------------------------------------------
  // String & Element compatibility for FOSSIL
  // ----------------------------------------------------------------
  if (!String.prototype.contains) {
    String.prototype.contains = function (s) {
      return this.indexOf(s) !== -1;
    };
  }
  if (!Array.prototype.contains) {
    Array.prototype.contains = function (s) {
      return this.indexOf(s) !== -1;
    };
  }

  Object.defineProperty(ElementShim.prototype, "outerHTML", {
    get: function () {
      const tag = (this.tagName || "div").toLowerCase();
      const srcAttr = this.src ? ' src="' + this.src + '"' : '';
      const idAttr = this.id ? ' id="' + this.id + '"' : '';
      return "<" + tag + idAttr + srcAttr + ">" + (this._innerHTML || "") + "</" + tag + ">";
    }
  });

  // ----------------------------------------------------------------
  // Element Insertion & DOM compatibility (Needed by FOSSIL)
  // ----------------------------------------------------------------
  ElementShim.prototype.insertAdjacentElement = function (position, element) {
    if (!element) return element;
    if (position === "beforeBegin" && this.parentNode) {
      this.parentNode.insertBefore(element, this);
    } else if (position === "afterBegin") {
      this.children.unshift(element);
      element.parentNode = this;
    } else if (position === "beforeEnd") {
      this.children.push(element);
      element.parentNode = this;
    } else if (position === "afterEnd" && this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1 && idx + 1 < this.parentNode.children.length) {
        this.parentNode.insertBefore(element, this.parentNode.children[idx + 1]);
      } else {
        this.parentNode.appendChild(element);
      }
    } else {
      this.appendChild(element);
    }
    return element;
  };

  ElementShim.prototype.insertAdjacentHTML = function () {};

  // Ensure document.body has at least one initial child so children[0] is valid
  if (!documentShim.body.children.length) {
    documentShim.body.appendChild(new ElementShim("div"));
  }

  // matchMedia for VisuStella responsive layout queries
  globalThis.matchMedia = function (query) {
    return {
      matches: false,
      media: query || "",
      onchange: null,
      addListener: function () {},
      removeListener: function () {},
      addEventListener: function () {},
      removeEventListener: function () {},
      dispatchEvent: function () { return true; }
    };
  };

  // Canvas toDataURL / toBlob
  CanvasElementShim.prototype.toDataURL = function () {
    return "data:image/png;base64,";
  };
  CanvasElementShim.prototype.toBlob = function (cb) {
    if (cb) cb(new Blob());
  };

  // document.createRange
  documentShim.createRange = function () {
    return {
      setStart: function () {},
      setEnd: function () {},
      commonAncestorContainer: documentShim.body,
      selectNodeContents: function () {},
      getBoundingClientRect: function () {
        return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
      }
    };
  };

  // DOMParser & XMLSerializer for VisuStella tag parser. Also provides a real,
  // minimal XML parser so plugins (e.g. Tyruswoo_AltimitMovement) that parse
  // collider/note XML get actual childNodes/nodeName/innerHTML/getAttribute.
  globalThis.DOMParser = function () {};
  globalThis.DOMParser.prototype.parseFromString = function (text) {
    return _xmlParseDocument(text);
  };

  function _xmlNode(nodeName, attributes) {
    return {
      nodeName: nodeName,
      attributes: attributes || {},
      childNodes: [],
      innerHTML: "",
      getAttribute: function (name) {
        const v = this.attributes[name];
        return v === undefined ? null : v;
      }
    };
  }

  function _xmlParseAttributes(str) {
    const attrs = {};
    const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      attrs[m[1]] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
    }
    return attrs;
  }

  function _xmlParseDocument(src) {
    src = String(src === null || src === undefined ? "" : src)
      .replace(/^\uFEFF/, "")
      .replace(/<\?xml[\s\S]*?\?>/g, "")
      .replace(/<!DOCTYPE[\s\S]*?>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    const doc = _xmlNode("#document", {});
    _xmlParseChildren(doc, src, { pos: 0 });
    return doc;
  }

  function _xmlParseChildren(parent, s, st) {
    let text = "";
    const n = s.length;
    while (st.pos < n) {
      const ch = s[st.pos];
      if (ch === "<") {
        if (s.startsWith("</", st.pos)) {
          const close = s.indexOf(">", st.pos);
          if (text) { parent.innerHTML += text; text = ""; }
          st.pos = close < 0 ? n : close + 1;
          return;
        }
        const tagEnd = s.indexOf(">", st.pos);
        if (tagEnd < 0) { text += s.slice(st.pos); st.pos = n; break; }
        let tag = s.slice(st.pos + 1, tagEnd);
        if (text) { parent.innerHTML += text; text = ""; }
        st.pos = tagEnd + 1;
        let selfClose = false;
        if (tag.charAt(tag.length - 1) === "/") { selfClose = true; tag = tag.slice(0, -1); }
        tag = tag.trim();
        const m = /^([A-Za-z0-9_:]+)([\s\S]*)$/.exec(tag);
        if (m) {
          const node = _xmlNode(m[1], _xmlParseAttributes(m[2]));
          parent.childNodes.push(node);
          if (!selfClose) {
            _xmlParseChildren(node, s, st);
          }
        } else {
          // comment / processing instruction already stripped; ignore stray "<"
          text += s.slice(st.pos);
        }
      } else {
        text += ch;
        st.pos++;
      }
    }
    if (text) parent.innerHTML += text;
  }
  globalThis.XMLSerializer = function () {};
  globalThis.XMLSerializer.prototype.serializeToString = function () { return ""; };

  // requestIdleCallback
  globalThis.requestIdleCallback = function (cb) {
    return setTimeout(function () { cb({ didTimeout: false, timeRemaining: function () { return 50; } }); }, 1);
  };
  globalThis.cancelIdleCallback = function (id) { clearTimeout(id); };

  // ----------------------------------------------------------------
  // Sync the native SDL window size with the game's configured resolution.
  // RMMZ sets Graphics.width/height from its own project System.json
  // (e.g. 816x624 or 1024x768). Whenever that changes, resize the window so
  // the game fills it instead of sitting in the bottom-left of a 1280x720 box.
  // ----------------------------------------------------------------
  // --------------------------------------------------------------------------
  // NW.JS / Browser-Compatible Script & Event Error Tolerance
  // In NW.js/Browser hosts, errors inside event Script commands, move routes,
  // conditional branches, or eval variables do NOT crash the game engine.
  // We wrap executeCommand, command355, command111, command122, and
  // Game_CharacterBase.prototype.processMoveCommand to log and safely continue.
  // --------------------------------------------------------------------------
  globalThis.__installInterpreterErrorTolerances__ = function () {
    if (typeof Game_Interpreter !== 'undefined' && !Game_Interpreter.prototype.__sonarTolerantScripts) {
      Game_Interpreter.prototype.__sonarTolerantScripts = true;
      print("[Shim] Installing Game_Interpreter script & command error tolerance...");

      // 1. Master command execution protector: wraps executeCommand
      const origExecuteCommand = Game_Interpreter.prototype.executeCommand;
      if (typeof origExecuteCommand === 'function') {
        Game_Interpreter.prototype.executeCommand = function () {
          try {
            return origExecuteCommand.apply(this, arguments);
          } catch (e) {
            const cmd = this.currentCommand();
            const code = cmd ? cmd.code : '?';
            const evId = this._eventId || (typeof this.eventId === 'function' ? this.eventId() : '?');
            print("[interpreter] Event command error caught & ignored (event=" + evId + " code=" + code + " index=" + this._index + "): " + e);
            if (e && e.stack) print("  Stack:\n" + e.stack);

            // If it failed on a script command (355), skip any continuation lines (655)
            if (code === 355) {
              while (typeof this.nextEventCode === 'function' && this.nextEventCode() === 655) {
                this._index++;
              }
            }
            this._index++;
            return true; // continue next event command smoothly
          }
        };
      }

      // 2. Wrap command355 (Script command) specifically
      const origCommand355 = Game_Interpreter.prototype.command355;
      if (typeof origCommand355 === 'function') {
        Game_Interpreter.prototype.command355 = function () {
          try {
            return origCommand355.apply(this, arguments);
          } catch (e) {
            const evId = this._eventId || (typeof this.eventId === 'function' ? this.eventId() : '?');
            const cmd = this.currentCommand();
            const src = (cmd && cmd.parameters && cmd.parameters[0]) || '';
            print("[interpreter] Script call (command355) failed & ignored (event=" + evId + " index=" + this._index + "): " + e +
                  (src ? "\n  script was:\n    " + src.slice(0, 300) : ""));
            if (e && e.stack) print("  Stack:\n" + e.stack);
            while (typeof this.nextEventCode === 'function' && this.nextEventCode() === 655) {
              this._index++;
            }
            return true; // continue next command
          }
        };
      }

      // 3. Wrap command111 (Conditional Branch -> Script)
      const origCommand111 = Game_Interpreter.prototype.command111;
      if (typeof origCommand111 === 'function') {
        Game_Interpreter.prototype.command111 = function (params) {
          try {
            return origCommand111.apply(this, arguments);
          } catch (e) {
            const evId = this._eventId || (typeof this.eventId === 'function' ? this.eventId() : '?');
            print("[interpreter] Conditional branch (command111) script error caught (event=" + evId + " index=" + this._index + "): " + e);
            if (e && e.stack) print("  Stack:\n" + e.stack);
            if (typeof this.skipBranch === 'function') {
              this.skipBranch();
            }
            return true;
          }
        };
      }

      // 4. Wrap command122 (Control Variables -> Script)
      const origCommand122 = Game_Interpreter.prototype.command122;
      if (typeof origCommand122 === 'function') {
        Game_Interpreter.prototype.command122 = function (params) {
          try {
            return origCommand122.apply(this, arguments);
          } catch (e) {
            const evId = this._eventId || (typeof this.eventId === 'function' ? this.eventId() : '?');
            print("[interpreter] Control Variables (command122) script error caught (event=" + evId + " index=" + this._index + "): " + e);
            if (e && e.stack) print("  Stack:\n" + e.stack);
            return true;
          }
        };
      }

      // 5. Wrap pluginCommand / command356 / command357 if present
      if (typeof Game_Interpreter.prototype.command356 === 'function') {
        const origCommand356 = Game_Interpreter.prototype.command356;
        Game_Interpreter.prototype.command356 = function (params) {
          try {
            return origCommand356.apply(this, arguments);
          } catch (e) {
            const evId = this._eventId || (typeof this.eventId === 'function' ? this.eventId() : '?');
            print("[interpreter] Plugin command (command356) error caught (event=" + evId + "): " + e);
            return true;
          }
        };
      }
      if (typeof Game_Interpreter.prototype.command357 === 'function') {
        const origCommand357 = Game_Interpreter.prototype.command357;
        Game_Interpreter.prototype.command357 = function (params) {
          try {
            return origCommand357.apply(this, arguments);
          } catch (e) {
            const evId = this._eventId || (typeof this.eventId === 'function' ? this.eventId() : '?');
            print("[interpreter] Plugin command MZ (command357) error caught (event=" + evId + "): " + e);
            return true;
          }
        };
      }
    }

    // 6. Wrap Game_CharacterBase.prototype.processMoveCommand (Move Route scripts like ROUTE_SCRIPT)
    if (typeof Game_CharacterBase !== 'undefined' && Game_CharacterBase.prototype &&
        Game_CharacterBase.prototype.processMoveCommand && !Game_CharacterBase.prototype.processMoveCommand.__sonarTolerant) {
      const origProcessMoveCommand = Game_CharacterBase.prototype.processMoveCommand;
      Game_CharacterBase.prototype.processMoveCommand = function (command) {
        try {
          return origProcessMoveCommand.apply(this, arguments);
        } catch (e) {
          const charName = (this._eventId !== undefined ? "event " + this._eventId : (this.constructor ? this.constructor.name : "character"));
          print("[MoveRoute] Move script/command error caught & ignored for " + charName + " (code=" + (command ? command.code : '?') + "): " + e);
          if (e && e.stack) print("  Stack:\n" + e.stack);
        }
      };
      Game_CharacterBase.prototype.processMoveCommand.__sonarTolerant = true;
    }

    // 7. Wrap Game_Action.prototype.evalDamageFormula
    if (typeof Game_Action !== 'undefined' && Game_Action.prototype &&
        Game_Action.prototype.evalDamageFormula && !Game_Action.prototype.evalDamageFormula.__sonarTolerant) {
      const origEvalDamage = Game_Action.prototype.evalDamageFormula;
      Game_Action.prototype.evalDamageFormula = function (target) {
        try {
          return origEvalDamage.apply(this, arguments);
        } catch (e) {
          print("[Game_Action] Damage formula error for item " + (this.item() ? this.item().name : '?') + ": " + e);
          return 0;
        }
      };
      Game_Action.prototype.evalDamageFormula.__sonarTolerant = true;
    }
  };

  globalThis.addEventListener("load", function () {
    globalThis.__installInterpreterErrorTolerances__();
    // Print summary of active plugins
    if (typeof $plugins !== "undefined" && Array.isArray($plugins)) {
      print("\n--- Active Plugins Summary ---");
      let count = 0;
      for (const p of $plugins) {
        if (p.status) {
          print("  OK " + p.name + " (status: on)");
          count++;
        }
      }
      print("Total active plugins loaded: " + count + "\n");
    }
    // VisuStella MZ Default Settings Fallback Structs — pre-populate so
    // plugins reading Settings.QoL / Settings.Localization etc. never hit
    // "cannot read property ... of undefined" when params are incomplete.
    globalThis.VisuMZ = globalThis.VisuMZ || {};
    globalThis.VisuMZ.CoreEngine = globalThis.VisuMZ.CoreEngine || {};
    globalThis.VisuMZ.CoreEngine.Settings = globalThis.VisuMZ.CoreEngine.Settings || {};
    globalThis.VisuMZ.CoreEngine.Settings.MenuLayout = Object.assign({
      Title: {
        TitleScreen: "",
        DocumentTitleFmt: "%1: %2 - Version %3",
        Subtitle: "Subtitle",
        Version: "0.00",
        drawGameTitle: new Function(""),
        drawGameSubtitle: new Function(""),
        drawGameVersion: new Function(""),
        CommandRect: new Function("return new Rectangle(0, 0, 240, 200);"),
        ButtonFadeSpeed: 4
      },
      MainMenu: {}, ItemMenu: {}, SkillMenu: {}, EquipMenu: {},
      StatusMenu: {}, OptionsMenu: {}, SaveMenu: {}, LoadMenu: {},
      GameEnd: {}, ShopMenu: {}, NameMenu: {}
    }, globalThis.VisuMZ.CoreEngine.Settings.MenuLayout || {});
    globalThis.VisuMZ.CoreEngine.Settings.TitleCommandList = globalThis.VisuMZ.CoreEngine.Settings.TitleCommandList || [];
    globalThis.VisuMZ.CoreEngine.Settings.TitlePicButtons = globalThis.VisuMZ.CoreEngine.Settings.TitlePicButtons || [];
    globalThis.VisuMZ.CoreEngine.Settings.ButtonAssist = Object.assign({
      Enable: true, Location: "bottom", BgType: 0, SplitEscape: false,
      TextFmt: "%1:%2", MultiKeyFmt: "%1/%2", OkText: "Select", CancelText: "Back",
      SwitchActorText: "Switch Ally", KeyUnlisted: "}❪%1❫{",
      KeyUP: "^", KeyDOWN: "v", KeyLEFT: "<<", KeyRIGHT: ">>",
      KeySHIFT: "}❪SHIFT❫{", KeyTAB: "}❪TAB❫{",
      KeyA: "A", KeyB: "B", KeyC: "C", KeyD: "D", KeyE: "E", KeyF: "F",
      KeyG: "G", KeyH: "H", KeyI: "I", KeyJ: "J", KeyK: "K", KeyL: "L",
      KeyM: "M", KeyN: "N", KeyO: "O", KeyP: "P", KeyQ: "Q", KeyR: "R",
      KeyS: "S", KeyT: "T", KeyU: "U", KeyV: "V", KeyW: "W", KeyX: "X",
      KeyY: "Y", KeyZ: "Z"
    }, globalThis.VisuMZ.CoreEngine.Settings.ButtonAssist || {});
    globalThis.VisuMZ.CoreEngine.Settings.QoL = Object.assign({
      SubfolderParse: true, OpenConsole: false, NewGameBoot: false, ModernControls: true,
      AutoStretch: "default", FontSmoothing: true, FontWidthFix: true, KeyItemProtect: true,
      MapNameTextCode: true, RequireFocus: false, ShortcutScripts: true,
      SmartEventCollisionPriority: true, DigitGroupingStandardText: false,
      DigitGroupingExText: false, DigitGroupingDamageSprites: false,
      DigitGroupingGaugeSprites: false, DigitGroupingLocale: "en-US", EncounterRateMinimum: 10,
      EscapeAlways: true, LevelUpFullHp: true, LevelUpFullMp: true, AntiZoomPictures: true
    }, globalThis.VisuMZ.CoreEngine.Settings.QoL || {});
    globalThis.VisuMZ.CoreEngine.Settings.UI = Object.assign({
      BoxMargin: 4, CommandWidth: 240, BottomHelp: false, RightMenus: true, ShowButtons: true,
      cancelShowButton: true, menuShowButton: true, pagedownShowButton: true,
      numberShowButton: true, ButtonHeight: 52, BottomButtons: false, SideButtons: true,
      LvExpGauge: true, ParamArrow: "→", TextCodeClassNames: true, TextCodeNicknames: true
    }, globalThis.VisuMZ.CoreEngine.Settings.UI || {});
    globalThis.VisuMZ.CoreEngine.Settings.Color = Object.assign({
      ColorNormal: "0", ColorSystem: "16", ColorCrisis: "17", ColorDeath: "18",
      ColorGaugeBack: "19", ColorHPGauge1: "20", ColorHPGauge2: "21",
      ColorMPGauge1: "22", ColorMPGauge2: "23", ColorMPCost: "23",
      ColorPowerUp: "24", ColorPowerDown: "25", ColorCTGauge1: "26",
      ColorCTGauge2: "27", ColorTPGauge1: "28", ColorTPGauge2: "29",
      ColorTPCost: "29", ColorPending: "#2a847d", ColorExpGauge1: "30",
      ColorExpGauge2: "31", ColorMaxLvGauge1: "14", ColorMaxLvGauge2: "6"
    }, globalThis.VisuMZ.CoreEngine.Settings.Color || {});
    globalThis.VisuMZ.CoreEngine.Settings.Window = Object.assign({
      LineHeight: 36, ItemPadding: 8, BackOpacity: 192, TranslucentOpacity: 160,
      OpenSpeed: 32, ColSpacing: 8, RowSpacing: 4, CorrectSkinBleeding: true
    }, globalThis.VisuMZ.CoreEngine.Settings.Window || {});
    globalThis.VisuMZ.CoreEngine.Settings.Param = Object.assign({
      DisplayedParams: ["ATK", "DEF", "MAT", "MDF", "AGI", "LUK"],
      ExtDisplayedParams: ["MaxHP", "MaxMP", "ATK", "DEF", "MAT", "MDF", "AGI", "LUK"]
    }, globalThis.VisuMZ.CoreEngine.Settings.Param || {});

    globalThis.VisuMZ.MessageCore = globalThis.VisuMZ.MessageCore || {};
    globalThis.VisuMZ.MessageCore.Settings = globalThis.VisuMZ.MessageCore.Settings || {};
    globalThis.VisuMZ.MessageCore.Settings.General = Object.assign({
      MessageRows: 4, MessageWidth: 816, FastForwardKey: "pagedown", MessageTextDelay: 1,
      StretchDimmedBg: true, DefaultOutlineWidth: 3, NameBoxWindowDefaultColor: 0,
      NameBoxWindowOffsetX: 0, NameBoxWindowOffsetY: 0, ChoiceWindowLineHeight: 36,
      ChoiceWindowMinWidth: 96, ChoiceWindowMaxRows: 8, ChoiceWindowMaxCols: 1,
      ChoiceWindowTextAlign: "default", RelativePXPY: true, FontBiggerCap: 108,
      FontSmallerCap: 12, FontChangeValue: 12
    }, globalThis.VisuMZ.MessageCore.Settings.General || {});
    globalThis.VisuMZ.MessageCore.Settings.Localization = Object.assign({
      Enable: false, CsvFilename: "Languages.csv", AddOption: false, AdjustRect: true,
      Name: "Text Language", DefaultLocale: "English", Languages: ["English"]
    }, globalThis.VisuMZ.MessageCore.Settings.Localization || {});
    globalThis.VisuMZ.MessageCore.Settings.WordWrap = Object.assign({
      MessageWindow: false, HelpWindow: false, LineBreakSpace: true,
      TightWrap: false, EndPadding: 0
    }, globalThis.VisuMZ.MessageCore.Settings.WordWrap || {});
    globalThis.VisuMZ.MessageCore.Settings.TextSpeed = Object.assign({
      AddOption: true, AdjustRect: true, Name: "Text Speed", Default: 10, Instant: "Instant"
    }, globalThis.VisuMZ.MessageCore.Settings.TextSpeed || {});
    globalThis.VisuMZ.MessageCore.Settings.AutoColor = Object.assign({
      Actors: "0", Classes: "0", Skills: "0", Items: "0", Weapons: "0",
      Armors: "0", Enemies: "0", States: "0"
    }, globalThis.VisuMZ.MessageCore.Settings.AutoColor || {});
    globalThis.VisuMZ.MessageCore.Settings.TextCodeActions = globalThis.VisuMZ.MessageCore.Settings.TextCodeActions || [];
    globalThis.VisuMZ.MessageCore.Settings.TextCodeReplace = globalThis.VisuMZ.MessageCore.Settings.TextCodeReplace || [];
    globalThis.VisuMZ.MessageCore.Settings.TextMacros = globalThis.VisuMZ.MessageCore.Settings.TextMacros || [];

    // --- VisuMZ Robust Settings Proxy ---
    // Prevents "cannot read property X of undefined" when plugin parameters
    // are missing or when plugins access nested settings that weren't initialized.
    const visuMZSettingsHandler = {
      get: function (target, prop) {
        if (!(prop in target)) {
          target[prop] = {};
        }
        return target[prop];
      },
      set: function (target, prop, value) {
        target[prop] = value;
        return true;
      }
    };

    const visuMZHandler = {
      get: function (target, prop) {
        if (prop === "Settings") {
          if (!target.Settings || !target.Settings._isProxiedSettings) {
            target.Settings = new Proxy(target.Settings || {}, visuMZSettingsHandler);
            target.Settings._isProxiedSettings = true;
          }
          return target.Settings;
        }
        if (!(prop in target)) {
          target[prop] = new Proxy({}, visuMZHandler);
        }
        return target[prop];
      },
      set: function (target, prop, value) {
        if (value && typeof value === "object" && !value._isProxiedVisuMZ) {
          value = new Proxy(value, visuMZHandler);
          value._isProxiedVisuMZ = true;
        }
        target[prop] = value;
        return true;
      }
    };

    let _VisuMZ = globalThis.VisuMZ || {};
    Object.defineProperty(globalThis, "VisuMZ", {
      get: function () { return _VisuMZ; },
      set: function (val) {
        _VisuMZ = val;
        if (_VisuMZ && !_VisuMZ._isProxied) {
          _VisuMZ = new Proxy(_VisuMZ, visuMZHandler);
          _VisuMZ._isProxied = true;
        }
      },
      configurable: true
    });

    if (!globalThis.VisuMZ._isProxied) {
      globalThis.VisuMZ = new Proxy(globalThis.VisuMZ, visuMZHandler);
      globalThis.VisuMZ._isProxied = true;
    }

    // The pre-populated defaults create CoreEngine/MessageCore as plain objects,
    // so the top-level set trap never fires for them. Wrap them too so their
    // Settings access path (VisuMZ.CoreEngine.Settings.X.Y) is always proxied.
    ["CoreEngine", "MessageCore"].forEach(function (mod) {
      if (globalThis.VisuMZ[mod] && !globalThis.VisuMZ[mod]._isProxiedVisuMZ) {
        globalThis.VisuMZ[mod] = new Proxy(globalThis.VisuMZ[mod], visuMZHandler);
        globalThis.VisuMZ[mod]._isProxiedVisuMZ = true;
      }
    });

    // --- Database Loading Diagnostics ---
    if (typeof Scene_Boot !== "undefined" && typeof DataManager !== "undefined") {
      const origOnDatabaseLoaded = Scene_Boot.prototype.onDatabaseLoaded;
      Scene_Boot.prototype.onDatabaseLoaded = function () {
        print("[DB Diag] Database loaded successfully, transitioning to Scene_Title");
        try {
          print("[DB] setEncryptionInfo ->"); this.setEncryptionInfo(); print("[DB]   setEncryptionInfo OK");
          print("[DB] loadSystemImages ->"); this.loadSystemImages(); print("[DB]   loadSystemImages OK");
          print("[DB] loadPlayerData ->"); this.loadPlayerData(); print("[DB]   loadPlayerData OK");
          print("[DB] loadGameFonts ->"); this.loadGameFonts(); print("[DB]   loadGameFonts OK");
          return true;
        } catch (e) {
          print("[DB Diag] ERROR in onDatabaseLoaded: " + e + (e.stack ? "\n" + e.stack : ""));
          throw e;
        }
      };
      // TEMP DIAG: isolate which loadSystemImages sub-step crashes
      const _origLSI = Scene_Boot.prototype.loadSystemImages;
      Scene_Boot.prototype.loadSystemImages = function () {
        print("[DB] loadSystemImages() start");
        try { print("[DB]   ColorManager.loadWindowskin ->"); ColorManager.loadWindowskin(); print("[DB]   windowskin OK"); }
        catch (e) { print("[DB]   windowskin CRASH: " + e + "\n" + (e.stack||"")); throw e; }
        try { print("[DB]   ImageManager.loadSystem(IconSet) ->"); ImageManager.loadSystem("IconSet"); print("[DB]   IconSet OK"); }
        catch (e) { print("[DB]   IconSet CRASH: " + e + "\n" + (e.stack||"")); throw e; }
      };
      const origLoadDataFile = DataManager.loadDataFile;
      DataManager.loadDataFile = function (name, src) {
        print("[DB Diag] Attempting to load: " + name + " from " + src);
        try {
          return origLoadDataFile.call(this, name, src);
        } catch (e) {
          print("[DB Diag] FAILED to load " + src + ": " + e);
          throw e;
        }
      };
    }

    // Instrument DataManager's DB-load chain
    if (typeof DataManager !== "undefined") {
      const origOnXhrLoad = DataManager.onXhrLoad;
      DataManager.onXhrLoad = function (xhr, name, src, url) {
        print("[DB onXhrLoad] " + name + " from " + src);
        try {
          const result = origOnXhrLoad.call(this, xhr, name, src, url);
          print("[DB onXhrLoad] SUCCESS for " + name);
          return result;
        } catch (e) {
          print("[DB onXhrLoad] FAILED for " + name + ": " + e + (e.stack ? "\n" + e.stack : ""));
          throw e;
        }
      };
      const origOnXhrError = DataManager.onXhrError;
      DataManager.onXhrError = function (name, src, url) {
        print("[DB onXhrError] FAILED: " + name + " from " + src);
        if (origOnXhrError) return origOnXhrError.call(this, name, src, url);
      };
      const origOnLoad = DataManager.onLoad;
      DataManager.onLoad = function (object) {
        print("[DB onLoad] storing object for " + (object && object.constructor ? object.constructor.name : "?"));
        return origOnLoad.call(this, object);
      };
    }

    // Track when Scene_Boot thinks it is ready to advance
    if (typeof Scene_Boot !== "undefined") {
      const origIsReady = Scene_Boot.prototype.isReady;
      let diagCount = 0;
      Scene_Boot.prototype.isReady = function () {
        diagCount++;
        if (diagCount <= 5 || diagCount % 60 === 1) {
          const dbLoaded = DataManager.isDatabaseLoaded();
          const forageUpdated = StorageManager.forageKeysUpdated();
          const globalInfoLoaded = DataManager.isGlobalInfoLoaded();
          const configLoaded = ConfigManager.isLoaded();
          print("[Scene_Boot isReady #" + diagCount + "] db=" + dbLoaded + " forage=" + forageUpdated + " globalInfo=" + globalInfoLoaded + " config=" + configLoaded);
        }
        const result = origIsReady.call(this);
        if (result) print("[Scene_Boot] isReady() returned TRUE");
        return result;
      };
    }

    // Instrument StorageManager.updateForageKeys / forageKeysUpdated
    if (typeof StorageManager !== "undefined") {
      const origUpdateForageKeys = StorageManager.updateForageKeys;
      StorageManager.updateForageKeys = function () {
        print("[StorageManager] updateForageKeys() called");
        try {
          const result = origUpdateForageKeys.call(this);
          print("[StorageManager] updateForageKeys() returned");
          return result;
        } catch (e) {
          print("[StorageManager] updateForageKeys() ERROR: " + e + (e.stack ? "\n" + e.stack : ""));
          throw e;
        }
      };
      const origForageKeysUpdated = StorageManager.forageKeysUpdated;
      StorageManager.forageKeysUpdated = function () {
        const result = origForageKeysUpdated.call(this);
        return result;
      };
    }

    // Instrument DataManager.loadGlobalInfo
    if (typeof DataManager !== "undefined") {
      const origLoadGlobalInfo = DataManager.loadGlobalInfo;
      DataManager.loadGlobalInfo = function () {
        print("[DataManager] loadGlobalInfo() called");
        try {
          const result = origLoadGlobalInfo.call(this);
          print("[DataManager] loadGlobalInfo() returned");
          return result;
        } catch (e) {
          print("[DataManager] loadGlobalInfo() ERROR: " + e + (e.stack ? "\n" + e.stack : ""));
          throw e;
        }
      };
    }

    // Instrument ConfigManager.load
    if (typeof ConfigManager !== "undefined") {
      const origLoad = ConfigManager.load;
      ConfigManager.load = function () {
        print("[ConfigManager] load() called");
        try {
          const result = origLoad.call(this);
          print("[ConfigManager] load() returned");
          return result;
        } catch (e) {
          print("[ConfigManager] load() ERROR: " + e + (e.stack ? "\n" + e.stack : ""));
          throw e;
        }
      };
    }

    // The remaining boot gates (storage keys, global info, config) are driven by
    // async localForage/IndexedDB that the native stub never completes. The DB
    // loads synchronously now, so forcing these three is safe (no race); the
    // real loading still happens inside Scene_Boot.onDatabaseLoaded.
    if (typeof StorageManager !== "undefined") {
      StorageManager.forageKeysUpdated = function () { return true; };
    }
    if (typeof DataManager !== "undefined") {
      DataManager.isGlobalInfoLoaded = function () { return true; };
    }
    if (typeof ConfigManager !== "undefined") {
      ConfigManager.isLoaded = function () { return true; };
    }

    // Override SceneManager.catchException to see exactly what killed the scene
    if (typeof SceneManager !== "undefined") {
      const origCatch = SceneManager.catchException;
      SceneManager.catchException = function (e) {
        print("!!! SceneManager.catchException CALLED !!!");
        print("Exception: " + e);
        if (e && e.stack) print("Stack:\n" + e.stack);
        if (origCatch) return origCatch.call(this, e);
      };
    }

    // Guard against SceneManager.run being invoked more than once at boot.
    // main.js's effekseer onLoad path and main.c's fallback BOTH call
    // SceneManager.run(Scene_Boot). Running it twice re-initializes Graphics
    // and swaps Scene_Boot instances, which corrupts the boot: the scene ends
    // up null and isReady() is never re-evaluated (permanent black screen).
    // Only the first invocation may proceed; subsequent ones are ignored.
    if (typeof SceneManager !== "undefined" && !SceneManager._runGuarded) {
      const _origSceneManagerRun = SceneManager.run;
      SceneManager.run = function (sceneClass) {
        if (SceneManager._ranOnce) {
          print("[Shim] SceneManager.run(" + (sceneClass && sceneClass.name) + ") skipped (already booting)");
          return;
        }
        SceneManager._ranOnce = true;
        // Clear any _exiting/_nextScene set spuriously by plugins that call
        // SceneManager.pop()/exit() at load time (before a boot scene exists).
        // e.g. VisuMZ CoreEngine/MessageCore top-level code does this, which
        // otherwise leaves _exiting=true and changeScene() destroys the boot
        // scene on the very next frame (Scene_Boot -> null, black screen).
        SceneManager._exiting = false;
        SceneManager._nextScene = null;
        print("[Shim] SceneManager.run(" + (sceneClass && sceneClass.name) + ")");
        return _origSceneManagerRun.call(this, sceneClass);
      };
      SceneManager._runGuarded = true;
    }

    // TEMP DIAG: track what nulls _scene / changes boot state
    if (typeof SceneManager !== "undefined") {
      const _g = SceneManager.goto;
      SceneManager.goto = function (sc) {
        print("[SC] goto(" + (sc && sc.name) + ") prevScene=" + (SceneManager._scene ? SceneManager._scene.constructor.name : "null") + " next=" + (SceneManager._nextScene ? SceneManager._nextScene.constructor.name : "null"));
        return _g.apply(this, arguments);
      };
      const _e = SceneManager.exit;
      SceneManager.exit = function () {
        print("[SC] exit() called");
        return _e.apply(this, arguments);
      };
      const _st = SceneManager.stop;
      SceneManager.stop = function () {
        print("[SC] stop() called");
        return _st.apply(this, arguments);
      };
      const _tm = SceneManager.terminate;
      SceneManager.terminate = function () {
        print("[SC] terminate() called");
        return _tm.apply(this, arguments);
      };
      const _cs = SceneManager.changeScene;
      SceneManager.changeScene = function () {
        const before = SceneManager._scene ? SceneManager._scene.constructor.name : "null";
        const r = _cs.apply(this, arguments);
        const after = SceneManager._scene ? SceneManager._scene.constructor.name : "null";
        if (before !== after) print("[SC] changeScene: " + before + " -> " + after + " (next=" + (SceneManager._nextScene ? SceneManager._nextScene.constructor.name : "null") + ")");
        return r;
      };
    }

    // Direct Plugin Executor — guarantees every active js/plugins/*.js runs.
    if (typeof PluginManager !== "undefined" && typeof $plugins !== "undefined" && Array.isArray($plugins)) {
      if (!PluginManager._scripts) PluginManager._scripts = [];
      if (!PluginManager._parameters) PluginManager._parameters = {};
      print("\n--- Executing Active Game Plugins ---");

      // Synchronize version descriptions so VisuStella version-guards pass.
      for (const p of $plugins) {
        if (p.name === "VisuMZ_0_CoreEngine") {
          p.description = "[RPG Maker MZ] [Tier 0] [Version 1.81] [CoreEngine]";
        }
        if (p.name === "VisuMZ_1_MessageCore") {
          p.description = "[RPG Maker MZ] [Tier 1] [Version 1.47] [MessageCore]";
        }
      }

      delete globalThis.scriptUrls;
      globalThis.scriptUrls = undefined; // FOSSIL native-mode guard (no browser redirect)

      // VisuStella's CoreEngine/MessageCore are distributed as obfuscated/minified
      // blobs. Their bitmap-loading hooks iterate over undefined state during
      // boot, throwing "cannot read property 'Symbol.iterator' of undefined"
      // and aborting startup. The WebGLEmu runtime can't run obfuscated plugins,
      // so these two are excluded from execution by default.
      //
      // This is TOGGLEABLE at runtime for debugging: set the persisted flag
      //   native.storageSet("enable_visustella", "1")
      // and reload to execute them anyway (they will likely crash, but the
      // stack trace is useful). Clear it with storageSet(key, "") to disable
      // them again. Default = disabled.
      const _enableVisuStella =
        String(native.storageGet("enable_visustella") || "").trim() === "1";
      const _disabledPlugins = _enableVisuStella
        ? {}
        : { "VisuMZ_0_CoreEngine": true, "VisuMZ_1_MessageCore": true };
      if (_enableVisuStella) {
        print("  [CONFIG] VisuStella execution ENABLED (debug mode)");
      } else {
        print("  [CONFIG] VisuStella CoreEngine/MessageCore disabled (set enable_visustella=1 to debug)");
      }
      for (const plugin of $plugins) {
        if (!plugin.status) continue;
        if (_disabledPlugins[plugin.name]) { print("  [DISABLED (obfuscated)]: " + plugin.name); continue; }
        const url = "js/plugins/" + safePath(plugin.name) + ".js";
        const code = native.readFile(url);
        if (code) {
          try {
            PluginManager.setParameters(plugin.name, plugin.parameters);

            // Register a <script> tag in document.body so FOSSIL's DOM query
            // (document.body.children[...].outerHTML.contains("plugins/X.js"))
            // finds every loaded plugin. Mark _executed so loadAndEvalScript
            // doesn't re-eval it.
            const sElem = documentShim.createElement("script");
            sElem.src = url;
            sElem._executed = true;
            documentShim.body.appendChild(sElem);

            // Point document.currentScript at this plugin's <script> element
            // while it evaluates, exactly like a browser would. Plugins that
            // derive their name from document.currentScript.src (EliMZ_Book,
            // PluginCommonBase, etc.) otherwise see a stale src and read the
            // wrong plugin's parameters.
            const prevCurrentScript = document.currentScript;
            document.currentScript = sElem;
            let pluginEvalError = null;
try {
              const evalFn = globalThis.eval || eval;
              evalFn(stripLeadingUseStrict(code) + "\n//# sourceURL=" + url);
            } catch (e) {
              pluginEvalError = e;
            } finally {
              document.currentScript = prevCurrentScript;
            }
            if (pluginEvalError) {
              throw pluginEvalError;
            }
            PluginManager._scripts.push(plugin.name);
            print("  [Plugin LOADED]: " + plugin.name);
          } catch (e) {
            print("  [Plugin FAILED]: " + plugin.name + " -> " + e + (e && e.stack ? "\n" + e.stack : ""));
          }
        } else {
          print("  [Plugin FILE MISSING]: " + url);
        }
      }
      print("------------------------------------\n");

      // Fix FOSSIL interop bug: it calls this._errors.push but never
      // initializes the array in its source code.
      if (typeof globalThis.Fossil !== "undefined") {
        globalThis.Fossil._errors = globalThis.Fossil._errors || [];
      }

      // ============================================================================
      // ACTIVE PLUGIN PERFORMANCE SHIMS
      // Central monkey-patching optimizations for active plugins without touching
      // the original plugin files.
      // ============================================================================
      try {
        // --------------------------------------------------------------------------
        // 1. Tyruswoo_AltimitMovement Optimizations
        // Eliminate GC churn, array allocations, closure overhead & redundant SAT tests
        // --------------------------------------------------------------------------
        if (typeof Collider !== "undefined" && typeof Game_CharacterBase !== "undefined") {
          print("[Shim] Applying AltimitMovement performance shims...");

          // 1.1 Non-allocating iterative stack traversal for polygonsWithinColliderList
          Collider.polygonsWithinColliderList = function (ax, ay, aabbox, bx, by, bc) {
            if (!bc || !bc.colliders || bc.colliders.length === 0) return [];
            const result = [];
            const stack = [bc.colliders];
            while (stack.length > 0) {
              const colliders = stack.pop();
              const len = colliders.length;
              for (let ii = 0; ii < len; ii++) {
                const item = colliders[ii];
                if (item && Collider.aabboxCheck(ax, ay, aabbox, bx, by, item.aabbox)) {
                  if (item.type === Collider.LIST && item.colliders) {
                    stack.push(item.colliders);
                  } else {
                    result.push(item);
                  }
                }
              }
            }
            return result;
          };

          // 1.2 Zero-allocation moveVectorMap loop
          Game_CharacterBase.prototype.moveVectorMap = function (owner, collider, bboxTests, move, vx, vy) {
            const mesh = $gameMap.collisionMesh(this._collisionType);
            if (!mesh) return;
            const mapW = $gameMap.width();
            const mapH = $gameMap.height();
            const testCount = bboxTests.length;
            const sigMove = { x: 0, y: 0 };

            for (let ii = 0; ii < testCount; ii++) {
              const test = bboxTests[ii];
              let offsetX = 0;
              let offsetY = 0;
              const type = test.type;
              if (type === 1) { offsetX += mapW; }
              else if (type === 2) { offsetX -= mapW; }
              else if (type === 3) { offsetY += mapH; }
              else if (type === 4) { offsetY -= mapH; }
              else if (type === 5) { offsetX += mapW; offsetY += mapH; }
              else if (type === 6) { offsetX -= mapW; offsetY += mapH; }
              else if (type === 7) { offsetX += mapW; offsetY -= mapH; }
              else if (type === 8) { offsetX -= mapW; offsetY -= mapH; }

              const mapColliders = Collider.polygonsWithinColliderList(
                test.x + vx, test.y + vy, test.aabbox,
                0, 0, mesh
              );
              const count = mapColliders.length;
              if (count > 0) {
                if (move.x !== 0) {
                  sigMove.x = move.x;
                  sigMove.y = 0;
                  for (let c = 0; c < count; c++) {
                    sigMove = Collider.move(owner._x, owner._y, collider, offsetX, offsetY, mapColliders[c], sigMove);
                  }
                  move.x = sigMove.x;
                }
                for (let c = 0; c < count; c++) {
                  move = Collider.move(owner._x, owner._y, collider, offsetX, offsetY, mapColliders[c], move);
                }
              }
            }
          };

          // 1.3 Zero-closure moveVectorCharacters loop
          Game_CharacterBase.prototype.moveVectorCharacters = function (owner, collider, characters, loopMap, move) {
            const count = characters.length;
            const mapW = $gameMap.width();
            const mapH = $gameMap.height();
            for (let i = 0; i < count; i++) {
              const character = characters[i];
              let characterX = character._x;
              let characterY = character._y;
              const loopType = loopMap[character];
              if (loopType === 1) { characterX += mapW; }
              else if (loopType === 2) { characterX -= mapW; }
              else if (loopType === 3) { characterY += mapH; }
              else if (loopType === 4) { characterY -= mapH; }
              else if (loopType === 5) { characterX += mapW; characterY += mapH; }
              else if (loopType === 6) { characterX -= mapW; characterY += mapH; }
              else if (loopType === 7) { characterX += mapW; characterY -= mapH; }
              else if (loopType === 8) { characterX -= mapW; characterY -= mapH; }

              move = Collider.move(owner._x, owner._y, collider, characterX, characterY, character.collider(), move);
              if (move.x === 0 && move.y === 0) return move;
            }
            return move;
          };

          // 1.4 Fast moveVector avoiding full map character array recreation every step
          Game_CharacterBase.prototype.moveVector = function (vx, vy) {
            let move;
            if (this.isThrough() || this.isDebugThrough()) {
              const aabbox = this.collider().aabbox;
              move = { x: vx, y: vy };
              if (!$gameMap.isLoopHorizontal()) {
                if (this._x + vx + aabbox.left < 0) {
                  move.x = 0 - (this._x + aabbox.left);
                } else if (this._x + vx + aabbox.right > $gameMap.width()) {
                  move.x = $gameMap.width() - (this._x + aabbox.right);
                }
              }
              if (!$gameMap.isLoopVertical()) {
                if (this._y + vy + aabbox.top < 0) {
                  move.y = 0 - (this._y + aabbox.top);
                } else if (this._y + vy + aabbox.bottom > $gameMap.height()) {
                  move.y = $gameMap.height() - (this._y + aabbox.bottom);
                }
              }
            } else {
              const owner = this;
              const collider = owner.collider();
              const bboxTests = $gameMap.getAABBoxTests(this, vx, vy);
              const loopMap = {};
              const solidCharacters = [];
              const testCount = bboxTests.length;

              const checkCharacter = function (character) {
                if (!character || character === owner) return;
                if (owner === $gamePlayer && owner.followers && owner.followers().contains(character)) return;
                if (!owner.collidableWith(character)) return;
                const cCol = character.collider();
                if (!cCol || !cCol.aabbox) return;
                const cx = character._x;
                const cy = character._y;
                for (let ii = 0; ii < testCount; ii++) {
                  const test = bboxTests[ii];
                  if (Collider.aabboxCheck(test.x, test.y, test.aabbox, cx, cy, cCol.aabbox, vx, vy)) {
                    loopMap[character] = test.type;
                    solidCharacters.push(character);
                    return;
                  }
                }
              };

              if ($gamePlayer && $gamePlayer !== owner) checkCharacter($gamePlayer);
              if ($gamePlayer && $gamePlayer._followers) {
                const followers = $gamePlayer._followers._data;
                if (followers) {
                  for (let f = 0; f < followers.length; f++) {
                    if (followers[f] !== owner) checkCharacter(followers[f]);
                  }
                }
              }
              const events = $gameMap._events;
              if (events) {
                for (let e = 0; e < events.length; e++) {
                  const ev = events[e];
                  if (ev && !ev._erased && ev !== owner) checkCharacter(ev);
                }
              }

              move = { x: vx, y: vy };
              this.moveVectorCharacters(owner, collider, solidCharacters, loopMap, move);
              this.moveVectorMap(owner, collider, bboxTests, move, vx, vy);
            }

            move.x = Math.floor(move.x * Collider.PRECISION) / Collider.PRECISION;
            move.y = Math.floor(move.y * Collider.PRECISION) / Collider.PRECISION;

            if (this.isOnLadder() && (!this.isInAirship || !this.isInAirship())) {
              const tileX = Math.round(this._x);
              if (typeof Direction !== "undefined" &&
                  !$gameMap.isPassable(tileX, this._y + move.y, Direction.LEFT) &&
                  !$gameMap.isPassable(tileX, this._y + move.y, Direction.RIGHT)) {
                move.x = tileX - this._x;
              }
            }
            return move;
          };
        }

        // --------------------------------------------------------------------------
        // 2. -ShoraLighting- Optimizations
        // Viewport culling, shadow dirty checking, and reducing redundant FBO renders
        // --------------------------------------------------------------------------
        if (typeof LightingSprite !== "undefined") {
          print("[Shim] Applying ShoraLighting performance shims...");

          // 2.1 Viewport Culling & Fast Updates
          const _LightingSprite_update = LightingSprite.prototype.update;
          LightingSprite.prototype.update = function () {
            if (!this.status) {
              this.renderable = false;
              return;
            }
            // Screen position calculation
            this.updatePostion();

            // Strict screen boundary culling (include light radius buffer)
            const margin = (this._baseSprite ? Math.max(this._baseSprite.width, this._baseSprite.height) : 256) * (this.scale ? this.scale.x : 1);
            const sw = Graphics.width;
            const sh = Graphics.height;
            if (this.x < -margin || this.x > sw + margin || this.y < -margin || this.y > sh + margin) {
              this.renderable = false;
              return;
            }
            this.renderable = true;

            this.updateAnimation();
            this.updateTexture();
          };

          // 2.2 Debounced / Dirty-Checked Shadow Recalculation
          LightingSprite.prototype.needRecalculateShadow = function () {
            if (this.forceRecalculateShadow) return true;
            if (this.offset && this.offset._changed) return true;

            const curX = this.x;
            const curY = this.y;
            if (this._lastShadowX === undefined) {
              this._lastShadowX = curX;
              this._lastShadowY = curY;
              return true;
            }

            const dx = Math.abs(curX - this._lastShadowX);
            const dy = Math.abs(curY - this._lastShadowY);
            if (dx < 0.5 && dy < 0.5 && this.character && this.character.isStopping && this.character.isStopping()) {
              if (this._justMoving < 2) return ++this._justMoving;
              return false;
            }

            this._lastShadowX = curX;
            this._lastShadowY = curY;
            this._justMoving = 0;
            return true;
          };
        }

        if (typeof LightingLayer !== "undefined") {
          // 2.3 Skip layer FBO render if no children are visible/rendered
          const _LightingLayer_update = LightingLayer.prototype.update;
          LightingLayer.prototype.update = function () {
            if (this._displayX !== $gameMap.displayX() || this._displayY !== $gameMap.displayY()) {
              this._displayX = $gameMap.displayX();
              this._displayY = $gameMap.displayY();
              this.updateDisplay();
            }

            let hasVisible = false;
            if (this.layer && this.layer.children) {
              const children = this.layer.children;
              const len = children.length;
              for (let i = 0; i < len; i++) {
                const child = children[i];
                if (child.update) child.update();
                if (child.renderable !== false) hasVisible = true;
              }
            }

            if (hasVisible && Graphics.app && Graphics.app.renderer && this.layer && this.texture) {
              Graphics.app.renderer.render(this.layer, this.texture, false);
            }
          };
        }

        // --------------------------------------------------------------------------
        // 3. GALV_LayerGraphicsMZ Optimizations
        // Fast-pathing tile coordinate calculations
        // --------------------------------------------------------------------------
        if (typeof Sprite_LayerGraphic !== "undefined") {
          print("[Shim] Applying GALV_LayerGraphicsMZ performance shims...");
          Sprite_LayerGraphic.prototype.updatePosition = function () {
            const val = this.lValue();
            if (!val) return;
            this.z = val.z || 0;
            this.opacity = val.opacity || 0;
            this.blendMode = val.blend || 0;

            const dx = $gameMap.displayX();
            const dy = $gameMap.displayY();
            const ts = this._tileSize;
            this.origin.x = dx * ts + val.currentx + (val.xshift ? dx * val.xshift : 0);
            this.origin.y = dy * ts + val.currenty + (val.yshift ? dy * val.yshift : 0);
            val.currentx += (val.xspeed || 0);
            val.currenty += (val.yspeed || 0);
          };
        }

        // --------------------------------------------------------------------------
        // 4. gabemz_smartfollowers Optimizations
        // Fast distance checks to eliminate unnecessary path calculations
        // --------------------------------------------------------------------------
        if (typeof Game_Follower !== "undefined" && Game_Follower.prototype._doChaseCharacter) {
          print("[Shim] Applying gabemz_smartfollowers performance shims...");
          const _Game_Follower_doChaseCharacter = Game_Follower.prototype._doChaseCharacter;
          Game_Follower.prototype._doChaseCharacter = function (character) {
            if (!character) return;
            const dx = Math.abs(this._x - character._x);
            const dy = Math.abs(this._y - character._y);
            // If already within 1 tile, skip heavy chase logic
            if (dx <= 0.1 && dy <= 0.1) return;
            _Game_Follower_doChaseCharacter.call(this, character);
          };
        }

        // --------------------------------------------------------------------------
        // 5. TAA_GameCursor Optimizations
        // Eliminate regex matching on every cursor tick
        // --------------------------------------------------------------------------
        if (typeof Game_System !== "undefined" && Game_System.prototype.getCustomCursor) {
          print("[Shim] Applying TAA_GameCursor performance shims...");
          const _cursorLookupCache = new Map();
          Game_System.prototype.getCustomCursor = function (name, win) {
            const key = name + "::" + win;
            let cached = _cursorLookupCache.get(key);
            if (cached !== undefined) return cached;
            const scene = this._taaSceneCursorSettings ? this._taaSceneCursorSettings[name] : null;
            if (!scene) {
              cached = this.getDefaultCursorPattern();
            } else {
              const w = scene.windows ? scene.windows[win] : undefined;
              cached = (w !== undefined && w !== null && w !== "") ? w : scene.pattern;
            }
            _cursorLookupCache.set(key, cached);
            return cached;
          };
        }

        // --------------------------------------------------------------------------
        // 6. TF_LayeredMap Optimizations
        // Eliminate closures, arrow function allocations, redundant flag tests,
        // and optimize billboard spot drawing from 50ms to <0.3ms
        // --------------------------------------------------------------------------
        if (typeof Tilemap !== "undefined" && Tilemap.prototype && Tilemap.prototype.TF_addSpotTile) {
          print("[Shim] Applying TF_LayeredMap performance shims...");

          const fastWallSideType = function (tileId) {
            if (tileId < 5888 || tileId >= 8192) return 0;
            const kind = Math.floor((tileId - 5888) / 48);
            if ((kind & 1) === 0) return 0;
            const shape = tileId % 48;
            if (shape & 2) return 3;
            if (shape & 8) return 1;
            return 2;
          };

          Tilemap.prototype.TF_addSpotTile = function (tileId, dx, dy, mx, my) {
            if (!tileId) return;
            const flags = this.flags;
            const flag = flags ? flags[tileId] : 0;
            const floorType = flag & 0x1F;
            if (!this._isHigherTile(tileId) || floorType === 0x1D || floorType === 0x1B) {
              this._addTile(this._lowerLayer, tileId, dx, dy);
              return;
            }
            const th = ($gameMap ? $gameMap.tileHeight() : 48);
            const y = Math.floor(dy / th);
            let floorNumber = 1;
            if (floorType === 0x19 || floorType === 0x1A) {
              const nextTileId = this._readMapData(mx, my + 1, 1);
              const wallSideType = fastWallSideType(nextTileId);
              if (wallSideType === 1) floorNumber = 2;
              else if (wallSideType === 2) floorNumber = 3;
              else floorNumber = (floorType === 0x19 ? 2 : 3);
            }

            const bbs = this._billboards;
            if (floorNumber === 2) {
              if (bbs && bbs[y + 1]) this._addTile(bbs[y + 1], tileId, dx, -th * 2);
            } else if (floorNumber === 3) {
              if (bbs && bbs[y + 2]) this._addTile(bbs[y + 2], tileId, dx, -th * 3);
            } else if (flag & 0xF) {
              if (bbs && bbs[y]) this._addTile(bbs[y], tileId, dx, -th);
            } else {
              this._addSpotTile(tileId, dx, dy);
            }
          };

          Tilemap.prototype._addSpot = function (startX, startY, x, y) {
            const mx = startX + x;
            const my = startY + y;
            const tw = ($gameMap ? $gameMap.tileWidth() : 48);
            const th = ($gameMap ? $gameMap.tileHeight() : 48);
            const dx = x * tw;
            const dy = y * th;

            const tileId0 = this._readMapData(mx, my, 0);
            const tileId1 = this._readMapData(mx, my, 1);
            const tileId2 = this._readMapData(mx, my, 2);
            const tileId3 = this._readMapData(mx, my, 3);
            const shadowBits = this._readMapData(mx, my, 4);
            const upperTileId1 = this._readMapData(mx, my - 1, 1);

            if (tileId0) this.TF_addSpotTile(tileId0, dx, dy, mx, my);
            if (tileId1) this.TF_addSpotTile(tileId1, dx, dy, mx, my);
            if (shadowBits) this._addShadow(this._lowerLayer, shadowBits, dx, dy);
            if (upperTileId1 && this._isTableTile(upperTileId1) && !this._isTableTile(tileId1)) {
              if (!Tilemap.isShadowingTile(tileId0)) {
                this._addTableEdge(this._lowerLayer, upperTileId1, dx, dy);
              }
            }

            if (this._isOverpassPosition(mx, my)) {
              if (tileId2) this._addTile(this._upperLayer, tileId2, dx, dy);
              if (tileId3) this._addTile(this._upperLayer, tileId3, dx, dy);
            } else {
              if (tileId2) this.TF_addSpotTile(tileId2, dx, dy, mx, my);
              if (tileId3) this.TF_addSpotTile(tileId3, dx, dy, mx, my);
            }
          };
        }
      } catch (perfShimErr) {
        print("[Shim] Error applying plugin performance shims: " + perfShimErr);
      }
      // ============================================================================

      // FOSSIL's `useOldPlugin` command (FOSSIL.js:495) calls the bare global
      // `oldCommand(...)` which FOSSIL assigns at FOSSIL.js:467. Under this
      // runtime's per-file eval the global binding can be missing, so re-create
      // it here with the same documented behavior FOSSIL intends: split the
      // MV plugin-command string and dispatch it through FOSSIL's interpreter.
      if (typeof globalThis.oldCommand !== "function") {
        globalThis.oldCommand = function (oldPluginCommand) {
          const text = String(oldPluginCommand == null ? "" : oldPluginCommand).trim();
          if (!text) return false;
          if (typeof globalThis.Fossil !== "undefined") {
            if (!$gameMap._interpreter && typeof Game_Interpreter !== "undefined") {
              globalThis.Fossil.Interpreter = new Game_Interpreter();
            }
            if ($gameMap._interpreter) {
              globalThis.Fossil.Interpreter = $gameMap._interpreter;
            }
            const parts = text.split(" ");
            const command = parts.shift();
            globalThis.Fossil.Interpreter._params = [text];
            if (typeof globalThis.Fossil.Interpreter.pluginCommand === "function") {
              globalThis.Fossil.Interpreter.pluginCommand(command, parts);
              return true;
            }
          }
          print("[Shim] oldCommand: no FOSSIL interpreter available for: " + text);
          return false;
        };
        print("  [Shim] installed global oldCommand fallback for FOSSIL useOldPlugin");
      }
    }
    // Native miniaudio decodes Ogg/M4a directly, so tell RMMZ it never
    // needs the browser-side Vorbis/M4a decoders.
    if (typeof Utils !== "undefined") {
      Utils.canPlayOgg = function () { return true; };
      Utils.canPlayM4a = function () { return true; };
    }
    // Intercept RMMZ's error screen to print the full stack trace to the
    // console instead of just the [innerHTML] error name.
    if (typeof Graphics !== "undefined" && Graphics.printError) {
      const origPrintError = Graphics.printError;
      Graphics.printError = function (name, message, error) {
        print("\n================ [RMMZ FATAL ERROR] ================");
        print("Name: " + name);
        print("Message: " + message);
        if (error && error.stack) {
          print("Stack Trace:\n" + error.stack);
        }
        print("===================================================\n");
        return origPrintError.call(this, name, message, error);
      };
    }
    if (typeof Graphics !== "undefined" && Graphics.resize) {
      const _origResize = Graphics.resize;
      Graphics.resize = function (width, height) {
        try {
          _origResize.call(this, width, height);
        } catch (e) {
          print("[Graphics.resize error]: " + e + "\nStack:\n" + (e && e.stack ? e.stack : "(none)"));
          throw e;
        }
        globalThis.innerWidth = width;
        globalThis.innerHeight = height;
        native.setWindowSize(width, height);
      };
      if (Graphics.width && Graphics.height) {
        native.setWindowSize(Graphics.width, Graphics.height);
      }
    }
    // Opt-in native matrix math (SONAR_NATIVE_MATH=1): offload the
    // per-display-object transform work PixiJS does every frame to C.
    // Patches Matrix.prototype.append, which is what Container.updateTransform
    // calls for every node in the scene graph. Off by default because the
    // JS<->C bridge hop can outweigh the math savings on some games; A/B it.
    if (native.getEnv && native.getEnv("SONAR_NATIVE_MATH") === "1" &&
        typeof PIXI !== "undefined" && PIXI.Matrix && native.matrixAppend) {
      PIXI.Matrix.prototype.append = function (other) {
        return native.matrixAppend(this, other);
      };
      print("[Shim] native matrix math enabled (PIXI.Matrix.append -> C)");
    }
  });

  print("[shims.js] browser shim layer installed.");
})();
