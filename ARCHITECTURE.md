# Sonar.js Architecture Diagram

## System Overview

Sonar.js is a native desktop runtime for RPG Maker MZ games that replaces the browser-based NW.js environment with a C-based runtime using QuickJS, SDL3, and OpenGL.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Sonar.js Runtime Architecture                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Main Components

### 1. Native C Layer (main.c, native_gl.c)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              C Runtime Layer                                 │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                  │
│  │   SDL3       │    │   OpenGL     │    │  QuickJS     │                  │
│  │              │    │   (GLAD)     │    │   Engine     │                  │
│  │ • Windowing  │◄───┤ • Rendering  │◄───┤ • JS Runtime │                  │
│  │ • Input      │    │ • WebGL2     │    │ • Context    │                  │
│  │ • Audio      │    │              │    │ • Eval       │                  │
│  └──────────────┘    └──────────────┘    └──────┬───────┘                  │
│         │                   │                     │                         │
│         └───────────────────┴─────────────────────┘                         │
│                            │                                                   │
│                    ┌───────▼────────┐                                        │
│                    │   Main Loop    │                                        │
│                    │ • Event Pump   │                                        │
│                    │ • JS Tick      │                                        │
│                    │ • GL Swap      │                                        │
│                    └───────┬────────┘                                        │
└────────────────────────────┼────────────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────────────┐
│                         JavaScript Bridge Layer                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                         Native Bridge                                 │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │  │
│  │  │ File I/O     │  │ Text Render  │  │ Audio        │               │  │
│  │  │ • readFile   │  │ • rasterize  │  │ • miniaudio  │               │  │
│  │  │ • decodeImg  │  │ • measure    │  │              │               │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │  │
│  │  │ Storage      │  │ Input        │  │ Matrix Math  │               │  │
│  │  │ • storageSet │  │ • Keyboard   │  │ • multiply   │               │  │
│  │  │ • storageGet │  │ • Mouse      │  │ • transform  │               │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │  │
│  │  │ WebGL Bridge │  │ Profiling    │  │ Window Mgmt  │               │  │
│  │  │ • gl.* funcs  │  │ • Tracy      │  │ • resize     │               │  │
│  │  │ • shaders    │  │ • zones      │  │ • quit       │               │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │  │
│  └────────────────────────────┬─────────────────────────────────────────┘  │
└───────────────────────────────┼────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────────────────┐
│                         JavaScript Shims Layer                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                    Browser Environment Simulation                     │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │  │
│  │  │ window       │  │ document     │  │ navigator    │               │  │
│  │  │ • events     │  │ • DOM stubs  │  │ • userAgent  │               │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │  │
│  │  │ WebAssembly  │  │ Worker       │  │ Effekseer    │               │  │
│  │  │ • stub       │  │ • stub       │  │ • stub       │               │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │  │
│  │  │ Canvas/WebGL │  │ Image/Bitmap │  │ AudioContext │               │  │
│  │  │ • contexts   │  │ • loading    │  │ • audio      │               │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │  │
│  └────────────────────────────┬─────────────────────────────────────────┘  │
└───────────────────────────────┼────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────────────────┐
│                    RPG Maker MZ Game Layer                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                         RMMZ Engine                                  │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │  │
│  │  │ PixiJS v5.3  │  │ RMMZ Core    │  │ Plugins      │               │  │
│  │  │ • WebGL      │  │ • Managers   │  │ • VisuStella  │               │  │
│  │  │ • Sprites    │  │ • Objects    │  │ • UltraMode7  │               │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │  │
│  │  │ Scenes       │  │ Sprites      │  │ Windows      │               │  │
│  │  │ • Boot       │  │ • Characters │  │ • Message     │               │  │
│  │  │ • Title      │  │ • Animation  │  │ • Menu        │               │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  Game Data:                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                     │
│  │ data/        │  │ img/         │  │ audio/       │                     │
│  │ • System.json│  │ • characters │  │ • bgm/       │                     │
│  │ • Map*.json  │  │ • system     │  │ • bgs/       │                     │
│  └──────────────┘  └──────────────┘  └──────────────┘                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### Startup Sequence

```
1. main() initializes:
   ├── SDL3 (window, input, audio)
   ├── OpenGL context (4.1 Core Profile)
   ├── GLAD (OpenGL loader)
   ├── QuickJS runtime & context
   └── Native bridge functions

2. Load and evaluate shims.js:
   ├── Creates browser environment stubs
   ├── Sets up WebAssembly/Worker stubs
   ├── Implements Canvas/WebGL contexts
   └── Connects to native bridge

3. Change to Project1 directory:
   ├── Load RMMZ libraries (pixi.js, pako, localforage)
   ├── Load RMMZ engine files (rmmz_*.js)
   ├── Load plugins.js
   └── Load main.js

4. Fire 'load' event:
   ├── Triggers RMMZ boot sequence
   ├── Initializes SceneManager
   └── Starts Scene_Boot

5. Enter main loop:
   ├── Process SDL events (input, window)
   ├── Dispatch events to JS via __tick__
   ├── Execute pending JS jobs
   └── Swap OpenGL buffers
```

### Rendering Pipeline

```
RMMZ Game Logic
     │
     ├── PixiJS display objects
     │
     ├── WebGL rendering commands
     │
     ├── Native WebGL Bridge (native_gl.c)
     │   ├── Converts JS parameters to GL types
     │   ├── Handles texture uploads (with flip/premultiply)
     │   ├── Manages buffer data uploads
     │   └── Executes GL draw calls
     │
     └── OpenGL (via GLAD)
         ├── Shader compilation
         ├── Texture management
         ├── Buffer operations
         └── Final rendering to SDL window
```

### Input Processing

```
SDL Input Events
     │
     ├── Keyboard events
     │   ├── Convert scancode to keycode
     │   └── Dispatch to __dispatchKeyboardEvent__
     │
     ├── Mouse events
     │   ├── Track position and buttons
     │   └── Dispatch to __dispatchMouseEvent__
     │
     └── Wheel events
         └── Dispatch to __dispatchWheelEvent__

JavaScript Event Handlers
     │
     └── RMMZ Input processing
         ├── Map keys to game controls
         └── Trigger game actions
```

### File Loading

```
RMMZ Asset Request
     │
     ├── URL decoding (percent-encoded paths)
     │
     ├── Native bridge call
     │   ├── native.readFile() (text)
     │   ├── native.readFileBinary() (binary)
     │   └── native.decodeImage() (images)
     │
     └── File system access
         ├── stb_image for image decoding
         ├── Direct file reading for data
         └── Return to JS as ArrayBuffer/String
```

## Third-Party Dependencies

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Third-Party Libraries                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                     │
│  │ quickjs-ng   │  │ SDL3         │  │ GLAD         │                     │
│  │ • JS engine  │  │ • Platform   │  │ • OpenGL     │                     │
│  │ • Embeddable │  │   abstraction│  │   loader     │                     │
│  └──────────────┘  └──────────────┘  └──────────────┘                     │
│                                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                     │
│  │ stb          │  │ miniaudio    │  │ Tracy        │                     │
│  │ • image      │  │ • audio      │  │ • profiler   │                     │
│  │ • truetype   │  │   playback   │  │ • optimization│                     │
│  └──────────────┘  └──────────────┘  └──────────────┘                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Architectural Decisions

### 1. JavaScript Runtime
- **QuickJS** chosen over V8/SpiderMonkey for:
  - Small footprint and embeddability
  - C API simplicity
  - No external dependencies
  - Sufficient ES6+ support for RMMZ

### 2. Rendering
- **OpenGL 4.1 Core Profile** via GLAD:
  - Direct hardware access
  - WebGL2 compatibility layer
  - Cross-platform support
  - Native performance

### 3. Browser Compatibility
- **Shim layer** instead of full browser:
  - Minimal surface area to maintain
  - Only implements what RMMZ actually uses
  - Avoids heavy browser engine dependencies
  - Better performance overhead

### 4. Audio
- **miniaudio** instead of Web Audio API:
  - Native audio decoding
  - Cross-platform support
  - No browser audio engine complexity
  - Direct file playback

### 5. Text Rendering
- **stb_truetype** for font rasterization:
  - Native TTF rendering
  - No browser text engine needed
  - System font integration
  - Custom glyph bitmap generation

## Performance Optimizations

### 1. Tracy Profiling
- Optional per-call GL profiling (SONAR_TRACY=1)
- JS-accessible zone profiling
- Frame timing analysis
- Hot path identification

### 2. Batch Uploads (Optional)
- SONAR_BATCH_UPLOADS=1 enables:
  - Deferred bufferSubData operations
  - Single flush per draw call
  - Reduced JS->C boundary crossings
  - Significant overhead reduction

### 3. Matrix Math Offloading
- Native C implementation of:
  - Matrix multiplication
  - Transform operations
  - Bounds calculation
  - Reduces JS math overhead

### 4. Text Measurement Optimization
- Separate measureText() function
- Skips bitmap generation for layout
- Critical for word-wrap performance

## Current Limitations

### Known Issues
- Fonts: Default system font only
- Icons: Entire sheet displayed instead of individual icons
- Faces: Entire face sheet displayed
- Saving/Loading: Basic implementation only
- Audio: No Web Audio API compatibility
- Effekseer: WASM effects not supported (PNG animations only)
- Video playback: Not implemented
- Touch UI: Not implemented

### Plugin Compatibility
- Vanilla RMMZ: Mostly working with text rendering bugs
- FOSSIL: Should theoretically work
- VisuStella: Known issues, not fully supported
- UltraMode7: Works (proof of concept)
- Community plugins: Variable support

## Build System

### CMake Configuration
```
CMakeLists.txt
├── Dependencies
│   ├── quickjs-ng (JS engine)
│   ├── SDL3 (platform abstraction)
│   ├── GLAD (OpenGL loader)
│   ├── stb (image/truetype)
│   ├── miniaudio (audio)
│   └── Tracy (profiling)
├── Main executable
│   ├── main.c (core runtime)
│   └── native_gl.c (WebGL bridge)
└── Post-build
    ├── Copy shims.js
    └── Copy Project1 (game files)
```

## File Structure

```
Sonar.js/
├── src/
│   ├── main.c              # Core runtime and event loop
│   ├── native_gl.c         # WebGL bridge implementation
│   ├── matrix_math.h       # Matrix operations
│   ├── shims.js            # Browser environment simulation
│   ├── icon.ico            # Application icon
│   └── Project1/           # Sample RPG Maker MZ project
│       ├── js/             # Game scripts
│       ├── data/           # Game data (JSON)
│       ├── img/            # Game images
│       ├── audio/          # Game audio
│       └── index.html      # Original HTML entry point
├── third_party/
│   ├── quickjs-ng/         # JavaScript engine
│   ├── SDL/                # Platform abstraction
│   ├── glad/               # OpenGL loader
│   ├── stb/                # Image/font libraries
│   ├── miniaudio/          # Audio library
│   └── tracy/              # Profiler
├── CMakeLists.txt          # Build configuration
├── README.md               # Project documentation
└── compile_instructions.txt # Build instructions
```

## Extension Points

### Adding New Native Functions
1. Add C function in main.c or native_gl.c
2. Register in register_native_bridge()
3. Access via globalThis.__native__ in JS

### Adding WebGL Functions
1. Add C function in native_gl.c
2. Register in register_gl_bridge()
3. Access via globalThis.__native__.gl in JS

### Adding Browser APIs
1. Add stub implementation in shims.js
2. Integrate with existing native bridges where needed
3. Test with RMMZ usage patterns

This architecture enables Sonar.js to provide a lightweight, performant native runtime for RPG Maker MZ games while maintaining compatibility with the existing PixiJS-based RMMZ engine.