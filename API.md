# API.md — Qué se puede sacar realmente del OECE

> Referencia verificada contra el bulk de **julio 2026 (5.576 procesos)** y contra
> los endpoints en vivo, el **2026-08-01**. Los porcentajes son cobertura real.
> Complementa [CONTEXT.md](CONTEXT.md) (estado del proyecto) y [PLAN.md](PLAN.md) (hacia dónde va).

Base: `https://contratacionesabiertas.oece.gob.pe` · estándar OCDS 1.1 · licencia
CC-BY 4.0 · sin API key. Extensiones propias del OECE: `currencyname`, `department`,
`datasegmentation`.

---

## 1. Endpoints

| Endpoint | Estado | Para qué sirve | Notas |
|---|---|---|---|
| `/api/v1/releases` | ✅ en uso | Convocatorias recientes, paginado 20 | Se actualiza **durante el día** |
| `/api/v1/file/seace_v3/json/YYYY/MM/` | ✅ en uso | Zip con **todo** el mes (compiledRelease) | Se regenera **~1 vez al día** |
| `/api/v1/records` | 🔵 sin usar | Igual que releases pero envuelto en records | |
| `/static/buyers.json` | ✅ en uso | Catálogo de entidades (3.316) | `{ "PE-CONSUCODE-1191": "NOMBRE" }` |
| `/api/v1/buyerProcesses?buyerID=` | ✅ en uso | Historial de procesos de una entidad | Acepta `order_processes_date=desc` |
| `/api/v1/buyerContracts?buyerID=` | ✅ en uso | Contratos de una entidad | **No** acepta orden |
| `/api/v1/suppliers` | 🔴 **sin usar** | Catálogo de proveedores — **497.911** | Con `total_processes`, `total_contracts`, teléfono y **email** |
| `/api/v1/supplierProcesses?supplierID=` | 🔴 **sin usar** | **Todo el historial de un proveedor** | `supplierID=PE-RUC-xxxxxxxxxxx` |
| `/api/v1/supplierContracts?supplierID=` | 🔴 **sin usar** | Contratos ganados por un proveedor | |
| `/api/v1/` (docs) | ❌ 404 | No hay documentación publicada | Todo esto es ingeniería inversa |

⚠ **`/suppliers` no admite búsqueda por nombre.** Probado con `search`, `name`, `q`,
`supplierName`: todos devuelven los 497.911 completos (el parámetro se ignora). Para
buscar un proveedor por nombre hay que **construir índice propio** desde el bulk y
luego bajar el detalle con `supplierID`.

---

## 2. Campos del bulk mensual, con cobertura real

### Identidad y fechas — 100 %
| Campo | Ej. | Nota |
|---|---|---|
| `ocid` | `ocds-dgv273-seacev3-1237126` | Clave primaria |
| `tender.id` | `1237126` | Id interno SEACE |
| `tender.datePublished` | `2026-07-20T17:39:00-05:00` | **Fecha real de convocatoria** |
| `date` / `publishedDate` | | Hora del lote OCDS — **no** es la convocatoria |

### Entidad convocante — 100 %
| Campo | Ej. | Nota |
|---|---|---|
| `buyer.id` | `PE-CONSUCODE-1191` | ⭐ **Coincide con `buyers.json` en 5.576/5.576** |
| `buyer.name` | `MUNICIPALIDAD PROVINCIAL DE TRUJILLO` | ⚠ no coincide byte a byte con el catálogo |
| `parties[].additionalIdentifiers` (`PE-RUC`) | `20175639391` | **RUC de la entidad** |
| `parties[].address.department` | `LA LIBERTAD` | 25 departamentos |
| `parties[].address.region` | `TRUJILLO` | **189 provincias** — hoy sin usar |
| `parties[].address.locality` | `TRUJILLO` | **775 distritos** — hoy sin usar |
| `parties[].address.streetAddress` | `DIEGO DE ALMAGRO` | = "Dirección Legal" de la ficha |
| `parties[].contactPoint.telephone` | `044484240` | 60,7 % |
| `parties[].contactPoint.url` | `https://WWW.MUNITRUJILLO.GOB.PE` | 14,9 % |

> ⭐ **Filtrar por `buyer.id` en vez de por nombre elimina de raíz el bug del doble
> espacio** documentado en CONTEXT.md §6.

### Procedimiento — 100 %
| Campo | Cobertura | Valores |
|---|---|---|
| `tender.procurementMethodDetails` | 100 % | **17 valores** (ver §3) |
| `tender.mainProcurementCategory` | 100 % | `goods` 2.474 · `services` 2.229 · `works` 873 |
| `tender.value.amount` | 43,6 % > 0 | El resto lo protege la ley |
| `tender.value.currency` | 100 % | PEN 5.483 · **USD 86 · EUR 5 · GBP 2** |
| `tender.value.amount_PEN` | 100 % | ⭐ **Ya normalizado a soles** |
| `tender.hasTenderInformationProtectedByLaw` | 100 % | Explica los montos en 0 |
| `planning.budget.description` | 100 % | `Fondos Públicos` |
| `planning.budget.project` / `projectID` | 43,9 % | Proyecto de inversión (obras) |

### Ítems — 100 %
`tender.items[]`: `description`, `quantity`, `unit.name`, `totalValue`, `statusDetails`.
Más dos catálogos estándar, **hoy sin usar**:

- `classification` (**CUBSO**, 81,4 %) — catálogo peruano de bienes y servicios.
- `additionalClassifications` (**UNSPSC**, 81,4 %) — estándar internacional.

Permiten filtrar por rubro sin depender de keywords.

### 🔴 Postores — `tender.tenderers[]`, 29,9 % — **HOY IGNORADO**
| Dato | Julio 2026 |
|---|---|
| Procesos con lista de postores | 1.669 (29,9 %) |
| Postores listados | **9.545** |
| Con RUC (`PE-RUC-…`) | 9.545 (**100 %**) |
| RUCs distintos | **5.388** |
| `tender.numberOfTenderers` | presente |

**El dato más valioso que la app no usa.** No es solo quién ganó — es **quién se
presentó**. Habilita: historial de participación de un postor, quién compite contra
quién, tasa de éxito, y detectar procesos con un solo postor.

### Adjudicaciones y contratos
| Campo | Cobertura |
|---|---|
| `awards[]` (`value`, `date`, `suppliers[]` con RUC, `items[]`) | 23,9 % |
| `contracts[]` (`title`, `dateSigned`, `period`, `value`, `documents[]`) | 4,3 % |

Roles en `parties[]`: `tenderer` 9.545 · `buyer` 5.576 · `procuringEntity` 5.576 · `supplier` 1.341.

### 🔴 Documentos — 100 %, **hoy solo se enlaza uno**
| `documentType` | n | Títulos reales |
|---|---|---|
| `biddingDocuments` | 8.871 | Bases Administrativas (5.647), Bases Integradas (1.850), Resumen ejecutivo (158) |
| `clarifications` | 1.922 | Pliego de absolución de consultas y observaciones (1.081), Acta de no formulación (841) |
| `awardNotice` | 1.568 | Documentos de Otorgamiento de Buena Pro |
| `evaluationReports` | 1.445 | Documentos de Calificación y Evaluación (593), Informe que sustenta la declaratoria de Desierto (852) |

`normalize()` se queda con **uno solo** (`biddingDocuments` o el primero). Para un
estudio, el *pliego de absolución*, el *acta de buena pro* y el *informe de desierto*
valen tanto o más que las bases.

---

## 3. Métodos de selección (17 valores reales, julio 2026)

```
1809 Licitación Pública Abreviada        298 Licitación Pública
1461 Concurso Público Abreviado          243 Concurso Público de Servicios
 612 Subasta Inversa Electrónica          82 Regímen Especial
 471 Comparación de Precios               68 Convenio
 346 Contratación Directa                 64 Contratación Internacional
                                          54 Concurso Público para Consultoría
  20 Adjudicación Abreviada               17 Adjudicación Selectiva
  13 Licitación Pública Abreviada Homologación   10 Adjudicación Simplificada
   6 Concurso Público Abreviado Homologación      2 Procedimiento Especial de Contratación
```

Hoy el filtro "Método" es un **campo de texto libre**. Debe ser un desplegable
construido desde los datos. (`tender.procurementMethod`, el código OCDS `open`/etc.,
solo está en el 35,8 % — usar siempre `procurementMethodDetails`.)

## 4. Estados (`items[].statusDetails`) — 12 valores reales

```
CONVOCADO 3942 · ADJUDICADO 673 · CONSENTIDO 410 · DESIERTO 289 · CONTRATADO 241
NULO 60 · CANCELADO 14 · APELADO 6 · DEJAR_SIN_EFECTO_ADJUDICACION 3
CONTRATACION_DIRECTA 3 · RETROTRAIDO_POR_RESOLUCION 1 · SUSPENDIDO 1
PENDIENTE_DE_REGISTRO_DE_EFECTO 1
```

La UI ofrece 8 y **omite justo los jurídicamente relevantes**: `SUSPENDIDO`,
`RETROTRAIDO_POR_RESOLUCION`, `DEJAR_SIN_EFECTO_ADJUDICACION`,
`PENDIENTE_DE_REGISTRO_DE_EFECTO`.

---

## 5. Ficha de Selección vs API — qué NO se puede automatizar

Contrastado con la ficha real del PDF (`DIRECTA-DIRECTA-1-2026-MDH/DEC-1`,
Municipalidad Distrital de Huamanquiquia).

| Campo de la ficha | ¿En la API? |
|---|---|
| Nomenclatura | ✅ `tender.title` |
| N° Convocatoria | ✅ dentro de la nomenclatura |
| Entidad Convocante | ✅ `buyer.name` + `buyer.id` |
| Dirección Legal | ✅ `parties[].address` |
| Teléfono / Página web | ✅ `contactPoint` (60,7 % / 14,9 %) |
| Objeto de Contratación | ✅ `mainProcurementCategory` |
| Descripción del Objeto | ✅ `tender.description` |
| VR / VE / Cuantía | ✅ `tender.value` (43,6 %) |
| Fecha y Hora Publicación | ✅ `tender.datePublished` |
| Lista de Documentos | ✅ `tender.documents[]` (con tipo, título y fecha) |
| **Normativa Aplicable** (Ley 32069 / 30225) | ❌ **no existe como campo** |
| **Causal** (p. ej. "Situación emergencia") | ❌ **no existe** |
| **Tipo Compra o Selección** ("Por la Entidad") | ❌ **no existe** |
| **Monto del Derecho de Participación** | ❌ **no existe** |
| **Cronograma completo** (Invitación → Presentación → Adjudicación, con hora y lugar) | ❌ **solo 2 periodos** |

Verificado por búsqueda directa en el bulk: `"32069"` aparece 45 veces y `"30225"` 34,
pero **solo dentro de descripciones en texto libre** — nunca como campo estructurado.
`Causal`, `Normativa`, `Por la Entidad` y `derechoParticipacion`: **0 ocurrencias**.

### Consecuencia de producto

El cronograma de la ficha tiene **3+ etapas con hora y lugar**
(`Invitación 17/07`, `Presentación de propuestas 31/07 08:30`, `Adjudicación 31/07`);
la API publica como mucho 2 periodos sin hora. Y la ficha no admite enlace directo
(verificado, CONTEXT.md §6).

**Lo honesto es no prometer el cronograma completo.** Lo que sí se puede hacer:

1. Mostrar los 2 periodos que sí existen, sin inventar los demás.
2. Enlazar las **bases y el resto de documentos**, que es donde está el cronograma real.
3. Botón de **copiar nomenclatura** para pegarla en el buscador del SEACE.
4. Si más adelante hace falta el cronograma completo de forma masiva, la única vía es
   scraping con sesión — un proyecto aparte, con su propio riesgo de mantenimiento.

---

## 6. Resumen: lo que hoy se desaprovecha

| Dato disponible | Estado | Valor para un estudio |
|---|---|---|
| `buyer.id` estable | ignorado | Arregla el filtro de entidad de raíz |
| `tenderers[]` + RUC (9.545/mes) | **ignorado** | Quién se presentó, no solo quién ganó |
| RUC de todos los actores | ignorado | Identificador real; búsqueda exacta |
| `supplierProcesses` / `supplierContracts` | **ignorado** | Historial completo de un competidor |
| Provincia (189) y distrito (775) | ignorado | Geografía fina, hoy solo departamento |
| CUBSO / UNSPSC | ignorado | Rubro sin keywords |
| 4 tipos de documento | 1 de 4 | Pliegos, buena pro, informes de desierto |
| `amount_PEN` | ignorado | ⚠ las estadísticas **suman PEN+USD+EUR como si fueran soles** |
| `numberOfTenderers` | ignorado | Nivel de competencia por proceso |
| 12 estados reales | 8 en la UI | Faltan los de litigio |
