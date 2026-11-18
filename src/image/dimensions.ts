// Lecture des dimensions d'une image depuis son en-tête, sans dépendance (PNG, JPEG, GIF, WebP).
// Milanote attend width/height/transparent dans `content.image` (test/fixtures/ws-09-update-image.json).

export interface ImageInfo {
  width: number;
  height: number;
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  ext: 'png' | 'jpg' | 'gif' | 'webp';
  /** Canal alpha d'après l'en-tête (approximation : PNG type couleur 4/6, GIF toujours vrai, WebP VP8X/VP8L). */
  transparent: boolean;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function readImageInfo(buf: Buffer): ImageInfo {
  if (buf.length >= 26 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const colorType = buf[25] ?? 0;
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      mime: 'image/png',
      ext: 'png',
      transparent: colorType === 4 || colorType === 6,
    };
  }
  if (buf.length >= 10 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), mime: 'image/gif', ext: 'gif', transparent: true };
  }
  if (buf.length >= 30 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { ...readWebp(buf), mime: 'image/webp', ext: 'webp' };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    return { ...readJpeg(buf), mime: 'image/jpeg', ext: 'jpg', transparent: false };
  }
  throw new Error('Format d’image non reconnu (PNG, JPEG, GIF ou WebP attendus).');
}

function readJpeg(buf: Buffer): { width: number; height: number } {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) throw new Error('JPEG : marqueur attendu.');
    const marker = buf[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15, sauf DHT (C4), JPG (C8) et DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('JPEG : segment SOF introuvable.');
}

function readWebp(buf: Buffer): { width: number; height: number; transparent: boolean } {
  const chunk = buf.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8X') {
    const flags = buf[20] ?? 0;
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), transparent: (flags & 0x10) !== 0 };
  }
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { width: 1 + (b & 0x3fff), height: 1 + ((b >>> 14) & 0x3fff), transparent: ((b >>> 28) & 1) === 1 };
  }
  if (chunk === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, transparent: false };
  }
  throw new Error('WebP : bloc inconnu.');
}
