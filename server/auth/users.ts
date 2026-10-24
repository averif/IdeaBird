import { query } from '../db/index.js';

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  google_sub: string | null;
  email_verified: boolean;
  token_version: number;
}

const COLUMNS = 'id, email, name, password_hash, google_sub, email_verified, token_version';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const [user] = await query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
  return user ?? null;
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const [user] = await query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE email = $1`, [normalizeEmail(email)]);
  return user ?? null;
}

export async function findUserByGoogleSub(sub: string): Promise<UserRow | null> {
  const [user] = await query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE google_sub = $1`, [sub]);
  return user ?? null;
}

/** Returns null when the email is already taken. */
export async function createUser(input: {
  email: string;
  name?: string | null;
  passwordHash?: string | null;
  googleSub?: string | null;
  emailVerified?: boolean;
}): Promise<UserRow | null> {
  const [user] = await query<UserRow>(
    `INSERT INTO users (email, name, password_hash, google_sub, email_verified)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO NOTHING
     RETURNING ${COLUMNS}`,
    [normalizeEmail(input.email), input.name ?? null, input.passwordHash ?? null, input.googleSub ?? null, input.emailVerified ?? false]
  );
  return user ?? null;
}
