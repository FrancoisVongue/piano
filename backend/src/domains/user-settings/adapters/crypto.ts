import crypto from 'crypto';
import config from '../../../config';

// AES-256-GCM symmetric encryption for at-rest sensitive values (e.g. user API keys).
// Format: `${ivHex}:${authTagHex}:${cipherHex}`

const ALGORITHM = 'aes-256-gcm';

const getKey = (): Buffer => {
  const secret = config.encryption.apiKeySecret;
  return Buffer.from(secret.padEnd(32).slice(0, 32));
};

export const encrypt = (plaintext: string): string => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
};

export const decrypt = (payload: string): string => {
  const parts = payload.split(':');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error('Invalid encrypted payload format');
  }
  const [ivHex, authTagHex, cipherHex] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};
