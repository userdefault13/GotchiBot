#!/usr/bin/env node
/**
 * Zero-dependency PNG icon generator for the GotchiBot phone app.
 * Draws a simple pixel-art "gotchi" ghost on a solid background.
 * Usage: node services/gotchibot-api/app/scripts/make-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");

const BG = [0x1a, 0x0a, 0x24, 0xff]; // theme #1a0a24
const BODY = [0xf0, 0xe6, 0xff, 0xff];
const EYE = [0x2a, 0x12, 0x3a, 0xff];
const CHEEK = [0xff, 0x6b, 0xcb, 0xff];
const CLEAR = [0, 0, 0, 0];

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 16x16 ghost sprite cells (1=body 2=eye 3=cheek 0=empty) */
const SPRITE = [
  "0001111110000000",
  "0011111111000000",
  "0111111111100000",
  "0112211221100000",
  "0112211221100000",
  "0111111111100000",
  "0111311311100000",
  "0111111111100000",
  "0111111111100000",
  "0111111111100000",
  "0111010111100000",
  "0110000011100000",
  "0100000001100000",
  "0000000000000000",
  "0000000000000000",
  "0000000000000000",
];

function colorFor(ch) {
  if (ch === "1") return BODY;
  if (ch === "2") return EYE;
  if (ch === "3") return CHEEK;
  return null;
}

function drawIcon(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  // fill background
  for (let i = 0; i < size * size; i++) {
    const c = maskable || true ? BG : CLEAR;
    rgba[i * 4] = c[0];
    rgba[i * 4 + 1] = c[1];
    rgba[i * 4 + 2] = c[2];
    rgba[i * 4 + 3] = c[3];
  }

  // Safe padding for maskable (~20%); normal icons use ~12%
  const padFrac = maskable ? 0.22 : 0.12;
  const pad = Math.floor(size * padFrac);
  const draw = size - pad * 2;
  const cell = draw / 16;

  for (let sy = 0; sy < 16; sy++) {
    for (let sx = 0; sx < 16; sx++) {
      const col = colorFor(SPRITE[sy][sx]);
      if (!col) continue;
      const x0 = Math.floor(pad + sx * cell);
      const y0 = Math.floor(pad + sy * cell);
      const x1 = Math.floor(pad + (sx + 1) * cell);
      const y1 = Math.floor(pad + (sy + 1) * cell);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const i = (y * size + x) * 4;
          rgba[i] = col[0];
          rgba[i + 1] = col[1];
          rgba[i + 2] = col[2];
          rgba[i + 3] = col[3];
        }
      }
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(OUT, { recursive: true });
const files = [
  ["icon-32.png", 32, false],
  ["icon-180.png", 180, false],
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["icon-512-maskable.png", 512, true],
];
for (const [name, size, maskable] of files) {
  const buf = drawIcon(size, { maskable });
  writeFileSync(join(OUT, name), buf);
  console.log(`wrote ${name} (${buf.length} bytes)`);
}
