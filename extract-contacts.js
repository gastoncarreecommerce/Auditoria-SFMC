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
  return {
    async get() {
      if (!accessToken || Date.now() > expiresAt - 120_000) {
        const { access_token, expires_in } = await getTokenRaw(accountId);
        accessToken = access_token;
        expiresAt = Date.now() + (expires_in || 1200) * 1000;
      }
      return accessToken;
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
  const fields = (Array.isArray(results) ? results : [results]).filter(Boolean).map((f) => f.Name);

  const idFields = [];
  for (const name of fields) {
    if (/subscriber.?key/i.test(name)) idFields.push({ name, type: 'subscriberkey' });
    else if (/^email$|email.?address|^correo|^mail$/i.test(name)) idFields.push({ name, type: 'email' });
  }
  return idFields;
}

async function fetchRowsetPage(buTokenMgr, customerKey, page) {
  const url = `${REST_BASE}/data/v1/customobjectdata/key/${encodeURIComponent(
    customerKey
  )}/rowset?$pageSize=${PAGE_SIZE}&$page=${page}`;
  let token = await buTokenMgr.get();
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    buTokenMgr.invalidate();
    token = await buTokenMgr.get();
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function openDb() {
  const db = new Database('contacts.db');
  db.pragma('journal_mode = WAL');
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
  return db;
}

async function main() {
  const db = openDb();
  const upsertProgress = db.prepare(`
    INSERT INTO de_progress (customer_key, bu_id, bu_name, de_name, id_fields, last_page_done, status)
    VALUES (@customer_key, @bu_id, @bu_name, @de_name, @id_fields, @last_page_done, @status)
    ON CONFLICT(customer_key) DO UPDATE SET
      last_page_done = excluded.last_page_done,
      status = excluded.status
  `);
  const getProgress = db.prepare('SELECT * FROM de_progress WHERE customer_key = ?');
  const insertRow = db.prepare(`
    INSERT INTO contact_map (identifier, id_type, bu_id, bu_name, de_name, customer_key)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertManyRows = db.transaction((rows) => {
    for (const r of rows) insertRow.run(r.identifier, r.id_type, r.bu_id, r.bu_name, r.de_name, r.customer_key);
  });
  const deleteDeRows = db.prepare('DELETE FROM contact_map WHERE customer_key = ?');

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
        console.log(`  [skip] ${de.name}: ya procesada en una corrida anterior.`);
        continue;
      }
      if (prog && prog.status === 'skipped') {
        console.log(`  [skip] ${de.name}: sin campo identificador, marcada como skip.`);
        continue;
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
      console.log(
        `  [${startPage === 1 ? 'inicio' : 'resume pág ' + startPage}] ${de.name} — identificador(es): ${idFields
          .map((f) => `${f.name}(${f.type})`)
          .join(', ')}`
      );

      let page = startPage;
      let done = false;
      while (!done) {
        if (timeIsUp()) {
          console.log('\nSe acabó el presupuesto de tiempo de esta corrida a mitad de una DE. Cortando ordenadamente.');
          stoppedEarly = true;
          break outer;
        }
        let data;
        try {
          data = await fetchRowsetPage(buTokenMgr, de.customerKey, page);
        } catch (err) {
          console.log(`    página ${page}: ERROR ${err.message} — se marca la DE como error y se sigue con la próxima.`);
          upsertProgress.run({
            customer_key: de.customerKey,
            bu_id: String(bu.id),
            bu_name: bu.name,
            de_name: de.name,
            id_fields: JSON.stringify(idFields),
            last_page_done: page - 1,
            status: 'error',
          });
          break;
        }

        const items = data.items || [];
        if (items.length === 0) {
          done = true;
          break;
        }

        const rowsToInsert = [];
        for (const item of items) {
          const flat = { ...(item.keys || {}), ...(item.values || {}) };
          for (const f of idFields) {
            const rawVal = flat[f.name];
            if (rawVal === undefined || rawVal === null || String(rawVal).trim() === '') continue;
            const norm = f.type === 'email' ? String(rawVal).trim().toLowerCase() : String(rawVal).trim();
            rowsToInsert.push({
              identifier: norm,
              id_type: f.type,
              bu_id: String(bu.id),
              bu_name: bu.name,
              de_name: de.name,
              customer_key: de.customerKey,
            });
          }
        }
        insertManyRows(rowsToInsert);

        upsertProgress.run({
          customer_key: de.customerKey,
          bu_id: String(bu.id),
          bu_name: bu.name,
          de_name: de.name,
          id_fields: JSON.stringify(idFields),
          last_page_done: page,
          status: 'in_progress',
        });

        if (items.length < PAGE_SIZE) {
          done = true;
        } else {
          page += 1;
          await sleep(100);
        }
      }

      if (done) {
        upsertProgress.run({
          customer_key: de.customerKey,
          bu_id: String(bu.id),
          bu_name: bu.name,
          de_name: de.name,
          id_fields: JSON.stringify(idFields),
          last_page_done: page,
          status: 'done',
        });
        console.log(`    listo (${page} página(s) procesadas).`);
      }
    }
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
