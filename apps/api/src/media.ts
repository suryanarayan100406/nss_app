import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';
import { HttpError } from './errors.js';

export type QualityWarning = 'LOW_RESOLUTION' | 'EXTREME_ASPECT_RATIO' | 'LIKELY_SOFT';

export type ProcessedUpload = {
  storageKey: string;
  originalName: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  sizeBytes: number;
  width: number;
  height: number;
  sha256: string;
  dHash: string;
  qualityWarnings: QualityWarning[];
};

async function sha256File(filePath: string) {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve());
  });
  return hash.digest('hex');
}

function inspectSignature(buffer: Buffer): ProcessedUpload['mimeType'] | null {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function bitsToHex(bits: number[]) {
  let out = '';
  for (let i = 0; i < bits.length; i += 4) out += parseInt(bits.slice(i, i + 4).join(''), 2).toString(16);
  return out;
}

export async function calculateDHash(filePath: string) {
  const { data } = await sharp(filePath).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const bits: number[] = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) bits.push(data[y * 9 + x] > data[y * 9 + x + 1] ? 1 : 0);
  }
  return bitsToHex(bits);
}

export function hammingDistance(a?: string | null, b?: string | null) {
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) distance += (parseInt(a[i], 16) ^ parseInt(b[i], 16)).toString(2).replace(/0/g, '').length;
  return distance;
}

async function likelySoft(filePath: string) {
  const { data, info } = await sharp(filePath).greyscale().resize({ width: 256, withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
  if (info.width < 3 || info.height < 3) return false;
  let sum = 0;
  let count = 0;
  for (let y = 1; y < info.height - 1; y += 1) {
    for (let x = 1; x < info.width - 1; x += 1) {
      const c = data[y * info.width + x];
      const lap = data[(y - 1) * info.width + x] + data[(y + 1) * info.width + x] + data[y * info.width + x - 1] + data[y * info.width + x + 1] - 4 * c;
      sum += lap * lap;
      count += 1;
    }
  }
  return count > 0 && sum / count < 18;
}

export async function processUpload(tempPath: string, originalName: string): Promise<ProcessedUpload> {
  const stat = await fs.stat(tempPath);
  if (stat.size > config.MAX_UPLOAD_BYTES) throw new HttpError(413, 'FILE_TOO_LARGE', `Files must be ${Math.round(config.MAX_UPLOAD_BYTES / 1_048_576)} MB or smaller.`);
  const handle = await fs.open(tempPath, 'r');
  const header = Buffer.alloc(16);
  try { await handle.read(header, 0, 16, 0); } finally { await handle.close(); }
  const signature = inspectSignature(header);
  if (!signature) throw new HttpError(415, 'UNSUPPORTED_IMAGE', 'Only JPEG, PNG, and WebP image files are supported.');
  let metadata: { width?: number; height?: number; pages?: number };
  try {
    metadata = await sharp(tempPath, { failOn: 'error', limitInputPixels: config.MAX_IMAGE_PIXELS }).metadata();
    if ((metadata.pages ?? 1) > 1) throw new Error('Animated images are unsupported');
    await sharp(tempPath, { failOn: 'error', limitInputPixels: config.MAX_IMAGE_PIXELS }).rotate().resize(32, 32).raw().toBuffer();
  } catch {
    throw new HttpError(422, 'CORRUPTED_IMAGE', 'The image could not be decoded.');
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height || width * height > config.MAX_IMAGE_PIXELS) throw new HttpError(422, 'IMAGE_DIMENSIONS_INVALID', 'The image dimensions or pixel count exceed the configured limit.');
  const warnings: QualityWarning[] = [];
  if (width < config.MIN_IMAGE_WIDTH || height < config.MIN_IMAGE_HEIGHT) warnings.push('LOW_RESOLUTION');
  const ratio = width / height;
  if (ratio > 4 || ratio < 0.25) warnings.push('EXTREME_ASPECT_RATIO');
  if (await likelySoft(tempPath)) warnings.push('LIKELY_SOFT');
  const sha256 = await sha256File(tempPath);
  const dHash = await calculateDHash(tempPath);
  await fs.mkdir(config.PRIVATE_MEDIA_ROOT, { recursive: true });
  const storageKey = `originals/${crypto.randomUUID()}.source`;
  const destination = path.join(config.PRIVATE_MEDIA_ROOT, storageKey);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(tempPath, destination);
  return { storageKey, originalName: originalName.slice(0, 255), mimeType: signature, sizeBytes: stat.size, width, height, sha256, dHash, qualityWarnings: warnings };
}

export async function createPublicDerivative(storageKey: string, publicKey = `images/${crypto.randomUUID()}.webp`) {
  const source = path.join(config.PRIVATE_MEDIA_ROOT, storageKey);
  const target = path.join(config.PUBLIC_MEDIA_ROOT, publicKey);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await sharp(source, { failOn: 'error' }).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84 }).toFile(target);
  const thumbKey = publicKey.replace(/\.webp$/, '-thumb.webp');
  await sharp(source, { failOn: 'error' }).rotate().resize({ width: 720, height: 720, fit: 'cover' }).webp({ quality: 78 }).toFile(path.join(config.PUBLIC_MEDIA_ROOT, thumbKey));
  return { publicKey, thumbKey };
}

export async function removePrivateUpload(storageKey: string) {
  await fs.rm(privatePath(storageKey), { force: true }).catch(() => undefined);
}

export async function removePublicDerivative(publicKey: string) {
  await Promise.all([
    fs.rm(publicPath(publicKey), { force: true }).catch(() => undefined),
    fs.rm(publicPath(publicKey.replace(/\.webp$/, '-thumb.webp')), { force: true }).catch(() => undefined),
  ]);
}

export function privatePath(storageKey: string) {
  const resolved = path.resolve(config.PRIVATE_MEDIA_ROOT, storageKey);
  if (!resolved.startsWith(`${config.PRIVATE_MEDIA_ROOT}${path.sep}`)) throw new HttpError(400, 'INVALID_MEDIA_PATH', 'Invalid media path.');
  return resolved;
}

export function publicPath(publicKey: string) {
  const resolved = path.resolve(config.PUBLIC_MEDIA_ROOT, publicKey);
  if (!resolved.startsWith(`${config.PUBLIC_MEDIA_ROOT}${path.sep}`)) throw new HttpError(400, 'INVALID_MEDIA_PATH', 'Invalid media path.');
  return resolved;
}
