import { NextResponse } from 'next/server';
import { submitContactDelete } from '../../../lib/sfmc';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_KEYS_PER_REQUEST = 500;

export async function POST(request) {
  try {
    const { subscriberKeys } = await request.json();
    if (!Array.isArray(subscriberKeys) || subscriberKeys.length === 0) {
      return NextResponse.json({ error: 'Faltan subscriberKeys' }, { status: 400 });
    }
    if (subscriberKeys.length > MAX_KEYS_PER_REQUEST) {
      return NextResponse.json(
        { error: `Máximo ${MAX_KEYS_PER_REQUEST} por solicitud — mandá menos por vez.` },
        { status: 400 }
      );
    }

    const operationId = await submitContactDelete(subscriberKeys);
    return NextResponse.json({ operationId, submitted: subscriberKeys.length });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
