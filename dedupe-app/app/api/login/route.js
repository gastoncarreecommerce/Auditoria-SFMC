import { NextResponse } from 'next/server';
import { checkPassword, makeSessionCookie } from '../../../lib/auth';

export const runtime = 'nodejs';

export async function POST(request) {
  const { password } = await request.json();
  if (!checkPassword(password)) {
    return NextResponse.json({ error: 'Contraseña incorrecta' }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.headers.set('Set-Cookie', await makeSessionCookie());
  return res;
}
