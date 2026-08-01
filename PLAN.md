# PLAN.md — De herramienta interna a producto para estudios de abogados

> Estado: **propuesta, sin implementar**. Fecha: 2026-08-01.
> Complementa [CONTEXT.md](CONTEXT.md) (qué existe hoy). Este doc es el **hacia dónde**.

---

## 0. El cambio de público

Hoy la app está construida para **Xertica buscando oportunidades TI**: keywords de
`config.json`, scoring de afinidad, filtro "Solo TI", digest diario de nube/datacenter.

El nuevo objetivo es un **estudio de abogados que monitorea el SEACE**: no quiere
"lo relevante para mí según unas keywords", quiere **exactamente lo que pidió**
(esta entidad, este objeto) y **que le avise cuando aparezca algo nuevo**.

Eso cambia tres cosas de fondo:

| | Hoy (Xertica TI) | Objetivo (estudio) |
|---|---|---|
| Búsqueda | 1 campo catch-all + scoring por afinidad | 2 campos explícitos, resultado literal y predecible |
| Relevancia | la decide `config.json` | la decide el usuario, y queda guardada |
| Alertas | 1 cadencia global (lo que diga el Task Scheduler) | cadencia **por alerta**, elegida por el usuario |

Consecuencia directa: **se quita "Solo TI"** (como pediste) y con él, del buscador,
todo el aparato de scoring. `filtrarRelevantes()` no se borra — sigue siendo el motor
del digest, que queda como un producto aparte de Xertica.

---

## 1. Hallazgos de la revisión (verificados con datos de julio 2026)

Antes de proponer features, tres cosas que **están rotas o engañan hoy**. Todas
verificadas contra `out/cache/2026-07.json` (5.576 procesos).

### 1.1 🔴 El autocompletado de entidad devuelve CERO resultados para EsSalud

El nombre en el catálogo oficial (`buyers.json`) y el nombre en los datos mensuales
**no coinciden byte a byte**:

```
catálogo : "SEGURO SOCIAL DE SALUD"      ← lo que ofrece el autocompletado
datos    : "SEGURO SOCIAL DE  SALUD"     ← doble espacio
```

`fold()` normaliza tildes y mayúsculas pero **no colapsa espacios**, así que el
filtro `fold(p.entidad).includes(fold(entidad))` falla. Eliges EsSalud en el
desplegable → 0 resultados, sin ningún error que lo explique.

Alcance en julio: **19 entidades / 180 procesos** con este problema. Colapsar
espacios (`.replace(/\s+/g,' ')`) lo arregla al **100 %** (1372/1372 entidades).
Pero una de esas 19 es EsSalud, el mayor comprador de salud del país.

### 1.2 🔴 "ESSALUD" como texto no encuentra a EsSalud como entidad

Ninguna sigla está en el catálogo: `ESSALUD`, `MINSA`, `MINEDU`, `PETROPERÚ`,
`INDECOPI`, `OSINERGMIN` → **0 coincidencias** en las 3.316 entidades.
Los nombres oficiales son "SEGURO SOCIAL DE SALUD", "MINISTERIO DE SALUD", etc.

O sea: el campo que pides — *"Nombre **o Sigla** de Entidad"* — **hoy no puede
funcionar con siglas**, porque el dato no las trae. Hay que construir un
**diccionario de siglas** nuestro (ver §2.1).

> Nota práctica: tu alerta de prueba `q = "essalud"` lleva semanas devolviendo
> "sin novedades". No es que no haya procesos — hay **119 en julio**. Es que
> matchean por el texto de la descripción, no por entidad, y el corte de fecha ya
> había pasado. Los dos bugs de arriba explican el comportamiento.

### 1.3 🟠 El filtro "Estado" no ofrece los estados que más le importan a un abogado

La lista está hardcodeada en `web/index.html` con 8 estados. Los datos reales de
julio traen 12. Faltan justo los **jurídicamente interesantes**:

```
en la UI  : CONVOCADO ADJUDICADO CONSENTIDO CONTRATADO DESIERTO NULO APELADO CANCELADO
faltantes : SUSPENDIDO · RETROTRAIDO_POR_RESOLUCION · DEJAR_SIN_EFECTO_ADJUDICACION
            CONTRATACION_DIRECTA · PENDIENTE_DE_REGISTRO_DE_EFECTO
```

Son pocos procesos (1-60 al mes) pero son **exactamente** el tipo de evento que un
estudio quiere cazar: impugnaciones, suspensiones, retrotracciones. La lista debe
salir de los datos, no de una constante.

### 1.4 🟠 El filtro "Hoy" se rompe después de las 19:00 (hora Lima)

`iso()` en el frontend hace `toISOString()` → UTC. A las 20:00 de Lima ya es el día
siguiente en UTC, así que "Hoy" pide `desde = mañana` y devuelve 0 resultados.
Afecta también a "Esta semana" y "Este mes" en su día de corte.

### 1.5 🟡 Nadie puede volver a entrar a sus alertas sin recordar el correo exacto

El correo es la identidad, no se guarda en el navegador, y `GET /api/alertas?email=`
lista las alertas de cualquiera que sepa el correo. Para uso interno pasa; para un
estudio con varios abogados, no.

---

## 2. Fase 1 — Lo que pediste

### 2.1 Dos campos de búsqueda separados

```
┌────────────────────────────────────────────────────────────────┐
│  Nombre o Sigla de Entidad          Descripción del Objeto     │
│  ┌──────────────────────────┐       ┌────────────────────────┐ │
│  │ ESSALUD              ▾   │       │ servicio de limpieza   │ │
│  └──────────────────────────┘       └────────────────────────┘ │
│   ╳ Seguro Social de Salud                                     │
│   ╳ Ministerio de Salud            Cualquiera de estas palabras│
│                                     ○ Todas  ● Cualquiera      │
└────────────────────────────────────────────────────────────────┘
```

Reglas:

- **Los dos son opcionales e independientes.** Solo entidad → todo lo de esa
  entidad. Solo objeto → ese objeto en todo el Estado. Los dos → intersección.
  Ninguno → todo lo publicado en el periodo.
- **Entidad** = typeahead sobre el catálogo oficial, **multi-selección con chips**
  (un estudio vigila un set fijo de entidades, no una). Varias entidades = OR.
- **Sigla**: diccionario propio `siglas.json` (`ESSALUD → SEGURO SOCIAL DE SALUD`,
  `MINSA → MINISTERIO DE SALUD`, …). Arrancar con las ~150 entidades más activas
  (cubren la mayoría del volumen) y ampliar. El typeahead busca en nombre **y** en
  sigla y siempre muestra el nombre oficial, para que el usuario vea qué eligió.
- **Descripción del Objeto** busca solo en `descripcion + nomenclatura + items`.
  **No** en entidad ni en proveedores — esos tienen su propio campo. Es un cambio
  respecto del `q` actual, pero es lo que hace el resultado predecible.
- Se cae el `/regex/` del campo visible. Quien lo necesite, que use "Búsqueda
  avanzada" (plegable). Un abogado no debe toparse con sintaxis regex.
- Se añade un **tercer campo opcional "Proveedor / Postor"** — hoy esa capacidad
  existe escondida dentro de `q` y es demasiado valiosa para perderla: es el
  "¿qué ha ganado la competencia / mi cliente?".

**Prerrequisito técnico:** arreglar 1.1 (colapsar espacios) o el multi-select de
entidades nace roto.

### 2.2 Frecuencia por alerta

```
┌─ Nueva alerta ────────────────────────────────────────────┐
│ Nombre     [ EsSalud · servicios de limpieza            ] │
│ Enviar a   [ maria@estudio.pe ] [ jlopez@estudio.pe ] [+] │
│                                                           │
│ ¿Cada cuánto?                                             │
│   ○ Apenas se publique      (revisa cada hora, 7–20 h)    │
│   ● Una vez al día          [ 08:00 ▾ ]                   │
│   ○ Dos veces al día        [ 08:00 ▾ ] [ 17:00 ▾ ]       │
│   ○ Semanal                 [ Lunes ▾ ] [ 08:00 ▾ ]       │
│                                                           │
│ ☐ Avísame también cuando no haya novedades                │
│                                                           │
│ Filtros: Seguro Social de Salud · "limpieza" · Lima       │
│                                     [ Cancelar ] [ Crear ]│
└───────────────────────────────────────────────────────────┘
```

Modelo de datos (extiende `alertas.json`, retrocompatible):

```json
{
  "frecuencia": { "tipo": "diaria", "horas": ["08:00"], "diaSemana": null, "tz": "America/Lima" },
  "proximoEnvio": "2026-08-02T13:00:00Z",
  "ultimoEnvio":  "2026-08-01T13:00:00Z",
  "pausada": false,
  "enviarVacios": false
}
```

Arquitectura del runner — **el scheduler se vuelve tonto y la app inteligente**:

- Task Scheduler / Cloud Scheduler invoca `npm run alertas` **cada hora**, siempre.
- El runner carga los procesos **una sola vez** por invocación y luego procesa
  **solo las alertas cuyo `proximoEnvio <= ahora`**. Tras enviar, recalcula
  `proximoEnvio` según la frecuencia. Añadir cadencias nuevas no toca el scheduler.
- **Horario hábil**: nunca enviar entre 20:00 y 07:00 (Lima). Se acumula y sale a
  las 07:00.
- El corte anti-duplicados (`ultimaFecha`) ya funciona bien y no cambia.

**Límite honesto de frescura:** los archivos mensuales se regeneran **~1 vez al
día**. "Apenas se publique" sobre datos mensuales sería mentira. Para que la opción
horaria signifique algo, el runner debe hacer un **híbrido**: bulk mensual (base) +
`fetchRecent()` sobre `/releases` (que sí se actualiza durante el día) para las
últimas 48 h, fusionado por `ocid`. Una fetch por invocación, no por alerta.

### 2.3 Arreglos que van en el mismo viaje

| # | Arreglo | Por qué ahora |
|---|---|---|
| 1 | Colapsar espacios en `fold()` | Sin esto el campo de entidad nace roto (§1.1) |
| 2 | Estados desde los datos, no hardcodeados | Habilita el caso de uso legal (§1.3) |
| 3 | Fechas en hora de Lima, no UTC | "Hoy" funciona de noche (§1.4) |
| 4 | Recordar correo en `localStorage` | Deja de retipear en cada visita (§1.5) |
| 5 | Filtros en la URL | Enlaces compartibles entre abogados del estudio |
| 6 | Botón **"Probar ahora"** por alerta | Sin él nadie confía en que la alerta funciona |
| 7 | Quitar "Solo TI" del buscador | Pedido explícito |

El #6 es más importante de lo que parece: hoy creas una alerta y no pasa **nada**
visible hasta mañana. "Probar ahora" manda el correo con lo que habría enviado —
convierte un acto de fe en una confirmación inmediata.

---

## 3. El panel de estadísticas

Te gusta, y con razón: es lo que diferencia esto de la búsqueda del SEACE. Pero hoy
**mide mal**.

### 3.1 El problema de fondo: solo el 43,6 % de los procesos publica su monto

De 5.576 procesos de julio, **2.430 (43,6 %)** traen monto referencial > 0 — el resto
lo protege el SEACE hasta la buena pro. Solo **1.332 (23,9 %)** tienen adjudicación.

Y **los cinco gráficos ordenan y dimensionan las barras por monto.** O sea:

- "Top entidades por monto referencial" no es *quién compra más*, es *quién compra
  más **entre los que publicaron su monto***. Una entidad enorme que protege sus
  montos no aparece.
- "Por mes" ordena cronológicamente pero la barra es monto: un mes con muchos
  procesos y montos protegidos se ve **vacío**. Es el gráfico más engañoso de los cinco.
- "Por categoría" y "Por departamento", igual.

El `departamento` sí está en el **100 %** de los procesos, y el conteo de procesos
también. Son las métricas confiables.

### 3.2 El arreglo: un toggle

```
┌─ 📊 Estadísticas ─────────── Medir por: [ Nº de procesos ] [ Monto S/ ] ─┐
│                                                                          │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐                          │
│  │ 5.576  │  │ 1.372  │  │ 43,6 % │  │ 1.332  │                          │
│  │procesos│  │entidades│ │publican│  │adjudi- │                          │
│  │        │  │        │  │ monto  │  │ cados  │                          │
│  └────────┘  └────────┘  └────────┘  └────────┘                          │
│                                                                          │
│  TOP ENTIDADES                                                           │
│  Seguro Social de Salud   ████████████████████  119 proc.   ← clicable   │
│  Municipalidad de Lima    ██████████            62 proc.                 │
│                                                                          │
│  EVOLUCIÓN MENSUAL          ╱╲                                           │
│                          ╱─╯  ╰──╮      (línea, no barras)               │
│                                                                          │
│  Calculado sobre los 5.576 procesos que cumplen tus filtros              │
│  (no solo los 150 mostrados arriba).                                     │
└──────────────────────────────────────────────────────────────────────────┘
```

Cambios concretos, por orden de valor:

1. **Toggle procesos / monto**, con "Nº de procesos" por defecto. Un cambio, y los
   cinco gráficos pasan de engañosos a confiables.
2. **Fila de KPIs arriba**, con el % de cobertura de monto **a la vista**. Que el
   usuario sepa sobre qué está mirando sin leer letra chica.
3. **Barras clicables** → aplican ese filtro a la búsqueda. Ver "Municipalidad de
   Lima: 62" e ir a esos 62 en un clic es la mitad del valor del panel.
4. **"Por mes" como línea**, no barras — es una serie temporal.
5. **Departamento: top 10 + "otros"**, no 26 barras. O un mapa del Perú.
6. **Nota al pie en "Top proveedores"**: cuando un award tiene varios proveedores,
   el monto se reparte en partes iguales (es una aproximación, no el dato real).
7. Etiqueta explícita de que las estadísticas se calculan sobre **todo** el conjunto
   filtrado, no sobre los 150 resultados visibles. Hoy es correcto pero nadie lo sabe.

### 3.3 Un widget nuevo: **Próximos cierres**

Lo más accionable para un estudio y hoy no existe en ninguna pantalla:

```
⏳ CIERRAN ESTA SEMANA (de tus entidades vigiladas)
   mié 06 ago · Seguro Social de Salud · Adquisición de …    [🔔] [ver]
   jue 07 ago · Municipalidad de Miraflores · Servicio de …  [🔔] [ver]
```

El dato ya está (`cierreOfertas`), solo hay que ordenarlo y presentarlo. Perder un
plazo es el peor error posible en este negocio; que la app lo empuje a la primera
pantalla es un argumento de venta por sí solo.

---

## 4. Fase 2 — Lo que un estudio va a pedir en la primera semana

| Feature | Por qué |
|---|---|
| **Exportar a Excel / CSV** | Van a querer anexar la búsqueda a un informe para el cliente. Es la petición nº 1 garantizada. |
| **Paginación y orden** | Hoy hay un tope duro de 150 resultados. Una búsqueda por entidad grande lo revienta. |
| **Vigilar un proveedor** como objeto | "Avísame cuando *Constructora X* gane algo". Hoy solo se puede como texto. |
| **Carpetas por cliente** | Un estudio no tiene "mis alertas", tiene "las alertas del caso Fulano". Agrupar alertas y seguimientos por cliente es el diferenciador real frente a buscar en el SEACE gratis. |
| **Alertas de estado jurídico** | "Avísame si algo pasa a APELADO / SUSPENDIDO / NULO". El motor de seguimientos ya detecta cambios de estado — falta exponerlo como alerta por filtro, no solo por proceso. |
| **Copiar nomenclatura** | La ficha del SEACE no admite enlace directo (verificado). Un botón de copiar ahorra el paso manual cada vez. |

---

## 5. Fase 3 — Para que sea "una app corriendo"

### 5.1 El techo técnico: hay que pasar a SQLite

Hoy el buscador **parsea los JSON mensuales completos a memoria**. El cache local ya
pesa **220 MB para tres meses**. Con el rango de "Últimos 6 meses" o "Este año" se
cargan cientos de MB en RAM por cada combinación de meses, y el cache en memoria
guarda **una copia por cada número de meses consultado**. Con un usuario en local
aguanta. Con el buscador que describes — varios abogados, rangos largos,
paginación, estadísticas — no.

**Propuesta: ingestar los zips mensuales a SQLite (`better-sqlite3`) una sola vez**,
con una tabla de procesos + índice **FTS5** para el texto. Eso resuelve de un golpe:

- búsqueda instantánea sobre años de datos, no solo meses;
- paginación y orden reales (`LIMIT`/`OFFSET`/`ORDER BY`), adiós al tope de 150;
- estadísticas como `GROUP BY` en vez de recorrer arrays en JS;
- memoria plana, sin importar el rango consultado;
- un solo archivo `.db` para respaldar o desplegar.

Es **el cambio técnico más importante de todos** y todo lo de la Fase 2 se vuelve
fácil después de hacerlo. Sugiero hacerlo **antes** de la Fase 2, no después.

### 5.2 Hosting

Cloud Run + Cloud Scheduler (el plan que ya estaba en el README) + el `.db` en un
volumen persistente o GCS. Un job de ingesta diario que refresca el mes en curso;
la app solo lee. Con eso el estudio entra por una URL y no depende de que la laptop
de nadie esté encendida — que es la diferencia entre una herramienta y un producto.

### 5.3 Lo que hay que resolver antes de exponerlo fuera

- **Confirmación del correo.** Hoy cualquiera puede suscribir a cualquiera. En
  cuanto esto sea público, es un vector de spam.
- **Enlace de baja** en cada correo. Legalmente esperable.
- **Autenticación mínima.** Aunque sea un magic link por correo. Hoy
  `?email=` lista y borra las alertas de cualquiera.
- **Tests.** Cero hoy. `aplicarFiltros()`, `normalize()` y el cálculo de
  `proximoEnvio` son lógica con casos borde y bugs silenciosos (los §1.1 y §1.4 son
  exactamente eso). Media docena de tests con `node:test` se pagan solos.

---

## 6. Orden recomendado

```
  AHORA   ── 1.1 espacios · 1.4 fechas Lima · estados desde datos
             (bugs; sin esto, lo demás se construye torcido)
     │
  FASE 1  ── 2 campos + siglas · quitar Solo TI · frecuencia por alerta
             · Probar ahora · localStorage · URL compartible
     │      → aquí ya es demostrable ante un estudio
     │
  STATS   ── toggle procesos/monto · KPIs · barras clicables · Próximos cierres
     │      → aquí ya es vendible
     │
  SQLITE  ── ingesta + FTS5   (destraba todo lo demás)
     │
  FASE 2  ── exportar · paginación · vigilar proveedor · carpetas por cliente
     │
  FASE 3  ── Cloud Run · confirmación de correo · auth · tests
```

El corte natural para enseñárselo a un estudio es **después de STATS**: dos campos
que hacen lo que dicen, alertas con la cadencia que el usuario elige, y un panel que
no miente. Todo lo de SQLite en adelante es para que aguante usuarios reales.

---

## 7. Decisiones abiertas

1. **¿El digest TI de Xertica sobrevive?** Hoy comparte código (`config.json`,
   `filtrarRelevantes`). Puede quedarse como producto paralelo sin estorbar, o
   convertirse en "plantillas de búsqueda" reutilizables (una plantilla "TI", otra
   "Obras", otra "Salud") — que para un estudio sería más útil.
2. **¿Un estudio piloto o multi-estudio desde el inicio?** Cambia si hace falta
   multi-tenancy en el modelo de datos. Recomiendo: un estudio primero, pero que el
   esquema SQLite lleve `cliente_id` desde el día uno.
3. **¿Cuántas siglas cargamos a mano?** Propongo empezar con ~150 y añadir las que
   los usuarios busquen sin resultado (registrar las búsquedas fallidas de entidad
   es la forma barata de descubrirlo).
