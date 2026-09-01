import Database from 'better-sqlite3';
import { XMLParser } from 'fast-xml-parser';

const { SFMC_CLIENT_ID, SFMC_CLIENT_SECRET, SFMC_SUBDOMAIN } = process.env;

const AUTH_URL = `https://${SFMC_SUBDOMAIN}.auth.marketingcloudapis.com/v2/token`;
const SOAP_URL = `https://${SFMC_SUBDOMAIN}.soap.marketingcloudapis.com/Service.asmx`;
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

function createTokenManager(accountId) {
  let accessToken = null;
  let expiresAt = 0;
  return {
    async get() {
      if (!accessToken || Date.now() > expiresAt - 120_000) {
        const res = await fetch(AUTH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'client_credentials',
            client_id: SFMC_CLIENT_ID,
            client_secret: SFMC_CLIENT_SECRET,
            account_id: accountId,
          }),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`Auth falló (${res.status}): ${text}`);
        const { access_token, expires_in } = JSON.parse(text);
        accessToken = access_token;
        expiresAt = Date.now() + (expires_in || 1200) * 1000;
      }
      return accessToken;
    },
  };
}

async function listFields(tokenMgr, customerKey) {
  const token = await tokenMgr.get();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header><fueloauth xmlns="http://exacttarget.com">${token}</fueloauth></soapenv:Header>
  <soapenv:Body>
    <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <RetrieveRequest>
        <ObjectType>DataExtensionField</ObjectType>
        <Properties>Name</Properties>
        <Properties>FieldType</Properties>
        <Properties>IsPrimaryKey</Properties>
        <Filter xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="SimpleFilterPart">
          <Property>DataExtension.CustomerKey</Property>
          <SimpleOperator>equals</SimpleOperator>
          <Value>${customerKey}</Value>
        </Filter>
      </RetrieveRequest>
    </RetrieveRequestMsg>
  </soapenv:Body>
</soapenv:Envelope>`;
  const res = await fetch(SOAP_URL, { method: 'POST', headers: { 'Content-Type': 'text/xml', SOAPAction: 'Retrieve' }, body: xml });
  const text = await res.text();
  const parsed = parser.parse(text);
  const msg = parsed.Envelope.Body.RetrieveResponseMsg;
  let results = msg?.Results || [];
  if (!Array.isArray(results)) results = [results];
  return results.filter(Boolean).map((f) => `${f.Name} (${f.FieldType}${f.IsPrimaryKey === 'true' ? ', PK' : ''})`);
}

async function main() {
  const db = new Database('contacts.db', { readonly: true });
  const skipped = db
    .prepare(`SELECT customer_key, bu_id, bu_name, de_name FROM de_progress WHERE status = 'skipped' AND id_fields = '[]'`)
    .all();
  db.close();

  console.log(`${skipped.length} DEs sin identificador detectado. Listando sus campos:\n`);

  const tokenMgrs = {};
  for (const de of skipped) {
    if (!tokenMgrs[de.bu_id]) tokenMgrs[de.bu_id] = createTokenManager(de.bu_id);
    try {
      const fields = await listFields(tokenMgrs[de.bu_id], de.customer_key);
      console.log(`--- [${de.bu_name}] ${de.de_name} ---`);
      console.log('  ' + fields.join(', '));
    } catch (err) {
      console.log(`--- [${de.bu_name}] ${de.de_name} --- ERROR: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
