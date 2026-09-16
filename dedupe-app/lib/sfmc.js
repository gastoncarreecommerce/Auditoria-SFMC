import { XMLParser } from 'fast-xml-parser';

const { SFMC_CLIENT_ID, SFMC_CLIENT_SECRET, SFMC_SUBDOMAIN, SFMC_PARENT_ACCOUNT_ID } = process.env;

const AUTH_URL = `https://${SFMC_SUBDOMAIN}.auth.marketingcloudapis.com/v2/token`;
const SOAP_URL = `https://${SFMC_SUBDOMAIN}.soap.marketingcloudapis.com/Service.asmx`;
const REST_BASE = `https://${SFMC_SUBDOMAIN}.rest.marketingcloudapis.com`;
const PAGE_SIZE = 500; // tanda chica a propósito: cada llamada borra como mucho esto

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

async function soapRetrieveAll(objectType, properties, filter) {
  let all = [];
  let continueId = null;
  let more = true;
  while (more) {
    const propsXml = properties.map((p) => `<Properties>${p}</Properties>`).join('');
    const filterXml = filter
      ? `<Filter xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="SimpleFilterPart">
           <Property>${filter.property}</Property>
           <SimpleOperator>equals</SimpleOperator>
           <Value>${filter.value}</Value>
         </Filter>`
      : '';
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

// Campos que realmente identifican la fila en SFMC (no los que detectamos
// como "parecen DNI/email" en la auditoría — acá hace falta la clave
// primaria real, la que exige SFMC para poder borrar).
export async function getPrimaryKeyFields(customerKey) {
  const results = await soapRetrieveAll(
    'DataExtensionField',
    ['Name', 'IsPrimaryKey'],
    { property: 'DataExtension.CustomerKey', value: customerKey }
  );
  const fields = (Array.isArray(results) ? results : [results]).filter(Boolean);
  return fields.filter((f) => f.IsPrimaryKey === 'true').map((f) => f.Name);
}

// Trae la página 1 del rowset. Siempre página 1 a propósito: como cada
// tanda borra lo que trajo, la "próxima" fila 1 pasa a ser la que antes
// era la 501 — no hace falta llevar offset.
export async function fetchFirstPage(customerKey, pkFields) {
  const token = await getToken();
  const url = `${REST_BASE}/data/v1/customobjectdata/key/${encodeURIComponent(customerKey)}/rowset?$pageSize=${PAGE_SIZE}&$page=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Rowset falló (${res.status})`);
  const data = await res.json();
  const items = data.items || [];
  return items.map((item) => {
    const flat = { ...(item.keys || {}), ...(item.values || {}) };
    const flatLower = {};
    for (const k in flat) flatLower[k.toLowerCase()] = flat[k];
    const key = {};
    for (const pk of pkFields) {
      key[pk] = flat[pk] !== undefined ? flat[pk] : flatLower[pk.toLowerCase()];
    }
    return key;
  });
}

// Borra por lotes de hasta 500 (mismo tamaño que la página que se lee, así
// nunca queda un resto sin borrar de la tanda leída).
export async function deleteRows(customerKey, pkFields, rowKeys) {
  if (rowKeys.length === 0) return;
  const objectsXml = rowKeys
    .map((row) => {
      const propsXml = pkFields
        .map((pk) => `<Property><Name>${escapeXml(pk)}</Name><Value>${escapeXml(String(row[pk] ?? ''))}</Value></Property>`)
        .join('');
      return `<Objects xsi:type="DataExtensionObject" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <CustomerKey>${escapeXml(customerKey)}</CustomerKey>
        <Properties>${propsXml}</Properties>
      </Objects>`;
    })
    .join('');
  const requestXml = `<DeleteRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">${objectsXml}</DeleteRequest>`;
  const body = await soapRequest(requestXml);
  const resp = body.DeleteResponse;
  const overallStatus = resp?.OverallStatus;
  if (overallStatus && overallStatus !== 'OK') {
    // No se aborta: SFMC puede reportar fallas parciales fila por fila
    // (ej. una ya borrada por otro proceso). Se devuelve para que la UI
    // lo muestre en vez de esconderlo.
    return { overallStatus, raw: resp };
  }
  return { overallStatus: overallStatus || 'OK' };
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
