import { NextResponse } from 'next/server';
import { getContactDeleteStatus } from '../../../lib/sfmc';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(request) {
  try {
    const { operationId } = await request.json();
    if (!operationId) {
      return NextResponse.json({ error: 'Falta operationId' }, { status: 400 });
    }
    const status = await getContactDeleteStatus(operationId);
    return NextResponse.json({ status });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
