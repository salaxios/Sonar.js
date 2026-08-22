// native_gl.c — WebGL2 bridge for PixiJS v5.3.12 traced call list.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"
#include <glad/glad.h>
#include "tracy/TracyC.h"

// Defined in main.c; gates the per-call GL Tracy zones (bufferSubData,
// bufferData, texImage*, draw*) that cost a timestamp + queue write on every
// call. Off by default; enable with SONAR_TRACY=1 to profile GL traffic.
extern int g_tracy_enabled;

// ------------------------------------------------------------------
// Bridge-side state for WebGL-only pixelStorei flags
// ------------------------------------------------------------------

typedef struct {
    GLboolean unpack_flip_y;
    GLboolean unpack_premultiply_alpha;
} GLBridgeState;

static GLBridgeState g_gl_state = {GL_FALSE, GL_FALSE};

// ------------------------------------------------------------------
// Argument helpers
// ------------------------------------------------------------------

static GLuint arg_uint(JSContext *ctx, JSValueConst v) {
    int64_t x = 0;
    JS_ToInt64(ctx, &x, v);
    return (GLuint)x;
}
static GLuint arg_handle(JSContext *ctx, JSValueConst v) {
    if (JS_IsNull(v) || JS_IsUndefined(v)) return 0;
    return arg_uint(ctx, v);
}
static GLint arg_int(JSContext *ctx, JSValueConst v) {
    int32_t x = 0;
    JS_ToInt32(ctx, &x, v);
    return (GLint)x;
}
static GLfloat arg_float(JSContext *ctx, JSValueConst v) {
    double x = 0;
    JS_ToFloat64(ctx, &x, v);
    return (GLfloat)x;
}
static GLboolean arg_bool(JSContext *ctx, JSValueConst v) {
    return JS_ToBool(ctx, v) ? GL_TRUE : GL_FALSE;
}

static uint8_t *arg_typed_array(JSContext *ctx, JSValueConst v, size_t *out_len) {
    if (JS_IsNull(v) || JS_IsUndefined(v)) { *out_len = 0; return NULL; }

    // Fast path: TypedArray / ArrayBufferView first. This is by far the
    // common case for bufferSubData (Float32Array/Uint16Array views), and it
    // avoids the wasted JS_GetArrayBuffer probe that the old order paid on
    // every one of the ~693k bufferSubData calls.
    size_t offset = 0, len = 0, bpe = 0;
    JSValue buf = JS_GetTypedArrayBuffer(ctx, v, &offset, &len, &bpe);
    if (!JS_IsException(buf)) {
        size_t buf_size = 0;
        uint8_t *data = JS_GetArrayBuffer(ctx, &buf_size, buf);
        JS_FreeValue(ctx, buf);
        if (data) {
            *out_len = len;
            return data + offset;
        }
    } else {
        JS_FreeValue(ctx, JS_GetException(ctx));
    }

    // 2. Check if it's an ArrayBuffer directly
    size_t ab_len = 0;
    uint8_t *ab_data = JS_GetArrayBuffer(ctx, &ab_len, v);
    if (ab_data) {
        *out_len = ab_len;
        return ab_data;
    }

    // 3. Fallback for plain JS Array
    if (JS_IsArray(v)) {
        JSValue len_val = JS_GetPropertyStr(ctx, v, "length");
        int32_t arr_len = 0;
        JS_ToInt32(ctx, &arr_len, len_val);
        JS_FreeValue(ctx, len_val);
        if (arr_len > 0) {
            static float s_scratch[2048];
            if (arr_len <= 2048) {
                for (int i = 0; i < arr_len; i++) {
                    JSValue elem = JS_GetPropertyUint32(ctx, v, i);
                    double d = 0;
                    JS_ToFloat64(ctx, &d, elem);
                    s_scratch[i] = (float)d;
                    JS_FreeValue(ctx, elem);
                }
                *out_len = (size_t)arr_len * sizeof(float);
                return (uint8_t *)s_scratch;
            }
        }
    }

    *out_len = 0;
    return NULL;
}

static JSValue make_location(JSContext *ctx, GLint loc) {
    if (loc == -1) return JS_NULL;
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "__glLoc", JS_NewInt32(ctx, loc));
    return obj;
}
static GLint arg_location(JSContext *ctx, JSValueConst v) {
    if (JS_IsNull(v) || JS_IsUndefined(v)) return -1;
    JSValue p = JS_GetPropertyStr(ctx, v, "__glLoc");
    int32_t loc = -1;
    JS_ToInt32(ctx, &loc, p);
    JS_FreeValue(ctx, p);
    return loc;
}

static void flip_rows_in_place(uint8_t *data, int width, int height, int bytes_per_pixel) {
    if (!data || height <= 1) return;
    size_t row_bytes = (size_t)width * bytes_per_pixel;
    uint8_t *tmp = malloc(row_bytes);
    if (!tmp) return;
    for (int y = 0; y < height / 2; y++) {
        uint8_t *top = data + (size_t)y * row_bytes;
        uint8_t *bottom = data + (size_t)(height - 1 - y) * row_bytes;
        memcpy(tmp, top, row_bytes);
        memcpy(top, bottom, row_bytes);
        memcpy(bottom, tmp, row_bytes);
    }
    free(tmp);
}

static void premultiply_in_place(uint8_t *data, size_t byte_len) {
    if (!data) return;
    for (size_t i = 0; i + 3 < byte_len; i += 4) {
        uint8_t a = data[i + 3];
        data[i + 0] = (uint8_t)((data[i + 0] * a) / 255);
        data[i + 1] = (uint8_t)((data[i + 1] * a) / 255);
        data[i + 2] = (uint8_t)((data[i + 2] * a) / 255);
    }
}

// ------------------------------------------------------------------
// Create / delete
// ------------------------------------------------------------------

#define GEN_CREATE(jsname, glgen)                                              \
static JSValue js_##jsname(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) { \
    (void)t; (void)argc; (void)argv;                                           \
    GLuint id = 0; glgen(1, &id);                                              \
    return JS_NewInt64(ctx, (int64_t)id);                                      \
}
#define GEN_DELETE(jsname, gldel)                                              \
static JSValue js_##jsname(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) { \
    (void)t;                                                                   \
    if (argc < 1) return JS_UNDEFINED;                                         \
    GLuint id = arg_handle(ctx, argv[0]); gldel(1, &id);                       \
    return JS_UNDEFINED;                                                      \
}

GEN_CREATE(createBuffer, glGenBuffers)
GEN_CREATE(createTexture, glGenTextures)
GEN_CREATE(createFramebuffer, glGenFramebuffers)
GEN_CREATE(createRenderbuffer, glGenRenderbuffers)
GEN_CREATE(createVertexArray, glGenVertexArrays)
GEN_DELETE(deleteBuffer, glDeleteBuffers)
GEN_DELETE(deleteTexture, glDeleteTextures)
GEN_DELETE(deleteFramebuffer, glDeleteFramebuffers)
GEN_DELETE(deleteRenderbuffer, glDeleteRenderbuffers)
GEN_DELETE(deleteVertexArray, glDeleteVertexArrays)

static JSValue js_createShader(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    GLenum type = (GLenum)arg_uint(ctx, argv[0]);
    return JS_NewInt64(ctx, (int64_t)glCreateShader(type));
}
static JSValue js_deleteShader(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glDeleteShader(arg_handle(ctx, argv[0])); return JS_UNDEFINED;
}
static JSValue js_createProgram(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; (void)argc; (void)argv;
    return JS_NewInt64(ctx, (int64_t)glCreateProgram());
}
static JSValue js_deleteProgram(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glDeleteProgram(arg_handle(ctx, argv[0])); return JS_UNDEFINED;
}

// ------------------------------------------------------------------
// Attach / detach shader
// ------------------------------------------------------------------

static JSValue js_attachShader(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    glAttachShader(arg_handle(ctx, argv[0]), arg_handle(ctx, argv[1]));
    return JS_UNDEFINED;
}

// ------------------------------------------------------------------
// Binding
// ------------------------------------------------------------------

static JSValue js_bindBuffer(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glBindBuffer(arg_uint(ctx, argv[0]), arg_handle(ctx, argv[1])); return JS_UNDEFINED;
}
static JSValue js_bindTexture(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    GLenum target = arg_uint(ctx, argv[0]);
    GLuint tex = (GLuint)arg_handle(ctx, argv[1]);
    glBindTexture(target, tex);
    return JS_UNDEFINED;
}
static JSValue js_bindFramebuffer(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glBindFramebuffer(arg_uint(ctx, argv[0]), arg_handle(ctx, argv[1])); return JS_UNDEFINED;
}
static JSValue js_bindRenderbuffer(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glBindRenderbuffer(arg_uint(ctx, argv[0]), arg_handle(ctx, argv[1])); return JS_UNDEFINED;
}
static JSValue js_bindVertexArray(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glBindVertexArray(arg_handle(ctx, argv[0])); return JS_UNDEFINED;
}

// ------------------------------------------------------------------
// Buffer / texture upload
// ------------------------------------------------------------------

static JSValue js_bufferData(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    TracyCZoneN(zone, "gl.bufferData", g_tracy_enabled);
    GLenum target = arg_uint(ctx, argv[0]);
    GLenum usage = arg_uint(ctx, argv[2]);
    if (JS_IsNumber(argv[1])) {
        GLsizeiptr size = (GLsizeiptr)arg_int(ctx, argv[1]);
        glBufferData(target, size, NULL, usage);
    } else {
        size_t len = 0;
        uint8_t *data = arg_typed_array(ctx, argv[1], &len);
        glBufferData(target, (GLsizeiptr)len, data, usage);
    }
    TracyCZoneEnd(zone);
    return JS_UNDEFINED;
}
// Per-frame profiling for bufferSubData to identify call patterns
static int g_frame_buffer_subdata_calls = 0;
static size_t g_frame_buffer_subdata_bytes = 0;
static int g_frame_array_buffer_calls = 0;
static int g_frame_element_array_buffer_calls = 0;

static JSValue js_bufferSubData(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    TracyCZoneN(zone, "gl.bufferSubData", g_tracy_enabled);
    GLenum target = arg_uint(ctx, argv[0]);
    GLintptr offset = (GLintptr)arg_int(ctx, argv[1]);
    size_t len = 0;
    uint8_t *data = arg_typed_array(ctx, argv[2], &len);
    
    // Track call statistics
    g_frame_buffer_subdata_calls++;
    g_frame_buffer_subdata_bytes += len;
    if (target == GL_ARRAY_BUFFER) {
        g_frame_array_buffer_calls++;
    } else if (target == GL_ELEMENT_ARRAY_BUFFER) {
        g_frame_element_array_buffer_calls++;
    }
    
    glBufferSubData(target, offset, (GLsizeiptr)len, data);
    TracyCZoneEnd(zone);
    return JS_UNDEFINED;
}

// Function to get bufferSubData statistics for the current frame
static JSValue js_getBufferSubDataStats(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; (void)argc; (void)argv;
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "calls", JS_NewInt32(ctx, g_frame_buffer_subdata_calls));
    JS_SetPropertyStr(ctx, obj, "bytes", JS_NewInt64(ctx, (int64_t)g_frame_buffer_subdata_bytes));
    JS_SetPropertyStr(ctx, obj, "arrayBufferCalls", JS_NewInt32(ctx, g_frame_array_buffer_calls));
    JS_SetPropertyStr(ctx, obj, "elementArrayBufferCalls", JS_NewInt32(ctx, g_frame_element_array_buffer_calls));
    return obj;
}

// Function to reset bufferSubData statistics (call once per frame)
static JSValue js_resetBufferSubDataStats(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; (void)argc; (void)argv;
    g_frame_buffer_subdata_calls = 0;
    g_frame_buffer_subdata_bytes = 0;
    g_frame_array_buffer_calls = 0;
    g_frame_element_array_buffer_calls = 0;
    return JS_UNDEFINED;
}

// Detects and extracts pixel data from an Image/Canvas-like source object
// (our ImageShim sets _pixelData as a real ArrayBuffer, plus width/height),
// used to support WebGL's 6-arg texImage2D/7-arg texSubImage2D overloads —
// confirmed required by tracing pixi.js's BaseImageResource.upload(), which
// calls gl.texImage2D(target, 0, format, format, type, source) with the
// Image object itself as the last argument, not a raw pixel buffer.
static int is_image_like_source(JSContext *ctx, JSValueConst v) {
    if (!JS_IsObject(v)) return 0;
    JSValue pd = JS_GetPropertyStr(ctx, v, "_pixelData");
    int has = !JS_IsUndefined(pd) && !JS_IsNull(pd);
    JS_FreeValue(ctx, pd);
    return has;
}
static uint8_t *get_image_source_pixels(JSContext *ctx, JSValueConst source,
                                         int *out_w, int *out_h, size_t *out_len) {
    JSValue wv = JS_GetPropertyStr(ctx, source, "width");
    JSValue hv = JS_GetPropertyStr(ctx, source, "height");
    int32_t w = 0, h = 0;
    JS_ToInt32(ctx, &w, wv);
    JS_ToInt32(ctx, &h, hv);
    JS_FreeValue(ctx, wv);
    JS_FreeValue(ctx, hv);
    *out_w = w;
    *out_h = h;

    JSValue pd = JS_GetPropertyStr(ctx, source, "_pixelData"); // ArrayBuffer
    size_t len = 0;
    uint8_t *data = NULL;
    if (!JS_IsUndefined(pd) && !JS_IsNull(pd)) {
        data = JS_GetArrayBuffer(ctx, &len, pd);
    }
    JS_FreeValue(ctx, pd);
    *out_len = len;
    return data;
}

static JSValue js_texImage2D(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    TracyCZoneN(zone, "gl.texImage2D", g_tracy_enabled);
    GLenum target = arg_uint(ctx, argv[0]);
    GLint level = arg_int(ctx, argv[1]);

    if (argc <= 6 && argc > 0 && JS_IsObject(argv[argc - 1]) && is_image_like_source(ctx, argv[argc - 1])) {
        GLint internalformat = arg_int(ctx, argv[2]);
        GLenum format = arg_uint(ctx, argv[3]);
        GLenum type = arg_uint(ctx, argv[4]);
        JSValueConst source = argv[5];

        GLint gl_internal = internalformat;
        if (gl_internal == GL_RGBA) gl_internal = GL_RGBA8;
        else if (gl_internal == GL_RGB) gl_internal = GL_RGB8;

        int w = 0, h = 0;
        size_t len = 0;
        uint8_t *pixels = get_image_source_pixels(ctx, source, &w, &h, &len);

        uint8_t *scratch = NULL;
        if (pixels && (g_gl_state.unpack_flip_y || g_gl_state.unpack_premultiply_alpha)) {
            scratch = malloc(len);
            memcpy(scratch, pixels, len);
            if (g_gl_state.unpack_premultiply_alpha && format == GL_RGBA)
                premultiply_in_place(scratch, len);
            if (g_gl_state.unpack_flip_y)
                flip_rows_in_place(scratch, w, h, 4);
            pixels = scratch;
        }
        glTexImage2D(target, level, gl_internal, w, h, 0, format, type, pixels);
        if (scratch) free(scratch);
        TracyCZoneEnd(zone);
        return JS_UNDEFINED;
    }

    GLint internalformat = arg_int(ctx, argv[2]);
    GLsizei width = arg_int(ctx, argv[3]);
    GLsizei height = arg_int(ctx, argv[4]);
    GLint border = arg_int(ctx, argv[5]);
    GLenum format = arg_uint(ctx, argv[6]);
    GLenum type = arg_uint(ctx, argv[7]);
    size_t len = 0;
    uint8_t *pixels = argc > 8 ? arg_typed_array(ctx, argv[8], &len) : NULL;

    GLint gl_internal = internalformat;
    if (gl_internal == GL_RGBA) gl_internal = GL_RGBA8;
    else if (gl_internal == GL_RGB) gl_internal = GL_RGB8;

    uint8_t *scratch = NULL;
    if (pixels && (g_gl_state.unpack_flip_y || g_gl_state.unpack_premultiply_alpha)) {
        scratch = malloc(len);
        memcpy(scratch, pixels, len);
        if (g_gl_state.unpack_premultiply_alpha && format == GL_RGBA)
            premultiply_in_place(scratch, len);
        if (g_gl_state.unpack_flip_y)
            flip_rows_in_place(scratch, width, height, format == GL_RGBA ? 4 : format == GL_RGB ? 3 : 1);
        pixels = scratch;
    }
    glTexImage2D(target, level, gl_internal, width, height, border, format, type, pixels);
    if (scratch) free(scratch);
    TracyCZoneEnd(zone);
    return JS_UNDEFINED;
}

static JSValue js_texSubImage2D(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    TracyCZoneN(zone, "gl.texSubImage2D", g_tracy_enabled);
    GLenum target = arg_uint(ctx, argv[0]);
    GLint level = arg_int(ctx, argv[1]);

    // Same dual-overload situation as texImage2D above:
    //   9-arg raw buffer: (target, level, xoffset, yoffset, width, height, format, type, pixels)
    //   7-arg image source: (target, level, xoffset, yoffset, format, type, source)
    // Confirmed required: BaseImageResource.upload()'s texSubImage2D fast
    // path uses the 7-arg form for same-size texture updates.
    if (argc <= 7 && argc > 0 && JS_IsObject(argv[argc - 1]) && is_image_like_source(ctx, argv[argc - 1])) {
        GLint xoffset = arg_int(ctx, argv[2]);
        GLint yoffset = arg_int(ctx, argv[3]);
        GLenum format = arg_uint(ctx, argv[4]);
        GLenum type = arg_uint(ctx, argv[5]);
        JSValueConst source = argv[6];

        int w = 0, h = 0;
        size_t len = 0;
        uint8_t *pixels = get_image_source_pixels(ctx, source, &w, &h, &len);

        uint8_t *scratch = NULL;
        if (pixels && (g_gl_state.unpack_flip_y || g_gl_state.unpack_premultiply_alpha)) {
            scratch = malloc(len);
            memcpy(scratch, pixels, len);
            if (g_gl_state.unpack_premultiply_alpha && format == GL_RGBA)
                premultiply_in_place(scratch, len);
            if (g_gl_state.unpack_flip_y)
                flip_rows_in_place(scratch, w, h, 4);
            pixels = scratch;
        }
        glTexSubImage2D(target, level, xoffset, yoffset, w, h, format, type, pixels);
        if (scratch) free(scratch);
        TracyCZoneEnd(zone);
        return JS_UNDEFINED;
    }

    GLint xoffset = arg_int(ctx, argv[2]);
    GLint yoffset = arg_int(ctx, argv[3]);
    GLsizei width = arg_int(ctx, argv[4]);
    GLsizei height = arg_int(ctx, argv[5]);
    GLenum format = arg_uint(ctx, argv[6]);
    GLenum type = arg_uint(ctx, argv[7]);
    size_t len = 0;
    uint8_t *pixels = argc > 8 ? arg_typed_array(ctx, argv[8], &len) : NULL;
    uint8_t *scratch = NULL;
    if (pixels && (g_gl_state.unpack_flip_y || g_gl_state.unpack_premultiply_alpha)) {
        scratch = malloc(len);
        memcpy(scratch, pixels, len);
        if (g_gl_state.unpack_premultiply_alpha && format == GL_RGBA)
            premultiply_in_place(scratch, len);
        if (g_gl_state.unpack_flip_y)
            flip_rows_in_place(scratch, width, height, format == GL_RGBA ? 4 : format == GL_RGB ? 3 : 1);
        pixels = scratch;
    }
    glTexSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixels);
    if (scratch) free(scratch);
    TracyCZoneEnd(zone);
    return JS_UNDEFINED;
}

static JSValue js_texImage3D(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    size_t len = 0;
    uint8_t *pixels = argc > 9 ? arg_typed_array(ctx, argv[9], &len) : NULL;
    glTexImage3D(arg_uint(ctx, argv[0]), arg_int(ctx, argv[1]), arg_int(ctx, argv[2]),
                 arg_int(ctx, argv[3]), arg_int(ctx, argv[4]), arg_int(ctx, argv[5]),
                 arg_int(ctx, argv[6]), arg_uint(ctx, argv[7]), arg_uint(ctx, argv[8]), pixels);
    return JS_UNDEFINED;
}
static JSValue js_texSubImage3D(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    size_t len = 0;
    uint8_t *pixels = argc > 10 ? arg_typed_array(ctx, argv[10], &len) : NULL;
    glTexSubImage3D(arg_uint(ctx, argv[0]), arg_int(ctx, argv[1]), arg_int(ctx, argv[2]),
                     arg_int(ctx, argv[3]), arg_int(ctx, argv[4]), arg_int(ctx, argv[5]),
                     arg_int(ctx, argv[6]), arg_int(ctx, argv[7]), arg_uint(ctx, argv[8]),
                     arg_uint(ctx, argv[9]), pixels);
    return JS_UNDEFINED;
}

// ------------------------------------------------------------------
// Shader / program pipeline
// ------------------------------------------------------------------

static JSValue js_shaderSource(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    GLuint shader = arg_handle(ctx, argv[0]);
    const char *src = JS_ToCString(ctx, argv[1]);
    
    // Create a mutable copy of the shader source
    size_t slen = strlen(src);
    char *cleaned = malloc(slen + 1);
    strcpy(cleaned, src);
    
    // Overwrite any 'precision ...;' declarations with spaces
    char *p = cleaned;
    while ((p = strstr(p, "precision "))) {
        char *end = strchr(p, ';');
        if (end) {
            memset(p, ' ', end - p + 1);
        } else {
            break;
        }
    }
    
    const char *final_src = cleaned;
    glShaderSource(shader, 1, &final_src, NULL);
    
    free(cleaned);
    JS_FreeCString(ctx, src);
    return JS_UNDEFINED;
}
static JSValue js_compileShader(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glCompileShader(arg_handle(ctx, argv[0])); return JS_UNDEFINED;
}
static JSValue js_bindAttribLocation(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    const char *name = JS_ToCString(ctx, argv[2]);
    glBindAttribLocation(arg_handle(ctx, argv[0]), arg_uint(ctx, argv[1]), name);
    JS_FreeCString(ctx, name);
    return JS_UNDEFINED;
}
static JSValue js_linkProgram(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glLinkProgram(arg_handle(ctx, argv[0])); return JS_UNDEFINED;
}
static JSValue js_useProgram(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glUseProgram(arg_handle(ctx, argv[0])); return JS_UNDEFINED;
}
static JSValue js_getShaderInfoLog(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    GLuint shader = arg_handle(ctx, argv[0]);
    char buf[4096]; GLsizei len = 0;
    glGetShaderInfoLog(shader, sizeof(buf), &len, buf);
    return JS_NewStringLen(ctx, buf, len);
}
static JSValue js_getProgramInfoLog(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    GLuint prog = arg_handle(ctx, argv[0]);
    char buf[4096]; GLsizei len = 0;
    glGetProgramInfoLog(prog, sizeof(buf), &len, buf);
    return JS_NewStringLen(ctx, buf, len);
}

static JSValue js_getShaderParameter(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    GLuint shader = arg_handle(ctx, argv[0]);
    GLenum pname = arg_uint(ctx, argv[1]);
    GLint v = 0;
    glGetShaderiv(shader, pname, &v);
    if (pname == GL_COMPILE_STATUS || pname == GL_DELETE_STATUS)
        return JS_NewBool(ctx, v != 0);
    return JS_NewInt32(ctx, v);
}
static JSValue js_getProgramParameter(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    GLuint prog = arg_handle(ctx, argv[0]);
    GLenum pname = arg_uint(ctx, argv[1]);
    GLint v = 0;
    glGetProgramiv(prog, pname, &v);
    if (pname == GL_LINK_STATUS || pname == GL_VALIDATE_STATUS || pname == GL_DELETE_STATUS)
        return JS_NewBool(ctx, v != 0);
    return JS_NewInt32(ctx, v);
}

static JSValue js_getActiveAttrib(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    GLuint prog = arg_handle(ctx, argv[0]);
    GLuint index = arg_uint(ctx, argv[1]);
    
    char name[256];
    memset(name, 0, sizeof(name)); // Ensure safe buffer
    GLsizei len = 0, size = 0; GLenum type = 0;
    
    glGetActiveAttrib(prog, index, sizeof(name) - 1, &len, &size, &type, name);
    
    // Force standard C length calculation to strip Intel's trailing null byte
    len = (GLsizei)strlen(name);
    
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "name", JS_NewStringLen(ctx, name, len));
    JS_SetPropertyStr(ctx, obj, "size", JS_NewInt32(ctx, size));
    JS_SetPropertyStr(ctx, obj, "type", JS_NewInt32(ctx, (int32_t)type));
    return obj;
}
static JSValue js_getActiveUniform(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    GLuint prog = arg_handle(ctx, argv[0]);
    GLuint index = arg_uint(ctx, argv[1]);
    
    char name[256];
    memset(name, 0, sizeof(name)); // Ensure safe buffer
    GLsizei len = 0, size = 0; GLenum type = 0;
    
    glGetActiveUniform(prog, index, sizeof(name) - 1, &len, &size, &type, name);
    
    // Force standard C length calculation to strip Intel's trailing null byte
    len = (GLsizei)strlen(name);
    
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "name", JS_NewStringLen(ctx, name, len));
    JS_SetPropertyStr(ctx, obj, "size", JS_NewInt32(ctx, size));
    JS_SetPropertyStr(ctx, obj, "type", JS_NewInt32(ctx, (int32_t)type));
    return obj;
}

static JSValue js_getUniformLocation(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    GLuint prog = arg_handle(ctx, argv[0]);
    const char *name = JS_ToCString(ctx, argv[1]);
    GLint loc = glGetUniformLocation(prog, name);
    JS_FreeCString(ctx, name);
    return make_location(ctx, loc);
}

// Desktop GL does not have glGetShaderPrecisionFormat; stub with WebGL defaults.
static JSValue js_getShaderPrecisionFormat(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    GLenum shaderType = arg_uint(ctx, argv[0]);
    GLenum precisionType = arg_uint(ctx, argv[1]);
    (void)shaderType;
    GLint range[2] = {127, 127};
    GLint precision = 23;
    switch (precisionType) {
        case 0x8DF0: case 0x8DF1: case 0x8DF2:
            range[0] = 127; range[1] = 127; precision = 23;
            break;
        case 0x8DF3: case 0x8DF4: case 0x8DF5:
            range[0] = 24; range[1] = 24; precision = 0;
            break;
    }
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "rangeMin", JS_NewInt32(ctx, range[0]));
    JS_SetPropertyStr(ctx, obj, "rangeMax", JS_NewInt32(ctx, range[1]));
    JS_SetPropertyStr(ctx, obj, "precision", JS_NewInt32(ctx, precision));
    return obj;
}

// ------------------------------------------------------------------
// Uniform setters
// ------------------------------------------------------------------

#define GEN_UNIFORM_1(jsname, glfn, ctype, conv)                               \
static JSValue js_##jsname(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) { \
    (void)t; glfn(arg_location(ctx, argv[0]), conv(ctx, argv[1])); return JS_UNDEFINED; }
#define GEN_UNIFORM_2(jsname, glfn, conv)                                      \
static JSValue js_##jsname(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) { \
    (void)t; glfn(arg_location(ctx, argv[0]), conv(ctx, argv[1]), conv(ctx, argv[2])); return JS_UNDEFINED; }
#define GEN_UNIFORM_3(jsname, glfn, conv)                                      \
static JSValue js_##jsname(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) { \
    (void)t; glfn(arg_location(ctx, argv[0]), conv(ctx, argv[1]), conv(ctx, argv[2]), conv(ctx, argv[3])); return JS_UNDEFINED; }
#define GEN_UNIFORM_4(jsname, glfn, conv)                                      \
static JSValue js_##jsname(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) { \
    (void)t; glfn(arg_location(ctx, argv[0]), conv(ctx, argv[1]), conv(ctx, argv[2]), conv(ctx, argv[3]), conv(ctx, argv[4])); return JS_UNDEFINED; }

GEN_UNIFORM_1(uniform1f, glUniform1f, GLfloat, arg_float)
GEN_UNIFORM_1(uniform1i, glUniform1i, GLint, arg_int)
GEN_UNIFORM_2(uniform2f, glUniform2f, arg_float)
GEN_UNIFORM_2(uniform2i, glUniform2i, arg_int)
GEN_UNIFORM_3(uniform3f, glUniform3f, arg_float)
GEN_UNIFORM_3(uniform3i, glUniform3i, arg_int)
GEN_UNIFORM_4(uniform4f, glUniform4f, arg_float)
GEN_UNIFORM_4(uniform4i, glUniform4i, arg_int)

#define GEN_UNIFORM_V(jsname, glfn, ctype)                                     \
static JSValue js_##jsname(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) { \
    (void)t; size_t len = 0; uint8_t *data = arg_typed_array(ctx, argv[1], &len); \
    glfn(arg_location(ctx, argv[0]), (GLsizei)(len / sizeof(ctype)), (const ctype *)data); \
    return JS_UNDEFINED; }

GEN_UNIFORM_V(uniform1fv, glUniform1fv, GLfloat)
GEN_UNIFORM_V(uniform2fv, glUniform2fv, GLfloat)
GEN_UNIFORM_V(uniform3fv, glUniform3fv, GLfloat)
GEN_UNIFORM_V(uniform4fv, glUniform4fv, GLfloat)
GEN_UNIFORM_V(uniform1iv, glUniform1iv, GLint)
GEN_UNIFORM_V(uniform2iv, glUniform2iv, GLint)
GEN_UNIFORM_V(uniform3iv, glUniform3iv, GLint)
GEN_UNIFORM_V(uniform4iv, glUniform4iv, GLint)

#define GEN_UNIFORM_MATRIX(jsname, glfn, count)                                \
static JSValue js_##jsname(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) { \
    (void)t; GLboolean transpose = arg_bool(ctx, argv[1]);                     \
    size_t len = 0; uint8_t *data = arg_typed_array(ctx, argv[2], &len);       \
    glfn(arg_location(ctx, argv[0]), (GLsizei)(len / (sizeof(GLfloat) * count)), transpose, (const GLfloat *)data); \
    return JS_UNDEFINED; }

GEN_UNIFORM_MATRIX(uniformMatrix2fv, glUniformMatrix2fv, 4)
GEN_UNIFORM_MATRIX(uniformMatrix3fv, glUniformMatrix3fv, 9)
GEN_UNIFORM_MATRIX(uniformMatrix4fv, glUniformMatrix4fv, 16)

// ------------------------------------------------------------------
// Vertex attributes / drawing
// ------------------------------------------------------------------

static JSValue js_enableVertexAttribArray(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glEnableVertexAttribArray(arg_uint(ctx, argv[0])); return JS_UNDEFINED;
}
static JSValue js_vertexAttribPointer(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    glVertexAttribPointer(arg_uint(ctx, argv[0]), arg_int(ctx, argv[1]), arg_uint(ctx, argv[2]),
                           arg_bool(ctx, argv[3]), arg_int(ctx, argv[4]),
                           (const void *)(intptr_t)arg_int(ctx, argv[5]));
    return JS_UNDEFINED;
}
static JSValue js_vertexAttribDivisor(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glVertexAttribDivisor(arg_uint(ctx, argv[0]), arg_uint(ctx, argv[1])); return JS_UNDEFINED;
}
static JSValue js_drawArrays(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; TracyCZoneN(zone, "gl.drawArrays", g_tracy_enabled); glDrawArrays(arg_uint(ctx, argv[0]), arg_int(ctx, argv[1]), arg_int(ctx, argv[2])); TracyCZoneEnd(zone);
    return JS_UNDEFINED;
}
static JSValue js_drawElements(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    TracyCZoneN(zone, "gl.drawElements", g_tracy_enabled);
    glDrawElements(arg_uint(ctx, argv[0]), arg_int(ctx, argv[1]), arg_uint(ctx, argv[2]),
                    (const void *)(intptr_t)arg_int(ctx, argv[3]));
    TracyCZoneEnd(zone);
    return JS_UNDEFINED;
}
static JSValue js_drawArraysInstanced(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    TracyCZoneN(zone, "gl.drawArraysInstanced", g_tracy_enabled);
    glDrawArraysInstanced(arg_uint(ctx, argv[0]), arg_int(ctx, argv[1]), arg_int(ctx, argv[2]), arg_int(ctx, argv[3]));
    TracyCZoneEnd(zone);
    return JS_UNDEFINED;
}
static JSValue js_drawElementsInstanced(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    TracyCZoneN(zone, "gl.drawElementsInstanced", g_tracy_enabled);
    glDrawElementsInstanced(arg_uint(ctx, argv[0]), arg_int(ctx, argv[1]), arg_uint(ctx, argv[2]),
                             (const void *)(intptr_t)arg_int(ctx, argv[3]), arg_int(ctx, argv[4]));
    TracyCZoneEnd(zone);
    return JS_UNDEFINED;
}
static JSValue js_drawBuffers(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    if (argc < 1 || !JS_IsObject(argv[0])) return JS_UNDEFINED;
    JSValue lenVal = JS_GetPropertyStr(ctx, argv[0], "length");
    int32_t n = 0; JS_ToInt32(ctx, &n, lenVal); JS_FreeValue(ctx, lenVal);
    if (n <= 0 || n > 16) return JS_UNDEFINED;
    GLenum bufs[16];
    for (int i = 0; i < n; i++) {
        JSValue el = JS_GetPropertyUint32(ctx, argv[0], i);
        bufs[i] = arg_uint(ctx, el);
        JS_FreeValue(ctx, el);
    }
    glDrawBuffers(n, bufs);
    return JS_UNDEFINED;
}

// ------------------------------------------------------------------
// Framebuffer / renderbuffer
// ------------------------------------------------------------------

static JSValue js_framebufferTexture2D(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    glFramebufferTexture2D(arg_uint(ctx, argv[0]), arg_uint(ctx, argv[1]), arg_uint(ctx, argv[2]),
                            arg_handle(ctx, argv[3]), arg_int(ctx, argv[4]));
    return JS_UNDEFINED;
}
static JSValue js_framebufferRenderbuffer(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    glFramebufferRenderbuffer(arg_uint(ctx, argv[0]), arg_uint(ctx, argv[1]), arg_uint(ctx, argv[2]), arg_handle(ctx, argv[3]));
    return JS_UNDEFINED;
}
static JSValue js_renderbufferStorage(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    glRenderbufferStorage(arg_uint(ctx, argv[0]), arg_uint(ctx, argv[1]), arg_int(ctx, argv[2]), arg_int(ctx, argv[3]));
    return JS_UNDEFINED;
}
static JSValue js_renderbufferStorageMultisample(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    glRenderbufferStorageMultisample(arg_uint(ctx, argv[0]), arg_int(ctx, argv[1]), arg_uint(ctx, argv[2]),
                                      arg_int(ctx, argv[3]), arg_int(ctx, argv[4]));
    return JS_UNDEFINED;
}
static JSValue js_blitFramebuffer(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    glBlitFramebuffer(arg_int(ctx, argv[0]), arg_int(ctx, argv[1]), arg_int(ctx, argv[2]), arg_int(ctx, argv[3]),
                       arg_int(ctx, argv[4]), arg_int(ctx, argv[5]), arg_int(ctx, argv[6]), arg_int(ctx, argv[7]),
                       arg_uint(ctx, argv[8]), arg_uint(ctx, argv[9]));
    return JS_UNDEFINED;
}
static JSValue js_generateMipmap(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glGenerateMipmap(arg_uint(ctx, argv[0])); return JS_UNDEFINED;
}
static JSValue js_readPixels(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    size_t len = 0;
    uint8_t *data = arg_typed_array(ctx, argv[6], &len);
    glReadPixels(arg_int(ctx, argv[0]), arg_int(ctx, argv[1]), arg_int(ctx, argv[2]), arg_int(ctx, argv[3]),
                 arg_uint(ctx, argv[4]), arg_uint(ctx, argv[5]), data);
    return JS_UNDEFINED;
}

// ------------------------------------------------------------------
// State / misc
// ------------------------------------------------------------------

static JSValue js_activeTexture(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glActiveTexture(arg_uint(ctx, argv[0])); return JS_UNDEFINED;
}
static JSValue js_blendFunc(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glBlendFunc(arg_uint(ctx, argv[0]), arg_uint(ctx, argv[1])); return JS_UNDEFINED;
}
static JSValue js_blendFuncSeparate(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glBlendFuncSeparate(arg_uint(ctx, argv[0]), arg_uint(ctx, argv[1]), arg_uint(ctx, argv[2]), arg_uint(ctx, argv[3])); return JS_UNDEFINED;
}
static JSValue js_blendEquationSeparate(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glBlendEquationSeparate(arg_uint(ctx, argv[0]), arg_uint(ctx, argv[1])); return JS_UNDEFINED;
}
static JSValue js_clear(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; TracyCZoneN(zone, "gl.clear", 1); glClear((GLbitfield)arg_uint(ctx, argv[0])); TracyCZoneEnd(zone); return JS_UNDEFINED;
}
static JSValue js_clearColor(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glClearColor(arg_float(ctx, argv[0]), arg_float(ctx, argv[1]), arg_float(ctx, argv[2]), arg_float(ctx, argv[3])); return JS_UNDEFINED;
}
static JSValue js_clearStencil(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glClearStencil(arg_int(ctx, argv[0])); return JS_UNDEFINED;
}
static JSValue js_colorMask(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glColorMask(arg_bool(ctx, argv[0]), arg_bool(ctx, argv[1]), arg_bool(ctx, argv[2]), arg_bool(ctx, argv[3])); return JS_UNDEFINED;
}
static JSValue js_enable(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glEnable(arg_uint(ctx, argv[0])); return JS_UNDEFINED;
}
static JSValue js_disable(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glDisable(arg_uint(ctx, argv[0])); return JS_UNDEFINED;
}
static JSValue js_frontFace(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glFrontFace(arg_uint(ctx, argv[0])); return JS_UNDEFINED;
}
static JSValue js_getAttribLocation(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    GLuint prog = arg_handle(ctx, argv[0]);
    const char *name = JS_ToCString(ctx, argv[1]);
    GLint loc = glGetAttribLocation(prog, name);
    JS_FreeCString(ctx, name);
    return JS_NewInt32(ctx, loc);
}
static JSValue js_stencilMask(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glStencilMask((GLuint)arg_uint(ctx, argv[0])); return JS_UNDEFINED;
}
static JSValue js_depthMask(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glDepthMask(arg_bool(ctx, argv[0])); return JS_UNDEFINED;
}
static JSValue js_cullFace(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glCullFace((GLenum)arg_uint(ctx, argv[0])); return JS_UNDEFINED;
}
static JSValue js_scissor(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glScissor(arg_int(ctx, argv[0]), arg_int(ctx, argv[1]), arg_int(ctx, argv[2]), arg_int(ctx, argv[3])); return JS_UNDEFINED;
}
static JSValue js_viewport(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glViewport(arg_int(ctx, argv[0]), arg_int(ctx, argv[1]), arg_int(ctx, argv[2]), arg_int(ctx, argv[3])); return JS_UNDEFINED;
}
static JSValue js_polygonOffset(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glPolygonOffset(arg_float(ctx, argv[0]), arg_float(ctx, argv[1])); return JS_UNDEFINED;
}
static JSValue js_stencilFunc(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glStencilFunc(arg_uint(ctx, argv[0]), arg_int(ctx, argv[1]), arg_uint(ctx, argv[2])); return JS_UNDEFINED;
}
static JSValue js_stencilOp(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glStencilOp(arg_uint(ctx, argv[0]), arg_uint(ctx, argv[1]), arg_uint(ctx, argv[2])); return JS_UNDEFINED;
}
static JSValue js_flush(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; (void)argc; (void)argv; glFlush(); return JS_UNDEFINED;
}
static JSValue js_getError(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; (void)argc; (void)argv; return JS_NewInt32(ctx, (int32_t)glGetError());
}
static JSValue js_isContextLost(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; (void)argc; (void)argv; return JS_NewBool(ctx, 0);
}
static JSValue js_getContextAttributes(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; (void)argc; (void)argv;
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "alpha", JS_NewBool(ctx, 1));
    JS_SetPropertyStr(ctx, obj, "antialias", JS_NewBool(ctx, 0));
    JS_SetPropertyStr(ctx, obj, "premultipliedAlpha", JS_NewBool(ctx, 1));
    // Confirmed required: pixi.js's Renderer.create checks
    // gl.getContextAttributes().stencil and throws "WebGL unsupported in
    // this browser" if it's falsy (traced directly in the bundle).
    JS_SetPropertyStr(ctx, obj, "stencil", JS_NewBool(ctx, 1));
    return obj;
}

static JSValue js_texParameteri(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glTexParameteri(arg_uint(ctx, argv[0]), arg_uint(ctx, argv[1]), arg_int(ctx, argv[2])); return JS_UNDEFINED;
}
static JSValue js_texParameterf(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t; glTexParameterf(arg_uint(ctx, argv[0]), arg_uint(ctx, argv[1]), arg_float(ctx, argv[2])); return JS_UNDEFINED;
}

#define GL_UNPACK_FLIP_Y_WEBGL 0x9240
#define GL_UNPACK_PREMULTIPLY_ALPHA_WEBGL 0x9241
static JSValue js_pixelStorei(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    GLenum pname = arg_uint(ctx, argv[0]);
    if (pname == GL_UNPACK_FLIP_Y_WEBGL) {
        g_gl_state.unpack_flip_y = arg_bool(ctx, argv[1]);
        return JS_UNDEFINED;
    }
    if (pname == GL_UNPACK_PREMULTIPLY_ALPHA_WEBGL) {
        g_gl_state.unpack_premultiply_alpha = arg_bool(ctx, argv[1]);
        return JS_UNDEFINED;
    }
    glPixelStorei(pname, arg_int(ctx, argv[1]));
    return JS_UNDEFINED;
}

static JSValue js_getParameter(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    GLenum pname = arg_uint(ctx, argv[0]);
    if (pname == 0x84FF) {
        GLfloat v = 1.0f;
#ifdef GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT
        glGetFloatv(GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT, &v);
#endif
        return JS_NewFloat64(ctx, v);
    }
    GLint v = 0;
    glGetIntegerv(pname, &v);
    return JS_NewInt32(ctx, v);
}
static JSValue js_getInternalformatParameter(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)ctx; (void)t; (void)argc; (void)argv;
    return JS_NULL;
}

static JSValue js_getExtension(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    const char *name = JS_ToCString(ctx, argv[0]);
    JSValue obj = JS_NewObject(ctx);
    if (name && strcmp(name, "EXT_texture_filter_anisotropic") == 0) {
        JS_SetPropertyStr(ctx, obj, "TEXTURE_MAX_ANISOTROPY_EXT", JS_NewInt32(ctx, 0x84FE));
        JS_SetPropertyStr(ctx, obj, "MAX_TEXTURE_MAX_ANISOTROPY_EXT", JS_NewInt32(ctx, 0x84FF));
    }
    if (name && strcmp(name, "WEBGL_lose_context") == 0) {
        JS_SetPropertyStr(ctx, obj, "loseContext", JS_NewCFunction(ctx, js_flush, "loseContext", 0));
        JS_SetPropertyStr(ctx, obj, "restoreContext", JS_NewCFunction(ctx, js_flush, "restoreContext", 0));
    }
    if (name) JS_FreeCString(ctx, name);
    return obj;
}

// ------------------------------------------------------------------
// Batch buffer uploads — collapse many per-upload JS->C crossings into a
// single native call. gl.bufferSubData alone was traced at ~693k calls;
// batching them is the "reduce JS<->C boundary crossings" optimization.
// ------------------------------------------------------------------

// gl.batchBufferSubData([{target, offset, data, buffer}, ...]) — runs N
// bufferSubData uploads in one native call instead of 3 JS->C hops per
// upload. Each item carries the buffer ID that was bound at deferral time,
// so the C loop re-binds it before uploading (correct even if the JS side
// switched buffers between deferred calls).
static JSValue js_batchBufferSubData(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    if (argc < 1 || !JS_IsArray(argv[0])) return JS_UNDEFINED;
    TracyCZoneN(zone, "gl.batchBufferSubData", g_tracy_enabled);
    JSValue len_val = JS_GetPropertyStr(ctx, argv[0], "length");
    int32_t n = 0;
    JS_ToInt32(ctx, &n, len_val);
    JS_FreeValue(ctx, len_val);
    for (int32_t i = 0; i < n; i++) {
        JSValue item = JS_GetPropertyUint32(ctx, argv[0], i);
        if (!JS_IsObject(item)) { JS_FreeValue(ctx, item); continue; }

        JSValue targetVal = JS_GetPropertyStr(ctx, item, "target");
        JSValue offsetVal = JS_GetPropertyStr(ctx, item, "offset");
        JSValue dataVal   = JS_GetPropertyStr(ctx, item, "data");
        JSValue bufferVal = JS_GetPropertyStr(ctx, item, "buffer");

        GLenum target = arg_uint(ctx, targetVal);
        GLintptr offset = (GLintptr)arg_int(ctx, offsetVal);
        GLuint buffer = arg_handle(ctx, bufferVal);
        size_t len = 0;
        uint8_t *data = arg_typed_array(ctx, dataVal, &len);

        if (data && len > 0) {
            glBindBuffer(target, buffer);
            glBufferSubData(target, offset, (GLsizeiptr)len, data);
        }

        JS_FreeValue(ctx, targetVal);
        JS_FreeValue(ctx, offsetVal);
        JS_FreeValue(ctx, dataVal);
        JS_FreeValue(ctx, bufferVal);
        JS_FreeValue(ctx, item);
    }
    TracyCZoneEnd(zone);
    return JS_UNDEFINED;
}

// gl.uploadBatchBuffer(vertexBuffer, vertexData, indexBuffer, indexData[, usage])
// — uploads a render batch's vertex + index buffers in one native call.
// Leaves GL_ARRAY_BUFFER bound to vertexBuffer and GL_ELEMENT_ARRAY_BUFFER
// bound to indexBuffer, exactly like two glBufferData calls would.
static JSValue js_uploadBatchBuffer(JSContext *ctx, JSValueConst t, int argc, JSValueConst *argv) {
    (void)t;
    if (argc < 4) return JS_UNDEFINED;
    TracyCZoneN(zone, "gl.uploadBatchBuffer", g_tracy_enabled);
    GLuint vbo = arg_handle(ctx, argv[0]);
    GLuint ibo = arg_handle(ctx, argv[2]);
    GLenum usage = argc > 4 ? arg_uint(ctx, argv[4]) : GL_DYNAMIC_DRAW;

    size_t vlen = 0;
    uint8_t *vdata = arg_typed_array(ctx, argv[1], &vlen);
    size_t ilen = 0;
    uint8_t *idata = arg_typed_array(ctx, argv[3], &ilen);

    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)vlen, vdata, usage);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ibo);
    glBufferData(GL_ELEMENT_ARRAY_BUFFER, (GLsizeiptr)ilen, idata, usage);

    TracyCZoneEnd(zone);
    return JS_UNDEFINED;
}

// ------------------------------------------------------------------
// Registration
// ------------------------------------------------------------------

#define REG(obj, name) JS_SetPropertyStr(ctx, obj, #name, JS_NewCFunction(ctx, js_##name, #name, 0))
#define REG_CONST(obj, name) JS_SetPropertyStr(ctx, obj, #name, JS_NewInt32(ctx, GL_##name))

void register_gl_constants(JSContext *ctx, JSValueConst gl_obj) {
    REG_CONST(gl_obj, ACTIVE_ATTRIBUTES); REG_CONST(gl_obj, ACTIVE_UNIFORMS);
    REG_CONST(gl_obj, ARRAY_BUFFER); REG_CONST(gl_obj, BLEND);
    REG_CONST(gl_obj, COLOR_ATTACHMENT0); REG_CONST(gl_obj, COLOR_BUFFER_BIT);
    REG_CONST(gl_obj, COMPILE_STATUS); REG_CONST(gl_obj, CULL_FACE);
    REG_CONST(gl_obj, DECR); REG_CONST(gl_obj, DEPTH_ATTACHMENT);
    REG_CONST(gl_obj, DEPTH_COMPONENT); REG_CONST(gl_obj, DEPTH_COMPONENT16);
    REG_CONST(gl_obj, DEPTH_STENCIL); REG_CONST(gl_obj, DEPTH_STENCIL_ATTACHMENT);
    REG_CONST(gl_obj, DEPTH_TEST); REG_CONST(gl_obj, DST_ALPHA);
    REG_CONST(gl_obj, DST_COLOR); REG_CONST(gl_obj, DYNAMIC_DRAW);
    REG_CONST(gl_obj, ELEMENT_ARRAY_BUFFER); REG_CONST(gl_obj, EQUAL);
    REG_CONST(gl_obj, FLOAT); REG_CONST(gl_obj, FRAGMENT_SHADER);
    REG_CONST(gl_obj, FRAMEBUFFER); REG_CONST(gl_obj, FUNC_ADD);
    REG_CONST(gl_obj, FUNC_REVERSE_SUBTRACT); REG_CONST(gl_obj, HALF_FLOAT);
    REG_CONST(gl_obj, HIGH_FLOAT); REG_CONST(gl_obj, INCR); REG_CONST(gl_obj, KEEP);
    REG_CONST(gl_obj, LINEAR); REG_CONST(gl_obj, LINEAR_MIPMAP_LINEAR);
    REG_CONST(gl_obj, LINES); REG_CONST(gl_obj, LINK_STATUS);
    REG_CONST(gl_obj, MAX_TEXTURE_IMAGE_UNITS); REG_CONST(gl_obj, NEAREST);
    REG_CONST(gl_obj, NEAREST_MIPMAP_NEAREST); REG_CONST(gl_obj, ONE);
    REG_CONST(gl_obj, ONE_MINUS_DST_ALPHA); REG_CONST(gl_obj, ONE_MINUS_SRC_ALPHA);
    REG_CONST(gl_obj, ONE_MINUS_SRC_COLOR); REG_CONST(gl_obj, POLYGON_OFFSET_FILL);
    REG_CONST(gl_obj, READ_FRAMEBUFFER); REG_CONST(gl_obj, RENDERBUFFER);
    REG_CONST(gl_obj, RGBA); REG_CONST(gl_obj, RGBA16F); REG_CONST(gl_obj, RGBA32F);
    REG_CONST(gl_obj, RGBA8); REG_CONST(gl_obj, SAMPLES); REG_CONST(gl_obj, SCISSOR_TEST);
    REG_CONST(gl_obj, SRC_ALPHA); REG_CONST(gl_obj, STATIC_DRAW);
    REG_CONST(gl_obj, STENCIL_BUFFER_BIT); REG_CONST(gl_obj, STENCIL_TEST);
    REG_CONST(gl_obj, TEXTURE0); REG_CONST(gl_obj, TEXTURE_2D);
    REG_CONST(gl_obj, TEXTURE_2D_ARRAY); REG_CONST(gl_obj, TEXTURE_CUBE_MAP);
    REG_CONST(gl_obj, TEXTURE_CUBE_MAP_POSITIVE_X); REG_CONST(gl_obj, TEXTURE_MAG_FILTER);
    REG_CONST(gl_obj, TEXTURE_MIN_FILTER); REG_CONST(gl_obj, TEXTURE_WRAP_S);
    REG_CONST(gl_obj, TEXTURE_WRAP_T); REG_CONST(gl_obj, TRIANGLES);
    REG_CONST(gl_obj, UNSIGNED_BYTE); REG_CONST(gl_obj, UNSIGNED_INT);
    REG_CONST(gl_obj, UNSIGNED_SHORT); REG_CONST(gl_obj, VALIDATE_STATUS);
    REG_CONST(gl_obj, VERTEX_SHADER); REG_CONST(gl_obj, ZERO);
    // Confirmed required by tracing pixi.js's mapType()/GL_TO_GLSL_TYPES
    // (generateUniformsSync / uniform & attribute sync): these are read via
    // computed access `gl[tn]`, not `gl.CONST` dot notation, so they were
    // invisible to the original trace regex. Without them, mapType()
    // returns undefined for every uniform/attribute type, causing
    // "cannot read property 'replace' of undefined".
    REG_CONST(gl_obj, FLOAT_VEC2); REG_CONST(gl_obj, FLOAT_VEC3); REG_CONST(gl_obj, FLOAT_VEC4);
    REG_CONST(gl_obj, INT); REG_CONST(gl_obj, INT_VEC2); REG_CONST(gl_obj, INT_VEC3); REG_CONST(gl_obj, INT_VEC4);
    REG_CONST(gl_obj, BOOL); REG_CONST(gl_obj, BOOL_VEC2); REG_CONST(gl_obj, BOOL_VEC3); REG_CONST(gl_obj, BOOL_VEC4);
    REG_CONST(gl_obj, FLOAT_MAT2); REG_CONST(gl_obj, FLOAT_MAT3); REG_CONST(gl_obj, FLOAT_MAT4);
    REG_CONST(gl_obj, SAMPLER_2D);
    REG_CONST(gl_obj, SAMPLER_CUBE);
    REG_CONST(gl_obj, SAMPLER_2D_ARRAY);
#ifdef GL_INT_SAMPLER_2D
    REG_CONST(gl_obj, INT_SAMPLER_2D);
#endif
#ifdef GL_UNSIGNED_INT_SAMPLER_2D
    REG_CONST(gl_obj, UNSIGNED_INT_SAMPLER_2D);
#endif
#ifdef GL_INT_SAMPLER_CUBE
    REG_CONST(gl_obj, INT_SAMPLER_CUBE);
#endif
#ifdef GL_UNSIGNED_INT_SAMPLER_CUBE
    REG_CONST(gl_obj, UNSIGNED_INT_SAMPLER_CUBE);
#endif
#ifdef GL_INT_SAMPLER_2D_ARRAY
    REG_CONST(gl_obj, INT_SAMPLER_2D_ARRAY);
#endif
#ifdef GL_UNSIGNED_INT_SAMPLER_2D_ARRAY
    REG_CONST(gl_obj, UNSIGNED_INT_SAMPLER_2D_ARRAY);
#endif

    JS_SetPropertyStr(ctx, gl_obj, "UNPACK_FLIP_Y_WEBGL", JS_NewInt32(ctx, GL_UNPACK_FLIP_Y_WEBGL));
    JS_SetPropertyStr(ctx, gl_obj, "UNPACK_PREMULTIPLY_ALPHA_WEBGL", JS_NewInt32(ctx, GL_UNPACK_PREMULTIPLY_ALPHA_WEBGL));

    // Additional constants PixiJS may reference
    JS_SetPropertyStr(ctx, gl_obj, "DRAW_FRAMEBUFFER", JS_NewInt32(ctx, 0x8CA9));
    JS_SetPropertyStr(ctx, gl_obj, "LOW_FLOAT", JS_NewInt32(ctx, 0x8DF0));
    JS_SetPropertyStr(ctx, gl_obj, "MEDIUM_FLOAT", JS_NewInt32(ctx, 0x8DF1));
    JS_SetPropertyStr(ctx, gl_obj, "HIGH_FLOAT", JS_NewInt32(ctx, 0x8DF2));
    JS_SetPropertyStr(ctx, gl_obj, "LOW_INT", JS_NewInt32(ctx, 0x8DF3));
    JS_SetPropertyStr(ctx, gl_obj, "MEDIUM_INT", JS_NewInt32(ctx, 0x8DF4));
    JS_SetPropertyStr(ctx, gl_obj, "HIGH_INT", JS_NewInt32(ctx, 0x8DF5));
}

void register_gl_bridge(JSContext *ctx, JSValueConst gl_obj) {
    register_gl_constants(ctx, gl_obj);
    REG(gl_obj, activeTexture); REG(gl_obj, attachShader); REG(gl_obj, bindAttribLocation);
    REG(gl_obj, bindBuffer); REG(gl_obj, bindFramebuffer); REG(gl_obj, bindRenderbuffer);
    REG(gl_obj, bindTexture); REG(gl_obj, bindVertexArray); REG(gl_obj, blendEquationSeparate);
    REG(gl_obj, blendFunc); REG(gl_obj, blendFuncSeparate); REG(gl_obj, blitFramebuffer);
    REG(gl_obj, bufferData); REG(gl_obj, bufferSubData); REG(gl_obj, batchBufferSubData);
    REG(gl_obj, uploadBatchBuffer); REG(gl_obj, clear); REG(gl_obj, clearColor);
    REG(gl_obj, clearStencil); REG(gl_obj, colorMask); REG(gl_obj, compileShader);
    REG(gl_obj, createBuffer); REG(gl_obj, createFramebuffer); REG(gl_obj, createProgram);
    REG(gl_obj, createRenderbuffer); REG(gl_obj, createShader); REG(gl_obj, createTexture);
    REG(gl_obj, createVertexArray); REG(gl_obj, deleteBuffer); REG(gl_obj, deleteFramebuffer);
    REG(gl_obj, deleteProgram); REG(gl_obj, deleteRenderbuffer); REG(gl_obj, deleteShader);
    REG(gl_obj, deleteTexture); REG(gl_obj, deleteVertexArray); REG(gl_obj, disable);
    REG(gl_obj, drawArrays); REG(gl_obj, drawArraysInstanced); REG(gl_obj, drawBuffers);
    REG(gl_obj, drawElements); REG(gl_obj, drawElementsInstanced); REG(gl_obj, enable);
    REG(gl_obj, enableVertexAttribArray); REG(gl_obj, flush); REG(gl_obj, framebufferRenderbuffer);
    REG(gl_obj, framebufferTexture2D); REG(gl_obj, frontFace); REG(gl_obj, generateMipmap);
    REG(gl_obj, getActiveAttrib); REG(gl_obj, getActiveUniform); REG(gl_obj, getAttribLocation);
    REG(gl_obj, getContextAttributes);
    REG(gl_obj, getError); REG(gl_obj, getExtension); REG(gl_obj, getInternalformatParameter);
    REG(gl_obj, getParameter); REG(gl_obj, getProgramInfoLog); REG(gl_obj, getProgramParameter);
    REG(gl_obj, getShaderInfoLog); REG(gl_obj, getShaderParameter); REG(gl_obj, getShaderPrecisionFormat);
    REG(gl_obj, getUniformLocation); REG(gl_obj, isContextLost); REG(gl_obj, linkProgram);
    REG(gl_obj, pixelStorei); REG(gl_obj, polygonOffset); REG(gl_obj, readPixels);
    REG(gl_obj, renderbufferStorage); REG(gl_obj, renderbufferStorageMultisample); REG(gl_obj, scissor);
    REG(gl_obj, shaderSource); REG(gl_obj, stencilFunc); REG(gl_obj, stencilMask); REG(gl_obj, stencilOp);
    REG(gl_obj, cullFace); REG(gl_obj, depthMask);
    REG(gl_obj, texImage2D); REG(gl_obj, texImage3D); REG(gl_obj, texParameterf);
    REG(gl_obj, texParameteri); REG(gl_obj, texSubImage2D); REG(gl_obj, texSubImage3D);
    REG(gl_obj, uniform1f); REG(gl_obj, uniform1fv); REG(gl_obj, uniform1i); REG(gl_obj, uniform1iv);
    REG(gl_obj, uniform2f); REG(gl_obj, uniform2fv); REG(gl_obj, uniform2i); REG(gl_obj, uniform2iv);
    REG(gl_obj, uniform3f); REG(gl_obj, uniform3fv); REG(gl_obj, uniform3i); REG(gl_obj, uniform3iv);
    REG(gl_obj, uniform4f); REG(gl_obj, uniform4fv); REG(gl_obj, uniform4i); REG(gl_obj, uniform4iv);
    REG(gl_obj, uniformMatrix2fv); REG(gl_obj, uniformMatrix3fv); REG(gl_obj, uniformMatrix4fv);
    REG(gl_obj, useProgram); REG(gl_obj, vertexAttribDivisor); REG(gl_obj, vertexAttribPointer);
    REG(gl_obj, viewport);
    REG(gl_obj, getBufferSubDataStats); REG(gl_obj, resetBufferSubDataStats);
}