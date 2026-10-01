import crypto from 'node:crypto';

// AES-256-GCM envelope for credentials stored in Postgres. The key is derived
// from SECRETS_KEY (preferred) or — with no extra configuration —
// the DATABASE_URL connection string, which lives outside the database, so a
// database dump alone does not reveal the API keys. Changing that value makes
// stored credentials unreadable; they are then reported as such and must be
// re-entered.
const SALT = 'eter-news/engine-credentials/v1';
let cached = { base: null, key: null };

export function secretBase() {
  return process.env.SECRETS_KEY || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '';
}

function derive() {
  const base = secretBase();
  if (!base) throw new Error('No DATABASE_URL (or SECRETS_KEY) available to derive the credential encryption key');
  if (cached.base !== base) cached = { base, key: crypto.scryptSync(base, SALT, 32) };
  return cached.key;
}

export function canEncrypt() {
  return Boolean(secretBase());
}

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derive(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

// Returns null when the value cannot be decrypted (wrong/rotated key, corrupt row).
export function decrypt(blob) {
  try {
    const [version, iv, tag, ct] = String(blob).split(':');
    if (version !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', derive(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function maskSecret(value) {
  const v = String(value || '');
  if (!v) return '';
  if (v.length <= 12) return `${v.slice(0, 2)}${'•'.repeat(6)}`;
  return `${v.slice(0, 4)}${'•'.repeat(8)}${v.slice(-4)}`;
}
