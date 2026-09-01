import fs from 'fs';
import { XMLParser } from 'fast-xml-parser';

const {
  SFMC_CLIENT_ID,
  SFMC_CLIENT_SECRET,
  SFMC_SUBDOMAIN,
  SFMC_PARENT_ACCOUNT_ID, // MID de la Enterprise/Parent BU (donde está instalado el paquete)
  SFMC_BUSINESS_UNIT_IDS, // opcional: lista de MIDs separados por coma para limitar el scope, ej "100001,100002"
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

async function getToken(accountId) {
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
  return JSON.parse(text).access_token;
}

function buildRetrieveXml(token, objectType, properties, continueId = null) {
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
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><fueloauth xmlns="http://exacttarget.com">${token}</fueloauth></soapenv:Header>
  <soapenv:Body>
    <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <RetrieveRequest>
        <ObjectType>${objectType}</ObjectType>
        ${propsXml}
      </RetrieveRequest>
    </RetrieveRequestMsg>
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function soapRetrieveAll(token, objectType, properties) {
  let all = [];
  let continueId = null;
  let more = true;

  while (more) {
    const xml = buildRetrieveXml(token, objectType, properties, continueId);
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
    const msg = continueId ? body.ContinueResponseMsg : body.RetrieveResponseMsg;

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

async function listBusinessUnits(parentToken) {
  const results = await soapRetrieveAll(parentToken, 'BusinessUnit', ['ID', 'Name', 'ParentID', 'IsActive']);
  return results.map((r) => ({
    id: r.ID,
    name: r.Name,
    parentId: r.ParentID,
    isActive: r.IsActive,
  }));
}

async function listAllDataExtensions(buToken) {
  const results = await soapRetrieveAll(buToken, 'DataExtension', ['CustomerKey', 'Name', 'CategoryID']);
  return results.map((r) => ({ customerKey: r.CustomerKey, name: r.Name }));
}

async function getRowCount(buToken, customerKey) {
  const url = `${REST_BASE}/data/v1/customobjectdata/key/${encodeURIComponent(
    customerKey
  )}/rowset?$pageSize=1&$page=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${buToken}` } });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const data = await res.json();
  return { count: typeof data.count === 'number' ? data.count : 0 };
}

async function main() {
  console.log('Autenticando en el nivel Enterprise/Parent...');
  const parentToken = await getToken(SFMC_PARENT_ACCOUNT_ID);

  console.log('Listando Business Units...');
  let businessUnits = await listBusinessUnits(parentToken);

  if (SFMC_BUSINESS_UNIT_IDS) {
    const allowed = new Set(SFMC_BUSINESS_UNIT_IDS.split(',').map((s) => s.trim()));
    businessUnits = businessUnits.filter((bu) => allowed.has(String(bu.id)));
  }

  console.log(`Procesando ${businessUnits.length} Business Units...`);

  const results = [];

  for (const bu of businessUnits) {
    console.log(`\n--- BU: ${bu.name} (MID ${bu.id}) ---`);
    let buToken;
    try {
      buToken = await getToken(bu.id);
    } catch (err) {
      console.log(`  No se pudo autenticar contra esta BU (¿el paquete no tiene acceso?): ${err.message}`);
      continue;
    }

    let des;
    try {
      des = await listAllDataExtensions(buToken);
    } catch (err) {
      console.log(`  Error listando DEs: ${err.message}`);
      continue;
    }

    console.log(`  ${des.length} Data Extensions encontradas. Contando registros...`);

    for (let i = 0; i < des.length; i++) {
      const de = des[i];
      const { count, error } = await getRowCount(buToken, de.customerKey);
      results.push({
        businessUnitName: bu.name,
        businessUnitId: bu.id,
        deName: de.name,
        customerKey: de.customerKey,
        count: count ?? null,
        error: error ?? null,
      });
      console.log(`  [${i + 1}/${des.length}] ${de.name}: ${error ? 'ERROR ' + error : count}`);
      await sleep(150); // margen de rate-limit
    }
  }

  results.sort((a, b) => (b.count ?? -1) - (a.count ?? -1));

  const csvLines = ['UnidadComercial,MID,NombreDE,CustomerKey,Registros,Error'];
  for (const r of results) {
    const safeBU = String(r.businessUnitName).replace(/"/g, '""');
    const safeName = String(r.deName).replace(/"/g, '""');
    csvLines.push(
      `"${safeBU}","${r.businessUnitId}","${safeName}","${r.customerKey}",${r.count ?? ''},${r.error ?? ''}`
    );
  }
  fs.writeFileSync('de-record-counts.csv', csvLines.join('\n'));

  console.log('\nListo. Resultado completo en de-record-counts.csv');
  console.log('\nTop 15 por cantidad de registros:');
  results.slice(0, 15).forEach((r) => console.log(`  ${r.count ?? 'ERR'} — [${r.businessUnitName}] ${r.deName}`));
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
