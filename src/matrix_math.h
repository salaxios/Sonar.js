// matrix_math.h — inline 2D transform math matching the PixiJS Matrix
// layout (column-major 3x3, stored as a,b,c,d,tx,ty where
//   | a  c  tx |
//   | b  d  ty |
//   | 0  0  1  |
// so x' = a*x + c*y + tx, y' = b*x + d*y + ty).
//
// All routines are `static inline` so the compiler can fold them into the
// bridge functions; there is no separate .c file to link.
#ifndef MATRIX_MATH_H
#define MATRIX_MATH_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <math.h>

typedef struct {
    float a, c, tx; // row 0
    float b, d, ty; // row 1
} Matrix3;

typedef struct {
    float m[16];
} Matrix4;

static inline void matrix3_identity(Matrix3 *m) {
    m->a = 1.0f; m->c = 0.0f; m->tx = 0.0f;
    m->b = 0.0f; m->d = 1.0f; m->ty = 0.0f;
}

// out = a * b   (matches PixiJS Matrix.append: this = this * other)
static inline void matrix3_multiply(Matrix3 *out, const Matrix3 *a, const Matrix3 *b) {
    float a0 = a->a, a1 = a->b, a2 = a->c, a3 = a->d;
    float a4 = a->tx, a5 = a->ty;
    float b0 = b->a, b1 = b->b, b2 = b->c, b3 = b->d;
    float b4 = b->tx, b5 = b->ty;

    out->a = a0 * b0 + a2 * b1;
    out->b = a1 * b0 + a3 * b1;
    out->c = a0 * b2 + a2 * b3;
    out->d = a1 * b2 + a3 * b3;
    out->tx = a0 * b4 + a2 * b5 + a4;
    out->ty = a1 * b4 + a3 * b5 + a5;
}

// out = a * b, reading a's elements back into itself afterwards
// (the shape PixiJS Container.updateTransform uses: a local transform is
// appended onto the parent's world transform each frame).
static inline void matrix3_append(Matrix3 *self, const Matrix3 *other) {
    float a0 = self->a, a1 = self->b, c0 = self->c, d0 = self->d;
    float tx0 = self->tx, ty0 = self->ty;
    float b0 = other->a, b1 = other->b, b2 = other->c, b3 = other->d;
    float b4 = other->tx, b5 = other->ty;

    if (b0 != 1.0f || b1 != 0.0f || b2 != 0.0f || b3 != 1.0f) {
        self->a = a0 * b0 + c0 * b1;
        self->b = a1 * b0 + d0 * b1;
        self->c = a0 * b2 + c0 * b3;
        self->d = a1 * b2 + d0 * b3;
    }
    self->tx = a0 * b4 + c0 * b5 + tx0;
    self->ty = a1 * b4 + d0 * b5 + ty0;
}

static inline void matrix3_transform_point(const Matrix3 *m, float *x, float *y) {
    float px = *x, py = *y;
    *x = m->a * px + m->c * py + m->tx;
    *y = m->b * px + m->d * py + m->ty;
}

static inline void matrix3_translate(Matrix3 *m, float x, float y) {
    m->tx += m->a * x + m->c * y;
    m->ty += m->b * x + m->d * y;
}

static inline void matrix3_scale(Matrix3 *m, float sx, float sy) {
    m->a *= sx;
    m->b *= sx;
    m->c *= sy;
    m->d *= sy;
}

static inline void matrix3_rotate(Matrix3 *m, float rad) {
    float c = cosf(rad);
    float s = sinf(rad);
    float a0 = m->a, a1 = m->b, a2 = m->c, a3 = m->d;

    m->a = a0 * c + a2 * s;
    m->b = a1 * c + a3 * s;
    m->c = a0 * -s + a2 * c;
    m->d = a1 * -s + a3 * c;
}

// Axis-aligned bounds of an untransformed rect (x,y,w,h) under `m`,
// transformed via its 4 corners. This is the shape PixiJS Bounds.addFrame /
// addQuad resolves for nearly every sprite every frame.
static inline void matrix3_calculate_bounds(const Matrix3 *m,
                                            float x, float y, float w, float h,
                                            float *out_min_x, float *out_min_y,
                                            float *out_max_x, float *out_max_y) {
    float x0 = m->a * x       + m->c * y       + m->tx;
    float y0 = m->b * x       + m->d * y       + m->ty;
    float x1 = m->a * (x + w) + m->c * y       + m->tx;
    float y1 = m->b * (x + w) + m->d * y       + m->ty;
    float x2 = m->a * x       + m->c * (y + h) + m->tx;
    float y2 = m->b * x       + m->d * (y + h) + m->ty;
    float x3 = m->a * (x + w) + m->c * (y + h) + m->tx;
    float y3 = m->b * (x + w) + m->d * (y + h) + m->ty;

    float mnx = x0, mxx = x0;
    float mny = y0, mxy = y0;
#define MINMAX(v, lo, hi) do { if (v < lo) lo = v; if (v > hi) hi = v; } while (0)
    MINMAX(x1, mnx, mxx); MINMAX(x2, mnx, mxx); MINMAX(x3, mnx, mxx);
    MINMAX(y1, mny, mxy); MINMAX(y2, mny, mxy); MINMAX(y3, mny, mxy);
#undef MINMAX

    *out_min_x = mnx;
    *out_min_y = mny;
    *out_max_x = mxx;
    *out_max_y = mxy;
}

#endif // MATRIX_MATH_H