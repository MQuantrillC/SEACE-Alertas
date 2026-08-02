# CONTEXT.md — seace-alertas

> Documento vivo de contexto del proyecto. **Actualízalo al final de cada sesión de
> trabajo** (ver [Cómo mantener este doc](#cómo-mantener-este-doc) al final).
> Última actualización: **2026-08-01**.
>
> Este doc = **cómo está hoy** · [PLAN.md](PLAN.md) = hacia dónde va ·
> [API.md](API.md) = qué se puede sacar realmente de la fuente.

---

## 1. Qué es

Herramienta local (Node, sin build, sin framework) para **vigilar licitaciones
públicas del SEACE (Perú)** y detectar oportunidades comerciales para Xertica.

Tres productos en un mismo repo, todos sobre la misma fuente de datos:

| Producto | Comando | Qué es |
|---|---|---|
| **Digest** | `npm run digest` | Script one-shot: baja convocatorias de las últimas 48 h, filtra por keywords TI, escribe `out/digest-YYYY-MM-DD.html`. Con `--send` lo manda por correo. |
| **Buscador** | `npm run web` | Servidor HTTP local (`http://localhost:4321`) con UI de búsqueda/filtros/estadísticas sobre meses completos de datos. **Es el único proceso que queda corriendo.** |
| **Runner de alertas** | `npm run alertas` | Script one-shot pensado para el Programador de tareas: revisa las alertas y seguimientos creados en el buscador y envía correos si hay novedades. |

No depende de ningún otro proyecto (en particular, **no toca el Account Plan**).

## 2. Fuente de datos

API abierta **OCDS del OECE** (ex-OSCE) — datos oficiales del SEACE, **sin API key
ni login**: `https://contratacionesabiertas.oece.gob.pe`

Se usan tres vías distintas:

1. **`/api/v1/releases`** (paginado 20×) → lo usa el **digest**. Ordenado por fecha
   del *lote* OCDS, no de la convocatoria (ver Gotchas).
2. **Archivos mensuales** `/api/v1/file/seace_v3/json/YYYY/MM/` → zip con TODOS los
   procesos del mes como `compiledRelease` (incluye adjudicaciones y proveedores).
   Lo usan el **buscador** y las **alertas**. Cacheados en `out/cache/`.
3. **`buyerProcesses` / `buyerContracts` + `static/buyers.json`** → historial de
   compras por entidad y autocompletado (~3.3k entidades).

## 3. Mapa del código

```
src/
  index.mjs        Entry point del digest (fetchRecent → filtrar → renderEmail → out/ → [--send])
  seace.mjs        Cliente API /releases + normalize(): aplana un release OCDS al modelo interno
  bulk.mjs         Descarga/cachea los zips mensuales → procesos normalizados (loadRecentMonths)
  digest.mjs       fold(), toMatcher() y filtrarRelevantes() — scoring por keywords de config.json
  search.mjs       aplicarFiltros() compartido por buscador y alertas + MONTO_RANGOS + mesesParaCubrir()
  emailHtml.mjs    renderEmail(): HTML del correo/digest (tarjetas con etapas, bases, enlaces)
  send.mjs         enviar(): SMTP vía nodemailer; no-op silencioso si faltan SMTP_USER/PASS
  server.mjs       Servidor HTTP del buscador + toda la API (ver tabla abajo)
  alertas.mjs      Runner: alertas por filtros + seguimientos por proceso
  alertasStore.mjs Persistencia JSON de alertas.json y seguimientos.json
web/
  index.html       UI del buscador (HTML + CSS + JS vanilla en un archivo, ~24 KB)
  entidad.html     Vista de historial de una entidad
```

Dependencias: solo **`adm-zip`** (descomprimir los meses) y **`nodemailer`** (SMTP).
`"type": "module"`, Node ≥ 18 (aquí corre v24).

### Endpoints de `server.mjs`

| Ruta | Qué devuelve |
|---|---|
| `GET /` · `GET /entidad` | Las dos páginas HTML |
| `GET /api/buscar` | Resultados filtrados (tope 150, con flag `truncado`) |
| `GET /api/stats` | Top entidades/proveedores + distribución por categoría, departamento y mes, sobre el conjunto YA filtrado |
| `GET /api/entidades` | Catálogo `buyers.json` (cache 24 h en memoria) |
| `GET /api/entidad?id=|nombre=` | Historial de compras de una entidad |
| `GET/POST/DELETE /api/alertas` | CRUD de alertas por filtros |
| `GET/POST/DELETE /api/seguimientos` | CRUD de seguimientos por proceso (🔔) |
| `GET /api/ficha?id=` | Inspector de la ficha del SEACE (diagnóstico, ver Gotchas) |

### Modelo interno de un proceso (`normalize()` en `seace.mjs`)

`ocid`, `fecha` (publicación real = `tender.datePublished`), `nomenclatura`,
`descripcion`, `items[]`, `entidad`, `categoria`, `metodo`, `monto`, `moneda`,
`cierreOfertas`, `etapas[]`, `basesUrl`, `departamento`, `estados[]`,
`proveedores[]`, `adjudicaciones[]` (monto real por award).

## 3.bis Capa nueva: datos.db (SQLite)

⚠ **Estado de la migración (2026-08-01).** El buscador (`npm run web`) ya corre
entero sobre SQLite. **El digest (`npm run digest`) y el runner de alertas
(`npm run alertas`) siguen en el camino viejo** (`bulk.mjs`, `search.mjs`,
`alertasStore.mjs`, `alertas.json`) y arrastran sus bugs. Se migran en el
siguiente paso; por eso esos módulos todavía no se borran.

```
src/db.mjs         Esquema y conexión de datos/datos.db (gitignored)
src/ingesta.mjs    Zips mensuales del OECE → SQLite.  npm run ingesta
src/buscar.mjs     Búsqueda, autocompletados, facetas, estadísticas y vencimientos
src/server.mjs     Servidor (reescrito): rutas de sesión + API sobre SQLite
src/verificar*.mjs Comprobaciones: datos, siglas, búsqueda y cuentas
siglas.json        92 siglas → nombre oficial (ESSALUD → SEGURO SOCIAL DE SALUD)
web/entrar.html    Pantalla de acceso
web/app.html/.css/.js   Buscador nuevo
```

Estado actual de la base: **23 meses · 152.173 procesos · 3.316 entidades ·
168.863 RUCs · 775.606 documentos · 1,68 M participaciones de postores · 1,1 GB.**

Comandos:

```bash
npm run ingesta                  # últimos 24 meses; salta los ya cargados
npm run ingesta -- --meses 6
npm run ingesta -- --desde 2025-01
npm run ingesta -- --rehacer     # fuerza recarga
node src/verificar.mjs           # integridad y bugs conocidos
node src/verificar-siglas.mjs    # que cada sigla resuelva
node src/verificar-buscar.mjs    # humo + tiempos de búsqueda
```

Rendimiento medido sobre los 152 k procesos: búsquedas 12-170 ms, autocompletado de
entidad 4-17 ms, de proveedor ~70 ms.

## 3.ter Capa nueva: cuentas.db (acceso e invitaciones)

```
src/cuentas.mjs         Esquema de datos/cuentas.db + utilidades de usuario
src/auth.mjs            Enlace mágico, sesiones, invitaciones, cookies
src/correosAuth.mjs     Plantillas HTML de acceso e invitación
src/usuario.mjs         CLI de cuentas.  npm run usuario
src/verificar-cuentas.mjs  30 pruebas sobre base temporal.  npm test
```

Reglas que NO hay que romper al tocar esto:

- **El registro por web está cerrado** (`REGISTRO_ABIERTO=1` lo abre). Un correo
  desconocido que pide acceso no crea cuenta ni recibe nada, y el mensaje es
  idéntico al de un correo válido para no filtrar quién tiene cuenta.
- **Los tokens se guardan hasheados** (sha256). El valor en claro solo existe en el
  correo del usuario y en su cookie.
- **`auth.destinatarios(alertaId)` es el único camino para enviar** un correo de
  alerta: devuelve solo quien aceptó la invitación. Nunca enviar a una lista suelta.
- Invitación: caduca a los 7 días, un solo uso, y aceptarla verifica el correo e
  inicia sesión. Mientras esté `pendiente`, esa persona no recibe nada.
- Cookie `seace_sesion`: HttpOnly + SameSite=Lax; `COOKIE_SECURE=1` añade Secure
  cuando se sirva por HTTPS.

Variables de entorno nuevas: `BASE_URL` (para los enlaces de los correos),
`REGISTRO_ABIERTO`, `COOKIE_SECURE`, `CUENTAS_DB`.

```bash
npm run usuario -- --crear ana@estudio.pe --nombre "Ana" --estudio "Estudio X"
npm run usuario -- --enlace ana@estudio.pe   # acceso sin enviar correo
npm run usuario -- --listar
npm test                                     # cuentas + datos + siglas
```

## 4. Cómo correrlo

Node ≥ 18 (verificado con v24.18.0). Desde la raíz del proyecto:

```bash
npm install
```

**Buscador — este es "el dev server":**

```bash
npm run web
```

→ `http://localhost:4321`. Puerto configurable con `PORT`. Se detiene con `Ctrl+C`.
La **primera búsqueda de cada rango de meses descarga el zip mensual** (tarda; el mes
de julio son ~44 MB ya descomprimido). Después es instantáneo: cache en disco
(`out/cache/`) + cache en memoria de 30 min por número de meses.
No hay hot-reload — tras editar `src/*.mjs` hay que reiniciar el proceso; los cambios
en `web/index.html` solo necesitan recargar el navegador (se lee del disco en cada request).

**Digest:**

```bash
npm run digest
```

Genera `out/digest-YYYY-MM-DD.html` y lo lista en consola. Para enviarlo por correo:

```bash
npm run digest:send
```

**Alertas (lo que se programa en el Task Scheduler):**

```bash
npm run alertas
```

### Correo

Copia `.env.example` → `.env` y completa `SMTP_HOST/PORT/USER/PASS`. Con Google
Workspace hay que usar una *contraseña de aplicación*. Los scripts ya cargan `.env`
solos (`node --env-file-if-exists=.env`) — no hace falta exportar nada.
Sin `SMTP_USER`/`SMTP_PASS` el envío se omite con un aviso; el digest igual se genera.

## 5. Configuración y estado

| Archivo | Versionado | Qué guarda |
|---|---|---|
| `config.json` | sí | `diasHaciaAtras` (2), `maxPaginas` (300), `palabrasAlta/Media/Excluir`, `destinatarios`, `asuntoPrefijo` |
| `.env` | **no** (gitignored) | Credenciales SMTP |
| `alertas.json` | **no** | Alertas por filtros. Cada una: `emails[]`, `nombre`, `filtros`, `ultimaFecha` (corte) |
| `seguimientos.json` | **no** | Procesos seguidos con 🔔 + snapshot de estado |
| `out/cache/*.json` | **no** | Meses descargados. **Pesan mucho** (~220 MB hoy: mayo 108 MB, junio 67 MB, julio 44 MB). Borrables sin riesgo. |
| `out/digest-*.html`, `out/alertas.log` | **no** | Salidas |

**Sintaxis de keywords** (las tres listas de `config.json`): texto plano = subcadena,
o `"/regex/"` entre barras. Todo se compara contra texto **plegado** (minúsculas, sin
tildes) → escribe los patrones sin tildes (`migraci.n`, no `migración`). Una regex
inválida se ignora con un aviso, no rompe nada.
Scoring: alta = 10 pts, media = 1 pt; las de exclusión descartan el proceso **salvo**
que también haya señal alta.

## 6. Gotchas verificados (no re-descubrir)

- **`release.date` ≠ fecha de convocatoria.** `release.date` es la hora del lote de
  conversión OCDS (igual para cientos de procesos). La fecha real es
  `tender.datePublished`. Por eso `fetchRecent()` pagina mientras el *lote* esté en
  rango pero filtra por la fecha real de cada proceso.
- **`tenderPeriod` es la ventana del proceso** (convocatoria → presentación de
  ofertas), *nunca* la duración del contrato. Si inicio y fin caen el mismo día, el
  SEACE solo publicó la convocatoria — se etiqueta distinto para no inducir a error.
- **Solo hay dos periodos en datos abiertos** (verificado escaneando 300 procesos):
  `tenderPeriod` y a veces `enquiryPeriod`. El cronograma etapa-por-etapa completo
  solo está en las bases (PDF) y en la ficha del buscador SEACE.
- **La ficha del SEACE no es deep-linkeable.** Verificado con `/api/ficha`: fuera de
  una sesión del buscador devuelve solo el esqueleto HTML, sin datos. No se puede
  automatizar por ese camino.
- **Los montos referenciales suelen venir en 0** (protegidos hasta la buena pro).
  De ahí la banda de filtro "Sin monto publicado" (`s0`).
- **Estadísticas de proveedores usan el monto del award**, no el referencial del
  proceso: un proceso multi-award (ej. medicinas) se reparte entre varios ganadores.
- **`buyerID`, no `buyer`.** En `buyerProcesses`/`buyerContracts` el parámetro
  correcto es `buyerID`; con `buyer` la API ignora el filtro y devuelve todo el
  dataset. Los contratos no aceptan orden — se ordenan en local sobre una muestra de 50.
- **Frescura:** el OECE regenera el archivo mensual ~1 vez al día, así que el filtro
  "Hoy" puede tardar horas en poblarse. Lo de ayer siempre está.
- **El corte de una alerta avanza a la publicación más reciente enviada**, no a
  "ahora", para no saltarse el hueco si el bulk se regenera con retraso.
- Tope de 50 procesos por correo de alerta (una alerta sin filtros matchea cientos).
- **Los nombres de entidad del catálogo NO coinciden byte a byte con los del bulk.**
  Catálogo: `"SEGURO SOCIAL DE SALUD"`; datos: `"SEGURO SOCIAL DE  SALUD"` (doble
  espacio). `fold()` no colapsa espacios → elegir EsSalud en el autocompletado da
  **0 resultados**. 19 entidades / 180 procesos afectados en julio 2026; colapsar
  espacios arregla 1372/1372. Ver [PLAN.md](PLAN.md) §1.1.
- **Las siglas no existen en el dato.** `ESSALUD`, `MINSA`, `MINEDU`, `PETROPERU`,
  `INDECOPI`, `OSINERGMIN` → 0 coincidencias en las 3.316 entidades del catálogo.
  Buscar por sigla exige un diccionario propio. Ver [PLAN.md](PLAN.md) §1.2.
- **La lista de estados de `web/index.html` está incompleta**: los datos traen 12
  estados, la UI ofrece 8. Faltan `SUSPENDIDO`, `RETROTRAIDO_POR_RESOLUCION`,
  `DEJAR_SIN_EFECTO_ADJUDICACION`, `PENDIENTE_DE_REGISTRO_DE_EFECTO`.
  (Resuelto en el buscador nuevo: la lista sale de los datos — 14 estados.)
- **El objeto de contratación llega con 3 valores, no con los 4 del SEACE.**
  "Consultoría de Obra" viaja dentro de `services` y `additionalProcurementCategories`
  solo duplica el valor principal. Se reconstruye en la ingesta
  (`procesos.es_consultoria`) con UNSPSC 8110 + método "consultor" — 14.593 procesos
  en 24 meses. Ver [API.md](API.md) §2.
- **`iso()` del frontend usa UTC** → después de las 19:00 de Lima, el filtro "Hoy"
  pide el día siguiente y devuelve 0 resultados.
- **Cobertura de datos (julio 2026, 5.576 procesos)**: monto referencial > 0 en el
  **43,6 %**, adjudicaciones en el **23,9 %**, departamento en el **100 %**. Por eso
  las estadísticas por monto son un ranking parcial, no el total real.
- **`buyer.id` coincide con las claves de `buyers.json` en 5.576/5.576.** Filtrar por
  id en vez de por nombre elimina de raíz el problema del doble espacio.
- **Las estadísticas del buscador viejo suman monedas distintas** (USD/EUR/GBP como
  soles). `amount_PEN` corrige eso, pero **no está siempre**: falta en el 10 % de los
  procesos en USD con monto real. La ingesta lo deja en NULL, nunca en 0.
- **El "cierre de ofertas" prácticamente no existe en datos abiertos.**
  `tenderPeriod.endDate` coincide con el día de publicación en el 95,6 % de los
  casos, y de los 6.653 restantes **5.229 (79 %) son ANTERIORES a la publicación**
  — plazos que vencieron meses antes de que el proceso saliera. Tras exigir que sea
  posterior quedan **1.424 en 24 meses (0,9 %)**. No se puede prometer.
  El plazo utilizable es `enquiryPeriod.endDate` (consultas y observaciones):
  107.192 coherentes frente a 1.051 anteriores a la publicación.
- **`tender.tenderers[]` existe y no se usa**: 9.545 postores en julio (29,9 % de los
  procesos), todos con RUC. Es "quién se presentó", no solo quién ganó.
- **`/api/v1/suppliers` no admite búsqueda por nombre** (probado con `search`, `name`,
  `q`, `supplierName`: devuelve los 497.911 completos). Buscar proveedores exige
  índice propio; el detalle sí se baja con `supplierID=PE-RUC-…`.
- **La ficha del SEACE tiene campos que la API no publica**: Normativa Aplicable
  (Ley 32069/30225), Causal, Tipo de Compra, Derecho de Participación y el cronograma
  completo etapa-por-etapa. Verificado por búsqueda directa en el bulk. Ver
  [API.md](API.md) §5 — no prometer esos campos.

## 7. Estado actual (2026-08-01)

- Funcionando end-to-end: digest, buscador (con estadísticas, historial por entidad,
  autocompletado) y runner de alertas.
- `alertas.json` tiene **2 alertas de prueba** ("Prueba" con `q=essalud` y "Prueba 2"
  sin filtros), ambas a marco.quantrill@xertica.com. Sin seguimientos.
- `out/alertas.log` muestra corridas hasta el **2026-07-31**, sin novedades → el
  runner ya está programado y corriendo (Task Scheduler).
- Último código tocado: `src/seace.mjs`, `src/server.mjs`, `web/index.html` (2026-07-11).
- **Bajo control de versiones desde el 2026-08-01**:
  <https://github.com/MQuantrillC/SEACE-Alertas> (rama `main`).
- **Cambio de rumbo (2026-08-01):** el público objetivo pasa de "Xertica buscando
  oportunidades TI" a **estudios de abogados que monitorean el SEACE**. Se quita
  "Solo TI" del buscador y la búsqueda pasa a dos campos explícitos
  (Entidad / Descripción del Objeto). Plan completo en [PLAN.md](PLAN.md).

## 8. Ideas / pendientes

Prioridad y detalle en [PLAN.md](PLAN.md). Resumen:

- **Bugs primero**: colapsar espacios en `fold()`, fechas en hora de Lima, estados
  desde los datos (§6).
- Fase 1: dos campos de búsqueda + diccionario de siglas, quitar "Solo TI",
  frecuencia por alerta, "Probar ahora", recordar correo, filtros en la URL.
- Estadísticas: toggle procesos/monto, KPIs, barras clicables, "Próximos cierres".
- Migrar el almacenamiento a SQLite + FTS5 (destraba paginación, orden y escala).
- Deploy en Cloud Run + Cloud Scheduler; confirmación de correo, baja y auth mínima.
- Limpiar las alertas de prueba; purga del cache de `out/cache/`.
- `config.json` lleva un correo real en `destinatarios` y está commiteado — sacarlo
  si el repo pasa a público.

---

## Cómo mantener este doc

Al terminar una sesión de trabajo, actualiza:

1. La **fecha** de la cabecera.
2. **§3 Mapa del código** si se añadió/renombró un archivo o endpoint.
3. **§6 Gotchas** con cualquier comportamiento raro de la API que se haya verificado
   (el objetivo es no volver a investigarlo nunca).
4. **§7 Estado actual** — qué quedó funcionando y qué quedó a medias.
5. **§8 Pendientes** — mueve a §7 lo que se completó.

Mantén `README.md` como el "cómo se usa" para una persona nueva, y este archivo como
el "cómo está y por qué" para retomar el trabajo.
