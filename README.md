# SFMC — Conteo de registros por Data Extension, por Business Unit

Recorre **todas las Business Units** de tu cuenta Enterprise, y dentro de cada una lista sus Data Extensions con la cantidad de registros. Exporta todo a `de-record-counts.csv`, ordenado de mayor a menor, con columna de Unidad Comercial (Business Unit).

## Cómo funciona
1. Se autentica a nivel **Enterprise/Parent** con tu Installed Package.
2. Lista todas las Business Units vía **SOAP** (`Retrieve` sobre `ObjectType: BusinessUnit`) — esto solo funciona si el token es del nivel Parent.
3. Para cada Business Unit, pide un **token nuevo** pasando su MID como `account_id` (así SFMC te da un token "scopeado" a esa BU).
4. Con ese token, lista las Data Extensions de esa BU (SOAP) y cuenta registros de cada una (REST `rowset?$pageSize=1`, leyendo el campo `count`).
5. Junta todo en un solo CSV con columnas: `UnidadComercial, MID, NombreDE, CustomerKey, Registros`.

## Permisos necesarios en el Installed Package
Esto es más exigente que un scope de una sola BU:
- El paquete tiene que estar **instalado en la Business Unit Parent/Enterprise** (no en una BU hija).
- El usuario/paquete necesita acceso a las BUs hijas que querés auditar (en SFMC esto se maneja vía **Setup > Users** o permisos de "Business Unit" del usuario asociado al paquete).
- **Data > Data Extensions**: Read, en todas las BUs relevantes.
- Si tu paquete NO tiene acceso a alguna BU, el script lo va a loguear como error y sigue con las demás (no corta la corrida entera).

## Setup en GitHub
Secrets necesarios en **Settings > Secrets and variables > Actions**:
- `SFMC_CLIENT_ID`
- `SFMC_CLIENT_SECRET`
- `SFMC_SUBDOMAIN` (subdominio del tenant, sin `https://`)
- `SFMC_PARENT_ACCOUNT_ID` — el MID de tu Business Unit Parent/Enterprise
- `SFMC_BUSINESS_UNIT_IDS` (opcional) — lista de MIDs separados por coma si querés limitar el scope a BUs puntuales en vez de recorrerlas todas, ej `"100001,100002"`

Después andá a **Actions**, elegí el workflow y corré **Run workflow**. Al terminar, bajate el artifact `de-record-counts`.

## Correrlo localmente (para probar)
```bash
npm install
SFMC_CLIENT_ID=xxx SFMC_CLIENT_SECRET=xxx SFMC_SUBDOMAIN=xxx SFMC_PARENT_ACCOUNT_ID=xxx node count-data-extensions.js
```

## Nota sobre volumen y tiempos
Con varias BUs, cada una con varias DEs, el script puede tardar bastante — está pensado para correr como Action manual (o programada), no para necesitar el resultado al instante. Hay una pausa de 150ms entre llamadas para no pisar el rate limit de SFMC; si tenés muchísimas DEs en total, considerá subir ese valor.
