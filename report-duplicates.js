import fs from 'fs';
import Database from 'better-sqlite3';

const db = new Database('contacts.db');

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

// Escribe el CSV incrementalmente. Antes se armaba el archivo entero como un
// solo string y con estos volúmenes (millones de filas) reventaba con
// "RangeError: Invalid string length" al superar el máximo de V8. El buffer
// acotado mantiene el uso de memoria plano sin importar cuántas filas haya.
function createCsvWriter(path, header) {
  const fd = fs.openSync(path, 'w');
  let buf = header + '\n';
  let count = 0;
  return {
    write(line) {
      buf += line + '\n';
      count++;
      if (buf.length > 4 * 1024 * 1024) {
        fs.writeSync(fd, buf);
        buf = '';
      }
    },
    close() {
      if (buf) fs.writeSync(fd, buf);
      fs.closeSync(fd);
      return count;
    },
  };
}

function writeDuplicatesCsv() {
  // .iterate() en vez de .all(): la consulta puede devolver millones de filas
  // y cargarlas todas en un array las duplica en memoria al pedo.
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
    .iterate();

  const detailStmt = db.prepare(
    `SELECT DISTINCT bu_name, de_name FROM contact_map WHERE identifier = ? AND id_type = ?`
  );

  const csv = createCsvWriter('contacts-duplicados.csv', 'Identificador,Tipo,EnCuantasDEs,TotalFilas,UnidadesYDEs');
  for (const d of dupIdentifiers) {
    const locations = detailStmt
      .all(d.identifier, d.id_type)
      .map((r) => `${r.bu_name} / ${r.de_name}`)
      .join(' | ');
    csv.write(
      `${csvEscape(d.identifier)},${csvEscape(d.id_type)},${d.de_count},${d.row_count},${csvEscape(locations)}`
    );
  }
  const n = csv.close();
  console.log(`\ncontacts-duplicados.csv generado: ${n} identificadores repetidos en más de una DE.`);
  return n;
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
    .iterate();

  const csv = createCsvWriter(
    'contacts-resumen-por-de.csv',
    'UnidadComercial,NombreDE,TipoIdentificador,FilasExtraidas,IdentificadoresUnicosEnEstaDE'
  );
  for (const r of perDe) {
    csv.write(
      `${csvEscape(r.bu_name)},${csvEscape(r.de_name)},${csvEscape(r.id_type)},${r.filas_extraidas},${r.identificadores_unicos}`
    );
  }
  const n = csv.close();
  console.log(`contacts-resumen-por-de.csv generado (${n} filas DE x tipo de identificador).`);
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

// Resuelve identidad real cruzando tipos de identificador: si una misma
// fila de origen tiene DNI y Email juntos (típico en las bases maestras),
// se los enlaza como la misma persona vía Union-Find. Así el cruce de
// duplicados deja de estar limitado a "DNI contra DNI" / "Email contra
// Email" y puede ver a alguien que está en una base maestra (DNI) y
// también en una campaña chica (Email), sin necesitar una DE puente
// explícita.
function resolveIdentitiesAcrossTypes() {
  console.log('\n=== Resolviendo identidad real (cruzando DNI+Email cuando conviven en la misma fila) ===');

  db.exec(`
    CREATE TABLE IF NOT EXISTS identity_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      id_type TEXT NOT NULL,
      identifier TEXT NOT NULL,
      root_id INTEGER,
      UNIQUE(id_type, identifier)
    );
  `);
  db.exec('DELETE FROM identity_nodes');
  db.exec('INSERT INTO identity_nodes (id_type, identifier) SELECT DISTINCT id_type, identifier FROM contact_map');

  const nodeCount = db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM identity_nodes').get().maxId;
  if (nodeCount === 0) {
    console.log('  No hay identificadores para resolver todavía.');
    return;
  }
  const parent = new Int32Array(nodeCount + 1);
  const rank = new Uint8Array(nodeCount + 1);
  for (let i = 0; i <= nodeCount; i++) parent[i] = i;

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) parent[ra] = rb;
    else if (rank[ra] > rank[rb]) parent[rb] = ra;
    else {
      parent[rb] = ra;
      rank[ra]++;
    }
  }

  const rowStmt = db.prepare(`
    SELECT n.id AS node_id, cm.customer_key, cm.row_seq
    FROM contact_map cm
    JOIN identity_nodes n ON cm.id_type = n.id_type AND cm.identifier = n.identifier
    WHERE cm.row_seq IS NOT NULL
    ORDER BY cm.customer_key, cm.row_seq
  `);

  let curKey = null;
  let curSeq = null;
  let group = [];
  let rowsSeen = 0;
  let groupsUnited = 0;
  const flushGroup = () => {
    if (group.length > 1) {
      for (let i = 1; i < group.length; i++) union(group[0], group[i]);
      groupsUnited++;
    }
    group = [];
  };
  for (const row of rowStmt.iterate()) {
    if (row.customer_key !== curKey || row.row_seq !== curSeq) {
      flushGroup();
      curKey = row.customer_key;
      curSeq = row.row_seq;
    }
    group.push(row.node_id);
    rowsSeen++;
  }
  flushGroup();
  console.log(`  ${rowsSeen} filas con row_seq analizadas, ${groupsUnited} fila(s) de origen con más de un tipo de identificador enlazadas.`);

  const updateRoot = db.prepare('UPDATE identity_nodes SET root_id = ? WHERE id = ?');
  db.transaction(() => {
    for (let i = 1; i <= nodeCount; i++) updateRoot.run(find(i), i);
  })();
  db.exec('CREATE INDEX IF NOT EXISTS idx_identity_nodes_root ON identity_nodes(root_id)');

  const totalPersonas = db.prepare('SELECT COUNT(DISTINCT root_id) AS n FROM identity_nodes').get().n;
  console.log(`  Personas únicas resueltas (contando DNI+Email de la misma fila como una sola): ${totalPersonas}`);

  // Se recorre en streaming y se escribe al vuelo: esta consulta puede
  // devolver millones de personas y cargarlas en un array (más el string del
  // CSV entero) era justamente lo que reventaba la memoria.
  const overlapping = db
    .prepare(
      `
    SELECT n.root_id AS root_id, COUNT(DISTINCT cm.customer_key) AS de_count, COUNT(*) AS row_count
    FROM contact_map cm
    JOIN identity_nodes n ON cm.id_type = n.id_type AND cm.identifier = n.identifier
    GROUP BY n.root_id
    HAVING de_count > 1
    ORDER BY de_count DESC, row_count DESC
  `
    )
    .iterate();

  const csv = createCsvWriter('contacts-personas-duplicadas.csv', 'RootId,EnCuantasDEs,TotalFilas');
  const top = []; // el ranking se arma sobre la marcha, acotado a 25
  for (const r of overlapping) {
    csv.write(`${r.root_id},${r.de_count},${r.row_count}`);
    if (top.length < 25) top.push(r);
  }
  const totalOverlapping = csv.close();
  console.log(`  Personas presentes en más de una DE (cruce real, no solo por tipo): ${totalOverlapping}`);
  console.log(`  contacts-personas-duplicadas.csv generado (${totalOverlapping} personas).`);

  const desOfRoot = db.prepare(`
    SELECT DISTINCT cm.bu_name, cm.de_name
    FROM contact_map cm
    JOIN identity_nodes n ON cm.id_type = n.id_type AND cm.identifier = n.identifier
    WHERE n.root_id = ?
  `);
  console.log('\n  Top 25 personas presentes en más DEs distintas (cruce real):');
  for (const r of top) {
    const des = desOfRoot.all(r.root_id).map((d) => `[${d.bu_name}] ${d.de_name}`);
    console.log(`    en ${r.de_count} DEs (${r.row_count} filas): ${des.join(', ')}`);
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
resolveIdentitiesAcrossTypes();
db.close();
