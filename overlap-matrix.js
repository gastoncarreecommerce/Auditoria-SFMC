import Database from 'better-sqlite3';

const db = new Database('contacts.db');

// Las DEs "maestras" que concentran casi toda la duplicación según el
// reporte general. Se puede pisar la lista pasando OVERLAP_DE_NAMES
// separado por "|" para probar otro grupo sin tocar el código.
const DEFAULT_NAMES = [
  'BaseMadre_Marketing',
  'DE_Account',
  'BaseMaestra_Ecommerce',
  'Base Maestra NUEVA',
  'Base Maestra - BSAS y CABA',
  'Base Maestra Marketing - Sin Empleados',
];
const targetNames = (process.env.OVERLAP_DE_NAMES || '').trim()
  ? process.env.OVERLAP_DE_NAMES.split('|').map((s) => s.trim())
  : DEFAULT_NAMES;

// --- Resolución de identidad (misma lógica que report-duplicates.js) ---
// No se persiste en la caché de la Action (el cache/save corre ANTES de
// report-duplicates.js), así que hay que recalcularla acá. Sobre los ~39M
// de filas tarda unos minutos — se corre una sola vez y se reusa para
// todos los pares.
function resolveIdentities() {
  console.log('Resolviendo identidad real (cruzando DNI+Email por fila)...');
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
  const flushGroup = () => {
    if (group.length > 1) for (let i = 1; i < group.length; i++) union(group[0], group[i]);
    group = [];
  };
  for (const row of rowStmt.iterate()) {
    if (row.customer_key !== curKey || row.row_seq !== curSeq) {
      flushGroup();
      curKey = row.customer_key;
      curSeq = row.row_seq;
    }
    group.push(row.node_id);
  }
  flushGroup();

  const updateRoot = db.prepare('UPDATE identity_nodes SET root_id = ? WHERE id = ?');
  db.transaction(() => {
    for (let i = 1; i <= nodeCount; i++) updateRoot.run(find(i), i);
  })();
  db.exec('CREATE INDEX IF NOT EXISTS idx_identity_nodes_root ON identity_nodes(root_id)');
  console.log('  listo.\n');
}

function main() {
  resolveIdentities();

  const findDe = db.prepare('SELECT customer_key, de_name FROM de_progress WHERE de_name = ?');
  const targets = [];
  for (const name of targetNames) {
    const row = findDe.get(name);
    if (!row) {
      console.log(`  ⚠️  No se encontró la DE "${name}" en de_progress — se omite.`);
      continue;
    }
    targets.push(row);
  }
  if (targets.length < 2) {
    console.error('Hacen falta al menos 2 DEs válidas para armar la matriz.');
    process.exit(1);
  }

  // Un set de personas (root_id) por DE, para poder cruzarlas en memoria en
  // vez de re-consultar la base por cada uno de los N² pares.
  const personSetStmt = db.prepare(`
    SELECT DISTINCT n.root_id AS root_id
    FROM contact_map cm
    JOIN identity_nodes n ON cm.id_type = n.id_type AND cm.identifier = n.identifier
    WHERE cm.customer_key = ?
  `);
  const personSets = new Map();
  for (const t of targets) {
    const set = new Set(personSetStmt.all(t.customer_key).map((r) => r.root_id));
    personSets.set(t.customer_key, set);
    console.log(`${t.de_name}: ${set.size} personas únicas`);
  }

  console.log('\n=== Matriz de solapamiento (% de la fila que también está en la columna) ===');
  const shortNames = targets.map((t) => t.de_name.slice(0, 18));
  console.log('  '.padEnd(30) + shortNames.map((n) => n.padStart(20)).join(''));
  for (const a of targets) {
    const setA = personSets.get(a.customer_key);
    let line = a.de_name.padEnd(30);
    for (const b of targets) {
      if (a.customer_key === b.customer_key) {
        line += '—'.padStart(20);
        continue;
      }
      const setB = personSets.get(b.customer_key);
      let shared = 0;
      for (const p of setA) if (setB.has(p)) shared++;
      const pct = setA.size > 0 ? ((shared / setA.size) * 100).toFixed(1) : '0.0';
      line += `${pct}%`.padStart(20);
    }
    console.log(line);
  }
  console.log(
    '\nLectura: cada celda es "% de las personas de la FILA que también están en la COLUMNA". No es simétrica: si A tiene 1M de personas y B tiene 5M, "A en B" puede ser 95% mientras "B en A" es 19%.'
  );

  db.close();
}

main();
