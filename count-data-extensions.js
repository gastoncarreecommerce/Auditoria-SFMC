import fs from 'fs';
import { XMLParser } from 'fast-xml-parser';

const {
  SFMC_CLIENT_ID,
  SFMC_CLIENT_SECRET,
  SFMC_SUBDOMAIN,
  SFMC_ACCOUNT_ID, // opcional: MID de la BU sobre la que querés correr esto (parent o child)
} = process.env;

if (!SFMC_CLIENT_ID || !SFMC_CLIENT_SECRET || !SFMC_SUBDOMAIN) {
  console.error('Faltan variables de entorno: SFMC_CLIENT_ID, SFMC_CLIENT_SECRET, SFMC_SUBDOMAIN');
  process.exit(1);
}

const AUTH_URL = `https://${SFMC_SUBDOMAIN}.auth.marketingcloudapis.com/v2/token`;
const SOAP_URL = `https://${SFMC_SUBDOMAIN}.soap.marketingcloudapis.com/Service.asmx`;
const REST_BASE = `https://${SFMC_SUBDOMAIN}.rest.marketingcloudapis.com`;

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getToken() {
  const body = {
    grant_type: 'client_credentials',
    client_id: SFMC_CLIENT_ID,
    client_secret: SFMC_CLIENT_SECRET,
  };
  if (SFMC_ACCOUNT_ID) body.account_id = SFMC_ACCOUNT_ID;

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Auth falló (${res.status}): ${text}`);
  return JSON.parse(text).access_token;
}

function buildInitialRetrieveXml(token) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><fueloauth xmlns="http://exacttarget.com">${token}</fueloauth></soapenv:Header>
  <soapenv:Body>
    <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <RetrieveRequest>
        <ObjectType>DataExtension</ObjectType>
        <Properties>CustomerKey</Properties>
        <Properties>Name</Properties>
        <Properties>CategoryID</Properties>
      </RetrieveRequest>
    </RetrieveRequestMsg>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildContinueXml(token, requestId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><fueloauth xmlns="http://exacttarget.com">${token}</fueloauth></soapenv:Header>
  <soapenv:Body>
    <ContinueRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <ContinueRequest>${requestId}</ContinueRequest>
    </ContinueRequestMsg>
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function listAllDataExtensions(token) {
  let all = [];
  let continueId = null;
  let more = true;

  while (more) {
    const xml = continueId ? buildContinueXml(token, continueId) : buildInitialRetrieveXml(token);
    const soapAction = continueId ? 'Continue' : 'Retrieve';

    const res = await fetch(SOAP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml', SOAPAction: soapAction },
      body: xml,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`SOAP falló (${res.status}): ${text}`);

    const parsed = parser.parse(text);
    const body = parsed.Envelope.Body;
    const msg = continueId ? body.ContinueResponseMsg : body.RetrieveResponseMsg;

    let results = msg.Results || [];
    if (!Array.isArray(results)) results = [results];
    all = all.concat(
      results.map((r) => ({ customerKey: r.CustomerKey, name: r.Name }))
    );

    if (msg.OverallStatus === 'MoreDataAvailable') {
      continueId = msg.RequestID;
    } else {
      more = false;
    }
  }
  return all;
}

async function getRowCount(token, customerKey) {
  const url = `${REST_BASE}/data/v1/customobjectdata/key/${encodeURIComponent(
    customerKey
  )}/rowset?$pageSize=1&$page=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const data = await res.json();
  return { count: typeof data.count === 'number' ? data.count : 0 };
}

async function main() {
  console.log('Autenticando contra SFMC...');
  const token = await getToken();

  console.log('Listando todas las Data Extensions (SOAP)...');
  const des = await listAllDataExtensions(token);
  console.log(`Encontradas ${des.length} Data Extensions. Contando registros una por una...`);

  const results = [];
  for (let i = 0; i < des.length; i++) {
    const de = des[i];
    const { count, error } = await getRowCount(token, de.customerKey);
    results.push({ name: de.name, customerKey: de.customerKey, count: count ?? null, error: error ?? null });
    console.log(`[${i + 1}/${des.length}] ${de.name}: ${error ? 'ERROR ' + error : count}`);
    await sleep(150); // margen de rate-limit
  }

  results.sort((a, b) => (b.count ?? -1) - (a.count ?? -1));

  const csvLines = ['Nombre,CustomerKey,Registros,Error'];
  for (const r of results) {
    const safeName = String(r.name).replace(/"/g, '""');
    csvLines.push(`"${safeName}","${r.customerKey}",${r.count ?? ''},${r.error ?? ''}`);
  }
  fs.writeFileSync('de-record-counts.csv', csvLines.join('\n'));

  console.log('\nListo. Resultado completo en de-record-counts.csv');
  console.log('\nTop 10 por cantidad de registros:');
  results.slice(0, 10).forEach((r) => console.log(`  ${r.count ?? 'ERR'} — ${r.name}`));
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
