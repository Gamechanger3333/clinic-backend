/**
 * src/test/authHelper.ts — signs a real access-token JWT for tests that
 * need to hit an authenticated route, without going through the full
 * login flow each time.
 */
import { signAccessToken, ACCESS_COOKIE } from "../lib/auth";

export async function authCookieFor(user: {
  userId: string;
  email: string;
  role: string;
  fullName: string;
  tokenVersion?: number;
}): Promise<string> {
  const token = await signAccessToken({ ...user, tokenVersion: user.tokenVersion ?? 0 });
  return `${ACCESS_COOKIE}=${token}`;
}
