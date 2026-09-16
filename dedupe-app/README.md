# SFMC — Borrar contactos globales a partir de una Data Extension

Herramienta interna: elegís una Data Extension, confirmás escribiendo su
nombre exacto, y la app escanea sus filas para resolver el **SubscriberKey**
real de cada una en SFMC. Con esos SubscriberKeys mandás una solicitud de
**borrado global del Contact/Subscriber** — no borra filas de esa DE
puntual, borra al contacto entero de toda la cuenta: todas las BUs, todas
las Data Extensions donde aparezca, y su historial de envíos.

## Cómo funciona

SFMC expone dos borrados distintos y esta herramienta usa el segundo:

- Borrar filas de una DE puntual (SOAP `DeleteRequest`) — la DE queda
  vacía, pero el contacto sigue existiendo en el resto de la cuenta.
- Borrar el Contact/Subscriber global (`POST /contacts/v1/contacts/actions/delete?type=keys`)
  — esto es lo que hace esta app.

Pasos:

1. **Escaneo**: recorre el rowset de la DE elegida, página por página. Por
   cada fila:
   - si la DE tiene un campo `SubscriberKey`/`ContactKey`, se usa ese valor
     tal cual (es el identificador real de SFMC, sea lo que sea que guarde
     en esta cuenta — en algunas DEs es el DNI, en otras el email).
   - si no, y hay un campo de email, se resuelve el SubscriberKey real
     consultando el objeto `Subscriber` de SFMC por ese email (porque la
     clave primaria de la DE no necesariamente coincide con la Clave del
     Suscriptor de la cuenta).
   - si no hay ninguno de los dos, esa fila queda sin resolver y se cuenta
     aparte — nunca se inventa un identificador.
2. **Envío**: una vez terminado el escaneo, se manda la solicitud de
   borrado global en tandas de hasta 500 SubscriberKeys. SFMC la encola —
   el procesamiento real puede tardar horas — y devuelve un `OperationID`
   por tanda.
3. **Estado**: con cada `OperationID` podés consultar el estado del
   borrado (`/contacts/v1/contacts/actions/delete/status`) cuando quieras,
   sin tener que quedarte esperando en la página.

## ⚠️ Sin verificar contra la cuenta real

A diferencia del resto del proyecto de auditoría (todo probado contra
respuestas reales de SFMC antes de confiarlo a escala), esta llamada de
borrado global no se probó todavía contra la cuenta — no hay endpoint de
sandbox para esto. El esquema del request (`ContactTypeId`, `values`,
`DeleteOperationType`) está tomado de la documentación oficial de
Salesforce, pero la primera tanda real que mandes es también la primera
prueba end-to-end. Recomendado: la primera vez, mandá una tanda chica
(o de una DE de bajo riesgo) y confirmá en SFMC que el contacto
efectivamente se borró antes de tandas grandes.

## Deploy en Vercel

1. Este proyecto vive en `dedupe-app/` dentro del repo `Auditoria-SFMC`,
   no en la raíz. Al crear el proyecto en Vercel, en **Root Directory**
   elegí `dedupe-app`.
2. Framework Preset: Next.js (debería detectarlo solo).
3. Cargá las variables de entorno de `.env.example` en Project Settings →
   Environment Variables (credenciales de un paquete de SFMC con permiso
   de **Contacts: Read and Write** además de Data Extensions, más
   `APP_PASSWORD` con una contraseña propia).
4. Deploy. Cada push a la rama conectada vuelve a desplegar solo.

## Correr en local

```bash
cd dedupe-app
npm install
cp .env.example .env.local   # completar los valores
npm run dev
```

## Seguridad

- Toda la app queda detrás de un login por contraseña única (`APP_PASSWORD`),
  pensado para un solo usuario — no hay cuentas ni roles.
- El nombre que confirmás se valida contra el nombre real en SFMC (no
  contra lo que mandó el navegador en un paso anterior), así un
  `customerKey` mal armado no pasa la confirmación aunque el nombre en
  pantalla sea el correcto.
- Las DEs de sistema de SFMC (`_Subscribers`, `_Sent`, etc.) están excluidas
  tanto del listado como, por las dudas, del propio endpoint de escaneo.
- Una fila sin `SubscriberKey`/`ContactKey` ni email detectable nunca se
  "adivina" — queda contada como sin resolver y no se manda a borrar.
