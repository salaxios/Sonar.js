Here's the full project appraisal:
Sonar.js — Project Handoff
What It Is
Sonar.js (Salaxios Open NAtive Runtime) is a native C desktop runtime for RPG Maker MZ games, replacing the browser/NW.js environment entirely. The goal is an "EasyRPG but for RPGMaker MZ" — a complete software emulation layer for PixiJS v5 WebGL applications. Currently runs the game "Locust" (a plugin-heavy RPG Maker MZ project with 67+ active plugins).
Tech Stack
Component	Library	Version	Purpose
JS Engine	quickjs-ng	0.16.1	No JIT, no WASM — lightweight JS evaluation
Windowing/Input	SDL3	3.5.0	Platform abstraction, GL context, gamepad
Graphics	OpenGL 4.1 Core via GLAD	—	WebGL2 rendering via native GL
Audio	miniaudio	0.11.25	BGM/BGS/ME/SE playback via stb_vorbis
Image Loading	stb_image	—	PNG/JPG/BMP decoding
Font Rasterization	stb_truetype	—	TTF glyph rendering
OGG Decoding	stb_vorbis	1.22	Ogg Vorbis audio decoding for miniaudio
Profiling	Tracy	—	Live profiling on port 8086
Math	matrix_math.h	—	Custom 3x3/4x4 matrix ops
Build: CMake 3.20+, C11, builds with MinGW/MSVC/Clang/GCC. Currently configured for MSYS2 ucrt64 Ninja build. Output: build/rmmz_native.exe.
Architecture (3 Layers)
1. C Runtime (src/main.c — 1494 lines, src/native_gl.c)
The C layer handles:
- SDL window creation (1280×720, OpenGL 4.1 Core, vsync)
- QuickJS runtime/context setup
- Script loading via eval_file() (reads file → JS_Eval)
- 38 JS bridge functions on globalThis.__native__:
- 15 audio functions (play, stop, uninit, set volume/pitch/pan/looping, fade, seek, isPlaying, getLength, getCursor, atEnd, engineVolume)
- GL functions via register_gl_bridge() (drawArrays, drawElements, texImage2D, bufferData, etc.)
- Utility: readFile, readFileBinary, decodeImage, rasterizeText, measureText, storageGet/Set, now, setWindowSize, quit, memoryUsage, matrix ops, tracy zones
- Main event loop: SDL_PollEvent → dispatch to JS __tick__ → JS_ExecutePendingJob → SDL_GL_SwapWindow
2. Browser Shim Layer (src/shims.js — 4210 lines)
Shims the entire browser DOM API for QuickJS:
- Window/Document: createElement, getElementById, body/head, querySelector, full EventTarget system
- Canvas: CanvasElementShim with software 2D rasterizer + WebGL2 context passthrough to native.gl
- Events: Event, KeyboardEvent, MouseEvent, WheelEvent with full property support
- XHR/Fetch: Async file loading via native.readFile/native.readFileBinary
- WebGL: Wraps native.gl with WebGL2RenderingContext prototype, strips precision for desktop GL, fixes Intel \0 null bytes in shader names
- localStorage: Backed by native.storageGet/native.storageSet
- Timers: setTimeout/setInterval/requestAnimationFrame backed by SDL timing
- NW.js/Node compat: process, require('fs'), require('path'), require('nw.gui')
- Effekseer: Full stub (particle effects deferred — WASM can't run under QuickJS)
- WebAssembly: All inert stubs
Key subsystems in shims.js:
- Script loading (loadAndEvalScript): DOM-based <script> tag injection → native file read → indirect eval. Guard: globalThis.__evaluatedUrls__ prevents double-evaluation.
- Incremental tilemap repaint (SONAR_TILEMAP_INCREMENTAL): Reuses previously painted tile rects, only repaints newly exposed rows/columns. Critical perf optimization.
- Text rendering caches: LRU caches for rasterized glyphs (600 entries) and text measurements (4000 entries).
- Plugin loading: Iterates $plugins array, reads js/plugins/<name>.js, evaluates with document.currentScript set. Skips VisuStella by default.
- Tracy profiling integration: Wraps SceneManager, Ticker, Map/Player/Character updates, tilemap internals.
- 67+ plugin performance shims: AltimitMovement, ShoraLighting, GALV_LayerGraphics, smartfollowers, GameCursor, TF_LayeredMap.
3. Audio Shim Layer (src/audio_shims.js — 249 lines)
Overrides every AudioManager method to route through native.audioPlay/etc.:
- BGM/BGS: Single handle each, looping, with save/restore cursor position
- ME: Single handle, temporarily stops BGM, restarts BGM when ME ends
- SE: Array of handles, deduplicated per frame, auto-cleaned when done
- Static SE: Pre-decoded/cached SE for cursor sounds etc.
- Volume model: (configVol × audioVol) / 10000 → 0.0–1.0
- Path construction: audio/bgm/ + encodeURIComponent(name) + .ogg
Key Build/Runtime Notes
- SDL_INIT_AUDIO is removed from SDL_Init() to prevent WASAPI device conflict with miniaudio
- Working directory changes to Project1/ at runtime via _chdir("Project1")
- shims.js is in the CMake POST_BUILD copy + a copy_shims ALL target so JS-only changes are picked up on every build
- audio_shims.js is NOT auto-copied — must be manually synced: cp src/audio_shims.js build/audio_shims.js
- build/Project1/ is the user's game — never overwritten by build (guarded by cmake/copy_project1.cmake)
- stb_vorbis.c includes need STB_VORBIS_NO_INTEGER_CONVERSION and #undef PLAYBACK_LEFT/RIGHT before inclusion to avoid Windows SDK macro conflicts
- vorbisdecoder.js is intentionally skipped in script loading — miniaudio handles OGG natively now
- No CI/CD — no GitHub Actions or similar configured
- Branch: experimental (latest commit: 004593c Audio works!)
Known Issues (from README)
Feature	Status
Vanilla RMMZ games	Runs with text rendering bugs
Fonts	Loads default font only
Icons in text	Shows entire icon sheet, not individual icons
Faces in messages	Shows entire face sheet
Community plugins	Variable — some work, many don't
VisuStella	Not supported yet (disabled by default)
Saving/Loading	Not working
Audio	Working (just implemented)
Battle scenes	Load but Effekseer particles don't work
Video playback	Not intended for implementation
Touch input	Not implemented
Keyboard (Z/X/arrows/shift)	Works
Current Limitations / Opportunities for Next Agent
1. Text rendering — Icons and face graphics are broken (show full sheets instead of individual elements)
2. Saving/loading — Not implemented
3. Plugin compatibility — Many community plugins don't work; VisuStella blocked
4. WASM — Can't run under QuickJS; Effekseer and vorbisdecoder are stubbed out
5. shims.js is 4210 lines — Large surface area for bugs; the incremental tilemap system is complex
6. No AGENTS.md — The project lacks agent-specific guidance
7. audio_shims.js not in CMake build — Must remember to manually sync after edits
8. Build is Ninja (msys64/ucrt64) — CMakeCache.txt in build/ is configured for this toolchain
Key File Paths
File	Role	Lines
src/main.c	C runtime, all JS bridges	1494
src/native_gl.c	GL bridge functions	~600
src/shims.js	Browser shim layer	4210
src/audio_shims.js	Audio backend	249
src/matrix_math.h	Matrix math	~200
CMakeLists.txt	Build config	138
third_party/miniaudio/miniaudio.h	Audio engine	95864
third_party/stb/stb_vorbis.c	OGG decoder	5584
Git Status
Clean working tree, branch experimental, up to date with origin/experimental. Latest commit: 004593c Audio works!.




1. Top-Level Directory Listing
.git/
.gitignore
ARCHITECTURE_DIAGRAM.txt
ARCHITECTURE.md
build-mingw/
build/
cmake/
CMakeLists.txt
compile commands.txt
compile_instructions.txt
icon.ico
LICENSE
OPENFOLDER.cmd
README.md
src/
third_party/
16 entries total. The project has two build directories (build/ and build-mingw/), a cmake/ helper folder, a src/ folder with C and JS source, and third_party/ containing vendored dependencies (quickjs-ng, SDL3, glad, stb, miniaudio, tracy).
2. CMakeLists.txt
File: C:\Users\Armin J\Documents\GitHub\Sonar.js\CMakeLists.txt (138 lines)
- Project name: rmmz_native (C and CXX, C11 standard)
- Dependencies:
- quickjs-ng (JavaScript engine, from third_party/quickjs-ng)
- SDL3 (static build, from third_party/SDL)
- glad (OpenGL loader, built as a static lib)
- stb and miniaudio (header-only includes)
- Tracy profiler (vendored, enabled with TRACY_ENABLE)
- Main executable rmmz_native is built from:
- src/main.c
- src/native_gl.c
- Platform handling: Windows icon resource via .rc.in, MinGW static linking, Apple/Win32/Linux OpenGL linking
- Post-build: Copies shims.js next to the executable, and optionally bootstraps src/Project1/ into the build tree
3. First 100 Lines of src/main.c
File: C:\Users\Armin J\Documents\GitHub\Sonar.js\src\main.c (1494 lines total)
This is the C runtime entry point. Key highlights from the first 100 lines:
- A QuickJS + SDL3 + raw GL container for RPG Maker MZ
- Includes: quickjs.h, SDL3/SDL.h, glad/glad.h, tracy/TracyC.h, matrix_math.h
- Uses stb_image, stb_truetype, stb_vorbis, and miniaudio (all with IMPLEMENTATION defines)
- Defines an EngineState struct holding JSRuntime, JSContext, SDL_Window, SDL_GLContext, and a running flag
- Global audio engine: ma_engine g_audio_engine
- Implements native_data_path() -- sanitizes save keys by flattening / and \ to _ to prevent silent save failures
- Implements js_native_storage_set() and js_native_storage_get() -- native file-based save/load functions exposed to JavaScript
4. First 100 Lines of src/shims.js
File: C:\Users\Armin J\Documents\GitHub\Sonar.js\src\shims.js (4210 lines total)
This is a massive browser-environment polyfill/shim layer for QuickJS. Key highlights:
- safePath(url) -- decodes percent-encoded asset URLs back to filesystem paths
- effekseer stub -- completely inert WASM effekseer replacement (since WASM cannot run in QuickJS), with all required methods stubbed out to prevent crashes in RMMZ's Graphics._createEffekseerContext()
- WebAssembly stub -- a full inert implementation including Memory, Table, Module, Instance, Compile, instantiate, validate, etc. Rejects at the instantiate boundary so Emscripten modules (effekseer.min.js, vorbisdecoder.js) abort cleanly via their onError path
This file effectively creates a fake browser DOM/Web API environment so that PixiJS v5 and RMMZ JavaScript code can run inside QuickJS without a real browser.
5. First 100 Lines of src/audio_shims.js
File: C:\Users\Armin J\Documents\GitHub\Sonar.js\src\audio_shims.js (249 lines total)
This is a native miniaudio backend that replaces the WebAudio API entirely. Key highlights:
- Loads after shims.js, before rmmz_core.js
- Routes AudioManager methods directly through globalThis.__native__ (the C-side miniaudio bindings)
- Manages handles for BGM, BGS, ME, and SE tracks (_bgmHandle, _bgsHandle, _meHandle, _seHandles)
- Implements: playBgm, replayBgm, stopBgm, fadeOutBgm, fadeInBgm, playBgs, replayBgs, and parameter updates (volume, pitch, pan)
- audioPath() constructs file paths using AudioManager._path, folder, encodeURIComponent(name), and extension
- Volume is computed as (configVol * audioVol) / 10000
6. AGENTS.md and README.md
AGENTS.md: There is no AGENTS.md in the project root. The only AGENTS.md found is inside third_party/SDL/AGENTS.md (part of the vendored SDL dependency, not the project's own).
README.md (C:\Users\Armin J\Documents\GitHub\Sonar.js\README.md, 52 lines):
Sonar.js (Salaxios Open NAtive Runtime) is a non-browser/DOM JavaScript desktop native runtime written in C, for PixiJS v5 WebGL applications, focused on being a game wrapper for RPG Maker MZ games. Part of the Salaxios Narrative Engine.
Key points from the README:
- Goal: create something like EasyRPG but for RPG Maker MZ / PixiJS v5
- Current state: Tracy profiler implemented, bitmap text rendering WIP
- Known limitations:
- Fonts: only default font loads
- Icons in text: entire sheet shows instead of individual icons
- Faces: entire face sheet shows instead of individual faces
- Community plugins: highly variable support (FOSSIL should work, VisuStella does not, UltraMode7 works)
- Saving/Loading: do not work yet (though the C code has storage functions)
- No Audio yet (README may be slightly outdated -- audio_shims.js exists and the latest commit says "Audio works!")
- Battle scenes load but Effekseer particle effects won't work (WASM unsupported in QuickJS)
- No video playback or touch UI support
- Basic keyboard input (Z/X/arrows/Shift) works
7. Git Status and Recent Commits
Branch: experimental (up to date with origin/experimental)
Working tree: Clean, nothing to commit
Last 5 commits:
004593c  Audio works!
069784c  AUDIO BROKEN CODE, USE LAST BUILD
d34be93  some fixes
a9cef7f  fixed tracy flag
67d574f  runtime event command error protection
The most recent commit (004593c) indicates audio has started working. The commit before that (069784c) is a warning about broken audio code.
8. All .c and .js Files in src/
C files (2):
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\main.c
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\native_gl.c
JS files (19):
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\shims.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\audio_shims.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\Project1\js\plugins.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\Project1\js\rmmz_windows.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\Project1\js\rmmz_sprites.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\Project1\js\rmmz_scenes.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\Project1\js\rmmz_objects.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\Project1\js\rmmz_managers.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\Project1\js\rmmz_core.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\Project1\js\main.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\Project1\js\plugins\AltSaveScreen.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\Project1\js\plugins\TextPicture.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\Project1\js\plugins\AltMenuScreen.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\Project1\js\plugins\ButtonPicture.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\Project1\js\libs\vorbisdecoder.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\Project1\js\libs\pixi.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\Project1\js\libs\pako.min.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\Project1\js\libs\localforage.min.js
- C:\Users\Armin J\Documents\GitHub\Sonar.js\src\Project1\js\libs\effekseer.min.js
The src/ directory also contains non-code files: icon.ico, matrix_math.h, rmmz_native.rc.in, and run_game.bat.
Summary
Sonar.js is a native (non-browser) RPG Maker MZ runtime built on QuickJS + SDL3 + OpenGL + miniaudio. The architecture is:
- C layer (main.c, native_gl.c): Engine loop, JS runtime, native OpenGL bindings, audio via miniaudio, file-based save/load
- JS shim layer (shims.js -- 4210 lines): Massive browser API polyfill (DOM, Canvas, WebAudio stubs, WASM stubs, Effekseer stubs, etc.) so PixiJS/RMMZ code runs unmodified in QuickJS
- Audio shim (audio_shims.js -- 249 lines): Native miniaudio backend replacing WebAudio for real audio playback
- Game project (Project1/): An RMMZ game with core engine JS, plugins, and PixiJS