import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import sharp from 'sharp';
import { calculateDHash, hammingDistance, processUpload } from '../src/media.js';

const tempRoot = path.resolve(process.cwd(), 'var/test-media');

afterEach(async () => { await fs.rm(tempRoot, { recursive: true, force: true }); });

async function makeImage(name: string, width = 1200, height = 900, color = '#4a6647') {
  const file = path.join(tempRoot, name);
  await fs.mkdir(tempRoot, { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toFile(file);
  return file;
}

describe('deterministic image checks', () => {
  it('computes identical hashes for exact duplicate bytes', async () => {
    const a = await makeImage('a.jpg');
    const b = path.join(tempRoot, 'b.jpg');
    await fs.copyFile(a, b);
    expect(await calculateDHash(a)).toBe(await calculateDHash(b));
    expect(hammingDistance(await calculateDHash(a), await calculateDHash(b))).toBe(0);
  });

  it('reports a small perceptual distance for a visually similar image', async () => {
    const a = await makeImage('a.jpg', 1200, 900, '#4a6647');
    const b = await makeImage('b.jpg', 1200, 900, '#4d684a');
    expect(hammingDistance(await calculateDHash(a), await calculateDHash(b))).toBeLessThanOrEqual(8);
  });

  it('rejects unsupported and corrupted files', async () => {
    await fs.mkdir(tempRoot, { recursive: true });
    const txt = path.join(tempRoot, 'bad.txt');
    await fs.writeFile(txt, 'not an image');
    await expect(processUpload(txt, 'bad.txt')).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE' });
    const jpg = path.join(tempRoot, 'corrupt.jpg');
    await fs.writeFile(jpg, Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]));
    await expect(processUpload(jpg, 'corrupt.jpg')).rejects.toMatchObject({ code: 'CORRUPTED_IMAGE' });
  });

  it('returns an explainable low-resolution warning', async () => {
    const file = await makeImage('small.jpg', 320, 240);
    const result = await processUpload(file, 'small.jpg');
    expect(result.qualityWarnings).toContain('LOW_RESOLUTION');
  });
});
