import fs from 'fs';
import Database from 'better-sqlite3';
import { XMLParser } from 'fast-xml-parser';

const {
  SFMC_CLIENT_ID,
  SFMC_CLIENT_SECRET,
  SFMC_SUBDOMAIN,
  SFMC_PARENT_ACCOUNT_ID,
  SFMC_BUSINESS_UNIT_IDS,
  EXTRACT_PAGE_SIZE,
  EXTRACT_TIME_BUDGET_MINUTES, // corta el proceso ordenadamente antes de que lo mate el timeout del job
  EXTRACT_PAGE_CONCURRENCY, // páginas pedidas en paralelo dentro de una misma DE
  EXTRACT_DE_CONCURRENCY, // DEs procesadas en paralelo
} = process.env;

if (!SFMC_CLIENT_ID || !SFMC_CLIENT_SECRET || !SFMC_SUBDOMAIN) {
  console.error('Faltan variables de entorno: SFMC_CLIENT_ID, SFMC_CLIENT_SECRET, SFMC_SUBDOMAIN');
  process.exit(1);
}

const AUTH_URL = `https://${SFMC_SUBDOMAIN}.auth.marketingcloudapis.com/v2/token`;
const SOAP_URL = `https://${SFMC_SUBDOMAIN}.soap.marketingcloudapis.com/Service.asmx`;
const REST_BASE = `https://${SFMC_SUBDOMAIN}.rest.marketingcloudapis.com`;
const PAGE_SIZE = Number(EXTRACT_PAGE_SIZE) || 2500;
const TIME_BUDGET_MS = (Number(EXTRACT_TIME_BUDGET_MINUTES) || 320) * 60 * 1000;
const START_TIME = Date.now();
// El endpoint rowset acepta $page=N directo (no depende de la página
// anterior — de hecho ya se usaba así al resumir una DE a medio bajar),
// así que se pueden pedir varias páginas a la vez. Configurables por env
// para poder bajarlos si SFMC empieza a devolver 429.
const PAGE_CONCURRENCY = Number(EXTRACT_PAGE_CONCURRENCY) || 5;
const DE_CONCURRENCY = Number(EXTRACT_DE_CONCURRENCY) || 2;
const MAX_FETCH_ATTEMPTS = 6; // reintentos ante rate limit o cortes de red

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeIsUp() {
  return Date.now() - START_TIME > TIME_BUDGET_MS;
}

// --- Mismos patrones que count-data-extensions.js para no contar DEs de sistema ---
const SYSTEM_DE_PATTERNS = [
  /^_/,
  /_Salesforce$/,
  /^PI_/,
  /^IGO_/,
  /^Einstein_/,
  /^CloudPages_DataExtension$/,
  /^ExpressionBuilderAttributes$/,
  /^MobileLineOrphanContact$/,
];
function isSystemDE(name) {
  return SYSTEM_DE_PATTERNS.some((re) => re.test(name));
}

async function getTokenRaw(accountId) {
  const body = {
    grant_type: 'client_credentials',
    client_id: SFMC_CLIENT_ID,
    client_secret: SFMC_CLIENT_SECRET,
  };
  if (accountId) body.account_id = accountId;

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Auth falló para account_id=${accountId ?? '(default)'} (${res.status}): ${text}`);
  return JSON.parse(text);
}

// Los tokens de SFMC expiran a los ~20 minutos. Un manager por BU los renueva
// solo antes de vencer (y permite forzar renovación si el server igual
// devuelve "Token Expired"), en vez de pedir uno solo al principio y usarlo
// para docenas de DEs que pueden tardar más que eso en procesarse.
function createTokenManager(accountId) {
  let accessToken = null;
  let expiresAt = 0;
  let inFlight = null; // dedupe: con pedidos en paralelo, al vencer el token
  // todos entrarían a renovarlo a la vez y dispararían N auths innecesarias.
  return {
    async get() {
      if (accessToken && Date.now() < expiresAt - 120_000) return accessToken;
      if (!inFlight) {
        inFlight = getTokenRaw(accountId)
          .then(({ access_token, expires_in }) => {
            accessToken = access_token;
            expiresAt = Date.now() + (expires_in || 1200) * 1000;
            return accessToken;
          })
          .finally(() => {
            inFlight = null;
          });
      }
      return inFlight;
    },
    invalidate() {
      accessToken = null;
      expiresAt = 0;
    },
  };
}

function buildRetrieveXml({ token, objectType, properties, filterProperty, filterValue, continueId }) {
  if (continueId) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><fueloauth xmlns="http://exacttarget.com">${token}</fueloauth></soapenv:Header>
  <soapenv:Body>
    <ContinueRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <ContinueRequest>${continueId}</ContinueRequest>
    </ContinueRequestMsg>
  </soapenv:Body>
</soapenv:Envelope>`;
  }
  const propsXml = properties.map((p) => `<Properties>${p}</Properties>`).join('\n        ');
  const filterXml = filterProperty
    ? `<Filter xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="SimpleFilterPart">
          <Property>${filterProperty}</Property>
          <SimpleOperator>equals</SimpleOperator>
          <Value>${filterValue}</Value>
        </Filter>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><fueloauth xmlns="http://exacttarget.com">${token}</fueloauth></soapenv:Header>
  <soapenv:Body>
    <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <RetrieveRequest>
        <ObjectType>${objectType}</ObjectType>
        ${propsXml}
        ${filterXml}
      </RetrieveRequest>
    </RetrieveRequestMsg>
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function soapRequestOnce(token, { objectType, properties, filter, continueId }) {
  const xml = buildRetrieveXml({
    token,
    objectType,
    properties,
    filterProperty: filter?.property,
    filterValue: filter?.value,
    continueId,
  });
  const soapAction = continueId ? 'Continue' : 'Retrieve';

  const res = await fetch(SOAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', SOAPAction: soapAction },
    body: xml,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SOAP falló (${objectType}, ${res.status}): ${text}`);

  const parsed = parser.parse(text);
  const body = parsed.Envelope.Body;

  if (body.Fault) {
    const faultString = body.Fault.faultstring || JSON.stringify(body.Fault);
    const err = new Error(`SOAP Fault (${objectType}): ${faultString}`);
    err.isTokenExpired = /token expired/i.test(faultString);
    throw err;
  }

  return continueId ? body.ContinueResponseMsg : body.RetrieveResponseMsg;
}

async function soapRetrieveAll(tokenMgr, objectType, properties, filter = null) {
  let all = [];
  let continueId = null;
  let more = true;

  while (more) {
    let token = await tokenMgr.get();
    let msg;
    try {
      msg = await soapRequestOnce(token, { objectType, properties, filter, continueId });
    } catch (err) {
      if (err.isTokenExpired) {
        tokenMgr.invalidate();
        token = await tokenMgr.get();
        msg = await soapRequestOnce(token, { objectType, properties, filter, continueId });
      } else {
        throw err;
      }
    }

    let results = msg.Results || [];
    if (!Array.isArray(results)) results = [results];
    all = all.concat(results);

    if (msg.OverallStatus === 'MoreDataAvailable') {
      continueId = msg.RequestID;
    } else {
      more = false;
    }
  }
  return all;
}

async function listBusinessUnits(parentTokenMgr) {
  const results = await soapRetrieveAll(parentTokenMgr, 'BusinessUnit', ['ID', 'Name', 'ParentID', 'IsActive']);
  return results.map((r) => ({ id: r.ID, name: r.Name, parentId: r.ParentID, isActive: r.IsActive }));
}

async function listAllDataExtensions(buTokenMgr) {
  const results = await soapRetrieveAll(buTokenMgr, 'DataExtension', ['CustomerKey', 'Name', 'CategoryID']);
  return results.map((r) => ({ customerKey: r.CustomerKey, name: r.Name }));
}

// Detecta qué campo(s) de la DE sirven como identificador de contacto.
async function detectIdentifierFields(buTokenMgr, customerKey) {
  const results = await soapRetrieveAll(
    buTokenMgr,
    'DataExtensionField',
    ['Name', 'FieldType', 'IsPrimaryKey'],
    { property: 'DataExtension.CustomerKey', value: customerKey }
  );
  const fieldList = (Array.isArray(results) ? results : [results]).filter(Boolean);

  // Nombres reales vistos en la cuenta: vienen con prefijo/sufijo de sync
  // con Salesforce (PersonEmail, DNI__c, Otro_documento__c), no solo
  // "Email"/"DNI" a secas — por eso se busca la palabra en cualquier parte
  // del nombre. El FieldType filtra los que no pueden ser un identificador
  // real (Boolean, Date, Decimal, Number) — así se descartan flags como
  // PersonHasOptedOutOfEmail (Boolean) sin depender de una lista de
  // palabras prohibidas. "Tipo_DNI__c" (categoría "DNI"/"Pasaporte", no un
  // número de documento) se excluye por nombre porque igual es tipo Text.
  const NON_IDENTIFIER_TYPES = /^(boolean|date|decimal|number)$/i;
  const NOT_AN_IDENTIFIER_NAME = /^tipo|tipo.?doc|tipo.?dni|bounce|reason|optout|prefer|consent|unsub|score/i;
  const idFields = [];
  for (const f of fieldList) {
    const name = f.Name;
    if (NON_IDENTIFIER_TYPES.test(f.FieldType)) continue;
    if (NOT_AN_IDENTIFIER_NAME.test(name)) continue;
    // ContactKey / SubscriberKey son EL identificador de contacto de SFMC,
    // pero su nombre no dice qué guardan: en esta cuenta la Clave del
    // Suscriptor es el DNI (así lo declara la ficha de BaseMaestra_Ecommerce:
    // "DNI__c se refiere al suscriptor de Clave del suscriptor"), en otras es
    // el email. En vez de suponerlo, se marcan como 'auto' y el tipo se
    // deduce del valor real fila por fila (ver classifyKeyValue).
    if (/subscriber.?key|contact.?key/i.test(name)) idFields.push({ name, type: 'auto' });
    else if (/dni|documento|nro.?doc|numero.?doc/i.test(name)) idFields.push({ name, type: 'dni' });
    else if (/email|correo|^mail$/i.test(name)) idFields.push({ name, type: 'email' });
  }
  return idFields;
}

// Para los campos 'auto' (ContactKey/SubscriberKey): clasifica según lo que
// realmente trae el valor, así cruza con las demás DEs en vez de quedar
// aislado en un tipo propio.
//  - con "@"                  -> email
//  - 7 u 8 dígitos            -> dni (formato de documento argentino)
//  - cualquier otra cosa      -> subscriberkey (GUID, id interno, etc.)
// El rango 7-8 es a propósito: evita tomar por DNI a ids numéricos largos.
function classifyKeyValue(raw) {
  const value = String(raw).trim();
  if (value.includes('@')) return { type: 'email', norm: value.toLowerCase() };
  const digits = value.replace(/\D/g, '');
  if (digits.length >= 7 && digits.length <= 8 && /^[\d.\-\s]+$/.test(value)) {
    return { type: 'dni', norm: digits };
  }
  return { type: 'subscriberkey', norm: value };
}

async function fetchRowsetPage(buTokenMgr, customerKey, page, attempt = 0) {
  const url = `${REST_BASE}/data/v1/customobjectdata/key/${encodeURIComponent(
    customerKey
  )}/rowset?$pageSize=${PAGE_SIZE}&$page=${page}`;
  try {
    let token = await buTokenMgr.get();
    let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      buTokenMgr.invalidate();
      token = await buTokenMgr.get();
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      // 4xx (salvo 429) son definitivos: reintentar no cambia nada.
      err.noRetry = res.status < 500 && res.status !== 429;
      throw err;
    }
    return await res.json();
  } catch (err) {
    // Los cortes de red ("fetch failed", ECONNRESET, socket hang up) NO son
    // un status HTTP: llegan como excepción. Al pedir varias páginas en
    // paralelo aparecen seguido, y sin este catch se propagaban por el
    // Promise.all y mataban la DE entera (pasó en la corrida #7: 7 DEs
    // perdidas, entre ellas BaseMaestra_Ecommerce en la página 41).
    if (!err.noRetry && attempt < MAX_FETCH_ATTEMPTS) {
      await sleep(1000 * 2 ** attempt);
      return fetchRowsetPage(buTokenMgr, customerKey, page, attempt + 1);
    }
    throw err;
  }
}

function openDb() {
  const db = new Database('contacts.db');
  db.pragma('journal_mode = WAL');
  // Con WAL + synchronous=NORMAL se deja de hacer fsync en cada commit (el
  // cuello de botella real: ~980 inserts/seg medidos en la corrida #6).
  // El riesgo que queda es perder los últimos commits ante un corte de luz
  // del runner, no ante una caída del proceso — y en ese caso simplemente
  // se vuelve a extraer esa DE.
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -200000'); // ~200 MB de caché de páginas
  db.pragma('temp_store = MEMORY');
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_map (
      identifier TEXT NOT NULL,
      id_type TEXT NOT NULL,
      bu_id TEXT NOT NULL,
      bu_name TEXT NOT NULL,
      de_name TEXT NOT NULL,
      customer_key TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_map_identifier ON contact_map(identifier, id_type);
    CREATE INDEX IF NOT EXISTS idx_contact_map_de ON contact_map(customer_key);

    CREATE TABLE IF NOT EXISTS de_progress (
      customer_key TEXT PRIMARY KEY,
      bu_id TEXT,
      bu_name TEXT,
      de_name TEXT,
      id_fields TEXT,
      last_page_done INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
    );
  `);

  // row_seq identifica de qué fila de origen salió cada identificador, para
  // poder enlazar "DNI y Email de la misma persona" cuando una DE tiene
  // ambos campos en la misma fila (ej. las maestras). Migración manual
  // porque las bases viejas no tienen esta columna todavía.
  const cols = db.prepare('PRAGMA table_info(contact_map)').all();
  if (!cols.some((c) => c.name === 'row_seq')) {
    db.exec('ALTER TABLE contact_map ADD COLUMN row_seq INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS idx_contact_map_row ON contact_map(customer_key, row_seq)');
  }
  return db;
}

async function main() {
  const db = openDb();
  const upsertProgress = db.prepare(`
    INSERT INTO de_progress (customer_key, bu_id, bu_name, de_name, id_fields, last_page_done, status)
    VALUES (@customer_key, @bu_id, @bu_name, @de_name, @id_fields, @last_page_done, @status)
    ON CONFLICT(customer_key) DO UPDATE SET
      id_fields = excluded.id_fields,
      last_page_done = excluded.last_page_done,
      status = excluded.status
  `);
  const getProgress = db.prepare('SELECT * FROM de_progress WHERE customer_key = ?');
  const insertRow = db.prepare(`
    INSERT INTO contact_map (identifier, id_type, bu_id, bu_name, de_name, customer_key, row_seq)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertManyRows = db.transaction((rows) => {
    for (const r of rows) insertRow.run(r.identifier, r.id_type, r.bu_id, r.bu_name, r.de_name, r.customer_key, r.row_seq);
  });
  const deleteDeRows = db.prepare('DELETE FROM contact_map WHERE customer_key = ?');

  // Re-evaluar con el patrón de detección actual las DEs que quedaron "skipped"
  // por no tener campo detectable en una corrida anterior (ej. antes de sumar DNI).
  const resetSkipped = db
    .prepare("UPDATE de_progress SET status = 'pending', id_fields = NULL WHERE status = 'skipped' AND id_fields = '[]'")
    .run();
  if (resetSkipped.changes > 0) {
    console.log(`Re-evaluando ${resetSkipped.changes} DE(s) que habían quedado sin identificador con el patrón anterior.`);
  }

  console.log('Autenticando en el nivel Enterprise/Parent...');
  const parentTokenMgr = createTokenManager(SFMC_PARENT_ACCOUNT_ID);
  await parentTokenMgr.get();

  console.log('Listando Business Units...');
  let businessUnits = await listBusinessUnits(parentTokenMgr);
  if (SFMC_BUSINESS_UNIT_IDS) {
    const allowed = new Set(SFMC_BUSINESS_UNIT_IDS.split(',').map((s) => s.trim()));
    businessUnits = businessUnits.filter((bu) => allowed.has(String(bu.id)));
  }

  let stoppedEarly = false;
  // Fase 1 (secuencial y rápida): decidir qué DEs hay que extraer y con qué
  // campos. Fase 2 (abajo): bajarlas en paralelo. Separarlo evita que las
  // decisiones de estado (que escriben en SQLite) se pisen entre workers.
  const workQueue = [];

  outer: for (const bu of businessUnits) {
    console.log(`\n--- BU: ${bu.name} (MID ${bu.id}) ---`);
    const buTokenMgr = createTokenManager(bu.id);
    try {
      await buTokenMgr.get();
    } catch (err) {
      console.log(`  No se pudo autenticar contra esta BU: ${err.message}`);
      continue;
    }

    let des;
    try {
      des = await listAllDataExtensions(buTokenMgr);
    } catch (err) {
      console.log(`  Error listando DEs: ${err.message}`);
      continue;
    }
    const contactDEs = des.filter((de) => !isSystemDE(de.name));
    console.log(`  ${contactDEs.length} DEs de contacto (de ${des.length} totales) para procesar.`);

    for (const de of contactDEs) {
      if (timeIsUp()) {
        console.log('\nSe acabó el presupuesto de tiempo de esta corrida. Cortando ordenadamente — correr el workflow de nuevo para continuar donde quedó.');
        stoppedEarly = true;
        break outer;
      }

      let prog = getProgress.get(de.customerKey);
      if (prog && prog.status === 'done') {
        // El patrón de detección de campos cambia entre corridas (ej. se
        // amplió para reconocer "DNI__c"/"PersonEmail"). Un solo Retrieve
        // de metadata es barato — vale la pena re-chequear antes de dar
        // por buena una extracción vieja que pudo haberse quedado corta.
        let freshFields;
        try {
          freshFields = await detectIdentifierFields(buTokenMgr, de.customerKey);
        } catch (err) {
          console.log(`  [skip] ${de.name}: ya procesada (no se pudo re-chequear campos: ${err.message}).`);
          continue;
        }
        const storedNames = new Set(JSON.parse(prog.id_fields || '[]').map((f) => f.name));
        const newFields = freshFields.filter((f) => !storedNames.has(f.name));
        if (newFields.length === 0) {
          console.log(`  [skip] ${de.name}: ya procesada en una corrida anterior.`);
          continue;
        }
        console.log(
          `  [re-proceso] ${de.name}: patrón nuevo encontró campo(s) adicional(es) (${newFields
            .map((f) => `${f.name}(${f.type})`)
            .join(', ')}), se vuelve a extraer completa.`
        );
        deleteDeRows.run(de.customerKey);
        upsertProgress.run({
          customer_key: de.customerKey,
          bu_id: String(bu.id),
          bu_name: bu.name,
          de_name: de.name,
          id_fields: JSON.stringify(freshFields),
          last_page_done: 0,
          status: 'in_progress',
        });
        prog = getProgress.get(de.customerKey);
      }
      if (prog && prog.status === 'skipped') {
        // Igual que con 'done': re-chequear siempre contra el patrón actual
        // en vez de confiar en el flag guardado. Por el bug viejo de
        // upsertProgress (ya corregido) varias DEs quedaron con id_fields
        // en NULL en vez de '[]', así que el reset automático basado en
        // ese valor no las agarraba — esto las re-evalúa sin depender de
        // en qué estado haya quedado esa columna históricamente.
        let freshFields;
        try {
          freshFields = await detectIdentifierFields(buTokenMgr, de.customerKey);
        } catch (err) {
          console.log(`  [skip] ${de.name}: sin campo identificador (no se pudo re-chequear: ${err.message}).`);
          continue;
        }
        if (freshFields.length === 0) {
          console.log(`  [skip] ${de.name}: sin campo identificador, marcada como skip.`);
          upsertProgress.run({
            customer_key: de.customerKey,
            bu_id: String(bu.id),
            bu_name: bu.name,
            de_name: de.name,
            id_fields: '[]',
            last_page_done: 0,
            status: 'skipped',
          });
          continue;
        }
        console.log(
          `  [re-proceso] ${de.name}: patrón nuevo encontró campo(s) (${freshFields
            .map((f) => `${f.name}(${f.type})`)
            .join(', ')}), estaba en skip.`
        );
        upsertProgress.run({
          customer_key: de.customerKey,
          bu_id: String(bu.id),
          bu_name: bu.name,
          de_name: de.name,
          id_fields: JSON.stringify(freshFields),
          last_page_done: 0,
          status: 'in_progress',
        });
        prog = getProgress.get(de.customerKey);
      }

      let idFields;
      if (prog && prog.id_fields) {
        idFields = JSON.parse(prog.id_fields);
      } else {
        try {
          idFields = await detectIdentifierFields(buTokenMgr, de.customerKey);
        } catch (err) {
          console.log(`  [error] ${de.name}: no se pudieron leer los campos (${err.message})`);
          continue;
        }
        if (idFields.length === 0) {
          console.log(`  [skip] ${de.name}: no tiene campo SubscriberKey ni Email detectable.`);
          upsertProgress.run({
            customer_key: de.customerKey,
            bu_id: String(bu.id),
            bu_name: bu.name,
            de_name: de.name,
            id_fields: '[]',
            last_page_done: 0,
            status: 'skipped',
          });
          continue;
        }
        upsertProgress.run({
          customer_key: de.customerKey,
          bu_id: String(bu.id),
          bu_name: bu.name,
          de_name: de.name,
          id_fields: JSON.stringify(idFields),
          last_page_done: 0,
          status: 'in_progress',
        });
        prog = getProgress.get(de.customerKey);
      }

      const startPage = (prog.last_page_done || 0) + 1;
      workQueue.push({ bu, buTokenMgr, de, idFields, startPage });
    }
  }

  // --- Fase 2: extracción propiamente dicha, en paralelo ---
  // Convierte cada fila del rowset en las filas de contact_map que le
  // corresponden (una por campo identificador con valor).
  function rowsFromItems(items, page, bu, de, idFields) {
    const rows = [];
    items.forEach((item, idx) => {
      // Estable entre corridas (no depende del orden de llegada de esta
      // ejecución puntual): misma página + misma posición en la página
      // siempre da el mismo row_seq para esta DE.
      const rowSeq = (page - 1) * PAGE_SIZE + idx;
      const flat = { ...(item.keys || {}), ...(item.values || {}) };
      // El rowset REST devuelve las claves en minúsculas para las DEs
      // sincronizadas desde Salesforce (ej. "dni__c"), mientras que la
      // metadata SOAP (DataExtensionField, usada para detectar idFields)
      // preserva el casing real (ej. "DNI__c"). El lookup directo por
      // nombre fallaba en silencio para esas DEs — nunca tiraba error,
      // simplemente no encontraba el valor y saltaba la fila entera,
      // dejando la DE en 0 filas pese a procesar todas las páginas igual.
      const flatLower = {};
      for (const k in flat) flatLower[k.toLowerCase()] = flat[k];
      for (const f of idFields) {
        const rawVal = flat[f.name] !== undefined ? flat[f.name] : flatLower[f.name.toLowerCase()];
        if (rawVal === undefined || rawVal === null || String(rawVal).trim() === '') continue;
        let norm = String(rawVal).trim();
        let type = f.type;
        if (type === 'auto') {
          // ContactKey/SubscriberKey: el tipo sale del valor, no del nombre.
          ({ type, norm } = classifyKeyValue(rawVal));
        } else if (type === 'email') norm = norm.toLowerCase();
        else if (type === 'dni') norm = norm.replace(/\D/g, ''); // saca puntos/guiones para que "12.345.678" y "12345678" matcheen
        if (norm === '') continue;
        rows.push({
          identifier: norm,
          id_type: type,
          bu_id: String(bu.id),
          bu_name: bu.name,
          de_name: de.name,
          customer_key: de.customerKey,
          row_seq: rowSeq,
        });
      }
    });
    return rows;
  }

  async function processDE({ bu, buTokenMgr, de, idFields, startPage }) {
    console.log(
      `  [${startPage === 1 ? 'inicio' : 'resume pág ' + startPage}] ${de.name} — identificador(es): ${idFields
        .map((f) => `${f.name}(${f.type})`)
        .join(', ')}`
    );

    let page = startPage;
    let done = false;
    let failed = false;
    let itemsSeenTotal = 0;
    let rowsInsertedTotal = 0;
    let lastLoggedPage = startPage;
    const typeCounts = {}; // para poder verificar en el log cómo se clasificó
    // lo que traía un campo 'auto' (ContactKey), en vez de darlo por supuesto

    while (!done && !failed) {
      if (timeIsUp()) {
        console.log(`    ${de.name}: se acabó el presupuesto de tiempo (quedó en la página ${page - 1}).`);
        stoppedEarly = true;
        return;
      }

      // Se piden PAGE_CONCURRENCY páginas a la vez. El checkpoint sólo
      // avanza hasta la última página consecutiva confirmada del lote, así
      // que un corte a mitad de lote reanuda sin saltearse nada.
      const batch = [];
      for (let i = 0; i < PAGE_CONCURRENCY; i++) batch.push(page + i);

      let results;
      try {
        results = await Promise.all(
          batch.map((p) => fetchRowsetPage(buTokenMgr, de.customerKey, p).then((data) => ({ page: p, data })))
        );
      } catch (err) {
        console.log(`    ${de.name} — página ~${page}: ERROR ${err.message} — se marca la DE como error y se sigue con la próxima.`);
        upsertProgress.run({
          customer_key: de.customerKey,
          bu_id: String(bu.id),
          bu_name: bu.name,
          de_name: de.name,
          id_fields: JSON.stringify(idFields),
          last_page_done: page - 1,
          status: 'error',
        });
        failed = true;
        break;
      }

      results.sort((a, b) => a.page - b.page);
      const rowsToInsert = [];
      let lastGoodPage = page - 1;
      for (const { page: p, data } of results) {
        const items = data.items || [];
        if (items.length === 0) {
          done = true;
          break; // no hay más datos: las páginas siguientes del lote tampoco tienen
        }
        rowsToInsert.push(...rowsFromItems(items, p, bu, de, idFields));
        itemsSeenTotal += items.length;
        lastGoodPage = p;
        if (items.length < PAGE_SIZE) {
          done = true;
          break; // última página parcial
        }
      }

      if (rowsToInsert.length > 0) insertManyRows(rowsToInsert);
      rowsInsertedTotal += rowsToInsert.length;
      for (const r of rowsToInsert) typeCounts[r.id_type] = (typeCounts[r.id_type] || 0) + 1;

      if (lastGoodPage >= page) {
        upsertProgress.run({
          customer_key: de.customerKey,
          bu_id: String(bu.id),
          bu_name: bu.name,
          de_name: de.name,
          id_fields: JSON.stringify(idFields),
          last_page_done: lastGoodPage,
          status: 'in_progress',
        });
        page = lastGoodPage + 1;
      }

      if (!done && page - lastLoggedPage >= 200) {
        console.log(`    ${de.name}: ${page - 1} páginas, ${rowsInsertedTotal} identificadores...`);
        lastLoggedPage = page;
      }
    }

    if (done) {
      upsertProgress.run({
        customer_key: de.customerKey,
        bu_id: String(bu.id),
        bu_name: bu.name,
        de_name: de.name,
        id_fields: JSON.stringify(idFields),
        last_page_done: page - 1,
        status: 'done',
      });
      if (itemsSeenTotal > 0 && rowsInsertedTotal === 0) {
        console.log(
          `    ⚠️  ${de.name}: listo (${page - 1} página(s), ${itemsSeenTotal} fila(s) de origen vistas) pero 0 identificadores insertados — los nombres de campo esperados (${idFields
            .map((f) => f.name)
            .join(', ')}) probablemente no matchean las claves reales del rowset. Revisar con inspect-rowset-sample.js.`
        );
      } else {
        const desglose = Object.entries(typeCounts)
          .map(([t, n]) => `${n} ${t}`)
          .join(', ');
        console.log(
          `    listo: ${de.name} (${page - 1} página(s), ${itemsSeenTotal} filas de origen, ${rowsInsertedTotal} identificador(es): ${desglose}).`
        );
      }
    }
  }

  if (workQueue.length > 0) {
    console.log(
      `\n=== Extrayendo ${workQueue.length} DE(s): ${DE_CONCURRENCY} en paralelo, ${PAGE_CONCURRENCY} páginas a la vez cada una ===`
    );
    let next = 0;
    const workers = [];
    for (let i = 0; i < Math.min(DE_CONCURRENCY, workQueue.length); i++) {
      workers.push(
        (async () => {
          while (next < workQueue.length && !timeIsUp()) {
            const item = workQueue[next++];
            await processDE(item);
          }
        })()
      );
    }
    await Promise.all(workers);
    if (next < workQueue.length) stoppedEarly = true;
  }

  db.close();

  if (stoppedEarly) {
    console.log('\n=== Corrida incompleta: quedaron DEs pendientes. Volvé a correr el workflow para continuar. ===');
  } else {
    console.log('\n=== Extracción completa. Ya se puede correr report-duplicates.js ===');
  }
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
