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

function printDeOverlapRanking() {
  const rows = db
    .prepare(
      `
    SELECT cm.bu_name, cm.de_name, cm.id_type,
           COUNT(*) AS filas,
           SUM(CASE WHEN dup.de_count > 1 THEN 1 ELSE 0 END) AS filas_que_se_repiten_en_otra_de
    FROM contact_map cm
    JOIN (
      SELECT identifier, id_type, COUNT(DISTINCT customer_key) AS de_count
      FROM contact_map GROUP BY identifier, id_type
    ) dup ON cm.identifier = dup.identifier AND cm.id_type = dup.id_type
    GROUP BY cm.customer_key, cm.id_type
    ORDER BY filas_que_se_repiten_en_otra_de DESC
    LIMIT 25
  `
    )
    .all();

  console.log('\n=== DEs que más aportan a la duplicación (top 25) ===');
  for (const r of rows) {
    const pct = r.filas > 0 ? ((r.filas_que_se_repiten_en_otra_de / r.filas) * 100).toFixed(1) : '0.0';
    console.log(
      `  [${r.bu_name}] ${r.de_name} (${r.id_type}): ${r.filas_que_se_repiten_en_otra_de} de ${r.filas} filas (${pct}%) también están en otra DE`
    );
  }
}

function printTopDuplicateIdentifiers() {
  const rows = db
    .prepare(
      `
    SELECT identifier, id_type, COUNT(DISTINCT customer_key) AS de_count
    FROM contact_map
    GROUP BY identifier, id_type
    HAVING de_count > 1
    ORDER BY de_count DESC
    LIMIT 15
  `
    )
    .all();
  const detailStmt = db.prepare(`SELECT DISTINCT bu_name, de_name FROM contact_map WHERE identifier = ? AND id_type = ?`);
  console.log('\n=== Identificadores que más se repiten (top 15, en cuántas DEs distintas aparecen) ===');
  for (const r of rows) {
    const locs = detailStmt.all(r.identifier, r.id_type).map((x) => x.de_name);
    console.log(`  (${r.id_type}) presente en ${r.de_count} DEs: ${locs.join(', ')}`);
  }
}

function totals() {
  const byType = db
    .prepare('SELECT id_type, COUNT(DISTINCT identifier) AS n FROM contact_map GROUP BY id_type')
    .all();
  console.log('');
  const labels = { subscriberkey: 'SubscriberKeys únicos', email: 'Emails únicos', dni: 'DNIs únicos' };
  for (const r of byType) {
    console.log(`${labels[r.id_type] || r.id_type + ' únicos'} vistos (en DEs que tienen ese campo): ${r.n}`);
  }
  console.log(
    'Nota: estos números NO se suman entre sí — una misma persona puede aparecer contada por un tipo de identificador en una DE y por otro tipo en otra, sin que se pueda cruzar automáticamente ahí.'
  );
}

progressSummary();
totals();
writeDeSummaryCsv();
writeDuplicatesCsv();
printDeOverlapRanking();
printTopDuplicateIdentifiers();
db.close();
