// Firma HMAC con Web Crypto (no el módulo "crypto" de Node): el middleware
// corre en el Edge Runtime de Next.js, que no tiene acceso a Node's crypto.
// Web Crypto sí está disponible en los dos lados (Edge y Node).

const COOKIE_NAME = 'sfmc_cleaner_session';

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sign(value) {
  const secret = process.env.APP_PASSWORD || '';
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return toHex(sig);
}

export async function makeSessionCookie() {
  const value = 'ok';
  const sig = await sign(value);
  return `${COOKIE_NAME}=${value}.${sig}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 12}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export async function isValidSession(cookieHeader) {
  if (!cookieHeader) return false;
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return false;
  const [value, sig] = decodeURIComponent(match[1]).split('.');
  if (!value || !sig) return false;
  return sig === (await sign(value));
}

// Comparación en tiempo constante manual (Web Crypto no trae
// timingSafeEqual). Innecesario a esta escala, pero es gratis hacerlo bien.
export function checkPassword(password) {
  const expected = process.env.APP_PASSWORD || '';
  const a = String(password || '');
  if (!expected) return false;
  if (a.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export { COOKIE_NAME };
