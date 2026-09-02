import Database from 'better-sqlite3';

const { SFMC_CLIENT_ID, SFMC_CLIENT_SECRET, SFMC_SUBDOMAIN, INSPECT_DE_NAME } = process.env;

const AUTH_URL = `https://${SFMC_SUBDOMAIN}.auth.marketingcloudapis.com/v2/token`;
const REST_BASE = `https://${SFMC_SUBDOMAIN}.rest.marketingcloudapis.com`;

async function main() {
  const db = new Database('contacts.db', { readonly: true });
  const prog = db.prepare('SELECT * FROM de_progress WHERE de_name = ?').get(INSPECT_DE_NAME);
  db.close();
  if (!prog) {
    console.error(`No se encontró "${INSPECT_DE_NAME}" en de_progress.`);
    process.exit(1);
  }
  console.log(`customer_key=${prog.customer_key}, bu_id=${prog.bu_id}, id_fields guardado=${prog.id_fields}`);

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: SFMC_CLIENT_ID,
      client_secret: SFMC_CLIENT_SECRET,
      account_id: prog.bu_id,
    }),
  });
  const { access_token } = await res.json();

  const url = `${REST_BASE}/data/v1/customobjectdata/key/${encodeURIComponent(prog.customer_key)}/rowset?$pageSize=3&$page=1`;
  const rowsetRes = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
  const data = await rowsetRes.json();
  console.log(`HTTP ${rowsetRes.status}`);
  console.log(JSON.stringify(data, null, 2).slice(0, 6000));
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
