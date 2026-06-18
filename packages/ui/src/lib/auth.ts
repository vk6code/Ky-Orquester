import bcrypt from "bcryptjs";

/**
 * Web auth for the HTTP transport: the daemon stores a bcrypt hash of the
 * password and publishes its salt. The client derives the SAME hash from the
 * typed password + salt and uses it as the bearer — so the plaintext password
 * is never sent nor stored; only the derived hash lives in localStorage.
 */
export function deriveAuthHash(password: string, salt: string): string {
  return bcrypt.hashSync(password, salt);
}

const keyFor = (endpoint: string) => `orquester.auth:${endpoint}`;

export function loadStoredHash(endpoint: string): string | undefined {
  try {
    return localStorage.getItem(keyFor(endpoint)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function storeHash(endpoint: string, hash: string): void {
  try {
    localStorage.setItem(keyFor(endpoint), hash);
  } catch {
    /* storage unavailable */
  }
}

export function clearStoredHash(endpoint: string): void {
  try {
    localStorage.removeItem(keyFor(endpoint));
  } catch {
    /* storage unavailable */
  }
}
