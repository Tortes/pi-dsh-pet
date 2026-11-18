import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const output = resolve('src-tauri/icons/icon.ico');
await mkdir(dirname(output), { recursive: true });

// Minimal valid 1x1, 32-bit ICO. This is a build placeholder; replace it
// with the actual pet icon before publishing a branded installer.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // image type: ICO
header.writeUInt16LE(1, 4); // image count

const entry = Buffer.alloc(16);
entry.writeUInt8(1, 0); // width
entry.writeUInt8(1, 1); // height
entry.writeUInt8(0, 2); // palette
entry.writeUInt8(0, 3);
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(48, 8); // image data size
entry.writeUInt32LE(22, 12); // image data offset

const dib = Buffer.alloc(40);
dib.writeUInt32LE(40, 0); // BITMAPINFOHEADER size
dib.writeInt32LE(1, 4); // width
dib.writeInt32LE(2, 8); // doubled height (XOR + AND masks)
dib.writeUInt16LE(1, 12); // planes
dib.writeUInt16LE(32, 14); // bits per pixel
dib.writeUInt32LE(0, 16); // BI_RGB
dib.writeUInt32LE(4, 20); // XOR bitmap size

const pixel = Buffer.from([0x40, 0x80, 0xff, 0xff]); // opaque orange BGRA
const mask = Buffer.alloc(4);

await writeFile(output, Buffer.concat([header, entry, dib, pixel, mask]));
console.log('Generated ' + output);
