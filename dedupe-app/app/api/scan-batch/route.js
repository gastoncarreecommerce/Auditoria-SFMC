import { NextResponse } from 'next/server';
import {
  getDataExtensionName,
  isSystemDE,
  getIdFields,
  fetchPage,
  resolveSubscriberKeysByEmail,
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

    const { rows, hasMore, totalRows } = await fetchPage(customerKey, page, idFields);

    // Primero se separan las filas que ya traen SubscriberKey directo de
    // las que necesitan resolverse por email, así el lookup por email
    // (el que puede tardar) se manda todo junto en paralelo en vez de
    // intercalado fila por fila.
    const direct = []; // { identifier, subscriberKey }
    const needsLookup = []; // { identifier }
    for (const row of rows) {
      let directKey = null;
      for (const f of idFields) {
        if (f.type === 'subscriberkey' && row[f.name]) {
          directKey = row[f.name];
          break;
        }
      }
      if (directKey) {
        direct.push({ identifier: directKey, subscriberKey: directKey });
        continue;
      }
      const emailField = idFields.find((f) => f.type === 'email' && row[f.name]);
      if (emailField) needsLookup.push({ identifier: row[emailField.name] });
      else needsLookup.push({ identifier: null });
    }

    const emailsToResolve = needsLookup.filter((r) => r.identifier).map((r) => r.identifier);
    const resolvedKeys = await resolveSubscriberKeysByEmail(emailsToResolve);
    let resolvedIdx = 0;
    const lookedUp = needsLookup.map((r) => {
      if (!r.identifier) return { identifier: null, subscriberKey: null };
      return { identifier: r.identifier, subscriberKey: resolvedKeys[resolvedIdx++] };
    });

    const resolved = [...direct, ...lookedUp].filter((r) => r.subscriberKey);
    const unresolved = [...direct, ...lookedUp].filter((r) => !r.subscriberKey);

    return NextResponse.json({
      deName: realName,
      page,
      rowsInPage: rows.length,
      hasMore,
      totalRows,
      resolved, // [{ identifier, subscriberKey }]
      unresolvedCount: unresolved.length,
      unresolvedIdentifiers: unresolved.map((r) => r.identifier).filter(Boolean),
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
