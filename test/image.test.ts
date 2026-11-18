import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readImageInfo } from '../src/image/dimensions.js';

/** PNG minimal : signature + IHDR (dimensions, profondeur, type couleur). */
function png(width: number, height: number, colorType: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR'),
    ihdr,
    Buffer.alloc(4),
  ]);
}

/** JPEG minimal : SOI, un segment APP0, puis SOF0 avec les dimensions. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0, 16]), Buffer.alloc(14)]);
  const sof = Buffer.alloc(2 + 2 + 7);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(9, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(8)]);
}

function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(16);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function webpVp8x(width: number, height: number, alpha: boolean): Buffer {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b[20] = alpha ? 0x10 : 0;
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

test('readImageInfo : PNG, avec et sans alpha', () => {
  assert.deepEqual(readImageInfo(png(64, 48, 6)), { width: 64, height: 48, mime: 'image/png', ext: 'png', transparent: true });
  assert.equal(readImageInfo(png(640, 480, 2)).transparent, false);
});

test('readImageInfo : JPEG (SOF0 après un segment APP0), GIF et WebP VP8X', () => {
  assert.deepEqual(readImageInfo(jpeg(1920, 1080)), { width: 1920, height: 1080, mime: 'image/jpeg', ext: 'jpg', transparent: false });
  assert.deepEqual(readImageInfo(gif(10, 20)), { width: 10, height: 20, mime: 'image/gif', ext: 'gif', transparent: true });
  assert.deepEqual(readImageInfo(webpVp8x(300, 200, true)), { width: 300, height: 200, mime: 'image/webp', ext: 'webp', transparent: true });
});

test('readImageInfo : rejette un fichier qui n’est pas une image', () => {
  assert.throws(() => readImageInfo(Buffer.from('%PDF-1.7 ....................')), /non reconnu/);
});
