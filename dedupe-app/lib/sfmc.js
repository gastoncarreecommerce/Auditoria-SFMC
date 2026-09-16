import { XMLParser } from 'fast-xml-parser';

const { SFMC_CLIENT_ID, SFMC_CLIENT_SECRET, SFMC_SUBDOMAIN, SFMC_PARENT_ACCOUNT_ID } = process.env;

const AUTH_URL = `https://${SFMC_SUBDOMAIN}.auth.marketingcloudapis.com/v2/token`;
const SOAP_URL = `https://${SFMC_SUBDOMAIN}.soap.marketingcloudapis.com/Service.asmx`;
const REST_BASE = `https://${SFMC_SUBDOMAIN}.rest.marketingcloudapis.com`;
const PAGE_SIZE = 500; // tamaño de tanda para el envío de borrado (values por request)
// Tamaño de página al ESCANEAR una DE. Antes era 50 porque cada fila sin
// SubscriberKey propio hacía un lookup SOAP por email UNO POR UNO — con
// DEs de millones de filas eso era, literalmente, cuestión de días. Ahora
// los lookups se agrupan (ver EMAIL_BATCH_SIZE) así una página de 500
// filas sigue resolviéndose en unos pocos segundos.
const SCAN_PAGE_SIZE = 500;
// Cuántos emails entran en un solo Retrieve SOAP (filtro OR anidado) en
// vez de una consulta por email — esto es lo que realmente acelera el
// escaneo, no la paralelización sola.
const EMAIL_BATCH_SIZE = 25;
// Cuántos de esos lotes de 25 se mandan en paralelo.
const LOOKUP_CONCURRENCY = 6;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

// Mismos patrones que el resto del proyecto de auditoría, para no tocar
// nunca una DE de sistema por error.
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
export function isSystemDE(name) {
  return SYSTEM_DE_PATTERNS.some((re) => re.test(name));
}

// Un solo token para todo el proceso de una request HTTP (las funciones
// serverless de Vercel son de vida corta, no hace falta el manejo de
// renovación proactiva que sí tiene extract-contacts.js para corridas de
// horas).
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60_000) return cachedToken;
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

async function soapRequest(bodyXml) {
  const token = await getToken();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><fueloauth xmlns="http://exacttarget.com">${token}</fueloauth></soapenv:Header>
  <soapenv:Body>${bodyXml}</soapenv:Body>
</soapenv:Envelope>`;
  const res = await fetch(SOAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', SOAPAction: bodyXml.startsWith('<DeleteRequest') ? 'Delete' : 'Retrieve' },
    body: xml,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SOAP falló (${res.status}): ${text}`);
  const parsed = parser.parse(text);
  const body = parsed.Envelope.Body;
  if (body.Fault) throw new Error(`SOAP Fault: ${body.Fault.faultstring || JSON.stringify(body.Fault)}`);
  return body;
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function simpleFilterXml(property, value) {
  return `<Filter xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="SimpleFilterPart">
    <Property>${property}</Property>
    <SimpleOperator>equals</SimpleOperator>
    <Value>${escapeXml(value)}</Value>
  </Filter>`;
}

// Arma un filtro OR anidado para traer N valores en UNA sola llamada SOAP
// en vez de una llamada por valor — sin esto, resolver millones de filas
// por email es completamente inviable en tiempo real.
function orFilterXml(property, values) {
  if (values.length === 1) return simpleFilterXml(property, values[0]);
  const [first, ...rest] = values;
  return `<Filter xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ComplexFilterPart">
    <LeftOperand xsi:type="SimpleFilterPart">
      <Property>${property}</Property>
      <SimpleOperator>equals</SimpleOperator>
      <Value>${escapeXml(first)}</Value>
    </LeftOperand>
    <LogicalOperator>OR</LogicalOperator>
    <RightOperand ${rest.length === 1 ? 'xsi:type="SimpleFilterPart"' : 'xsi:type="ComplexFilterPart"'}>
      ${rest.length === 1
        ? `<Property>${property}</Property><SimpleOperator>equals</SimpleOperator><Value>${escapeXml(rest[0])}</Value>`
        : orFilterInnerXml(property, rest)}
    </RightOperand>
  </Filter>`;
}

// Igual que orFilterXml pero sin el <Filter> envolvente — para anidar
// dentro de un <RightOperand xsi:type="ComplexFilterPart">.
function orFilterInnerXml(property, values) {
  const [first, ...rest] = values;
  return `<LeftOperand xsi:type="SimpleFilterPart">
      <Property>${property}</Property>
      <SimpleOperator>equals</SimpleOperator>
      <Value>${escapeXml(first)}</Value>
    </LeftOperand>
    <LogicalOperator>OR</LogicalOperator>
    <RightOperand ${rest.length === 1 ? 'xsi:type="SimpleFilterPart"' : 'xsi:type="ComplexFilterPart"'}>
      ${rest.length === 1
        ? `<Property>${property}</Property><SimpleOperator>equals</SimpleOperator><Value>${escapeXml(rest[0])}</Value>`
        : orFilterInnerXml(property, rest)}
    </RightOperand>`;
}

async function soapRetrieveAll(objectType, properties, filter) {
  let all = [];
  let continueId = null;
  let more = true;
  while (more) {
    const propsXml = properties.map((p) => `<Properties>${p}</Properties>`).join('');
    let filterXml = '';
    if (filter && filter.raw) filterXml = filter.raw;
    else if (filter) filterXml = simpleFilterXml(filter.property, filter.value);
    const requestXml = continueId
      ? `<ContinueRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI"><ContinueRequest>${continueId}</ContinueRequest></ContinueRequestMsg>`
      : `<RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
           <RetrieveRequest><ObjectType>${objectType}</ObjectType>${propsXml}${filterXml}</RetrieveRequest>
         </RetrieveRequestMsg>`;
    const body = await soapRequest(requestXml);
    const msg = continueId ? body.ContinueResponseMsg : body.RetrieveResponseMsg;
    let results = msg.Results || [];
    if (!Array.isArray(results)) results = [results];
    all = all.concat(results);
    if (msg.OverallStatus === 'MoreDataAvailable') continueId = msg.RequestID;
    else more = false;
  }
  return all;
}

// Se usa para verificar contra el nombre REAL en SFMC, no el que mande el
// cliente — así la confirmación "escribí el nombre de la DE" protege de
// verdad contra un customerKey equivocado, no solo contra un typo en la UI.
export async function getDataExtensionName(customerKey) {
  const results = await soapRetrieveAll('DataExtension', ['CustomerKey', 'Name'], {
    property: 'CustomerKey',
    value: customerKey,
  });
  const row = Array.isArray(results) ? results[0] : results;
  return row?.Name || null;
}

export async function listContactDataExtensions() {
  const results = await soapRetrieveAll('DataExtension', ['CustomerKey', 'Name']);
  return results.filter((r) => !isSystemDE(r.Name)).map((r) => ({ customerKey: r.CustomerKey, name: r.Name }));
}

// Misma heurística que extract-contacts.js: los nombres reales de campo
// vienen con prefijo/sufijo de sync con Salesforce (PersonEmail, DNI__c,
// Otro_documento__c), no solo "Email"/"DNI" a secas, por eso se busca la
// palabra en cualquier parte del nombre.
const NON_IDENTIFIER_TYPES = /^(boolean|date|decimal|number)$/i;
const NOT_AN_IDENTIFIER_NAME = /^tipo|tipo.?doc|tipo.?dni|bounce|reason|optout|prefer|consent|unsub|score/i;

export async function getIdFields(customerKey) {
  const results = await soapRetrieveAll(
    'DataExtensionField',
    ['Name', 'FieldType'],
    { property: 'DataExtension.CustomerKey', value: customerKey }
  );
  const fields = (Array.isArray(results) ? results : [results]).filter(Boolean);
  const idFields = [];
  for (const f of fields) {
    const name = f.Name;
    if (NON_IDENTIFIER_TYPES.test(f.FieldType)) continue;
    if (NOT_AN_IDENTIFIER_NAME.test(name)) continue;
    // SubscriberKey/ContactKey: en esta cuenta a veces guarda el DNI, a
    // veces el email — pero sea lo que sea, es EL identificador real de
    // SFMC, así que su valor se usa tal cual, sin resolver nada más.
    if (/subscriber.?key|contact.?key/i.test(name)) idFields.push({ name, type: 'subscriberkey' });
    else if (/email|correo|^mail$/i.test(name)) idFields.push({ name, type: 'email' });
  }
  return idFields;
}

// Trae una página del rowset con sus campos identificadores (no solo la
// clave primaria de la DE), para poder resolver el SubscriberKey real de
// cada fila más adelante.
export async function fetchPage(customerKey, page, idFields) {
  const token = await getToken();
  const url = `${REST_BASE}/data/v1/customobjectdata/key/${encodeURIComponent(customerKey)}/rowset?$pageSize=${SCAN_PAGE_SIZE}&$page=${page}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Rowset falló (${res.status})`);
  const data = await res.json();
  const items = data.items || [];
  const rows = items.map((item) => {
    const flat = { ...(item.keys || {}), ...(item.values || {}) };
    const flatLower = {};
    for (const k in flat) flatLower[k.toLowerCase()] = flat[k];
    const row = {};
    for (const f of idFields) {
      row[f.name] = flat[f.name] !== undefined ? flat[f.name] : flatLower[f.name.toLowerCase()];
    }
    return row;
  });
  // El rowset trae la cantidad total de filas de la DE (si la API la
  // expone) — sirve para mostrar un progreso real en vez de solo "página N".
  const totalRows = typeof data.count === 'number' ? data.count : null;
  return { rows, hasMore: items.length === SCAN_PAGE_SIZE, totalRows };
}

// Resuelve muchos emails a su SubscriberKey real vía el objeto Subscriber
// (el de la DE puede no coincidir: la clave primaria de la DE no es
// necesariamente la Clave del Suscriptor de la cuenta). Agrupa hasta
// EMAIL_BATCH_SIZE emails por llamada SOAP (filtro OR anidado) en vez de
// una llamada por email — es la diferencia entre horas y días en una DE
// grande. Devuelve un Map email(lowercase) -> SubscriberKey.
export async function resolveSubscriberKeysByEmail(emails) {
  const unique = [...new Set(emails)];
  if (unique.length === 0) return new Map();

  const batches = [];
  for (let i = 0; i < unique.length; i += EMAIL_BATCH_SIZE) {
    batches.push(unique.slice(i, i + EMAIL_BATCH_SIZE));
  }

  const map = new Map();
  await mapWithConcurrency(batches, LOOKUP_CONCURRENCY, async (batch) => {
    const results = await soapRetrieveAll('Subscriber', ['SubscriberKey', 'EmailAddress'], {
      raw: orFilterXml('EmailAddress', batch),
    });
    for (const row of results) {
      if (row?.EmailAddress && row?.SubscriberKey) {
        map.set(row.EmailAddress.toLowerCase(), row.SubscriberKey);
      }
    }
  });
  return map;
}

// Borrado global asíncrono del Contact/Subscriber dueño de cada
// SubscriberKey — no borra filas de una DE puntual, borra al contacto de
// toda la cuenta (todas las BUs, todas las DEs, historial de envíos).
// SFMC encola el pedido y lo procesa en horas; devuelve un OperationID
// para consultar el estado después.
export async function submitContactDelete(subscriberKeys) {
  if (subscriberKeys.length === 0) return null;
  const token = await getToken();
  const res = await fetch(`${REST_BASE}/contacts/v1/contacts/actions/delete?type=keys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ContactTypeId: 0,
      values: subscriberKeys,
      DeleteOperationType: 'ContactAndAttributes',
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Contact Delete falló (${res.status}): ${text}`);
  const data = JSON.parse(text);
  return data.OperationID || data.operationId || data.requestId || null;
}

export async function getContactDeleteStatus(operationId) {
  const token = await getToken();
  const url = `${REST_BASE}/contacts/v1/contacts/actions/delete/status?operationID=${encodeURIComponent(operationId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Consulta de estado falló (${res.status}): ${text}`);
  return JSON.parse(text);
}
