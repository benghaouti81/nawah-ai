import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Role } from '../../shared/types.ts';

let cachedMasterKey: Buffer | null = null;

export function getDataDir(): string {
  const dir = path.resolve(process.cwd(), process.env.NAWAH_DATA_DIR || './data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/**
 * Resolves the 32-byte AES-256-GCM master key.
 * Priority:
 * 1. NAWAH_MASTER_KEY environment variable (64-char hex or SHA-256 derived).
 * 2. Persisted key file inside NAWAH_DATA_DIR/.nawah_master_key (0o600) so
 *    auto-generated keys survive container restarts when data volume is mounted.
 */
export function getMasterKey(): Buffer {
  if (cachedMasterKey) {
    return cachedMasterKey;
  }

  const envKey = process.env.NAWAH_MASTER_KEY?.trim();
  if (envKey) {
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) {
      cachedMasterKey = Buffer.from(envKey, 'hex');
    } else {
      cachedMasterKey = crypto.createHash('sha256').update(envKey, 'utf8').digest();
    }
    return cachedMasterKey;
  }

  const keyFile = path.join(getDataDir(), '.nawah_master_key');
  if (fs.existsSync(keyFile)) {
    const raw = fs.readFileSync(keyFile, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      cachedMasterKey = Buffer.from(raw, 'hex');
      return cachedMasterKey;
    }
  }

  const generatedHex = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyFile, `${generatedHex}\n`, { mode: 0o600 });
  cachedMasterKey = Buffer.from(generatedHex, 'hex');
  return cachedMasterKey;
}

export function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid encrypted secret format');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const key = getMasterKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

export function generateApiKey(role: Role): {
  rawKey: string;
  keyPrefix: string;
  keyHash: string;
} {
  const roleTag =
    role === 'global_admin'
      ? 'gadm'
      : role === 'department_admin'
        ? 'dadm'
        : 'mbr';
  const token = crypto.randomBytes(24).toString('hex');
  const rawKey = `nawah_${roleTag}_${token}`;
  const keyPrefix = `${rawKey.slice(0, 15)}...${rawKey.slice(-4)}`;
  const keyHash = hashApiKey(rawKey);
  return { rawKey, keyPrefix, keyHash };
}

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
