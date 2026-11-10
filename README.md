# Firmely Loyalty — backend (etapa 1)

Autor: Edward Fiallo. Node + Express + SQLite. Multi-negocio (cada negocio tiene su `slug`).

## Arrancar
    npm install
    DB_FILE=./data/loyalty.db CODE_SECRET=<cadena-larga-aleatoria> npm run seed   # crea "undercut" y muestra las llaves
    CODE_SECRET=<la-misma> npm start
    npm test

`CODE_SECRET` firma los QR: si cambia, todos los QR emitidos dejan de valer. Obligatorio con NODE_ENV=production.

## Roles (header `x-api-key`, opcional `x-actor` con el nombre de quien opera)
- Sin llave: info del negocio y registro del cliente.
- Caja (staff): escanear y canjear.
- Admin: todo lo anterior + panel (clientes, edición, reinicio, estadísticas, avisos).

## Endpoints  (`/api/:slug/...`)
| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| GET | /info | — | Nombre, recompensa, visitas requeridas |
| POST | /register | — | `{name, phone, consent:true}` → cliente + `code` (el del QR). Mismo teléfono = mismo pase |
| POST | /scan | caja | `{code}` → `visit` / `too_soon` / `free_available` |
| POST | /redeem | caja | `{code}` → canjea el corte gratis y reinicia a 0 |
| GET | /stats | admin | Clientes, visitas de la semana, cortes canjeados |
| GET | /customers?q= | admin | Buscar por nombre o teléfono |
| GET | /customers/:id | admin | Detalle + historial (bitácora) |
| PATCH | /customers/:id | admin | `{name?, phone?, visits?}` (0 a 10) |
| POST | /customers/:id/reset | admin | Visitas a 0 |
| GET | /stamp/:n.png | — | Imagen de sellos con n visitas (`?kind=strip&scale=1|2|3` para Apple, `?kind=hero` para Google). Usa los colores del negocio |
| POST | /notices | admin | `{audience: all|inactive|near_reward, weeks?, message, dryRun?}` |

## Reglas
- Visita: máx. 1 cada `min_hours_between_visits` (4 por defecto). Al llegar a 10 el cliente queda con premio; el siguiente escaneo devuelve `free_available` hasta canjear.
- Avisos: mensaje de hasta 80 caracteres, máx. `max_notices_per_month` (2) por cliente en 30 días. `dryRun` devuelve cuántos recibirían el aviso sin enviarlo.
- Toda acción (registro, visita, canje, edición, reinicio, aviso) queda en `events` con fecha y actor.

## Etapas siguientes
`hooks.customerChanged` y `hooks.notice` (src/server.js) son los puntos donde se enchufan Apple Wallet (APNs) y Google Wallet.

## Etapa 2: sellos
`src/stamps.js` dibuja 0..N sellos con tijeras en PNG usando los colores de marca del negocio (`brand: {bg, fg}`, hex de 6 dígitos). `appleStripFiles(visits)` devuelve `strip.png`, `strip@2x.png` y `strip@3x.png` listos para el .pkpass; la ruta `/stamp/:n` sirve las mismas imágenes por URL para Google Wallet.

## Etapa 3: Apple Wallet

Se activa si existen las variables `APPLE_*`; sin ellas el servidor corre igual, solo sin Apple.

| Variable | Qué es |
|---|---|
| `APPLE_PASS_TYPE_ID` | `pass.com.firmely.loyalty` |
| `APPLE_TEAM_ID` | Team ID (10 caracteres) |
| `APPLE_CERT_PATH` | certificado del pase en PEM (`pass-cert.pem`) |
| `APPLE_KEY_PATH` | llave privada en PEM (`pass-key.pem`) |
| `APPLE_WWDR_PATH` | certificado intermedio WWDR G4 en PEM (`wwdr.pem`) |
| `PUBLIC_URL` | URL pública HTTPS del servidor (la que usa el iPhone para actualizar el pase) |

Requiere `openssl` instalado (firma el pase).

- `GET /api/:slug/pass.pkpass?code=<código del QR>`: descarga el pase (botón "Agregar a Apple Wallet").
- `/apple/v1/...`: servicio web que usa el iPhone (registro de dispositivo, lista de pases cambiados, descarga del pase actualizado, log).
- Al sumar visita, editar, reiniciar o enviar un aviso, se manda un push a APNs y el iPhone baja el pase nuevo; la notificación sale porque los campos "Estado" y "Último aviso" tienen `changeMessage`.
- No pongas nunca la llave privada (`pass-key.pem`) en el repositorio.

## Etapa 4: Google Wallet (Android)

Se activa con `GOOGLE_ISSUER_ID` (ID de emisor de Google Pay & Wallet Console) y `GOOGLE_SA_JSON` (contenido del JSON de la cuenta de servicio; también acepta `GOOGLE_SA_JSON_B64`). Requiere `PUBLIC_URL` o el dominio público de Railway.

- `GET /api/:slug/google-wallet?code=<código del QR>`: redirige al enlace "Agregar a Google Wallet".
- Cada negocio es una clase de lealtad (`<issuer>.<slug>`) y cada cliente un objeto (`<issuer>.<slug>-<id>`).
- Al sumar visita, canjear o editar se actualiza el objeto; al sumar visita, canjear o enviar un aviso se manda un mensaje con notificación (`TEXT_AND_NOTIFY`).
- Mientras el emisor esté en modo de prueba, solo pueden agregar el pase las cuentas de Google registradas como "Test users".
