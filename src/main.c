// rmmz-native: QuickJS + SDL3 + raw GL container for RPG Maker MZ.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#ifdef _WIN32
    #include <direct.h>
#else
    #include <unistd.h>
#endif
#include "quickjs.h"
#include <glad/glad.h>
#include "SDL3/SDL.h"
#include "tracy/TracyC.h"
#include "matrix_math.h"

#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"

#define STB_TRUETYPE_IMPLEMENTATION
#include "stb_truetype.h"

#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"

// ... rest of includes
void register_gl_bridge(JSContext *ctx, JSValueConst gl_obj);

typedef struct {
    JSRuntime *rt;
    JSContext *ctx;
    SDL_Window *window;
    SDL_GLContext gl_ctx;
    int running;
} EngineState;

static EngineState g_engine = {0};
static ma_engine g_audio_engine;
static int g_audio_initialized = 0;

static char *native_data_path(const char *key) {
    // Confirmed bug: RMMZ's NW.js-mode save path includes a subfolder
    // (e.g. key = "save/file1.rmmzsave"), which used to be dropped
    // straight into this snprintf, producing "./savedata/save/....sav".
    // fopen() never creates intermediate directories, so if
    // "./savedata/save/" doesn't already exist on disk, fopen() silently
    // returns NULL and js_native_storage_set's `if (f)` guard skips the
    // write with no error anywhere — saves appeared to work but nothing
    // ever reached disk. Flattening any '/' or '\' out of the key means
    // the path always lands directly inside "./savedata/" and never
    // depends on a subdirectory existing.
    static char sanitized[900];
    size_t i = 0;
    for (; key[i] && i < sizeof(sanitized) - 1; i++) {
        char c = key[i];
        sanitized[i] = (c == '/' || c == '\\') ? '_' : c;
    }
    sanitized[i] = '\0';

    static char path[1024];
    snprintf(path, sizeof(path), "./savedata/%s.sav", sanitized);
    return path;
}

static JSValue js_native_storage_set(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv) {
    if (argc < 2) return JS_UNDEFINED;
    const char *key = JS_ToCString(ctx, argv[0]);
    const char *value = JS_ToCString(ctx, argv[1]);
    if (key && value) {
        FILE *f = fopen(native_data_path(key), "wb");
        if (f) {
            fwrite(value, 1, strlen(value), f);
            fclose(f);
        }
    }
    if (key) JS_FreeCString(ctx, key);
    if (value) JS_FreeCString(ctx, value);
    return JS_UNDEFINED;
}

static JSValue js_native_storage_get(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv) {
    if (argc < 1) return JS_NULL;
    const char *key = JS_ToCString(ctx, argv[0]);
    if (!key) return JS_NULL;
    FILE *f = fopen(native_data_path(key), "rb");
    JSValue result = JS_NULL;
    if (f) {
        fseek(f, 0, SEEK_END);
        long len = ftell(f);
        fseek(f, 0, SEEK_SET);
        char *buf = malloc(len + 1);
        fread(buf, 1, len, f);
        buf[len] = '\0';
        fclose(f);
        result = JS_NewString(ctx, buf);
        free(buf);
    }
    JS_FreeCString(ctx, key);
    return result;
}

// Decode RMMZ percent-encoded asset URLs (Utils.encodeURI: %20 for space,
// %24 for '$', etc.) back into real filesystem paths before fopen/stbi_load.
static void url_decode(char *dst, const char *src, size_t dst_max) {
    size_t i = 0, j = 0;
    while (src[i] && j + 1 < dst_max) {
        if (src[i] == '%' && src[i+1] && src[i+2]) {
            int h1 = src[i+1];
            int h2 = src[i+2];
            int v1 = (h1 >= '0' && h1 <= '9') ? h1 - '0' :
                     (h1 >= 'a' && h1 <= 'f') ? h1 - 'a' + 10 :
                     (h1 >= 'A' && h1 <= 'F') ? h1 - 'A' + 10 : -1;
            int v2 = (h2 >= '0' && h2 <= '9') ? h2 - '0' :
                     (h2 >= 'a' && h2 <= 'f') ? h2 - 'a' + 10 :
                     (h2 >= 'A' && h2 <= 'F') ? h2 - 'A' + 10 : -1;
            if (v1 >= 0 && v2 >= 0) {
                dst[j++] = (char)((v1 << 4) | v2);
                i += 3;
                continue;
            }
        }
        dst[j++] = src[i++];
    }
    dst[j] = '\0';
}

static JSValue js_native_read_file(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    TracyCZoneN(zone, "native.readFile", 1);
    if (argc < 1) { TracyCZoneEnd(zone); return JS_NULL; }
    const char *raw_path = JS_ToCString(ctx, argv[0]);
    if (!raw_path) { TracyCZoneEnd(zone); return JS_NULL; }
    char path[1024];
    url_decode(path, raw_path, sizeof(path));
    JS_FreeCString(ctx, raw_path);
    FILE *f = fopen(path, "rb");
    JSValue result = JS_NULL;
    if (f) {
        fseek(f, 0, SEEK_END);
        long len = ftell(f);
        fseek(f, 0, SEEK_SET);
        char *buf = malloc(len + 1);
        fread(buf, 1, len, f);
        buf[len] = '\0';
        fclose(f);
        result = JS_NewString(ctx, buf);
        free(buf);
    } else {
        fprintf(stderr, "[readFile] missing: %s\n", path);
    }
    TracyCZoneEnd(zone);
    return result;
}

static JSValue js_native_read_file_binary(JSContext *ctx, JSValueConst this_val,
                                           int argc, JSValueConst *argv) {
    TracyCZoneN(zone, "native.readFileBinary", 1);
    if (argc < 1) { TracyCZoneEnd(zone); return JS_NULL; }
    const char *raw_path = JS_ToCString(ctx, argv[0]);
    if (!raw_path) { TracyCZoneEnd(zone); return JS_NULL; }
    char path[1024];
    url_decode(path, raw_path, sizeof(path));
    JS_FreeCString(ctx, raw_path);
    FILE *f = fopen(path, "rb");
    JSValue result = JS_NULL;
    if (f) {
        fseek(f, 0, SEEK_END);
        long len = ftell(f);
        fseek(f, 0, SEEK_SET);
        uint8_t *buf = malloc(len);
        fread(buf, 1, len, f);
        fclose(f);
        result = JS_NewArrayBufferCopy(ctx, buf, len);
        free(buf);
    } else {
        fprintf(stderr, "[readFileBinary] missing: %s\n", path);
    }
    TracyCZoneEnd(zone);
    return result;
}

static JSValue js_native_decode_image(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv) {
    TracyCZoneN(zone, "native.decodeImage", 1);
    if (argc < 1) { TracyCZoneEnd(zone); return JS_NULL; }
    const char *raw_path = JS_ToCString(ctx, argv[0]);
    if (!raw_path) { TracyCZoneEnd(zone); return JS_NULL; }
    char path[1024];
    url_decode(path, raw_path, sizeof(path));
    JS_FreeCString(ctx, raw_path);

    int w, h, channels;
    unsigned char *pixels = stbi_load(path, &w, &h, &channels, 4);
    if (!pixels) {
        fprintf(stderr, "[decodeImage] failed: %s\n", path);
        TracyCZoneEnd(zone);
        return JS_NULL;
    }

    JSValue ab = JS_NewArrayBufferCopy(ctx, pixels, w * h * 4);
    stbi_image_free(pixels);

    JSValue result = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, result, "width", JS_NewInt32(ctx, w));
    JS_SetPropertyStr(ctx, result, "height", JS_NewInt32(ctx, h));
    JS_SetPropertyStr(ctx, result, "data", ab);
    TracyCZoneEnd(zone);
    return result;
}

// ---------------------------------------------------------------------
// Text rasterization via stb_truetype. RMMZ draws all window text with
// canvas fillText(); without this, the 2D canvas rasterizer has no glyphs
// to blit and every menu is a blank window. We load a real TTF from the
// Windows system font directory (target is win32) and rasterize a whole
// string into an RGBA bitmap that the JS canvas context blits in.
// ---------------------------------------------------------------------
static unsigned char *g_font_data = NULL;
static stbtt_fontinfo g_font;
static int g_font_bold = -1; // -1 = never loaded

static const char *FONT_PATHS[] = {
    "fonts/mplus-1m-regular.ttf", "fonts/rmmz-mainfont.ttf",
    "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    NULL
};

static int load_font(int bold) {
    (void)bold;
    if (g_font_data) return 1;
    for (int i = 0; FONT_PATHS[i]; i++) {
        FILE *f = fopen(FONT_PATHS[i], "rb");
        if (!f) continue;
        fseek(f, 0, SEEK_END); long len = ftell(f); fseek(f, 0, SEEK_SET);
        unsigned char *data = malloc(len + 1);
        size_t rd = fread(data, 1, len, f);
        fclose(f);
        if (rd != (size_t)len) { free(data); continue; }
        int offset = stbtt_GetFontOffsetForIndex(data, 0);
        if (offset >= 0 && stbtt_InitFont(&g_font, data, offset)) {
            g_font_data = data;
            return 1;
        }
        free(data);
    }
    return 0;
}

static uint32_t utf8_next_codepoint(const char **p) {
    const uint8_t *s = (const uint8_t *)*p;
    if (!*s) return 0;
    uint32_t cp = 0;
    int len = 0;
    if (*s < 0x80) { cp = *s; len = 1; }
    else if ((*s & 0xE0) == 0xC0) { cp = *s & 0x1F; len = 2; }
    else if ((*s & 0xF0) == 0xE0) { cp = *s & 0x0F; len = 3; }
    else if ((*s & 0xF8) == 0xF0) { cp = *s & 0x07; len = 4; }
    else { (*p)++; return 0xFFFD; }
    for (int i = 1; i < len; i++) {
        if ((s[i] & 0xC0) != 0x80) { *p += i; return 0xFFFD; }
        cp = (cp << 6) | (s[i] & 0x3F);
    }
    *p += len;
    return cp;
}

// Width-only text measurement. Shares the same advance-width loop as
// js_native_rasterize_text below, but skips stbtt_GetCodepointBitmap/the
// per-glyph blit entirely. Added because Canvas2DContextShim.measureText
// was calling the FULL rasterizeText path (glyph bitmap render + malloc +
// JS_NewArrayBufferCopy) purely to read bmp.width off the result and throw
// the pixels away — RMMZ's word-wrap and menu-layout code calls
// measureText many times per frame, so that was effectively doing full
// text rendering work for numbers nobody used.
static JSValue js_native_measure_text(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv) {
    (void)this_val;
    TracyCZoneN(zone, "native.measureText", 1);
    // argv: text, fontFamily, fontSizePx, bold
    JSValue result = JS_NewObject(ctx);
    if (argc < 3) { JS_SetPropertyStr(ctx, result, "width", JS_NewFloat64(ctx, 0)); TracyCZoneEnd(zone); return result; }
    const char *text = JS_ToCString(ctx, argv[0]);
    const char *family = JS_ToCString(ctx, argv[1]);
    double size_px = 12;
    JS_ToFloat64(ctx, &size_px, argv[2]);
    int bold = (argc >= 4) ? JS_ToBool(ctx, argv[3]) : 0;
    if (!bold && family && strstr(family, "bold")) bold = 1;

    if (!text || !text[0] || size_px <= 0 || !load_font(bold)) {
        if (text) JS_FreeCString(ctx, text);
        if (family) JS_FreeCString(ctx, family);
        JS_SetPropertyStr(ctx, result, "width", JS_NewFloat64(ctx, 0));
        TracyCZoneEnd(zone);
        return result;
    }

    float scale = stbtt_ScaleForPixelHeight(&g_font, (float)size_px);
    float pen = 0.0f;
    const char *ptr = text;
    while (*ptr) {
        uint32_t cp = utf8_next_codepoint(&ptr);
        int adv = 0, lsb = 0;
        stbtt_GetCodepointHMetrics(&g_font, (int)cp, &adv, &lsb);
        pen += adv * scale;
    }
    // +4 matches the padding js_native_rasterize_text bakes into its own
    // returned bitmap width, so cursor/layout math stays consistent
    // whichever of the two functions produced the width in use.
    int w = (int)ceilf(pen) + 4; if (w < 1) w = 1;

    JS_FreeCString(ctx, text);
    JS_FreeCString(ctx, family);
    JS_SetPropertyStr(ctx, result, "width", JS_NewFloat64(ctx, w));
    TracyCZoneEnd(zone);
    return result;
}

static JSValue js_native_rasterize_text(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv) {
    (void)this_val;
    TracyCZoneN(zone, "native.rasterizeText", 1);
    // argv: text, fontFamily, fontSizePx, bold, r, g, b, a
    if (argc < 3) { TracyCZoneEnd(zone); return JS_NULL; }
    const char *text = JS_ToCString(ctx, argv[0]);
    const char *family = JS_ToCString(ctx, argv[1]);
    double size_px = 12;
    JS_ToFloat64(ctx, &size_px, argv[2]);
    int bold = (argc >= 4) ? JS_ToBool(ctx, argv[3]) : 0;
    if (!bold && family && strstr(family, "bold")) bold = 1;

    int32_t cr = 255, cg = 255, cb = 255, ca = 255;
    if (argc >= 8) {
        JS_ToInt32(ctx, &cr, argv[4]); JS_ToInt32(ctx, &cg, argv[5]);
        JS_ToInt32(ctx, &cb, argv[6]); JS_ToInt32(ctx, &ca, argv[7]);
    }
    if (ca < 0) ca = 0; if (ca > 255) ca = 255;

    if (!text || !text[0] || size_px <= 0) {
        if (text) JS_FreeCString(ctx, text);
        if (family) JS_FreeCString(ctx, family);
        TracyCZoneEnd(zone);
        return JS_NULL;
    }
    if (!load_font(bold)) {
        static int once = 0;
        if (!once) { once = 1; fprintf(stderr, "[rasterize] NO SYSTEM FONT FOUND (checked C:/Windows/Fonts)\n"); }
        if (text) JS_FreeCString(ctx, text);
        if (family) JS_FreeCString(ctx, family);
        TracyCZoneEnd(zone);
        return JS_NULL;
    }

    {
        static int once = 0;
        if (!once) { once = 1; fprintf(stderr, "[rasterize] font loaded, bold=%d size_px=%.1f\n", bold, size_px); }
    }

    float scale = stbtt_ScaleForPixelHeight(&g_font, (float)size_px);

    // Measure total advance width
    float pen = 0.0f;
    const char *ptr = text;
    while (*ptr) {
        uint32_t cp = utf8_next_codepoint(&ptr);
        int adv = 0, lsb = 0;
        stbtt_GetCodepointHMetrics(&g_font, (int)cp, &adv, &lsb);
        pen += adv * scale;
    }
    int ascent_px = 0, descent_px = 0, line_gap = 0;
    stbtt_GetFontVMetrics(&g_font, &ascent_px, &descent_px, &line_gap);
    int ascent = (int)ceilf(ascent_px * scale);
    int descent = -(int)floorf(descent_px * scale);
    int w = (int)ceilf(pen) + 4; if (w < 1) w = 1;
    int h = ascent + descent + 4; if (h < 1) h = 1;
    int baseline = ascent + 2;

    unsigned char *rgba = calloc(1, (size_t)w * (size_t)h * 4);

    float x = 0.0f;
    ptr = text;
    while (*ptr) {
        uint32_t cp = utf8_next_codepoint(&ptr);
        int adv = 0, lsb = 0;
        stbtt_GetCodepointHMetrics(&g_font, (int)cp, &adv, &lsb);
        int gw = 0, gh = 0, xo = 0, yo = 0;
        unsigned char *gb = stbtt_GetCodepointBitmap(&g_font, scale, scale,
                                                     (int)cp, &gw, &gh, &xo, &yo);
        if (gb) {
            for (int yy = 0; yy < gh; yy++) {
                int dst_y = baseline + yo + yy;
                if (dst_y < 0 || dst_y >= h) continue;
                for (int xx = 0; xx < gw; xx++) {
                    int dst_x = (int)(x + xo) + xx;
                    if (dst_x < 0 || dst_x >= w) continue;
                    unsigned cov = gb[yy * gw + xx];
                    if (!cov) continue;
                    size_t idx = ((size_t)dst_y * w + dst_x) * 4;
                    rgba[idx + 0] = (unsigned char)cr;
                    rgba[idx + 1] = (unsigned char)cg;
                    rgba[idx + 2] = (unsigned char)cb;
                    rgba[idx + 3] = (unsigned char)((cov * ca) / 255);
                }
            }
            stbtt_FreeBitmap(gb, NULL);
        }
        x += adv * scale;
    }

    JSValue ab = JS_NewArrayBufferCopy(ctx, rgba, (size_t)w * (size_t)h * 4);
    free(rgba);
    JS_FreeCString(ctx, text);
    JS_FreeCString(ctx, family);

    JSValue result = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, result, "width", JS_NewInt32(ctx, w));
    JS_SetPropertyStr(ctx, result, "height", JS_NewInt32(ctx, h));
    JS_SetPropertyStr(ctx, result, "ascent", JS_NewInt32(ctx, baseline));
    JS_SetPropertyStr(ctx, result, "data", ab);
    TracyCZoneEnd(zone);
    return result;
}

static JSValue js_native_audio_init(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    if (!g_audio_initialized) {
        ma_result res = ma_engine_init(NULL, &g_audio_engine);
        if (res != MA_SUCCESS) {
            fprintf(stderr, "audio_init failed\n");
            return JS_NewBool(ctx, 0);
        }
        g_audio_initialized = 1;
    }
    return JS_NewBool(ctx, 1);
}

static JSValue js_native_now(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewFloat64(ctx, (double)SDL_GetTicks());
}

static JSValue js_print(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv) {
    // Deliberately stderr, not stdout: this used to write to stdout while
    // the C-side error/exception printers write to stderr. Two independent
    // FILE* streams both redirected into the same file (`> output.log 2>&1`)
    // can each track their own file-position pointer on Windows and
    // overwrite each other's bytes when writes interleave — which is the
    // likely explanation for a prior run showing a full stack trace but a
    // missing message line right above it. Routing everything through one
    // stream removes the ambiguity entirely.
    for (int i = 0; i < argc; i++) {
        const char *str = JS_ToCString(ctx, argv[i]);
        if (str) {
            fputs(str, stderr);
            if (i < argc - 1) fputc(' ', stderr);
            JS_FreeCString(ctx, str);
        }
    }
    fputc('\n', stderr);
    return JS_UNDEFINED;
}

static int scancode_to_keycode(SDL_Scancode sc) {
    switch (sc) {
        case SDL_SCANCODE_A: return 65; case SDL_SCANCODE_B: return 66;
        case SDL_SCANCODE_C: return 67; case SDL_SCANCODE_D: return 68;
        case SDL_SCANCODE_E: return 69; case SDL_SCANCODE_F: return 70;
        case SDL_SCANCODE_G: return 71; case SDL_SCANCODE_H: return 72;
        case SDL_SCANCODE_I: return 73; case SDL_SCANCODE_J: return 74;
        case SDL_SCANCODE_K: return 75; case SDL_SCANCODE_L: return 76;
        case SDL_SCANCODE_M: return 77; case SDL_SCANCODE_N: return 78;
        case SDL_SCANCODE_O: return 79; case SDL_SCANCODE_P: return 80;
        case SDL_SCANCODE_Q: return 81; case SDL_SCANCODE_R: return 82;
        case SDL_SCANCODE_S: return 83; case SDL_SCANCODE_T: return 84;
        case SDL_SCANCODE_U: return 85; case SDL_SCANCODE_V: return 86;
        case SDL_SCANCODE_W: return 87; case SDL_SCANCODE_X: return 88;
        case SDL_SCANCODE_Y: return 89; case SDL_SCANCODE_Z: return 90;
        case SDL_SCANCODE_0: return 48; case SDL_SCANCODE_1: return 49;
        case SDL_SCANCODE_2: return 50; case SDL_SCANCODE_3: return 51;
        case SDL_SCANCODE_4: return 52; case SDL_SCANCODE_5: return 53;
        case SDL_SCANCODE_6: return 54; case SDL_SCANCODE_7: return 55;
        case SDL_SCANCODE_8: return 56; case SDL_SCANCODE_9: return 57;
        case SDL_SCANCODE_SPACE: return 32;
        case SDL_SCANCODE_RETURN: case SDL_SCANCODE_RETURN2: return 13;
        case SDL_SCANCODE_ESCAPE: return 27;
        case SDL_SCANCODE_BACKSPACE: return 8;
        case SDL_SCANCODE_TAB: return 9;
        case SDL_SCANCODE_UP: return 38;
        case SDL_SCANCODE_DOWN: return 40;
        case SDL_SCANCODE_LEFT: return 37;
        case SDL_SCANCODE_RIGHT: return 39;
        case SDL_SCANCODE_LSHIFT: case SDL_SCANCODE_RSHIFT: return 16;
        case SDL_SCANCODE_LCTRL: case SDL_SCANCODE_RCTRL: return 17;
        case SDL_SCANCODE_LALT: case SDL_SCANCODE_RALT: return 18;
        case SDL_SCANCODE_LGUI: case SDL_SCANCODE_RGUI: return 91;
        case SDL_SCANCODE_F1: return 112; case SDL_SCANCODE_F2: return 113;
        case SDL_SCANCODE_F3: return 114; case SDL_SCANCODE_F4: return 115;
        case SDL_SCANCODE_F5: return 116; case SDL_SCANCODE_F6: return 117;
        case SDL_SCANCODE_F7: return 118; case SDL_SCANCODE_F8: return 119;
        case SDL_SCANCODE_F9: return 120; case SDL_SCANCODE_F10: return 121;
        case SDL_SCANCODE_F11: return 122; case SDL_SCANCODE_F12: return 123;
        case SDL_SCANCODE_INSERT: return 45; case SDL_SCANCODE_DELETE: return 46;
        case SDL_SCANCODE_HOME: return 36; case SDL_SCANCODE_END: return 35;
        case SDL_SCANCODE_PAGEUP: return 33; case SDL_SCANCODE_PAGEDOWN: return 34;
        case SDL_SCANCODE_GRAVE: return 192;
        case SDL_SCANCODE_MINUS: return 189; case SDL_SCANCODE_EQUALS: return 187;
        case SDL_SCANCODE_LEFTBRACKET: return 219; case SDL_SCANCODE_RIGHTBRACKET: return 221;
        case SDL_SCANCODE_BACKSLASH: return 220;
        case SDL_SCANCODE_SEMICOLON: return 186; case SDL_SCANCODE_APOSTROPHE: return 222;
        case SDL_SCANCODE_COMMA: return 188; case SDL_SCANCODE_PERIOD: return 190;
        case SDL_SCANCODE_SLASH: return 191;
        default: return 0;
    }
}

static void dispatch_keyboard_event(JSContext *ctx, const char *type, SDL_KeyboardEvent *e) {
    TracyCZoneN(zone, "dispatch.keyboard", 1);
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, global, "__dispatchKeyboardEvent__");
    if (JS_IsFunction(ctx, fn)) {
        JSValue args[8];
        args[0] = JS_NewString(ctx, type);
        args[1] = JS_NewInt32(ctx, scancode_to_keycode(e->scancode));
        args[2] = JS_NewString(ctx, SDL_GetKeyName(e->key));
        args[3] = JS_NewBool(ctx, e->repeat);
        args[4] = JS_NewBool(ctx, (e->mod & SDL_KMOD_CTRL) != 0);
        args[5] = JS_NewBool(ctx, (e->mod & SDL_KMOD_SHIFT) != 0);
        args[6] = JS_NewBool(ctx, (e->mod & SDL_KMOD_ALT) != 0);
        args[7] = JS_NewBool(ctx, (e->mod & SDL_KMOD_GUI) != 0);
        JSValue result = JS_Call(ctx, fn, global, 8, args);
        if (JS_IsException(result)) {
            JSValue exc = JS_GetException(ctx);
            const char *msg = JS_ToCString(ctx, exc);
            fprintf(stderr, "Keyboard event error: %s\n", msg ? msg : "(unknown)");
            JS_FreeCString(ctx, msg);
            JS_FreeValue(ctx, exc);
        }
        JS_FreeValue(ctx, result);
        for (int i = 0; i < 8; i++) JS_FreeValue(ctx, args[i]);
    }
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, global);
    TracyCZoneEnd(zone);
}

static void dispatch_mouse_event(JSContext *ctx, const char *type, float x, float y, int button, int buttons) {
    TracyCZoneN(zone, "dispatch.mouse", 1);
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, global, "__dispatchMouseEvent__");
    if (JS_IsFunction(ctx, fn)) {
        JSValue args[5];
        args[0] = JS_NewString(ctx, type);
        args[1] = JS_NewFloat64(ctx, (double)x);
        args[2] = JS_NewFloat64(ctx, (double)y);
        args[3] = JS_NewInt32(ctx, button);
        args[4] = JS_NewInt32(ctx, buttons);
        JSValue result = JS_Call(ctx, fn, global, 5, args);
        if (JS_IsException(result)) {
            JSValue exc = JS_GetException(ctx);
            const char *msg = JS_ToCString(ctx, exc);
            fprintf(stderr, "Mouse event error: %s\n", msg ? msg : "(unknown)");
            JS_FreeCString(ctx, msg);
            JS_FreeValue(ctx, exc);
        }
        JS_FreeValue(ctx, result);
        for (int i = 0; i < 5; i++) JS_FreeValue(ctx, args[i]);
    }
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, global);
    TracyCZoneEnd(zone);
}

static void dispatch_wheel_event(JSContext *ctx, float dx, float dy) {
    TracyCZoneN(zone, "dispatch.wheel", 1);
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, global, "__dispatchWheelEvent__");
    if (JS_IsFunction(ctx, fn)) {
        JSValue args[2];
        args[0] = JS_NewFloat64(ctx, (double)dx);
        args[1] = JS_NewFloat64(ctx, (double)dy);
        JSValue result = JS_Call(ctx, fn, global, 2, args);
        if (JS_IsException(result)) {
            JSValue exc = JS_GetException(ctx);
            const char *msg = JS_ToCString(ctx, exc);
            fprintf(stderr, "Wheel event error: %s\n", msg ? msg : "(unknown)");
            JS_FreeCString(ctx, msg);
            JS_FreeValue(ctx, exc);
        }
        JS_FreeValue(ctx, result);
        JS_FreeValue(ctx, args[0]);
        JS_FreeValue(ctx, args[1]);
    }
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, global);
    TracyCZoneEnd(zone);
}

// Confirmed bug: Utils.isNwjs() correctly returns true (shims.js fakes
// require/process), so RMMZ's title/end-game "Exit to Desktop" command is
// shown and wired to nw.App.quit() — but that was a pure no-op in
// shims.js, so clicking it did nothing. This gives it something real to
// call: setting g_engine.running = 0 stops the main loop exactly like a
// native SDL_EVENT_QUIT does, so the app shuts down cleanly on the next
// iteration instead of hanging around.
static JSValue js_native_quit(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    g_engine.running = 0;
    return JS_UNDEFINED;
}

// ---------------------------------------------------------------------
// Tracy profiling bridges (JS-accessible, used by shims.js to profile the
// internals of __tick__ and other JS hot paths without recompiling).
// ---------------------------------------------------------------------

// Runtime-toggleable Tracy zone profiling. Every Tracy zone costs a
// timestamp + queue write even when no GUI is attached; the per-call GL
// zones (gl.bufferSubData was traced at ~693k calls) are gated behind this
// so normal play runs without paying for instrumentation. Enable with
// SONAR_TRACY=1. The coarse main-loop / JS tick / event-dispatch zones stay
// always-on so the profiler still shows frame structure.
int g_tracy_enabled = 0;

// QuickJS calls one native function per zone, so zone contexts have to be
// stashed between tracyZoneStart() and tracyZoneEnd() calls. A stack keeps
// nesting correct (__tick__ wraps timers and RAF inside a top-level zone).
#define JS_TRACY_ZONE_STACK_MAX 64
static TracyCZoneCtx g_js_zone_stack[JS_TRACY_ZONE_STACK_MAX];
static int g_js_zone_stack_top = 0;

static JSValue js_native_tracy_enabled(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    return JS_NewBool(ctx, g_tracy_enabled);
}

static JSValue js_native_get_env(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NULL;
    const char *name = JS_ToCString(ctx, argv[0]);
    if (!name) return JS_NULL;
    const char *val = getenv(name);
    JSValue r = val ? JS_NewString(ctx, val) : JS_NULL;
    JS_FreeCString(ctx, name);
    return r;
}

static JSValue js_native_tracy_zone_start(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_UNDEFINED;
    const char *name = JS_ToCString(ctx, argv[0]);
    if (!name) return JS_UNDEFINED;
    // ___tracy_alloc_srcloc_name() copies the strings into Tracy's own
    // storage, so freeing the JS string right after is safe.
    if (g_js_zone_stack_top < JS_TRACY_ZONE_STACK_MAX) {
        uint64_t srcloc = ___tracy_alloc_srcloc_name(__LINE__, "shims.js", 8, "tick", 4,
                                                     name, strlen(name), 0x40b0ff);
        g_js_zone_stack[g_js_zone_stack_top++] =
            ___tracy_emit_zone_begin_alloc(srcloc, 1);
    }
    JS_FreeCString(ctx, name);
    return JS_UNDEFINED;
}

static JSValue js_native_tracy_zone_end(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    if (g_js_zone_stack_top > 0) {
        ___tracy_emit_zone_end(g_js_zone_stack[--g_js_zone_stack_top]);
    }
    return JS_UNDEFINED;
}

static JSValue js_native_tracy_zone_text(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1 || g_js_zone_stack_top == 0) return JS_UNDEFINED;
    const char *text = JS_ToCString(ctx, argv[0]);
    if (text) {
        ___tracy_emit_zone_text(g_js_zone_stack[g_js_zone_stack_top - 1], text, strlen(text));
        JS_FreeCString(ctx, text);
    }
    return JS_UNDEFINED;
}

// ---------------------------------------------------------------------
// Matrix / bounds math bridges. These accept the PixiJS Matrix property
// layout ({a,b,c,d,tx,ty}) and offload the per-display-object transform
// math to C. Wire them into the JS side (e.g. monkey-patch
// PIXI.Matrix.prototype.append) to use; see README/shim notes.
// ---------------------------------------------------------------------

// Read the six {a,b,c,d,tx,ty} numbers off a PixiJS Matrix-shaped object.
static int read_matrix3(JSContext *ctx, JSValueConst v, Matrix3 *m) {
    if (!JS_IsObject(v)) return 0;
    JSValue props[6];
    props[0] = JS_GetPropertyStr(ctx, v, "a");
    props[1] = JS_GetPropertyStr(ctx, v, "b");
    props[2] = JS_GetPropertyStr(ctx, v, "c");
    props[3] = JS_GetPropertyStr(ctx, v, "d");
    props[4] = JS_GetPropertyStr(ctx, v, "tx");
    props[5] = JS_GetPropertyStr(ctx, v, "ty");
    double d[6] = {0, 0, 0, 0, 0, 0};
    for (int i = 0; i < 6; i++) {
        JS_ToFloat64(ctx, &d[i], props[i]);
        JS_FreeValue(ctx, props[i]);
    }
    m->a = (float)d[0]; m->b = (float)d[1]; m->c = (float)d[2];
    m->d = (float)d[3]; m->tx = (float)d[4]; m->ty = (float)d[5];
    return 1;
}

static void write_matrix3(JSContext *ctx, JSValue obj, const Matrix3 *m) {
    JS_SetPropertyStr(ctx, obj, "a", JS_NewFloat64(ctx, m->a));
    JS_SetPropertyStr(ctx, obj, "b", JS_NewFloat64(ctx, m->b));
    JS_SetPropertyStr(ctx, obj, "c", JS_NewFloat64(ctx, m->c));
    JS_SetPropertyStr(ctx, obj, "d", JS_NewFloat64(ctx, m->d));
    JS_SetPropertyStr(ctx, obj, "tx", JS_NewFloat64(ctx, m->tx));
    JS_SetPropertyStr(ctx, obj, "ty", JS_NewFloat64(ctx, m->ty));
}

// native.matrixMultiply(a, b) -> new matrix object (a * b)
static JSValue js_native_matrix_multiply(JSContext *ctx, JSValueConst this_val,
                                          int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_UNDEFINED;
    Matrix3 a, b, out;
    if (!read_matrix3(ctx, argv[0], &a) || !read_matrix3(ctx, argv[1], &b))
        return JS_UNDEFINED;
    matrix3_multiply(&out, &a, &b);
    JSValue obj = JS_NewObject(ctx);
    write_matrix3(ctx, obj, &out);
    return obj;
}

// native.matrixAppend(m, other) -> m  (mutates m in place, like Matrix.append)
static JSValue js_native_matrix_append(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_UNDEFINED;
    Matrix3 self, other;
    if (!read_matrix3(ctx, argv[0], &self) || !read_matrix3(ctx, argv[1], &other))
        return JS_UNDEFINED;
    matrix3_append(&self, &other);
    write_matrix3(ctx, argv[0], &self);
    JS_DupValue(ctx, argv[0]);
    return argv[0];
}

// native.transformPoint(m, x, y) -> {x, y}
static JSValue js_native_transform_point(JSContext *ctx, JSValueConst this_val,
                                          int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 3) return JS_UNDEFINED;
    Matrix3 m;
    if (!read_matrix3(ctx, argv[0], &m)) return JS_UNDEFINED;
    double x = 0, y = 0;
    JS_ToFloat64(ctx, &x, argv[1]);
    JS_ToFloat64(ctx, &y, argv[2]);
    float fx = (float)x, fy = (float)y;
    matrix3_transform_point(&m, &fx, &fy);
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "x", JS_NewFloat64(ctx, fx));
    JS_SetPropertyStr(ctx, obj, "y", JS_NewFloat64(ctx, fy));
    return obj;
}

// native.calculateBounds(m, x, y, w, h) -> {minX, minY, maxX, maxY}
static JSValue js_native_calculate_bounds(JSContext *ctx, JSValueConst this_val,
                                           int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 5) return JS_UNDEFINED;
    Matrix3 m;
    if (!read_matrix3(ctx, argv[0], &m)) return JS_UNDEFINED;
    double x = 0, y = 0, w = 0, h = 0;
    JS_ToFloat64(ctx, &x, argv[1]);
    JS_ToFloat64(ctx, &y, argv[2]);
    JS_ToFloat64(ctx, &w, argv[3]);
    JS_ToFloat64(ctx, &h, argv[4]);
    float mnx = 0, mny = 0, mxx = 0, mxy = 0;
    matrix3_calculate_bounds(&m, (float)x, (float)y, (float)w, (float)h,
                             &mnx, &mny, &mxx, &mxy);
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "minX", JS_NewFloat64(ctx, mnx));
    JS_SetPropertyStr(ctx, obj, "minY", JS_NewFloat64(ctx, mny));
    JS_SetPropertyStr(ctx, obj, "maxX", JS_NewFloat64(ctx, mxx));
    JS_SetPropertyStr(ctx, obj, "maxY", JS_NewFloat64(ctx, mxy));
    return obj;
}

static JSValue js_native_set_window_size(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_UNDEFINED;
    int32_t w = 0, h = 0;
    JS_ToInt32(ctx, &w, argv[0]);
    JS_ToInt32(ctx, &h, argv[1]);
    if (w > 0 && h > 0 && g_engine.window) {
        SDL_SetWindowSize(g_engine.window, w, h);
        SDL_SetWindowPosition(g_engine.window, SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED);
    }
    return JS_UNDEFINED;
}

// Returns QuickJS heap stats {allocSize, usedSize} so the JS side can watch
// GC pressure frame-by-frame (correlate with unzoned Tracy gaps).
// Note: quickjs-ng's JSMemoryUsage has no gc_count field.
static JSValue js_native_memory_usage(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    JSMemoryUsage mu;
    JS_ComputeMemoryUsage(g_engine.rt, &mu);
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "allocSize", JS_NewInt64(ctx, (int64_t)mu.malloc_size));
    JS_SetPropertyStr(ctx, obj, "usedSize", JS_NewInt64(ctx, (int64_t)mu.memory_used_size));
    return obj;
}

static void register_native_bridge(JSContext *ctx) {
    JSValue global = JS_GetGlobalObject(ctx);

    JS_SetPropertyStr(ctx, global, "print",
                       JS_NewCFunction(ctx, js_print, "print", 1));
    JSValue console = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, console, "log",
                       JS_NewCFunction(ctx, js_print, "log", 1));
    JS_SetPropertyStr(ctx, console, "warn",
                       JS_NewCFunction(ctx, js_print, "warn", 1));
    JS_SetPropertyStr(ctx, console, "error",
                       JS_NewCFunction(ctx, js_print, "error", 1));
    JS_SetPropertyStr(ctx, global, "console", console);

    JSValue native = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, native, "storageSet",
                       JS_NewCFunction(ctx, js_native_storage_set, "storageSet", 2));
    JS_SetPropertyStr(ctx, native, "storageGet",
                       JS_NewCFunction(ctx, js_native_storage_get, "storageGet", 1));
    JS_SetPropertyStr(ctx, native, "readFile",
                       JS_NewCFunction(ctx, js_native_read_file, "readFile", 1));
    JS_SetPropertyStr(ctx, native, "readFileBinary",
                       JS_NewCFunction(ctx, js_native_read_file_binary, "readFileBinary", 1));
    JS_SetPropertyStr(ctx, native, "decodeImage",
                       JS_NewCFunction(ctx, js_native_decode_image, "decodeImage", 1));
    JS_SetPropertyStr(ctx, native, "rasterizeText",
                       JS_NewCFunction(ctx, js_native_rasterize_text, "rasterizeText", 8));
    JS_SetPropertyStr(ctx, native, "measureText",
                       JS_NewCFunction(ctx, js_native_measure_text, "measureText", 4));
    JS_SetPropertyStr(ctx, native, "audioInit",
                       JS_NewCFunction(ctx, js_native_audio_init, "audioInit", 0));
    JS_SetPropertyStr(ctx, native, "now",
                       JS_NewCFunction(ctx, js_native_now, "now", 0));
    JS_SetPropertyStr(ctx, native, "setWindowSize",
                       JS_NewCFunction(ctx, js_native_set_window_size, "setWindowSize", 2));
    JS_SetPropertyStr(ctx, native, "quit",
                       JS_NewCFunction(ctx, js_native_quit, "quit", 0));
    JS_SetPropertyStr(ctx, native, "tracyEnabled",
                       JS_NewCFunction(ctx, js_native_tracy_enabled, "tracyEnabled", 0));
    JS_SetPropertyStr(ctx, native, "memoryUsage",
                       JS_NewCFunction(ctx, js_native_memory_usage, "memoryUsage", 0));
    JS_SetPropertyStr(ctx, native, "getEnv",
                       JS_NewCFunction(ctx, js_native_get_env, "getEnv", 1));
    JS_SetPropertyStr(ctx, native, "tracyZoneStart",
                       JS_NewCFunction(ctx, js_native_tracy_zone_start, "tracyZoneStart", 1));
    JS_SetPropertyStr(ctx, native, "tracyZoneEnd",
                       JS_NewCFunction(ctx, js_native_tracy_zone_end, "tracyZoneEnd", 0));
    JS_SetPropertyStr(ctx, native, "tracyZoneText",
                       JS_NewCFunction(ctx, js_native_tracy_zone_text, "tracyZoneText", 1));
    JS_SetPropertyStr(ctx, native, "matrixMultiply",
                       JS_NewCFunction(ctx, js_native_matrix_multiply, "matrixMultiply", 2));
    JS_SetPropertyStr(ctx, native, "matrixAppend",
                       JS_NewCFunction(ctx, js_native_matrix_append, "matrixAppend", 2));
    JS_SetPropertyStr(ctx, native, "transformPoint",
                       JS_NewCFunction(ctx, js_native_transform_point, "transformPoint", 3));
    JS_SetPropertyStr(ctx, native, "calculateBounds",
                       JS_NewCFunction(ctx, js_native_calculate_bounds, "calculateBounds", 5));

    JSValue gl = JS_NewObject(ctx);
    register_gl_bridge(ctx, gl);
    JS_SetPropertyStr(ctx, native, "gl", gl);

    JS_SetPropertyStr(ctx, global, "__native__", native);
    JS_FreeValue(ctx, global);
}

static char *read_text_file(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        fprintf(stderr, "Could not open %s\n", path);
        return NULL;
    }
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc(len + 1);
    fread(buf, 1, len, f);
    buf[len] = '\0';
    fclose(f);
    return buf;
}

static char *path_next_to_executable(const char *filename) {
    char *base = SDL_GetBasePath();
    if (!base) return SDL_strdup(filename);
    size_t base_len = SDL_strlen(base);
    size_t name_len = SDL_strlen(filename);
    bool needs_sep = base_len > 0 && base[base_len - 1] != '/' && base[base_len - 1] != '\\';
    char *joined = SDL_malloc(base_len + (needs_sep ? 1 : 0) + name_len + 1);
    if (!joined) { SDL_free(base); return NULL; }
    SDL_strlcpy(joined, base, base_len + 1);
    if (needs_sep) joined[base_len++] = '/';
    SDL_strlcpy(joined + base_len, filename, name_len + 1);
    SDL_free(base);
    return joined;
}

static int eval_file(JSContext *ctx, const char *path) {
    TracyCZoneN(zone, "eval_file", 1);
    TracyCZoneTextF(zone, "%s", path);
    char *src = read_text_file(path);
    if (!src) { TracyCZoneEnd(zone); return -1; }
    JSValue result = JS_Eval(ctx, src, strlen(src), path, JS_EVAL_TYPE_GLOBAL);
    int ok = 1;
    if (JS_IsException(result)) {
        ok = 0;
        JSValue exc = JS_GetException(ctx);
        const char *msg = JS_ToCString(ctx, exc);
        fprintf(stderr, "JS error in %s: %s\n", path, msg ? msg : "(unknown)");
        JS_FreeCString(ctx, msg);
        JSValue stack = JS_GetPropertyStr(ctx, exc, "stack");
        if (!JS_IsUndefined(stack)) {
            const char *stack_str = JS_ToCString(ctx, stack);
            if (stack_str) {
                fprintf(stderr, "Stack:\n%s\n", stack_str);
                JS_FreeCString(ctx, stack_str);
            }
        }
        JS_FreeValue(ctx, stack);
        JS_FreeValue(ctx, exc);
    }
    JS_FreeValue(ctx, result);
    free(src);
    TracyCZoneEnd(zone);
    return ok ? 0 : -1;
}

// Confirmed root cause of the "stack with no message" output: an
// exception thrown inside a Promise .then() callback (effekseer's
// initRuntime stub, in this case) doesn't go through eval_file's or
// dispatchEvent's try/catch — it becomes an unhandled promise rejection,
// which QuickJS reports through a completely separate mechanism that we
// hadn't configured. RMMZ/PixiJS use Promises throughout (fetch, Image,
// AudioContext, font loading), so this needs a general handler, not just
// a fix for this one call site.
static void promise_rejection_tracker(JSContext *ctx, JSValueConst promise,
                                       JSValueConst reason, bool is_handled,
                                       void *opaque) {
    (void)promise; (void)opaque;
    if (is_handled) return; // fires again when a .catch() attaches later — ignore those
    const char *msg = JS_ToCString(ctx, reason);
    fprintf(stderr, "[unhandled promise rejection] %s\n", msg ? msg : "(unknown)");
    JS_FreeCString(ctx, msg);
    JSValue stack = JS_GetPropertyStr(ctx, reason, "stack");
    if (!JS_IsUndefined(stack)) {
        const char *stack_str = JS_ToCString(ctx, stack);
        if (stack_str) {
            fprintf(stderr, "Stack:\n%s\n", stack_str);
            JS_FreeCString(ctx, stack_str);
        }
    }
    JS_FreeValue(ctx, stack);
}

int main(int argc, char *argv[]) {
    (void)argc; (void)argv;
    g_engine.running = 1;

    // Per-call GL Tracy zones are off unless SONAR_TRACY=1 (see
    // g_tracy_enabled). Read it before the first frame so the whole app
    // shares one consistent value.
    {
        const char *te = getenv("SONAR_TRACY");
        g_tracy_enabled = (te && te[0] == '1');
    }

    TracyCSetThreadName("Main");
    TracyCAppInfo("Sonar.js (RMMZ native)", sizeof("Sonar.js (RMMZ native)") - 1);

    // stdout is only line-buffered when attached to a real terminal;
    // redirected to a file or pipe (e.g. `> output.log`) it becomes fully
    // buffered, and since the main loop runs forever, nothing ever forces
    // a flush — output silently vanishes from logs even though it printed.
    // Force both streams unbuffered so every line lands immediately.
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);

    if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO | SDL_INIT_GAMEPAD)) {
        fprintf(stderr, "SDL_Init failed: %s\n", SDL_GetError());
        return 1;
    }

    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 4);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 1);
    SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);
    SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
    SDL_GL_SetAttribute(SDL_GL_STENCIL_SIZE, 8);

    g_engine.window = SDL_CreateWindow("RPG Maker MZ (Sonar.js)",
                                        1280, 720,
                                        SDL_WINDOW_OPENGL | SDL_WINDOW_RESIZABLE);
    if (!g_engine.window) {
        fprintf(stderr, "SDL_CreateWindow failed: %s\n", SDL_GetError());
        return 1;
    }

    g_engine.gl_ctx = SDL_GL_CreateContext(g_engine.window);
    if (!g_engine.gl_ctx) {
        fprintf(stderr, "SDL_GL_CreateContext failed: %s\n", SDL_GetError());
        return 1;
    }
    SDL_GL_MakeCurrent(g_engine.window, g_engine.gl_ctx);
    SDL_GL_SetSwapInterval(1);

    if (!gladLoadGLLoader((GLADloadproc)SDL_GL_GetProcAddress)) {
        fprintf(stderr, "gladLoadGLLoader failed\n");
        return 1;
    }
    fprintf(stderr, "GL: %s / %s\n", glGetString(GL_VERSION), glGetString(GL_RENDERER));

    g_engine.rt = JS_NewRuntime();
    g_engine.ctx = JS_NewContext(g_engine.rt);
    JS_SetHostPromiseRejectionTracker(g_engine.rt, promise_rejection_tracker, NULL);
    register_native_bridge(g_engine.ctx);

    char *shim_path = path_next_to_executable("shims.js");
    if (!shim_path || eval_file(g_engine.ctx, shim_path) != 0) {
        fprintf(stderr, "Failed to load shims.js\n");
        SDL_free(shim_path);
        return 1;
    }
    SDL_free(shim_path);

    //load actual game files here
    // eval_file(g_engine.ctx, "game/js/rmmz_core.js");
    // eval_file(g_engine.ctx, "game/js/main.js");
	// --- ENTER THE GAME DIRECTORY ---
	// Change working directory so data/, img/, js/ paths resolve correctly
	#ifdef _WIN32
		#include <direct.h>
		_chdir("Project1");
	#else
		#include <unistd.h>
		chdir("Project1");
	#endif

// --- LOAD RMMZ LIBRARIES (must be before engine files) ---
eval_file(g_engine.ctx, "js/libs/pixi.js");
eval_file(g_engine.ctx, "js/libs/pako.min.js");
eval_file(g_engine.ctx, "js/libs/localforage.min.js");
// vorbisdecoder.js intentionally NOT loaded: it's a real Emscripten-compiled
// WASM module, and our globalThis.WebAssembly in shims.js is a JS-only stub
// that never executes actual wasm bytecode (Instance() just sets
// exports = {}). Evaling this file crashes during its own startup
// (callRuntimeCallbacks hits an undefined export and calls .apply on it).
// It's also unnecessary: miniaudio (see native_audio_init below) decodes
// Ogg Vorbis natively, so RMMZ never needs this browser-side fallback decoder.
// eval_file(g_engine.ctx, "js/libs/vorbisdecoder.js");

// --- LOAD RMMZ ENGINE IN ORDER ---
eval_file(g_engine.ctx, "js/rmmz_core.js");
eval_file(g_engine.ctx, "js/rmmz_managers.js");
eval_file(g_engine.ctx, "js/rmmz_objects.js");
eval_file(g_engine.ctx, "js/rmmz_scenes.js");
eval_file(g_engine.ctx, "js/rmmz_sprites.js");
eval_file(g_engine.ctx, "js/rmmz_windows.js");
eval_file(g_engine.ctx, "js/plugins.js");
eval_file(g_engine.ctx, "js/main.js");

	fprintf(stderr, "Game files loaded. Entering main loop...\n");

	// Fire the browser 'load' event now that all game scripts have
	// executed. RMMZ's main.js registers window.addEventListener('load', ...)
	// and the real boot logic (SceneManager.run etc.) lives inside that
	// callback — a real browser fires 'load' automatically once the page
	// finishes loading, but nothing here does that on its own, so without
	// this the callback registers and then waits forever (black screen,
	// no crash, loop runs silently).
	{
		const char *fire_load =
			"window.dispatchEvent(new Event('load'));\n"
			"// Fallback for FOSSIL/native: if FOSSIL skipped its script loader,\n"
			"// SceneManager._scene might still be null. Force it to start at Scene_Boot\n"
			"// so the database (System.json) loads before the Title Screen starts.\n"
			"if (typeof SceneManager !== 'undefined' && !SceneManager._scene) {\n"
			"  print('[Shim] Fallback: Manually starting SceneManager.run(Scene_Boot)');\n"
			"  try { SceneManager.run(Scene_Boot); } catch (e) { print('[Shim] Fallback failed: ' + e + '\\n' + (e.stack || '')); }\n"
			"}\n"
			"if (typeof Graphics !== 'undefined') {\n"
			"  print('[Diag] Graphics._app=' + (!!Graphics._app) + ' ticker.started=' + (Graphics._app && Graphics._app.ticker ? Graphics._app.ticker.started : 'n/a') + ' scene=' + (typeof SceneManager !== 'undefined' && SceneManager._scene ? SceneManager._scene.constructor.name : 'null'));\n"
			"}";
		JSValue r = JS_Eval(g_engine.ctx, fire_load, strlen(fire_load), "<fire-load>", JS_EVAL_TYPE_GLOBAL);
		if (JS_IsException(r)) {
			JSValue exc = JS_GetException(g_engine.ctx);
			const char *msg = JS_ToCString(g_engine.ctx, exc);
			fprintf(stderr, "Failed to dispatch load event: %s\n", msg ? msg : "(unknown)");
			JS_FreeCString(g_engine.ctx, msg);
			JSValue stack = JS_GetPropertyStr(g_engine.ctx, exc, "stack");
			if (!JS_IsUndefined(stack)) {
				const char *stack_str = JS_ToCString(g_engine.ctx, stack);
				if (stack_str) {
					fprintf(stderr, "Stack:\n%s\n", stack_str);
					JS_FreeCString(g_engine.ctx, stack_str);
				}
			}
			JS_FreeValue(g_engine.ctx, stack);
			JS_FreeValue(g_engine.ctx, exc);
		}
		JS_FreeValue(g_engine.ctx, r);
	}


    SDL_Event event;
    while (g_engine.running) {
        TracyCZoneN(frame_zone, "Main loop", 1);
        while (SDL_PollEvent(&event)) {
            switch (event.type) {
                case SDL_EVENT_QUIT:
                    g_engine.running = 0;
                    break;
                case SDL_EVENT_KEY_DOWN:
                    dispatch_keyboard_event(g_engine.ctx, "keydown", &event.key);
                    break;
                case SDL_EVENT_KEY_UP:
                    dispatch_keyboard_event(g_engine.ctx, "keyup", &event.key);
                    break;
                case SDL_EVENT_MOUSE_MOTION:
                    dispatch_mouse_event(g_engine.ctx, "mousemove", event.motion.x, event.motion.y, 0, (int)event.motion.state);
                    break;
                case SDL_EVENT_MOUSE_BUTTON_DOWN:
                    dispatch_mouse_event(g_engine.ctx, "mousedown", event.button.x, event.button.y, event.button.button - 1, 1);
                    break;
                case SDL_EVENT_MOUSE_BUTTON_UP:
                    dispatch_mouse_event(g_engine.ctx, "mouseup", event.button.x, event.button.y, event.button.button - 1, 0);
                    break;
                case SDL_EVENT_MOUSE_WHEEL:
                    dispatch_wheel_event(g_engine.ctx, event.wheel.x, event.wheel.y);
                    break;
                case SDL_EVENT_WINDOW_RESIZED:
                case SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED: {
                    int w = 0, h = 0;
                    SDL_GetWindowSizeInPixels(g_engine.window, &w, &h);
                    glViewport(0, 0, w, h);
                    break;
                }
            }
        }

        JSValue global = JS_GetGlobalObject(g_engine.ctx);
        JSValue tick_fn = JS_GetPropertyStr(g_engine.ctx, global, "__tick__");
        JSValue ts = JS_NewFloat64(g_engine.ctx, (double)SDL_GetTicks());
        TracyCZoneN(tick_zone, "JS tick", 1);
        JSValue result = JS_Call(g_engine.ctx, tick_fn, global, 1, &ts);
        TracyCZoneEnd(tick_zone);
        if (JS_IsException(result)) {
            JSValue exc = JS_GetException(g_engine.ctx);
            const char *msg = JS_ToCString(g_engine.ctx, exc);
            fprintf(stderr, "Tick error: %s\n", msg ? msg : "(unknown)");
            JS_FreeCString(g_engine.ctx, msg);
            JSValue stack = JS_GetPropertyStr(g_engine.ctx, exc, "stack");
            if (!JS_IsUndefined(stack)) {
                const char *stack_str = JS_ToCString(g_engine.ctx, stack);
                if (stack_str) {
                    fprintf(stderr, "Stack:\n%s\n", stack_str);
                    JS_FreeCString(g_engine.ctx, stack_str);
                }
            }
            JS_FreeValue(g_engine.ctx, stack);
            JS_FreeValue(g_engine.ctx, exc);
        }
        JS_FreeValue(g_engine.ctx, result);
        JS_FreeValue(g_engine.ctx, ts);
        JS_FreeValue(g_engine.ctx, tick_fn);
        JS_FreeValue(g_engine.ctx, global);

        JSContext *pctx;
        while (JS_ExecutePendingJob(g_engine.rt, &pctx) > 0) {}

        SDL_GL_SwapWindow(g_engine.window);
        TracyCFrameMark;
        TracyCZoneEnd(frame_zone);
    }

    JS_FreeContext(g_engine.ctx);
    JS_FreeRuntime(g_engine.rt);
    SDL_GL_DestroyContext(g_engine.gl_ctx);
    SDL_DestroyWindow(g_engine.window);
    SDL_Quit();
    return 0;
}