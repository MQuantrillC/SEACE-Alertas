# PLAN.md — De herramienta interna a producto para estudios de abogados

> Estado: **propuesta, sin implementar**. Actualizado: 2026-08-01.
> [CONTEXT.md](CONTEXT.md) = cómo está hoy · [API.md](API.md) = qué da la fuente ·
> este doc = **hacia dónde va y en qué orden**.

---

## 0. El cambio de público

Hoy la app está construida para **Xertica buscando oportunidades TI**: keywords de
`config.json`, scoring de afinidad, filtro "Solo TI".

El objetivo es un **estudio de abogados que monitorea el SEACE**: no quiere "lo
relevante según unas keywords", quiere **exactamente lo que pidió** y **que le avisen
cuando aparezca**.

| | Hoy (Xertica TI) | Objetivo (estudio) |
|---|---|---|
| Búsqueda | 1 campo catch-all + scoring | 2 campos explícitos, resultado literal |
| Relevancia | la decide `config.json` | la decide el usuario y queda guardada |
| Alertas | 1 cadencia global | cadencia **por alerta**, elegida por el usuario |
| Usuarios | ninguno (el correo es un campo de texto) | **cuentas reales con login** |

Se quita **"Solo TI"** y también **el regex** del campo de búsqueda (decidido
2026-08-01). `filtrarRelevantes()` sobrevive solo como motor del digest de Xertica.

---

## 1. Bugs verificados (arreglar antes que nada)

Todo comprobado contra `out/cache/2026-07.json` (5.576 procesos). Detalle en
[CONTEXT.md](CONTEXT.md) §6.

| # | Bug | Impacto | Arreglo |
|---|---|---|---|
| 1 | Catálogo dice `"SEGURO SOCIAL DE SALUD"`, datos dicen `"SEGURO SOCIAL DE  SALUD"` (doble espacio). `fold()` no colapsa espacios | Elegir EsSalud en el autocompletado da **0 resultados**, sin error. 19 entidades / 180 procesos en julio | **Filtrar por `buyer.id`**, que coincide 5.576/5.576 (ver §3.1) |
| 2 | Las siglas no existen en el dato: `ESSALUD`, `MINSA`, `MINEDU`, `PETROPERU`, `INDECOPI` → 0 coincidencias en 3.316 entidades | El campo "Nombre **o Sigla**" no puede funcionar hoy | Diccionario `siglas.json` propio (§3.1) |
| 3 | La UI ofrece 8 estados; los datos traen 12 | No se puede filtrar `SUSPENDIDO`, `RETROTRAIDO_POR_RESOLUCION`, `DEJAR_SIN_EFECTO_ADJUDICACION` — los de litigio | Lista derivada de los datos |
| 4 | `iso()` usa `toISOString()` (UTC) | Después de las 19:00 de Lima, "Hoy" pide mañana → 0 resultados | Fechas en `America/Lima` |
| 5 | Las estadísticas suman `amount` sin mirar la moneda | 93 procesos de julio en USD/EUR/GBP se suman como si fueran soles | Usar `amount_PEN`, que está al 100 % |

---

## 2. Lo que la fuente da y no estamos usando

Resumen; el detalle con cobertura está en [API.md](API.md).

| Dato | Hoy | Qué habilita |
|---|---|---|
| **`tender.tenderers[]`** — 9.545 postores/mes, 100 % con RUC, 5.388 distintos | ignorado | **Quién se presentó**, no solo quién ganó. El dato más valioso desaprovechado |
| **`supplierProcesses` / `supplierContracts`** | ignorado | Historial completo de cualquier competidor por RUC |
| **`buyer.id`** (coincide 100 % con el catálogo) | ignorado | Arregla el bug 1 de raíz |
| **RUC de todos los actores** | ignorado | Identificador exacto; los abogados piensan en RUC |
| **Provincia (189) y distrito (775)** | solo departamento | Geografía fina |
| **CUBSO / UNSPSC** (81,4 %) | ignorado | Rubro sin keywords |
| **4 tipos de documento** | 1 de 4 | Pliego de absolución, acta de buena pro, informe de desierto |
| **`amount_PEN`** | ignorado | Arregla el bug 5 |
| **`numberOfTenderers`** | ignorado | Nivel de competencia; detectar postor único |

Y lo que **no** existe en la API y por tanto **no se puede prometer**: Normativa
Aplicable (Ley 32069/30225), Causal de contratación directa, Tipo de Compra, Derecho
de Participación y el **cronograma completo etapa por etapa**. Todo eso vive solo en
la ficha, que no admite enlace directo. Ver [API.md](API.md) §5.

---

## 3. Diseño de la búsqueda

### 3.1 Los dos campos

```
┌──────────────────────────────────────────────────────────────────┐
│  Nombre o Sigla de Entidad            Descripción del Objeto     │
│  ┌────────────────────────────┐       ┌────────────────────────┐ │
│  │ essalud                 ▾  │       │ servicio de limpieza   │ │
│  ├────────────────────────────┤       └────────────────────────┘ │
│  │ ESSALUD                    │                                  │
│  │ Seguro Social de Salud     │       Proveedor / Postor (opc.)  │
│  │ 119 procesos · Lima        │       ┌────────────────────────┐ │
│  └────────────────────────────┘       │ RUC o razón social     │ │
│   ╳ Seguro Social de Salud            └────────────────────────┘ │
│   ╳ Ministerio de Salud                                          │
│   📁 Cartera: Sector Salud (12)                                  │
└──────────────────────────────────────────────────────────────────┘
```

- **Los dos campos son opcionales e independientes.** Solo uno, el otro, los dos, o
  ninguno (= todo lo publicado en el periodo).
- **Entidad**: multi-selección con chips, resuelta a **`buyer.id`**, no a texto. El
  desplegable muestra nombre oficial + nº de procesos + departamento, y acepta
  **sigla** vía `siglas.json`. Varias entidades = OR.
- **Descripción del Objeto**: busca en `descripcion + nomenclatura + items`. **No** en
  entidad ni en proveedores — cada cosa tiene su campo. Es lo que hace el resultado
  predecible.
- **Tercer campo "Proveedor / Postor"**: por RUC o razón social, y busca en
  **adjudicados Y postores** (§2). Hoy esta capacidad existe escondida dentro de `q`.
- **Sin regex** en ninguna parte de la UI.

### 3.2 Carteras (grupos de entidades) — sí, buena idea

Un estudio vigila conjuntos estables: *"Municipalidades de Lima"*, *"Sector Salud"*,
*"Entidades del cliente Fulano"*. Una **cartera** es una lista guardada de
`buyer.id`s, reutilizable en cualquier búsqueda o alerta.

Vale la pena porque:
- Se define una vez y se usa en 10 alertas; cambiarla actualiza las 10.
- Es la unidad natural de organización por cliente del estudio.
- Técnicamente es trivial: una tabla de `(cartera_id, entidad_id)`.

Carteras precargadas útiles desde el día uno: *Ministerios*, *Gobiernos Regionales*,
*Municipalidades provinciales*, *Sector Salud*, *EPS de saneamiento*. Se derivan del
catálogo por patrón de nombre.

---

## 4. Cuentas, login e invitaciones

Hoy el correo es un campo de texto sin verificar: cualquiera puede suscribir a
cualquiera, y `GET /api/alertas?email=` lista y borra las alertas de quien sea.

### 4.1 Login por enlace mágico (passwordless)

Es la opción correcta aquí, y no es por moda:

- El correo **ya es** la identidad del producto (las alertas llegan ahí).
- Cero contraseñas que gestionar, resetear o filtrar — importante en un estudio que
  no tiene equipo de TI.
- **El propio login verifica el correo**, así que resuelve gratis el problema de las
  suscripciones no consentidas.

```
1. El usuario escribe su correo  →  2. Recibe un enlace con token (15 min, un solo uso)
3. Hace clic  →  4. Sesión en cookie httpOnly, 30 días
```

Ya hay SMTP funcionando (`src/send.mjs`), así que no hay infraestructura nueva.

### 4.2 Invitar a otro usuario a una alerta — sí, con aceptación

Tu intuición es correcta: **nadie debe recibir correos que no pidió.**

```
María crea "EsSalud · limpieza" y añade a jlopez@estudio.pe
        ↓
jlopez recibe: "María te invitó a la alerta X"  [Aceptar] [Rechazar]
        ↓
Hasta que acepte:  estado = pendiente  → NO se le envía nada
Al aceptar:        estado = aceptada   → entra en el reparto
Cada correo lleva  [Darme de baja de esta alerta]
```

Es la **misma maquinaria que el login**: un token de un solo uso enviado por correo.
Se diseña una vez y sirve para las dos cosas. La invitación caduca a los 7 días.

Roles por alerta: **propietario** (edita filtros, frecuencia, invita, borra) y
**suscriptor** (recibe y puede darse de baja). Suficiente; no hace falta más.

### 4.3 Estudio (tenant)

Aunque se empiece con un solo estudio piloto, el esquema debe llevar `estudio_id`
desde el día uno — añadirlo después obliga a migrar todo. Permite que las carteras y
las búsquedas guardadas se compartan entre los abogados del estudio.

---

## 5. Cómo organizar los datos

**Dos bases separadas.** Es la decisión de organización más importante:

```
datos.db     ← reconstruible desde el OECE. Si se corrompe, se re-ingesta y ya.
cuentas.db   ← irreemplazable. Es lo único que hay que respaldar.
```

### 5.1 `datos.db` — ingesta del bulk

```sql
entidades(id PK,            -- 'PE-CONSUCODE-1191'  ⭐ clave real
          nombre, ruc, departamento, provincia, distrito,
          direccion, telefono, web, n_procesos)

procesos(ocid PK, tender_id, nomenclatura, descripcion,
         entidad_id → entidades, categoria, metodo,
         monto, moneda, monto_pen,          -- ⭐ monto_pen para estadísticas
         protegido_por_ley, fecha_publicacion, cierre_ofertas,
         tender_ini, tender_fin, enquiry_ini, enquiry_fin,
         estado, n_postores, proyecto, proyecto_id)

items(id PK, ocid →, posicion, descripcion, cantidad, unidad,
      monto, cubso_id, cubso_desc, unspsc_id, unspsc_desc, estado)

actores(ocid →, ruc, nombre, rol)   -- 'tenderer' | 'supplier'  ⭐ índice de postores
adjudicaciones(id PK, ocid →, fecha, monto, moneda, monto_pen)
adjudicacion_ruc(adjudicacion_id →, ruc, nombre)
contratos(id PK, ocid →, award_id, titulo, firmado, inicio, fin, monto_pen)
documentos(id PK, ocid →, tipo, titulo, url, publicado, formato)

proveedores(ruc PK, nombre, n_procesos, n_adjudicaciones, ultimo)  -- derivada
procesos_fts  FTS5(descripcion, nomenclatura, items)               -- búsqueda de texto
```

Esto resuelve de un golpe: búsqueda instantánea sobre años, paginación y orden reales
(adiós al tope de 150), estadísticas como `GROUP BY`, memoria plana sin importar el
rango, índice propio de postores (que la API no permite buscar), y un solo archivo
para desplegar.

**Hoy** el buscador parsea los JSON completos a memoria: el cache ya pesa **220 MB
por 3 meses**, y guarda una copia por cada nº de meses consultado. Con un usuario en
local aguanta; con varios abogados y rangos largos, no.

### 5.2 `cuentas.db`

```sql
estudios(id PK, nombre)
usuarios(id PK, email UNIQUE, nombre, estudio_id →, creado, ultimo_acceso)
sesiones(token PK, usuario_id →, expira)
tokens(token PK, tipo, usuario_id →, payload_json, expira, usado)  -- login E invitación

carteras(id PK, estudio_id →, nombre)
cartera_entidad(cartera_id →, entidad_id)

busquedas(id PK, usuario_id →, nombre, filtros_json)
alertas(id PK, busqueda_id →, propietario_id →,
        frecuencia_json, proximo_envio, ultima_fecha, pausada)
alerta_suscriptor(alerta_id →, usuario_id →, estado)  -- pendiente|aceptada|baja
seguimientos(id PK, usuario_id →, ocid, snapshot_json)
envios(id PK, alerta_id →, fecha, n_procesos)          -- auditoría: "¿me llegó todo?"
```

`envios` parece opcional y no lo es: cuando un abogado pregunte *"¿por qué no me
avisaron de este proceso?"*, es la única forma de responder.

---

## 6. Frecuencia de alertas

```
¿Cada cuánto?
  ○ Apenas se publique   (revisa cada hora, 07–20 h)
  ● Una vez al día       [ 08:00 ▾ ]
  ○ Dos veces al día     [ 08:00 ▾ ] [ 17:00 ▾ ]
  ○ Semanal              [ Lunes ▾ ] [ 08:00 ▾ ]
☐ Avísame también cuando no haya novedades
```

**El scheduler se vuelve tonto y la app inteligente**: Task Scheduler / Cloud
Scheduler invoca `npm run alertas` **cada hora, siempre**. El runner carga los datos
**una vez** y procesa solo las alertas con `proximo_envio <= ahora`. Añadir una
cadencia nueva no vuelve a tocar el scheduler. Nada sale entre 20:00 y 07:00.

⚠ **Límite honesto**: el bulk se regenera ~1 vez al día. Para que "apenas se
publique" signifique algo, el runner debe hacer un **híbrido** — bulk como base +
`fetchRecent()` sobre `/releases` (que sí se actualiza durante el día) para las
últimas 48 h. Una fetch por invocación, no por alerta.

Y **"Probar ahora"** en cada alerta: manda el correo con lo que habría enviado.
Hoy creas una alerta y no pasa nada visible hasta mañana; eso es un acto de fe.

---

## 7. Estadísticas

El panel gusta y es el diferenciador — pero hoy **mide mal**.

**Solo el 43,6 % de los procesos publica monto** (2.430 de 5.576) y solo el 23,9 %
tiene adjudicación. Los cinco gráficos ordenan y dimensionan **por monto**. Entonces
"Top entidades por monto" no es *quién compra más*, es *quién compra más entre los
que revelaron su monto*. "Por mes" es el peor: barras cronológicas dimensionadas por
monto, así que un mes con muchos procesos y montos protegidos se ve **vacío**.
Y además se suman **PEN + USD + EUR** como si todo fueran soles (bug 5).

Por orden de valor:

1. **Toggle "Nº de procesos / Monto S/"**, con procesos por defecto. Un control, y
   los cinco gráficos pasan de engañosos a confiables.
2. **Usar `amount_PEN`** en todo lo monetario.
3. **Fila de KPIs** con el **% de cobertura de monto a la vista**.
4. **Barras clicables** → aplican ese filtro a la búsqueda.
5. **"Por mes" como línea**, no barras. Departamento: top 10 + "otros".
6. Nota al pie en Top proveedores: cuando un award tiene varios proveedores el monto
   se reparte en partes iguales (aproximación, no dato real).
7. Etiqueta de que se calcula sobre **todo** el conjunto filtrado, no sobre los 150
   visibles (ya es cierto; nadie lo sabe).

**Nuevos, ahora que sabemos que existen los postores:**

- **Nivel de competencia**: promedio de postores por proceso, y % de procesos con
  **un solo postor** — un indicador clásico de riesgo en contratación pública.
- **Quién compite contra quién**: dado un RUC, con qué otros postores coincide más.

### Widget nuevo: **Próximos vencimientos**

```
⏳ VENCEN ESTA SEMANA — consultas y observaciones (de tus carteras)
   lun 03 ago · Fuerza Aérea del Perú · Adquisición de material …   [🔔] [ver]
   lun 03 ago · Seguro Social de Salud · Servicio de alquiler de …  [🔔] [ver]
```

⚠ **Corregido tras medirlo (2026-08-01).** El plan decía que bastaba con ordenar
`cierreOfertas`. No es así: `tenderPeriod.endDate` coincide con el día de
publicación en el 95,6 % de los casos y **no tiene ni un solo vencimiento futuro**
en 24 meses de datos. El widget se construye sobre `enquiryPeriod.endDate`
(71,1 % de cobertura, 443 vencimientos futuros), que además es el plazo
jurídicamente más relevante: la ventana para cuestionar las bases. El cierre de
ofertas se muestra cuando existe, pero no se promete. Ver [API.md](API.md) §2.

---

## 8. Visión de UI

```
┌──────────────────────────────────────────────────────────────┐
│  SEACE Alertas          Buscar  Alertas  Carteras  Panel   ▾ │
└──────────────────────────────────────────────────────────────┘
```

Cinco pantallas, no una:

| Pantalla | Contenido |
|---|---|
| **Buscar** | Los 2 (3) campos + filtros + resultados paginados. Filtros en la URL → enlaces compartibles entre abogados |
| **Alertas** | Tabla: nombre, frecuencia, último envío, nº de resultados, suscriptores (con estado de invitación), [Probar ahora] [Pausar] [Editar] |
| **Carteras** | Grupos de entidades, reutilizables |
| **Panel** | Próximos cierres + estadísticas + cambios recientes en lo que sigo |
| **Proveedor** | Ficha de un RUC: procesos en los que se presentó, cuáles ganó, contra quién compitió, contratos |

Principios, en orden:

1. **Nada de jerga.** Ni regex, ni "OCDS", ni "ocid", ni "compiledRelease".
2. **Decir siempre sobre qué datos se está mirando.** "43,6 % publica monto" a la
   vista, no en letra chica. Un abogado que cita un número tiene que poder defenderlo.
3. **Todo enlazable.** El estado vive en la URL; se comparte por correo interno.
4. **Nunca cero resultados sin explicación.** Hoy elegir EsSalud da 0 en silencio.
   Debe decir por qué y ofrecer la salida.
5. **Exportar desde cualquier vista.** Excel/CSV; van a anexarlo a informes.
6. **Fechas siempre en hora de Lima**, y los vencidos en rojo.

---

## 9. Recomendación: ¿seguir planificando o construir?

**Construir. Ya hay plan de sobra.** Con dos matices sobre el orden:

**Primero el esquema, no las features.** Ahora sabemos que hacen falta postores
(9.545/mes), índice propio de proveedores (la API no permite buscarlos por nombre),
paginación, y tablas de usuarios/sesiones/invitaciones. Todo eso es SQLite. Si se
construyen las features sobre los JSON en memoria y se migra después, **se escribe
el mismo código dos veces**. Una sesión de esquema + ingesta destraba todo lo demás.

**Cuentas antes que features de búsqueda.** Suena al revés, pero: alertas, carteras
y búsquedas guardadas **cuelgan de un usuario**. Construirlas primero contra un campo
de texto de correo y después colgarlas de `usuario_id` es rehacer el modelo entero.
Y el login por enlace mágico son ~150 líneas apoyadas en el SMTP que ya funciona.

Orden propuesto:

```
1. Bugs 1-5                      rápido, y evita construir sobre algo torcido
2. datos.db: esquema + ingesta   destraba paginación, postores, estadísticas
3. cuentas.db + login mágico     destraba alertas, carteras, invitaciones
4. Búsqueda de 2 campos + carteras + quitar Solo TI/regex
5. Alertas: frecuencia + invitaciones + Probar ahora
6. Estadísticas: toggle, amount_PEN, KPIs, clicables, Próximos cierres
7. Exportar · ficha de proveedor · documentos por tipo
8. Cloud Run + Cloud Scheduler · tests
```

El punto **5** es el primer corte demostrable ante un estudio. El **6** es el primero
vendible.

---

## 10. Decisiones abiertas

1. **¿Sobrevive el digest TI de Xertica?** Comparte `config.json` y
   `filtrarRelevantes()`. Puede quedarse como producto paralelo, o convertirse en
   **plantillas de búsqueda** reutilizables ("TI", "Obras", "Salud") — más útil para
   un estudio.
2. **¿Un estudio piloto o multi-estudio?** Recomendación: piloto, pero con
   `estudio_id` en el esquema desde el día uno.
3. **¿Cuántas siglas cargamos a mano?** Empezar con ~150 y registrar las búsquedas de
   entidad sin resultado para descubrir el resto.
4. **¿Cuánta historia ingestamos?** El cache tiene 3 meses. Un estudio va a querer
   años (para historial de competidores). Cada mes son ~50-100 MB de JSON, pero en
   SQLite comprime muchísimo. Propongo empezar con 24 meses.
