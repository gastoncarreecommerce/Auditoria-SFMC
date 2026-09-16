# SFMC — Vaciar Data Extensions

Herramienta interna: elegís una Data Extension, confirmás escribiendo su
nombre exacto, y borrás sus filas de a tandas (hasta 500 por click) hasta
dejarla vacía. La DE en sí no se borra, solo sus filas.

## Cómo funciona el borrado

SFMC no tiene un endpoint de "vaciar toda la DE" — hay que borrar fila por
fila identificándola por su clave primaria. Esta app:

1. Trae la página 1 del rowset de la DE (hasta 500 filas).
2. Las borra por SOAP usando su(s) campo(s) de clave primaria real (no los
   que la auditoría detecta como "parece DNI/email" — la clave primaria de
   verdad, la que exige SFMC).
3. Repite: como cada tanda borra lo que trajo, la "próxima página 1"
   siempre son filas todavía no tocadas. No hace falta llevar offset.

Cada tanda es una llamada HTTP separada, disparada por el botón (o por el
modo "seguir automáticamente", que simplemente sigue apretando el mismo
botón solo, con un respiro de 400ms entre tandas). Así una DE de millones
de filas no depende de que una sola función serverless aguante horas
corriendo — cosa que Vercel no permite.

## Deploy en Vercel

1. Este proyecto vive en `dedupe-app/` dentro del repo `Auditoria-SFMC`,
   no en la raíz. Al crear el proyecto en Vercel, en **Root Directory**
   elegí `dedupe-app`.
2. Framework Preset: Next.js (debería detectarlo solo).
3. Cargá las variables de entorno de `.env.example` en Project Settings →
   Environment Variables (las mismas credenciales de SFMC que usa el resto
   del repo, más `APP_PASSWORD` con una contraseña propia).
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
  tanto del listado como, por las dudas, del propio endpoint de borrado.
