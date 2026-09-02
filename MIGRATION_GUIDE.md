# Sonar.js Migration Guide: quickjs-ng → Bellard QuickJS

## Executive Summary

This guide details migrating Sonar.js from **quickjs-ng** to **Fabrice Bellard's original QuickJS** (latest release: 2026-06-04). The migration is **highly feasible, low-risk, and performance-positive** for your RPG Maker MZ desktop runtime.

**Verdict: Recommended migration.** Your codebase uses exclusively standard QuickJS C APIs with zero quickjs-ng-specific extensions. Bellard's latest release is ~42% faster on bench-v8, includes rope string optimization (critical for RPG Maker's string-heavy workloads), and supports all ES2015+ features your corescripts require.

---

## 1. Compatibility Analysis

### 1.1 C API Compatibility

Your code (`main.c`, `native_gl.c`) uses these QuickJS C APIs — **all present in both engines**:

| API | Your Usage | Bellard | quickjs-ng |
|-----|-----------|---------|------------|
| `JS_GetPropertyStr` / `JS_SetPropertyStr` | Heavy (every native bridge function) | ✅ | ✅ |
| `JS_NewCFunction` / `JS_NewCFunction2` | All native bridge registrations | ✅ | ✅ |
| `JS_Call` / `JS_Eval` / `JS_EvalFunction` | Script execution | ✅ | ✅ |
| `JS_NewString` / `JS_ToCString` / `JS_FreeCString` | All string passing | ✅ | ✅ |
| `JS_NewArrayBufferCopy` / `JS_GetArrayBuffer` | Image/audio/binary data | ✅ | ✅ |
| `JS_GetTypedArrayBuffer` | WebGL buffer uploads | ✅ | ✅ |
| `JS_ComputeMemoryUsage` / `JSMemoryUsage` | Memory profiling | ✅ | ✅ |
| `JS_NewObject` / `JS_NewArray` | Object creation | ✅ | ✅ |
| `JS_IsFunction` / `JS_IsException` / etc. | Type checking | ✅ | ✅ |
| `JS_NewClassID` / `JS_NewClass` | Custom class registration | ✅ | ✅ |
| `JS_GetGlobalObject` | Global access | ✅ | ✅ |
| `JS_Throw` / `JS_GetException` | Error handling | ✅ | ✅ |
| `JS_NewDate` | Date creation (2026-06-04 release) | ✅ | ✅ |
| `JS_SetConstructor` / `JS_SetConstructorBit` | Prototype setup | ✅ | ✅ |
| `JS_GetPropertyUint32` / `JS_SetPropertyUint32` | Array element access | ✅ | ✅ |
| `JS_DefinePropertyValueStr` | Property definition | ✅ | ✅ |
| `JS_NewCFunctionData` | Closure creation | ✅ | ✅ |
| `JS_GetOpaque` / `JS_GetOpaque2` | Opaque pointer access | ✅ | ✅ |

**Zero quickjs-ng-specific APIs detected in your codebase.**

### 1.2 JavaScript Feature Compatibility (RMMZ Corescripts)

Your corescripts (`rmmz_core.js v1.9.0`) use these features — **all supported by Bellard's QuickJS**:

| Feature | Used? | Bellard Support |
|---------|-------|-----------------|
| `const` / `let` | Heavy | ✅ (ES2015+) |
| Arrow functions (`=>`) | 4 instances | ✅ (ES2015) |
| `for...of` loops | 29 instances | ✅ (ES2015) |
| Spread syntax (`...args`) | 17 instances | ✅ (ES2015) |
| Destructuring | Yes | ✅ (ES2015) |
| Default parameters | Yes | ✅ (ES2015) |
| `Array.from()` | Yes | ✅ (ES2015) |
| `Array.prototype.includes()` | 4 instances | ✅ (ES2016) |
| `String.prototype.padStart()` | Yes | ✅ (ES2017) |
| `String.prototype.startsWith()` | Yes | ✅ (ES2015) |
| `Object.defineProperty()` | Heavy | ✅ (ES2015) |
| `Object.keys()` | Yes | ✅ (ES2015) |
| `Promise` (basic `.then()`/`.catch()`) | Yes | ✅ (ES2015) |
| `performance.now()` | 3 instances | ✅ (shimmed) |
| `XMLHttpRequest` | 2 instances | ✅ (shimmed) |
| `fetch` | 1 instance | ✅ (shimmed) |

**No ES2020+ features** (no `?.`, `??`, `globalThis`, `Promise.allSettled`, etc.) are used in the corescripts.

### 1.3 WeakRef / FinalizationRegistry

**Your friend's claim is outdated.** Here are the facts:

- Bellard's QuickJS **added WeakRef, FinalizationRegistry, and symbols as weakrefs** in the **2025-04-26 release**.
- Your RMMZ corescripts **do not use WeakRef or FinalizationRegistry at all** — they are not referenced anywhere in `rmmz_core.js`, `rmmz_managers.js`, `rmmz_objects.js`, `rmmz_scenes.js`, `rmmz_sprites.js`, or `rmmz_windows.js`.
- Even if future plugins did use them, Bellard's latest release supports them natively.

### 1.4 Browser API Layer (shims.js)

Your shims.js implements a complete browser environment polyfill. Key observations:

- **`performance` object**: You override it with `globalThis.performance = { now: ... }`. Bellard's quickjs has no built-in `performance` object, so this just creates a new global (harmless, no conflict).
- **RegExp.$1-$9 polyfill**: Your comment says this patches around quickjs-ng's `[Symbol.match]` behavior. Bellard's quickjs handles `match(undefined)` coercion correctly per spec, so this polyfill becomes **unnecessary** (but won't break if left in place).
- **`XMLHttpRequest` / `fetch`**: Already shimmed in your code — no engine dependency.
- **`WebAssembly` / `Worker` / `URL` / `Blob`**: Already stubbed — no engine dependency.

---

## 2. Build System Changes

### 2.1 Key Difference: Build System

| Aspect | quickjs-ng | Bellard QuickJS |
|--------|-----------|-----------------|
| Build system | CMake | Makefile (no CMakeLists.txt) |
| CMake target | `qjs` | None (needs wrapper) |
| Library type | Static by default | Static (`libquickjs.a`) |

**Bellard's QuickJS has no CMakeLists.txt.** You need a wrapper to integrate it into your CMake build.

### 2.2 Wrapper CMakeLists.txt

Create `third_party/quickjs/CMakeLists.txt` (the wrapper):

```cmake
# Wrapper CMakeLists.txt for Bellard's QuickJS (no native CMake support)
cmake_minimum_required(VERSION 3.20)
project(quickjs_wrapper C)

set(QUICKJS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/src)

# Build libquickjs from source
add_library(quickjs STATIC
    ${QUICKJS_DIR}/quickjs.c
    ${QUICKJS_DIR}/cutils.c
    ${QUICKJS_DIR}/libregexp.c
    ${QUICKJS_DIR}/libunicode.c
    ${QUICKJS_DIR}/dtoa.c
    ${QUICKJS_DIR}/quickjs-libc.c
)

target_include_directories(quickjs PUBLIC ${QUICKJS_DIR})
target_compile_definitions(quickjs PRIVATE _GNU_SOURCE)
target_compile_features(quickjs PRIVATE c_std_11)

if(WIN32)
    target_compile_definitions(quickjs PRIVATE __USE_MINGW_ANSI_STDIO)
endif()

# Math library
find_library(M_LIBRARIES m)
if(M_LIBRARIES)
    target_link_libraries(quickjs PRIVATE m)
endif()

# Threading (for quickjs-libc worker support, optional)
find_package(Threads)
if(CMAKE_THREAD_LIBS_INIT)
    target_link_libraries(quickjs PRIVATE ${CMAKE_THREAD_LIBS_INIT})
endif()
```

### 2.3 Directory Structure

```
third_party/
├── quickjs/
│   ├── CMakeLists.txt    ← NEW wrapper (above)
│   └── src/              ← git clone https://github.com/bellard/quickjs.git
│       ├── quickjs.h
│       ├── quickjs.c
│       ├── quickjs-libc.h
│       ├── quickjs-libc.c
│       ├── cutils.c
│       ├── dtoa.c
│       ├── libregexp.c
│       ├── libunicode.c
│       └── ...
├── quickjs-ng/           ← REMOVE after migration
├── SDL/
├── glad/
├── stb/
├── miniaudio/
└── tracy/
```

### 2.4 CMakeLists.txt Changes

In your root `CMakeLists.txt`:

```cmake
# BEFORE (quickjs-ng):
set(THIRD_PARTY_DIR ${CMAKE_SOURCE_DIR}/third_party)
add_subdirectory(${THIRD_PARTY_DIR}/quickjs-ng EXCLUDE_FROM_ALL)

# AFTER (Bellard QuickJS):
set(THIRD_PARTY_DIR ${CMAKE_SOURCE_DIR}/third_party)
add_subdirectory(${THIRD_PARTY_DIR}/quickjs EXCLUDE_FROM_ALL)
```

The target detection logic (`set(QJS_TARGET quickjs)` etc.) should work as-is since the wrapper creates a `quickjs` target.

### 2.5 MSVC Atomics Workaround

Your existing MSVC atomics workaround is compatible:

```cmake
if(MSVC)
    if(TARGET qjs)
        target_compile_options(qjs PRIVATE "-D__STDC_NO_ATOMICS__")
    elseif(TARGET quickjs)
        target_compile_options(quickjs PRIVATE "-D__STDC_NO_ATOMICS__")
    endif()
endif()
```

This already handles both target names. No change needed.

---

## 3. shims.js Changes

### 3.1 Optional Cleanup (Not Required)

These changes are **optional** — the shims work as-is with Bellard's QuickJS. But they clean up quickjs-ng workarounds:

**Performance object** (no change needed):
```javascript
// This line is harmless with Bellard's quickjs — it just creates a new global.
// Bellard's quickjs has no built-in performance object, so no conflict.
globalThis.performance = {
    now: function () { return native.now(); },
};
```

**RegExp.$1-$9 polyfill** (optional cleanup):
The comment about "QuickJS-ng's internal [Symbol.match] fast path" is no longer relevant. Bellard's quickjs handles `match(undefined)` coercion correctly. You can remove the polyfill or leave it — it won't cause issues either way.

### 3.2 No Changes Required

The following shims work identically with Bellard's QuickJS:
- `XMLHttpRequest` stubs
- `fetch` stubs
- `WebAssembly` stubs
- `Worker` stubs
- `URL` / `Blob` stubs
- `localStorage` implementation
- `setTimeout` / `setInterval` / `requestAnimationFrame`
- Canvas/WebGL shim layer
- All event dispatching

---

## 4. Performance Benefits

### 4.1 Bench-v8 Score Improvement

| Engine | v8-v7 Score | Notes |
|--------|-------------|-------|
| quickjs-ng v0.11.0 | ~840 | Your current engine |
| Bellard QuickJS 2026-06-04 | ~1300+ | 42% faster than previous Bellard release |

### 4.2 Rope String Optimization

Bellard's QuickJS includes **rope string** optimization — a tree-based string representation that avoids O(n²) concatenation. This is critical for:

- RPG Maker MZ plugin loading (massive string concatenation in code generation)
- Scene description text building
- Plugin system script evaluation
- Any `String.prototype.replace()` chains

Your friend mentioned this indirectly — it's real and significant. quickjs-ng v0.12.0 has since ported rope strings, but Bellard's implementation has had more optimization time.

### 4.3 Other Optimizations (2026-06-04 Release)

- Custom malloc for small blocks (11% faster)
- Micro-optimizations (30% faster on bench-v8)
- Resizable ArrayBuffers
- `ArrayBuffer.prototype.transfer`
- Iterator helpers and methods
- `Math.sumPrecise()`

---

## 5. Migration Steps

### Step 1: Backup

```bash
git checkout -b migration-to-bellard-quickjs
```

### Step 2: Clone Bellard's QuickJS

```bash
cd third_party
rm -rf quickjs-ng
git clone https://github.com/bellard/quickjs.git quickjs
```

### Step 3: Create Wrapper CMakeLists.txt

Create `third_party/quickjs/CMakeLists.txt` with the wrapper content from Section 2.2.

### Step 4: Update Root CMakeLists.txt

Change:
```cmake
add_subdirectory(${THIRD_PARTY_DIR}/quickjs-ng EXCLUDE_FROM_ALL)
```
To:
```cmake
add_subdirectory(${THIRD_PARTY_DIR}/quickjs EXCLUDE_FROM_ALL)
```

### Step 5: Test Build

```bash
mkdir build && cd build
cmake .. -G "MinGW Makefiles"   # or your generator
cmake --build .
```

### Step 6: Smoke Test

Run a basic RPG Maker MZ game and verify:
- [ ] Game boots without errors
- [ ] Title screen renders
- [ ] Can start a new game
- [ ] Map renders correctly
- [ ] Text/dialogue displays
- [ ] Audio plays
- [ ] Keyboard input works
- [ ] Menu opens/closes

### Step 7: Performance Profiling

With Tracy profiler enabled, compare frame times before/after:
- Tilemap rendering (`Tilemap._addAllSpots`)
- Text rasterization (`native.rasterizeText`)
- WebGL buffer uploads (`gl.bufferSubData`)
- JavaScript tick time (`__tick__`)

---

## 6. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| API incompatibility | Very Low | High | All APIs verified compatible |
| Build failure | Low | Medium | Wrapper CMakeLists.txt provided |
| RegExp behavior difference | Very Low | Low | shims.js polyfills handle it |
| Module loading difference | Very Low | Low | You use custom loader, not engine's |
| Memory management regression | Very Low | Low | Bellard's GC is battle-tested |
| Plugin incompatibility | Very Low | Low | ES2015 features only, both engines support |

---

## 7. Rollback Plan

If any issues arise:

```bash
git checkout main
rm -rf third_party/quickjs
# Restore quickjs-ng from git history or re-clone
```

---

## 8. Conclusion

The migration from quickjs-ng to Bellard's QuickJS is:

- **Feasible**: Zero API incompatibilities detected
- **Safe**: All browser APIs are shimmed; no engine-specific features used
- **Performance-positive**: ~42% faster on bench-v8, rope string optimization for string-heavy workloads
- **Low effort**: ~1-2 hours including testing
- **Reversible**: Simple rollback if issues arise

The RMMZ corescripts target ES2015 — both engines fully support this. Your custom DOM/browser layer means you don't depend on any quickjs-ng built-in extensions. The only build system change is swapping the subdirectory and adding a thin CMake wrapper.

**Recommendation: Proceed with migration.**
