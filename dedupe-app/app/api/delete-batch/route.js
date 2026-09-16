import { NextResponse } from 'next/server';
import { getDataExtensionName, getPrimaryKeyFields, fetchFirstPage, deleteRows, isSystemDE } from '../../../lib/sfmc';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Borra UNA tanda (hasta 500 filas) por llamada. El cliente es quien
// decide si sigue llamando — no hay un loop automático del lado del
// servidor: cada tanda es una decisión explícita, visible en la UI antes
// de la siguiente.
export async function POST(request) {
  try {
    const { customerKey, confirmName } = await request.json();
    if (!customerKey || !confirmName) {
      return NextResponse.json({ error: 'Faltan customerKey o confirmName' }, { status: 400 });
    }

    // El nombre se verifica contra SFMC, no contra lo que mandó el cliente
    // en un llamado anterior: si alguien pasa un customerKey que no
    // corresponde al nombre tipeado, se corta acá.
    const realName = await getDataExtensionName(customerKey);
    if (!realName) {
      return NextResponse.json({ error: 'No se encontró esa Data Extension en SFMC' }, { status: 404 });
    }
    if (isSystemDE(realName)) {
      return NextResponse.json({ error: 'Es una DE de sistema, no se puede vaciar desde acá' }, { status: 403 });
    }
    if (confirmName.trim() !== realName) {
      return NextResponse.json({ error: `El nombre no coincide. La DE real se llama "${realName}".` }, { status: 400 });
    }

    const pkFields = await getPrimaryKeyFields(customerKey);
    if (pkFields.length === 0) {
      return NextResponse.json({ error: 'Esta DE no tiene clave primaria definida — no se puede borrar por API.' }, { status: 422 });
    }

    const rows = await fetchFirstPage(customerKey, pkFields);
    if (rows.length === 0) {
      return NextResponse.json({ deleted: 0, done: true, deName: realName });
    }

    const result = await deleteRows(customerKey, pkFields, rows);
    return NextResponse.json({
      deleted: rows.length,
      done: false,
      deName: realName,
      overallStatus: result?.overallStatus,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
