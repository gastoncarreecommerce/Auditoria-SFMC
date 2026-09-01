import fs from 'fs';
import Database from 'better-sqlite3';

const db = new Database('contacts.db', { readonly: true });

function csvEscape(v) {
  return `"${String(v).replace(/"/g, '""')}"`;
}

function progressSummary() {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM de_progress GROUP BY status').all();
  console.log('Estado de la extracción por DE:');
  for (const r of rows) console.log(`  ${r.status}: ${r.n}`);
  const pending = db
    .prepare("SELECT COUNT(*) AS n FROM de_progress WHERE status IN ('in_progress','pending')")
    .get().n;
  if (pending > 0) {
    console.log(
      `\n⚠️  Hay ${pending} DE(s) todavía sin terminar de extraer. Este reporte es PARCIAL — corré extract-contacts.js de nuevo hasta que no queden pendientes para un resultado completo.`
    );
  }
}

function writeDuplicatesCsv() {
  const dupIdentifiers = db
    .prepare(
      `
    SELECT identifier, id_type, COUNT(DISTINCT customer_key) AS de_count, COUNT(*) AS row_count
    FROM contact_map
    GROUP BY identifier, id_type
    HAVING de_count > 1
    ORDER BY de_count DESC, row_count DESC
  `
    )
    .all();

  const detailStmt = db.prepare(
    `SELECT DISTINCT bu_name, de_name FROM contact_map WHERE identifier = ? AND id_type = ?`
  );

  const lines = ['Identificador,Tipo,EnCuantasDEs,TotalFilas,UnidadesYDEs'];
  for (const d of dupIdentifiers) {
    const locations = detailStmt
      .all(d.identifier, d.id_type)
      .map((r) => `${r.bu_name} / ${r.de_name}`)
      .join(' | ');
    lines.push(
      `${csvEscape(d.identifier)},${csvEscape(d.id_type)},${d.de_count},${d.row_count},${csvEscape(locations)}`
    );
  }
  fs.writeFileSync('contacts-duplicados.csv', lines.join('\n'));
  console.log(`\ncontacts-duplicados.csv generado: ${dupIdentifiers.length} identificadores repetidos en más de una DE.`);
  return dupIdentifiers.length;
}

function writeDeSummaryCsv() {
  const perDe = db
    .prepare(
      `
    SELECT bu_name, de_name, customer_key, id_type,
           COUNT(*) AS filas_extraidas,
           COUNT(DISTINCT identifier) AS identificadores_unicos
    FROM contact_map
    GROUP BY customer_key, id_type
    ORDER BY bu_name, de_name
  `
    )
    .all();

  const lines = ['UnidadComercial,NombreDE,TipoIdentificador,FilasExtraidas,IdentificadoresUnicosEnEstaDE'];
  for (const r of perDe) {
    lines.push(
      `${csvEscape(r.bu_name)},${csvEscape(r.de_name)},${csvEscape(r.id_type)},${r.filas_extraidas},${r.identificadores_unicos}`
    );
  }
  fs.writeFileSync('contacts-resumen-por-de.csv', lines.join('\n'));
  console.log(`contacts-resumen-por-de.csv generado (${perDe.length} filas DE x tipo de identificador).`);
}

function totals() {
  const bySubKey = db
    .prepare("SELECT COUNT(DISTINCT identifier) AS n FROM contact_map WHERE id_type = 'subscriberkey'")
    .get().n;
  const byEmail = db.prepare("SELECT COUNT(DISTINCT identifier) AS n FROM contact_map WHERE id_type = 'email'").get().n;
  console.log(`\nSubscriberKeys únicos vistos (en DEs que tienen ese campo): ${bySubKey}`);
  console.log(`Emails únicos vistos (en DEs que tienen ese campo): ${byEmail}`);
  console.log(
    'Nota: estos dos números NO se suman entre sí — una misma persona puede aparecer contada por SubscriberKey en una DE y por Email en otra sin que se pueda cruzar automáticamente ahí.'
  );
}

progressSummary();
totals();
writeDeSummaryCsv();
writeDuplicatesCsv();
db.close();
