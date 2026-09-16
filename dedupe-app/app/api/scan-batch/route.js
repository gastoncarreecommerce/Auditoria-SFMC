import { NextResponse } from 'next/server';
import {
  getDataExtensionName,
  isSystemDE,
  getIdFields,
  fetchPage,
  resolveSubscriberKeyByEmail,
} from '../../../lib/sfmc';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request) {
  try {
    const { customerKey, confirmName, page } = await request.json();
    if (!customerKey || !confirmName || !page) {
      return NextResponse.json({ error: 'Faltan customerKey, confirmName o page' }, { status: 400 });
    }

    const realName = await getDataExtensionName(customerKey);
    if (!realName) {
      return NextResponse.json({ error: 'No se encontró esa Data Extension en SFMC' }, { status: 404 });
    }
    if (isSystemDE(realName)) {
      return NextResponse.json({ error: 'Es una DE de sistema, no se puede usar desde acá' }, { status: 403 });
    }
    if (confirmName.trim() !== realName) {
      return NextResponse.json({ error: `El nombre no coincide. La DE real se llama "${realName}".` }, { status: 400 });
    }

    const idFields = await getIdFields(customerKey);
    const hasSubscriberKeyField = idFields.some((f) => f.type === 'subscriberkey');
    const hasEmailField = idFields.some((f) => f.type === 'email');
    if (!hasSubscriberKeyField && !hasEmailField) {
      return NextResponse.json(
        {
          error:
            'Esta DE no tiene un campo SubscriberKey/ContactKey ni un campo de email detectable — no hay forma segura de resolver a qué contacto global de SFMC corresponde cada fila.',
        },
        { status: 422 }
      );
    }

    const { rows, hasMore } = await fetchPage(customerKey, page, idFields);

    const subscriberKeys = [];
    let unresolved = 0;
    for (const row of rows) {
      let key = null;
      for (const f of idFields) {
        if (f.type === 'subscriberkey' && row[f.name]) {
          key = row[f.name];
          break;
        }
      }
      if (!key) {
        const emailField = idFields.find((f) => f.type === 'email' && row[f.name]);
        if (emailField) key = await resolveSubscriberKeyByEmail(row[emailField.name]);
      }
      if (key) subscriberKeys.push(key);
      else unresolved++;
    }

    return NextResponse.json({
      deName: realName,
      page,
      rowsInPage: rows.length,
      hasMore,
      subscriberKeys,
      unresolved,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
