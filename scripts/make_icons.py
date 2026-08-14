#!/usr/bin/env python3
# 生成扩展图标：深色圆角方块 + 白色禁止符号（圆圈 + 斜杠）。
# 仅使用标准库（struct/zlib），无第三方依赖。输出到项目根目录 icons/。
import os
import struct
import zlib
import math

SIZES = [16, 32, 48, 128]

BG = (15, 23, 42)       # 深蓝灰背景
FG = (248, 250, 252)    # 白色禁令符号


def in_rounded_square(x, y, size, r):
    dx = min(x, size - 1 - x)
    dy = min(y, size - 1 - y)
    if dx >= r or dy >= r:
        return True
    cx, cy = r - dx, r - dy
    return cx * cx + cy * cy <= r * r


def render(size, ss):
    """按 ss 倍超采样渲染 size×size 图标，返回 RGBA 字节串。"""
    S = size * ss
    img = bytearray(S * S * 4)
    cx = cy = S / 2.0
    ring_in = S * 0.27
    ring_out = S * 0.40
    x1, y1, x2, y2 = S * 0.30, S * 0.72, S * 0.70, S * 0.28
    dxs = x2 - x1
    dys = y2 - y1
    seg_len2 = dxs * dxs + dys * dys
    half_w = S * 0.085

    for y in range(S):
        for x in range(S):
            px, py = x + 0.5, y + 0.5
            if not in_rounded_square(x, y, S, S * 0.20):
                continue  # 圆角外透明
            d = math.hypot(px - cx, py - cy)
            if ring_in <= d <= ring_out:
                col = FG
            else:
                t = max(0.0, min(1.0, ((px - x1) * dxs + (py - y1) * dys) / seg_len2))
                spx, spy = x1 + t * dxs, y1 + t * dys
                col = FG if math.hypot(px - spx, py - spy) < half_w else BG
            i = (y * S + x) * 4
            img[i], img[i + 1], img[i + 2], img[i + 3] = col[0], col[1], col[2], 255
    return _downsample(img, size, ss)


def _downsample(src, size, ss):
    S = size * ss
    out = bytearray(size * size * 4)
    n = ss * ss
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for yy in range(ss):
                for xx in range(ss):
                    i = ((y * ss + yy) * S + (x * ss + xx)) * 4
                    r += src[i]
                    g += src[i + 1]
                    b += src[i + 2]
                    a += src[i + 3]
            i = (y * size + x) * 4
            out[i], out[i + 1], out[i + 2], out[i + 3] = r // n, g // n, b // n, a // n
    return out


def _chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path, size, rgba):
    raw = b"".join(b"\x00" + bytes(rgba[y * size * 4:(y + 1) * size * 4]) for y in range(size))
    png = b"\x89PNG\r\n\x1a\n"
    png += _chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += _chunk(b"IDAT", zlib.compress(raw, 9))
    png += _chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    outdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
    os.makedirs(outdir, exist_ok=True)
    for size in SIZES:
        ss = 4 if size >= 32 else 4  # 统一 4 倍超采样，保证小尺寸圆角平滑
        path = os.path.join(outdir, f"icon{size}.png")
        write_png(path, size, render(size, ss))
        print("已生成", os.path.normpath(path), f"({size}x{size})")


if __name__ == "__main__":
    main()