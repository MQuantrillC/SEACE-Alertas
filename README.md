# seace-alertas

Digest de **licitaciones públicas del SEACE** (Perú) relevantes para Xertica.
Proyecto independiente — no toca ni depende del Account Plan.

Usa la **API abierta OCDS del OECE** (datos oficiales del SEACE, sin login ni
API key, actualizada durante el día): baja las convocatorias recientes, filtra
por palabras clave TI (nube, datacenter, licenciamiento, IA…) y genera un
correo HTML listo para enviar.

## Uso

```bash
npm install          # solo la primera vez
npm run digest       # genera out/digest-YYYY-MM-DD.html (ábrelo en el navegador)
npm run digest:send  # lo mismo + envía por correo (requiere .env, ver abajo)
npm run web          # BUSCADOR interactivo → http://localhost:4321
npm run alertas      # evalúa y envía las alertas creadas en el buscador
```

El digest y las alertas son scripts que corren y terminan; el buscador
(`npm run web`) sí es una página que queda corriendo hasta que cierres la terminal.

## Buscador (`npm run web`)

Busca sobre los **archivos mensuales** del OECE (~1 MB por mes, cacheados en
`out/cache/`): la primera búsqueda de un rango los descarga; después todo es
instantáneo. Cubre descripción + ítems + nomenclatura + **entidad convocante** +
**proveedores adjudicados** (sí: puedes buscar a un competidor y ver qué ganó).

Filtros: **periodo** (hoy / esta semana / este mes / 3-6 meses / este año /
fechas de calendario), categoría, **monto** (bandas multiselección),
**departamento** (25), **estado del proceso** (Convocado / Adjudicado /
Contratado / Desierto…), método, entidad, **Solo TI** (keywords de
`config.json`) y **Con ganador**. El campo de texto también acepta `/regex/`
(sintaxis del config), aunque el texto plano cubre la mayoría de casos.

Nota de frescura: el OECE regenera el archivo mensual una vez al día, así que
"Hoy" puede tardar horas en poblarse; lo publicado ayer siempre está.

### Inspector de fichas (`/api/ficha`)

`http://localhost:4321/api/ficha?id=<GUID o número>` trae la página de
`fichaSeleccion` del SEACE con ese id y devuelve TODO lo que responde su
servidor (status, formularios, inputs ocultos, tablas, texto visible).
Conclusión verificada: fuera de una sesión del buscador del SEACE, la ficha
devuelve solo el esqueleto — sus datos (incluido el cronograma completo) viven
en la sesión de navegación, por eso el enlace `?id=…` de tu navegador no es
compartible ni automatizable.

### Historial de una entidad (📊 en cada tarjeta)

`/entidad?nombre=…` muestra el historial de compras de una entidad (API oficial
`buyerProcesses`/`buyerContracts` con `buyerID` del catálogo): total histórico de
procesos y contratos, los 50 procesos más recientes y una muestra de contratos
con proveedor y monto. El filtro "Entidad" del buscador autocompleta con el
catálogo oficial (~3.3k entidades).

### Seguimiento de un proceso (🔔 en cada tarjeta)

El 🔔 guarda el proceso en `seguimientos.json` con un snapshot de su estado.
En cada corrida de `npm run alertas`, si el proceso cambió (nuevo estado
ADJUDICADO/DESIERTO/…, proveedor ganador, o cambia el cierre de ofertas), llega
un correo con el cambio.

### Estadísticas (📊 Estadísticas)

Panel sobre el conjunto YA filtrado (mismo periodo/filtros de la búsqueda):
top entidades por monto, top proveedores adjudicados, y distribución por
categoría, departamento y mes. Sirve para cualquier rubro, no solo TI.

## Alertas por correo

En el buscador: configura tus filtros → escribe tu correo → **Crear alerta**.
Cada alerta guarda sus filtros en `alertas.json` (local, gitignored). El envío
lo hace `npm run alertas`: compara lo publicado desde el último corte de cada
alerta, y si hay convocatorias nuevas que pasen los filtros, envía el correo
(usa el mismo SMTP del `.env`). Prográmalo 1-2 veces al día con el Programador
de tareas de Windows (o un cron / Cloud Scheduler).

## Configuración (`config.json`)

| Campo | Qué hace |
|---|---|
| `diasHaciaAtras` | Ventana de búsqueda (2 = convocatorias de las últimas 48 h). |
| `maxPaginas` | Tope de páginas de la API (20 procesos c/u). Si el aviso ⚠ aparece, súbelo. |
| `palabrasAlta` | Señal fuerte (nube, GCP, datacenter…). 10 pts c/u — ordenan el digest. |
| `palabrasMedia` | Señal media (software, licencias, ciberseguridad…). 1 pt c/u. |
| `palabrasExcluir` | Descartan el proceso salvo que también tenga señal fuerte. |
| `destinatarios` | A quién se envía con `digest:send`. |

### Sintaxis de búsqueda (texto o regex)

Cada entrada de las tres listas puede ser:

- **Texto plano** → subcadena: `"nube"` matchea `"MIGRACIÓN A LA NUBE"`.
- **Regex** → escrita entre barras: `"/(migraci.n|modernizaci.n) .{0,25}(nube|cloud)/"`.
  Insensible a mayúsculas siempre.

Todo se compara contra descripción + ítems + nomenclatura **ya plegados**
(minúsculas, sin tildes) — escribe los patrones sin tildes (`migraci.n` o
`migracion`, no `migración`). Una regex inválida se ignora con un aviso ⚠, no
rompe el digest.

### Etapas del proceso

Cada tarjeta muestra una tabla **Etapa / Fecha inicio / Fecha fin** con TODO lo
que la API abierta publica. Ojo: el OECE solo expone dos periodos en datos
abiertos — *Convocatoria/Presentación de ofertas* y, cuando existe, *Consultas y
observaciones* (verificado escaneando 300 procesos). El cronograma completo
etapa-por-etapa solo está en las **bases (PDF)** — enlazadas en cada tarjeta — y
en la ficha del proceso del buscador SEACE (que no admite enlaces directos).

## Envío por correo

Copia `.env.example` a `.env` y complétalo. Con Google Workspace se usa una
[contraseña de aplicación](https://myaccount.google.com/apppasswords).
Carga las variables antes de correr (`npm run digest:send`), por ejemplo con
`dotenv` de tu shell o exportándolas en la sesión.

## Automatizarlo (siguiente paso)

- **Windows**: Programador de tareas → acción `npm run digest:send` en esta carpeta, cada mañana.
- **Cloud**: contenedor mínimo en Cloud Run + Cloud Scheduler (mismo patrón que el deploy del Account Plan).

## Fuente de datos

- API: `https://contratacionesabiertas.oece.gob.pe/api/v1/releases` (estándar [OCDS](https://standard.open-contracting.org/))
- Los montos referenciales suelen venir en 0 (protegidos hasta la buena pro) — el digest los muestra solo cuando existen.
- Cada tarjeta enlaza las **bases (PDF)** y el buscador público del SEACE con la nomenclatura del proceso para ubicarlo.
