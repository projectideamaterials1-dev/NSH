#!/usr/bin/env python3
"""Builds the 3D Earth textures in public/textures/earth from NASA public-domain imagery.

Sources (NASA Earth Observatory, public domain):
  day     Blue Marble Next Generation, Aug 2004     74000/74117/world.200408.3x21600x10800.jpg
  night   Black Marble 2016 (3 km)                  144000/144898/BlackMarble_2016_3km.jpg
  elev    GEBCO_08 land elevation                   73000/73934/gebco_08_rev_elev_21600x10800.png
  clouds  Blue Marble cloud composite               57000/57747/cloud_combined_8192.tif
  (prefix: https://eoimages.gsfc.nasa.gov/images/imagerecords/)

Usage: python3 scripts/build-earth-textures.py <dir with day.jpg night.jpg elev.png clouds.tif>
Requires Pillow and numpy.
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else '.')
OUT = Path(__file__).resolve().parent.parent / 'public' / 'textures' / 'earth'
RELIEF_EXAGGERATION = 14.0   # terrain is invisible from orbit at true scale
METERS_PER_LEVEL = 6400 / 255


def save_jpg(img: Image.Image, name: str, quality: int = 88) -> None:
    img.save(OUT / name, quality=quality, optimize=True, progressive=True)
    print(f'{name:28s} {img.size[0]}x{img.size[1]}  {(OUT / name).stat().st_size / 1e6:.1f} MB')


def normal_map(elev: np.ndarray) -> Image.Image:
    """Tangent-space normal map (x = east, y = north) from an equirectangular height field."""
    h, w = elev.shape
    height_m = elev.astype(np.float32) * METERS_PER_LEVEL * RELIEF_EXAGGERATION
    px_m = 40_075_000.0 / w
    lat = (0.5 - (np.arange(h) + 0.5) / h) * np.pi
    dx_m = np.maximum(np.cos(lat), 0.02)[:, None] * px_m
    d_east = (np.roll(height_m, -1, axis=1) - np.roll(height_m, 1, axis=1)) / (2 * dx_m)
    d_north = np.zeros_like(height_m)
    d_north[1:-1] = (height_m[:-2] - height_m[2:]) / (2 * px_m)   # row index grows southward
    n = np.stack([-d_east, -d_north, np.ones_like(height_m)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return Image.fromarray(((n * 0.5 + 0.5) * 255).round().astype(np.uint8), 'RGB')


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    day = Image.open(SRC / 'day.jpg').convert('RGB')
    day8 = day.resize((8192, 4096), Image.LANCZOS)
    save_jpg(day8, 'day_8k.jpg', 90)
    save_jpg(day8.resize((4096, 2048), Image.LANCZOS), 'day_4k.jpg', 90)

    night = Image.open(SRC / 'night.jpg').convert('RGB')
    night8 = night.resize((8192, 4096), Image.LANCZOS)
    save_jpg(night8, 'night_8k.jpg', 85)
    save_jpg(night8.resize((4096, 2048), Image.LANCZOS), 'night_4k.jpg', 85)

    elev = Image.open(SRC / 'elev.png').convert('L')
    for size, name in ((8192, 'normal_8k.jpg'), (4096, 'normal_4k.jpg')):
        e = elev.resize((size, size // 2), Image.BOX).filter(ImageFilter.GaussianBlur(0.8))
        save_jpg(normal_map(np.asarray(e)), name, 90)

    # Water mask (white = water) for sun glint: zero land elevation and a dark, blue-dominant day pixel.
    e4 = np.asarray(elev.resize((4096, 2048), Image.BOX)).astype(np.int16)
    d4 = np.asarray(day8.resize((4096, 2048), Image.BOX)).astype(np.int16)
    water = (e4 <= 1) & (d4[..., 2] >= d4[..., 0]) & (d4.sum(axis=-1) < 260)
    mask = Image.fromarray((water * 255).astype(np.uint8), 'L').filter(ImageFilter.GaussianBlur(1.2))
    mask.save(OUT / 'water_4k.png', optimize=True)
    print(f'water_4k.png                 {(OUT / "water_4k.png").stat().st_size / 1e6:.1f} MB')

    clouds = Image.open(SRC / 'clouds.tif').convert('L').resize((4096, 2048), Image.LANCZOS)
    save_jpg(clouds, 'clouds_4k.jpg', 85)


if __name__ == '__main__':
    main()
