// Borra TODOS los contactos de la cuenta que NO estén en una DE "a
// conservar" (ej. Base Maestra NUEVA). A diferencia de dedupe-app/ (que
// borra el/los contacto(s) de UNA DE puntual, corriendo desde el
// navegador), esto recorre TODA la base de Subscribers de la cuenta
// (~21M) — un volumen que no entra en el límite de tiempo de una función
// serverless ni depende de mantener una pestaña abierta. Corre como
// GitHub Action, igual que extract-contacts.js.
//
// Tres fases:
//   1. Escanea la DE a conservar y guarda su campo identificador (por
//      default DNI__c, que en esta cuenta ES la Clave del Suscriptor)
//      en la tabla keep_keys.
//   2. Si se pasa DELETE_DE_CUSTOMER_KEY, lee directo esa DE (ya
//      calculada por una Query Activity de Automation Studio contra
//      _Subscribers — ver README) en vez de recorrer el objeto
//      Subscriber completo por SOAP, que se topa con un throttle muy
//      agresivo de SFMC en cuentas grandes. Sin esa variable, cae al
//      barrido SOAP original (más lento, se deja como respaldo).
//   3. Si DRY_RUN no es "true", manda el borrado global asíncrono
//      (Contact Delete) en tandas de 500 por cada fila de delete_keys
//      todavía no enviada.
//
// Todo el progreso queda en delete-outside-de.db (SQLite, cacheado entre
// corridas igual que contacts.db) — se puede cortar y resumir la fase 1
// (usa $page directo). La fase 2 depende de un ContinueRequest de SFMC
// que expira si se corta mucho tiempo: si el job se corta a mitad de la
// fase 2, hay que repetirla desde el principio (es idempotente — no
// duplica nada, solo repite trabajo).

import fs from 'fs';
import Database from 'better-sqlite3';
import { XMLParser } from 'fast-xml-parser';

const {
  SFMC_CLIENT_ID,
  SFMC_CLIENT_SECRET,
  SFMC_SUBDOMAIN,
  SFMC_PARENT_ACCOUNT_ID,
  KEEP_DE_CUSTOMER_KEY,
  KEEP_FIELD,
  DRY_RUN,
  SUBMIT_DELETE,
  TIME_BUDGET_MINUTES,
  KEEP_SCAN_PAGE_SIZE,
  KEEP_SCAN_CONCURRENCY,
  RESET_PHASE2,
  DELETE_DE_CUSTOMER_KEY,
} = process.env;

if (!SFMC_CLIENT_ID || !SFMC_CLIENT_SECRET || !SFMC_SUBDOMAIN) {
  console.error('Faltan variables de entorno: SFMC_CLIENT_ID, SFMC_CLIENT_SECRET, SFMC_SUBDOMAIN');
  process.exit(1);
}
if (!KEEP_DE_CUSTOMER_KEY) {
  console.error('Falta KEEP_DE_CUSTOMER_KEY (la Clave Externa de la DE a conservar, ej. Base Maestra NUEVA)');
  process.exit(1);
}

const IS_DRY_RUN = DRY_RUN !== 'false'; // por defecto SIEMPRE dry-run — hay que pedirlo explícitamente
const SHOULD_SUBMIT = !IS_DRY_RUN && SUBMIT_DELETE === 'true';
const IDENTIFIER_FIELD = KEEP_FIELD || 'DNI__c';

const AUTH_URL = `https://${SFMC_SUBDOMAIN}.auth.marketingcloudapis.com/v2/token`;
const SOAP_URL = `https://${SFMC_SUBDOMAIN}.soap.marketingcloudapis.com/Service.asmx`;
const REST_BASE = `https://${SFMC_SUBDOMAIN}.rest.marketingcloudapis.com`;
const PAGE_SIZE = Number(KEEP_SCAN_PAGE_SIZE) || 500;
const PAGE_CONCURRENCY = Number(KEEP_SCAN_CONCURRENCY) || 8;
const TIME_BUDGET_MS = (Number(TIME_BUDGET_MINUTES) || 330) * 60 * 1000;
const START_TIME = Date.now();
const MAX_FETCH_ATTEMPTS = 6;
// El retrieve masivo de Subscriber en una cuenta de ~21M parece toparse
// con un throttle de SFMC bastante agresivo (éxito ~1 de cada 15-25
// intentos en la práctica) — con backoff exponencial (hasta 90s) hacen
// falta bastantes reintentos para que una página termine pasando.
const MAX_SUBSCRIBER_ERROR_RETRIES = 60;
const SUBMIT_CHUNK = 500;

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function timeIsUp() {
  return Date.now() - START_TIME > TIME_BUDGET_MS;
}

// --- Auth con refresh (una corrida de horas necesita renovar el token) ---
let cachedToken = null;
let cachedTokenExpiresAt = 0;
async function getToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 120_000) return cachedToken;
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: SFMC_CLIENT_ID,
      client_secret: SFMC_CLIENT_SECRET,
      account_id: SFMC_PARENT_ACCOUNT_ID,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Auth falló (${res.status}): ${text}`);
  const { access_token, expires_in } = JSON.parse(text);
  cachedToken = access_token;
  cachedTokenExpiresAt = Date.now() + (expires_in || 1200) * 1000;
  return cachedToken;
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function soapRequest(bodyXml, attempt = 0) {
  const token = await getToken();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><fueloauth xmlns="http://exacttarget.com">${token}</fueloauth></soapenv:Header>
  <soapenv:Body>${bodyXml}</soapenv:Body>
</soapenv:Envelope>`;
  try {
    const res = await fetch(SOAP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml', SOAPAction: 'Retrieve' },
      body: xml,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`SOAP falló (${res.status}): ${text.slice(0, 300)}`);
      err.noRetry = res.status < 500 && res.status !== 429;
      throw err;
    }
    const parsed = parser.parse(text);
    const body = parsed.Envelope.Body;
    if (body.Fault) throw new Error(`SOAP Fault: ${body.Fault.faultstring || JSON.stringify(body.Fault)}`);
    return body;
  } catch (err) {
    if (!err.noRetry && attempt < MAX_FETCH_ATTEMPTS) {
      await sleep(1000 * 2 ** attempt);
      return soapRequest(bodyXml, attempt + 1);
    }
    throw err;
  }
}

async function fetchRowsetPage(customerKey, page, attempt = 0) {
  const url = `${REST_BASE}/data/v1/customobjectdata/key/${encodeURIComponent(customerKey)}/rowset?$pageSize=${PAGE_SIZE}&$page=${page}`;
  try {
    const token = await getToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.noRetry = res.status < 500 && res.status !== 429;
      throw err;
    }
    return await res.json();
  } catch (err) {
    if (!err.noRetry && attempt < MAX_FETCH_ATTEMPTS) {
      await sleep(1000 * 2 ** attempt);
      return fetchRowsetPage(customerKey, page, attempt + 1);
    }
    throw err;
  }
}

// --- SQLite: guarda todo el progreso, resumible entre corridas ---
const db = new Database('delete-outside-de.db');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -200000');
db.pragma('temp_store = MEMORY');
db.exec(`
  CREATE TABLE IF NOT EXISTS keep_keys (key TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS delete_keys (
    subscriber_key TEXT PRIMARY KEY,
    submitted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS operations (
    operation_id TEXT,
    submitted_at TEXT,
    chunk_size INTEGER
  );
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`);
const getMeta = (k) => db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v;
const setMeta = db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
const insertKeepKey = db.prepare('INSERT OR IGNORE INTO keep_keys (key) VALUES (?)');
const keepKeyExists = db.prepare('SELECT 1 FROM keep_keys WHERE key = ?');
const insertDeleteKey = db.prepare('INSERT OR IGNORE INTO delete_keys (subscriber_key) VALUES (?)');
const countKeep = () => db.prepare('SELECT COUNT(*) c FROM keep_keys').get().c;
const countDelete = () => db.prepare('SELECT COUNT(*) c FROM delete_keys').get().c;
const countScanned = () => Number(getMeta('subscribers_scanned') || 0);

// --- Fase 1: escanear la DE a conservar ---
async function scanKeepDe() {
  if (getMeta('phase1_done') === 'true') {
    console.log(`[fase 1] ya completada en una corrida anterior — ${countKeep()} claves a conservar`);
    return;
  }
  console.log(`[fase 1] escaneando ${KEEP_DE_CUSTOMER_KEY} (campo ${IDENTIFIER_FIELD})...`);
  let page = Number(getMeta('phase1_last_page') || 0) + 1;
  let more = true;
  while (more && !timeIsUp()) {
    const pages = Array.from({ length: PAGE_CONCURRENCY }, (_, i) => page + i);
    const results = await Promise.all(pages.map((p) => fetchRowsetPage(KEEP_DE_CUSTOMER_KEY, p)));
    let anyItems = false;
    const insertMany = db.transaction((rowsets) => {
      for (const data of rowsets) {
        const items = data.items || [];
        if (items.length > 0) anyItems = true;
        for (const item of items) {
          const flat = { ...(item.keys || {}), ...(item.values || {}) };
          const flatLower = {};
          for (const k in flat) flatLower[k.toLowerCase()] = flat[k];
          const value = flat[IDENTIFIER_FIELD] ?? flatLower[IDENTIFIER_FIELD.toLowerCase()];
          if (value) insertKeepKey.run(String(value).trim());
        }
        if (items.length < PAGE_SIZE) more = false;
      }
    });
    insertMany(results);
    page += PAGE_CONCURRENCY;
    setMeta.run('phase1_last_page', String(page - 1));
    if (!anyItems) more = false;
    if (page % 500 < PAGE_CONCURRENCY) console.log(`[fase 1] página ~${page} — ${countKeep()} claves acumuladas`);
  }
  if (!more) {
    setMeta.run('phase1_done', 'true');
    console.log(`[fase 1] completa — ${countKeep()} claves a conservar`);
  } else {
    console.log(`[fase 1] tiempo agotado, se resume en la próxima corrida desde la página ${page}`);
  }
}

// --- Fase 2 (alternativa): leer una DE ya calculada por una Query
// Activity de Automation Studio (SELECT SubscriberKey FROM _Subscribers
// LEFT JOIN <DE a conservar> ... WHERE ... IS NULL), en vez de recorrer
// el objeto Subscriber completo por SOAP. El cálculo pesado (el JOIN
// contra 21M de filas) lo hace SFMC del lado del servidor — evita por
// completo el throttle que hacía inviable el barrido por API.
async function scanDeleteDeFromQuery() {
  if (getMeta('phase2_done') === 'true') {
    console.log(`[fase 2] ya completada en una corrida anterior — ${countDelete()} a borrar de ${countScanned()} escaneados`);
    return;
  }
  console.log(`[fase 2] leyendo ${DELETE_DE_CUSTOMER_KEY} (ya calculada por la Query Activity)...`);
  let page = Number(getMeta('phase2_last_page') || 0) + 1;
  let more = true;
  let scanned = countScanned();
  while (more && !timeIsUp()) {
    const pages = Array.from({ length: PAGE_CONCURRENCY }, (_, i) => page + i);
    const results = await Promise.all(pages.map((p) => fetchRowsetPage(DELETE_DE_CUSTOMER_KEY, p)));
    let anyItems = false;
    const insertMany = db.transaction((rowsets) => {
      for (const data of rowsets) {
        const items = data.items || [];
        if (items.length > 0) anyItems = true;
        for (const item of items) {
          const flat = { ...(item.keys || {}), ...(item.values || {}) };
          const flatLower = {};
          for (const k in flat) flatLower[k.toLowerCase()] = flat[k];
          const value = flat['SubscriberKey'] ?? flatLower['subscriberkey'];
          if (value) {
            insertDeleteKey.run(String(value).trim());
            scanned++;
          }
        }
        if (items.length < PAGE_SIZE) more = false;
      }
    });
    insertMany(results);
    page += PAGE_CONCURRENCY;
    setMeta.run('phase2_last_page', String(page - 1));
    setMeta.run('subscribers_scanned', String(scanned));
    if (!anyItems) more = false;
    if (page % 500 < PAGE_CONCURRENCY) {
      console.log(`[fase 2] página ~${page} — ${scanned.toLocaleString('es-AR')} escaneados, ${countDelete().toLocaleString('es-AR')} a borrar`);
    }
  }
  if (!more) {
    setMeta.run('phase2_done', 'true');
    console.log(`[fase 2] completa — ${scanned.toLocaleString('es-AR')} escaneados, ${countDelete().toLocaleString('es-AR')} a borrar`);
  } else {
    console.log(`[fase 2] tiempo agotado, se resume en la próxima corrida desde la página ${page}`);
  }
}

// --- Fase 2: recorrer TODOS los Subscriber de la cuenta ---
async function scanAllSubscribers() {
  if (getMeta('phase2_done') === 'true') {
    console.log(`[fase 2] ya completada en una corrida anterior — ${countDelete()} a borrar de ${countScanned()} escaneados`);
    return;
  }
  console.log('[fase 2] recorriendo todo el objeto Subscriber de la cuenta...');
  let continueId = null;
  let more = true;
  let scanned = countScanned();
  let errorRetries = 0;
  while (more && !timeIsUp()) {
    const requestXml = continueId
      ? `<ContinueRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI"><ContinueRequest>${continueId}</ContinueRequest></ContinueRequestMsg>`
      : `<RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
           <RetrieveRequest><ObjectType>Subscriber</ObjectType><Properties>SubscriberKey</Properties></RetrieveRequest>
         </RetrieveRequestMsg>`;
    const body = await soapRequest(requestXml);
    // Cuando falla una continuación, SFMC a veces la envuelve igual bajo
    // RetrieveResponseMsg en vez de ContinueResponseMsg — no hay que
    // asumir la clave según el tipo de request, hay que usar la que
    // efectivamente vino.
    const msg = body.ContinueResponseMsg || body.RetrieveResponseMsg;
    if (!msg) {
      throw new Error(`Respuesta SOAP sin RetrieveResponseMsg/ContinueResponseMsg: ${JSON.stringify(body).slice(0, 500)}`);
    }
    if (msg.OverallStatus && msg.OverallStatus !== 'OK' && msg.OverallStatus !== 'MoreDataAvailable') {
      errorRetries++;
      // El patrón real (falla casi siempre, éxito ocasional) es un
      // throttle de SFMC en el retrieve masivo de Subscriber, no un token
      // de continuación roto — reiniciar el barrido con continueId=null
      // solo tira a la basura el progreso ya hecho sin arreglar nada, así
      // que se reintenta SIEMPRE con el mismo continueId (o la misma
      // primera página si todavía no arrancó), con un backoff más largo.
      if (errorRetries % 5 === 0) {
        console.log(`[fase 2] SFMC devolvió error de estado (van ${errorRetries} seguidos) — ${JSON.stringify(msg).slice(0, 300)}`);
      }
      if (errorRetries > MAX_SUBSCRIBER_ERROR_RETRIES) {
        throw new Error(`Fase 2: demasiados errores de SFMC seguidos (${errorRetries}), último: ${JSON.stringify(msg).slice(0, 500)}`);
      }
      await sleep(Math.min(5000 * 1.5 ** errorRetries, 90_000));
      continue;
    }
    errorRetries = 0;
    let results = msg.Results || [];
    if (!Array.isArray(results)) results = [results];
    // Diagnóstico: si SFMC devuelve 0 resultados sin "MoreDataAvailable",
    // puede ser que la cuenta esté vacía (raro) o, más probable, que al
    // paquete de API le falte el permiso Contacts → List and Subscribers:
    // Read — en ese caso SFMC no tira un SOAP Fault, solo devuelve un
    // OverallStatus distinto (o vacío) sin explicarlo, así que se loguea
    // completo para poder diagnosticarlo.
    if (results.length === 0) {
      console.log(`[fase 2] respuesta sin resultados — OverallStatus="${msg.OverallStatus}" StatusMessage="${msg.OverallStatusMessage || msg.StatusMessage || ''}"`);
      if (scanned === 0) console.log(`[fase 2] respuesta completa para diagnóstico: ${JSON.stringify(msg).slice(0, 1000)}`);
    }

    const tx = db.transaction((rows) => {
      for (const row of rows) {
        const key = row?.SubscriberKey;
        if (!key) continue;
        scanned++;
        if (!keepKeyExists.get(key)) insertDeleteKey.run(key);
      }
    });
    tx(results);
    setMeta.run('subscribers_scanned', String(scanned));

    if (msg.OverallStatus === 'MoreDataAvailable') {
      continueId = msg.RequestID;
    } else {
      more = false;
    }
    if (scanned % 25000 < results.length) {
      console.log(`[fase 2] ${scanned.toLocaleString('es-AR')} escaneados — ${countDelete().toLocaleString('es-AR')} a borrar hasta ahora`);
    }
  }
  if (!more) {
    // Si terminó (sin MoreDataAvailable) pero no escaneó nada, casi seguro
    // es un problema de permisos (falta Contacts → List and Subscribers:
    // Read en el paquete), no que la cuenta esté realmente vacía — no se
    // marca como "completa" para que la próxima corrida lo reintente en
    // vez de quedar salteada para siempre por el checkpoint.
    if (scanned === 0) {
      console.log('[fase 2] ADVERTENCIA: se escanearon 0 Subscribers. Lo más probable es que al paquete de API le falte el permiso "Contacts → List and Subscribers: Read". No se marca la fase como completa — revisá el permiso y volvé a correr el workflow.');
    } else {
      setMeta.run('phase2_done', 'true');
      console.log(`[fase 2] completa — ${scanned.toLocaleString('es-AR')} escaneados, ${countDelete().toLocaleString('es-AR')} a borrar`);
    }
  } else {
    console.log('[fase 2] tiempo agotado — el ContinueRequest de SFMC no sobrevive a una corrida nueva, así que la próxima corrida repite la fase 2 desde el principio (es idempotente, no duplica nada, solo repite trabajo).');
  }
}

// --- Fase 3: envío real del borrado (solo si no es dry-run) ---
async function submitDeletes() {
  if (!SHOULD_SUBMIT) {
    console.log(`[fase 3] DRY_RUN activo — no se manda nada. ${countDelete().toLocaleString('es-AR')} contactos quedarían marcados para borrar.`);
    return;
  }
  const pending = db.prepare('SELECT subscriber_key FROM delete_keys WHERE submitted = 0').all();
  console.log(`[fase 3] enviando borrado global de ${pending.length.toLocaleString('es-AR')} contactos en tandas de ${SUBMIT_CHUNK}...`);
  const markSubmitted = db.prepare('UPDATE delete_keys SET submitted = 1 WHERE subscriber_key = ?');
  const logOp = db.prepare('INSERT INTO operations (operation_id, submitted_at, chunk_size) VALUES (?, ?, ?)');
  for (let i = 0; i < pending.length; i += SUBMIT_CHUNK) {
    if (timeIsUp()) {
      console.log('[fase 3] tiempo agotado, se resume en la próxima corrida');
      break;
    }
    const chunk = pending.slice(i, i + SUBMIT_CHUNK).map((r) => r.subscriber_key);
    const token = await getToken();
    const res = await fetch(`${REST_BASE}/contacts/v1/contacts/actions/delete?type=keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ContactTypeId: 0, values: chunk, DeleteOperationType: 'ContactAndAttributes' }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[fase 3] tanda ${i}-${i + chunk.length} falló (${res.status}): ${text.slice(0, 300)}`);
      continue;
    }
    const data = JSON.parse(text);
    const opId = data.OperationID || data.operationId || data.requestId || null;
    const tx = db.transaction(() => {
      for (const key of chunk) markSubmitted.run(key);
      logOp.run(opId, new Date().toISOString(), chunk.length);
    });
    tx();
    console.log(`[fase 3] tanda ${i}-${i + chunk.length} enviada — OperationID ${opId}`);
  }
}

// Antes del fix de diagnóstico, una fase 2 que escaneaba 0 por falta de
// permisos igual quedaba guardada como "completa" en el .db cacheado — el
// fix evita que pase de nuevo, pero no limpia lo que ya quedó mal en una
// corrida anterior. RESET_PHASE2=true borra ese estado (y lo que se haya
// insertado en delete_keys) antes de arrancar, sin tener que ir a borrar
// el caché de GitHub Actions a mano.
function resetPhase2() {
  console.log('[reset] RESET_PHASE2=true — limpiando el checkpoint de la fase 2 antes de arrancar.');
  db.exec('DELETE FROM delete_keys; DELETE FROM meta WHERE k IN (\'phase2_done\', \'subscribers_scanned\');');
}

async function main() {
  console.log(`Conservar: ${KEEP_DE_CUSTOMER_KEY} (campo ${IDENTIFIER_FIELD})`);
  console.log(`Modo: ${IS_DRY_RUN ? 'DRY RUN (no borra nada)' : SHOULD_SUBMIT ? 'BORRADO REAL' : 'solo escaneo (SUBMIT_DELETE no es true)'}`);

  if (RESET_PHASE2 === 'true') resetPhase2();

  await scanKeepDe();
  if (getMeta('phase1_done') !== 'true') {
    console.log('Fase 1 sin terminar — cortando acá, se resume en la próxima corrida.');
    return;
  }

  if (DELETE_DE_CUSTOMER_KEY) {
    await scanDeleteDeFromQuery();
  } else {
    await scanAllSubscribers();
  }
  if (getMeta('phase2_done') !== 'true') {
    console.log('Fase 2 sin terminar — cortando acá, se resume en la próxima corrida.');
    return;
  }

  // CSV de salida siempre, dry-run o no, para poder auditar antes/después.
  const rows = db.prepare('SELECT subscriber_key, submitted FROM delete_keys').all();
  fs.writeFileSync(
    'delete-outside-de-report.csv',
    'subscriber_key,submitted\n' + rows.map((r) => `${r.subscriber_key},${r.submitted}`).join('\n')
  );
  console.log(`Reporte escrito en delete-outside-de-report.csv (${rows.length.toLocaleString('es-AR')} filas)`);

  await submitDeletes();

  console.log('--- Resumen ---');
  console.log(`Claves a conservar (de la DE):     ${countKeep().toLocaleString('es-AR')}`);
  console.log(`Subscribers escaneados en la cuenta: ${countScanned().toLocaleString('es-AR')}`);
  console.log(`A borrar:                            ${countDelete().toLocaleString('es-AR')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
