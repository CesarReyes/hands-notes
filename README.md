# Hands Notes

Notas a mano para tablets, inspiradas en GoodNotes. Escribe con Apple Pencil en iPad o con S Pen / lápiz activo en Android, y abre tus cuadernos actualizados en cualquier dispositivo.

**App:** https://cesarreyes.github.io/hands-notes/

## Instalar en tu tablet

La app es una PWA, el mismo modelo que GoodNotes usa para Android, Windows y Web.

- **iPad (Safari):** abre la URL, toca Compartir y luego **Agregar a pantalla de inicio**. Ábrela desde el ícono: corre a pantalla completa y funciona sin conexión.
- **Android (Chrome):** abre la URL, toca el menú ⋮ y luego **Instalar app**.

La primera vez, entra en **Cuenta** (ícono de persona) y crea tu cuenta con correo y contraseña. Te llega un código de 6 dígitos para confirmar. En los demás dispositivos entra con el mismo correo y contraseña.

## Qué hace

- **Tinta sensible a la presión** con tres plumas (fuente, bolígrafo, pincel), tres grosores y paleta de 5 colores editable. Toca el color activo para cambiarlo.
- **Resaltador** translúcido que queda detrás de la tinta.
- **Borrador** de trazo completo o parcial. El botón del S Pen y la goma de los lápices Wacom/Surface borran directamente.
- **Lazo** para seleccionar, mover, recolorear, duplicar o borrar trazos.
- **Mantener para línea recta:** termina un trazo y espera un instante.
- **Rechazo de palma:** al detectar el lápiz, los dedos solo desplazan y hacen zoom (configurable).
- **Gestos:** pellizcar para zoom (hasta 800 %, siempre nítido), toque con dos dedos para deshacer y con tres para rehacer.
- **Papel:** rayado, cuadriculado, puntos, Cornell o en blanco, sobre fondo blanco, crema u oscuro. Se elige por página.
- **Páginas:** añadir, duplicar, reordenar y eliminar, con panel de miniaturas.
- **Biblioteca** con portadas, miniaturas y búsqueda.
- **Exportar a PDF vectorial.**
- **Sin conexión primero:** todo se guarda al instante en el dispositivo y se sincroniza al volver la red. Los cambios de otro dispositivo aparecen en vivo.

## Arquitectura

| Capa | Elección | Por qué |
| --- | --- | --- |
| UI | React 18 + TypeScript, Vite | Un solo código para iPad, Android y escritorio |
| Motor de tinta | Canvas 2D propio + `perfect-freehand` | Contorno por presión. Una capa de tinta de baja latencia (`desynchronized`), eventos combinados y predichos del puntero, y caché de páginas en bitmap con dibujo vectorial directo al hacer zoom profundo |
| Datos locales | IndexedDB (Dexie) | Escritura instantánea y uso completo sin conexión |
| Sync | Supabase (Postgres + Realtime + Auth) | Filas por trazo, último en escribir gana (LWW) por `updated_at`, cursor `server_ts` y tiempo real filtrado por usuario |
| PWA | `vite-plugin-pwa` (Workbox) | Instalable y con caché offline del shell |

### Modelo de datos

`notebooks` → `pages` (orden fraccional) → `strokes`. Los puntos de cada trazo viajan como `x, y, presión` cuantizados en Int16 y codificados en base64, unos 8 bytes por punto. Los IDs son UUIDv7, que se ordenan por tiempo, así el orden z de los trazos coincide en todos los dispositivos. Borrar es una nueva versión con `deleted = true`, así que deshacer y borrar se sincronizan igual que cualquier edición. RLS limita cada fila a su dueño, y las RPC `push_*` hacen upserts LWW en lote.

### Sincronización

1. Cada escritura local marca la fila como `dirty` y programa un envío (debounce de 600 ms).
2. El envío llama a `push_<tabla>(jsonb)`. Solo limpia `dirty` si la fila no cambió mientras la petición estaba en vuelo.
3. La descarga lee `server_ts >= cursor − 5 s`. Ese solapamiento cubre transacciones confirmadas tarde. Un cambio remoto se aplica si es más nuevo; una edición local pendiente solo cede ante una estrictamente más nueva.
4. Realtime (`postgres_changes`) aplica los cambios en vivo. Si el canal falla se reconstruye con backoff, y cada 45 s hay una descarga incremental de respaldo.
5. El reloj es monotónico y nunca queda por detrás de un timestamp remoto visto, para que una tablet con la hora atrasada no pierda sus ediciones.

## Desarrollo

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run build
```

Para probar la sincronización de punta a punta sin tocar producción, levanta Supabase local (requiere Docker) y usa el modo `localtest`, que apunta a `http://127.0.0.1:55321`:

```bash
supabase start -x studio,imgproxy,edge-runtime,logflare,vector,storage-api,postgres-meta,supavisor,mailpit
```

```bash
npm run dev -- --mode localtest --port 5174
```

Abre `http://localhost:5174` y `http://127.0.0.1:5174`. Son dos orígenes con almacenamiento separado, así que funcionan como dos dispositivos. Las migraciones están en `supabase/migrations/`, y la configuración de Auth (correo con código de 6 dígitos) en `supabase/config.toml` y `supabase/templates/`.

El despliegue es automático: cada push a `main` corre las pruebas, construye y publica en GitHub Pages (`.github/workflows/deploy.yml`).

## Límites conocidos

- El correo de Supabase por defecto tiene un límite bajo de envíos por hora y solo entrega a miembros del equipo de la organización. Para más usuarios, configura un SMTP propio en Supabase.
- Si dos dispositivos editan el **mismo** trazo sin conexión, gana la última edición. Los trazos nuevos nunca chocan.
- Pendiente para siguientes versiones: búsqueda en manuscrito y conversión a texto, imágenes, importar PDF para anotar, figuras reconocidas y colaboración compartida.
