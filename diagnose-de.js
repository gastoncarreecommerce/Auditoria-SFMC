import Database from 'better-sqlite3';

const deName = process.env.DIAGNOSE_DE_NAME;
if (!deName) {
  console.error('Falta DIAGNOSE_DE_NAME');
  process.exit(1);
}

const db = new Database('contacts.db', { readonly: true });

const progRows = db.prepare('SELECT * FROM de_progress WHERE de_name = ?').all(deName);
console.log(`=== de_progress para "${deName}" (${progRows.length} fila(s)) ===`);
for (const r of progRows) {
  console.log(JSON.stringify(r, null, 2));
}

for (const r of progRows) {
  const totalRows = db.prepare('SELECT COUNT(*) AS n FROM contact_map WHERE customer_key = ?').get(r.customer_key).n;
  const byType = db
    .prepare('SELECT id_type, COUNT(*) AS n, COUNT(DISTINCT identifier) AS distinct_n FROM contact_map WHERE customer_key = ? GROUP BY id_type')
    .all(r.customer_key);
  const rowSeqStats = db
    .prepare(
      'SELECT SUM(CASE WHEN row_seq IS NULL THEN 1 ELSE 0 END) AS nulls, SUM(CASE WHEN row_seq IS NOT NULL THEN 1 ELSE 0 END) AS non_nulls FROM contact_map WHERE customer_key = ?'
    )
    .get(r.customer_key);
  console.log(`\n--- contact_map para customer_key=${r.customer_key} (${r.de_name}) ---`);
  console.log(`  total filas: ${totalRows}`);
  console.log(`  por tipo: ${JSON.stringify(byType)}`);
  console.log(`  row_seq: null=${rowSeqStats.nulls}, no-null=${rowSeqStats.non_nulls}`);
  const sample = db.prepare('SELECT * FROM contact_map WHERE customer_key = ? LIMIT 5').all(r.customer_key);
  console.log(`  muestra: ${JSON.stringify(sample)}`);
}

const totalContactMap = db.prepare('SELECT COUNT(*) AS n FROM contact_map').get().n;
const totalRowSeqNotNull = db.prepare('SELECT COUNT(*) AS n FROM contact_map WHERE row_seq IS NOT NULL').get().n;
console.log(`\n=== Totales globales ===`);
console.log(`  contact_map total: ${totalContactMap}`);
console.log(`  contact_map con row_seq no nulo: ${totalRowSeqNotNull}`);

db.close();
