import { NextResponse } from 'next/server';
import { listContactDataExtensions } from '../../../lib/sfmc';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET() {
  try {
    const des = await listContactDataExtensions();
    des.sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ dataExtensions: des });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
