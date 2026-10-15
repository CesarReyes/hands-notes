# Análisis de GoodNotes (base de diseño)

Fecha: 2026-10-15. Herramienta: REA (reverse-engineer-anything) más fuentes públicas.

## Qué se pudo analizar

| Versión | Acceso | Resultado |
| --- | --- | --- |
| Web (`web.goodnotes.com`) | Captura de navegador con REA, sin sesión iniciada | Se exportaron y analizaron estáticamente 145 módulos JS (2,5 MB). El editor completo y su binario Wasm solo cargan tras iniciar sesión, y no inicié sesión con credenciales reales |
| Android | Fuente pública (case study de web.dev) | Es la misma PWA empaquetada como Trusted Web Activity. El análisis web la cubre |
| Windows | Fuente pública | La misma PWA, empaquetada con PWABuilder |
| iPad / iOS | No disponible | El IPA de la App Store está cifrado con FairPlay y no hay un artefacto descargable analizable |

Evidencia REA: captura `capture_browser_scenario`; scripts exportados `export_web_scripts`; grafo de aplicación `ev_25e0ab16e10093841e98bb233c3bcc6d85eda099954d7115b7a193fb2a02b993` (resumen `ev_3620c6921f1984fcb0f2ba569c8db5f8f9da39c25227e69d48b18fcda0056ab4`).

## Observaciones (bundle web)

- **Herramientas del editor:** enumeración con `PEN_TOOL_OPTIONS`, `PENCIL_TOOL_OPTIONS`, `HIGHLIGHTER_TOOL_OPTIONS`, `ERASER_TOOL_OPTIONS`, `LASSO_TOOL_OPTIONS`, `TAPE_TOOL_OPTIONS`, `LASER_POINTER_TOOL_OPTIONS`, `SHAPE_*`, `TEXT_COLOR_TOOL` y `STICKY_NOTES_TOOL_COLOR` (`FullScreenModal-*.js`).
- **Grosor:** cada herramienta usa `tripleThicknessOption`, es decir, tres grosores predefinidos por herramienta.
- **Selector de color:** presets con índice (`selectedPresetIndex`, `addingPreset`), modelos HSL, RGB y hex, color propio del resaltador y polyfill de cuentagotas (`model-*.js`).
- **Textos de onboarding:** "Drag the highlighter over any text or drawing", "Grab the eraser and swipe over any stroke to clear it" y "Circle a section with the lasso, then drag it into place".
- **Modos del lazo:** `toolbar.lasso.mode`. También hay dibujo de líneas discontinuas detrás de un feature flag.
- **Tipos de documento:** `Standard` (cuaderno), `NexusDocument`, pizarra (`whiteboard`) y `StudySet`. Hay favoritos, carpetas, papelera, compartir y plantillas dinámicas.
- **Modelo del editor:** `editor.activeDocumentId`, `pages[].id`, selección múltiple de páginas, rotaciones programadas y miniaturas con estado de carga.
- **CRDT:** el bundle incluye `yjs` (`yjs-*.js`). Encaja con lo publicado: la colaboración usa CRDT y el trabajo offline usa IndexedDB.
- **Backend:** `api.goodnotesbeta.com` e identidad con Ory Kratos (`kratos.goodnotesbeta.com`). Login con Google, Microsoft, Apple, SSO y código de un solo uso.

## Inferencias (fuentes públicas)

- GoodNotes compiló su base Swift de iOS a WebAssembly con SwiftWasm, con React y TypeScript para la UI. Pasó de nodos DOM a un **canvas a pantalla completa** para el documento, y usa Workbox para la caché del service worker.
- El equipo dijo que en retrospectiva habría usado OffscreenCanvas y workers para el render.

## Decisiones para Hands Notes

| GoodNotes | Hands Notes |
| --- | --- |
| PWA para Android, Windows y Web, más app nativa en iPad | Una PWA para iPad y Android. Hoy Safari y Chrome entregan presión y eventos combinados del lápiz |
| Canvas a pantalla completa | Igual. Capa base con caché por página, más una capa de tinta de baja latencia |
| Tres grosores y presets de color | Igual: tres grosores por herramienta y 5 presets editables |
| Pluma, resaltador, borrador y lazo | Igual, más borrador parcial y línea recta al mantener el trazo |
| CRDT (Yjs) e IndexedDB | IndexedDB más LWW por trazo. Los trazos son casi inmutables, así que el LWW por fila da la misma convergencia sin el costo de un CRDT por documento |
| Login con código por correo | Correo y contraseña; confirmación de la cuenta por enlace una sola vez (el código de 6 dígitos requiere SMTP propio en el plan gratuito) |

Fuera de alcance en v1: texto tipado, imágenes, cinta, puntero láser, figuras, audio, IA, colaboración y búsqueda en manuscrito.
