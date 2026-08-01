// ──────────────────────────────────────────────────────────────────────────────
// Búsqueda sobre datos.db. Sustituye a src/search.mjs (que filtraba en memoria).
//
// Modelo de filtros — todos opcionales e independientes:
//   entidades[]   ids de entidad ('PE-CONSUCODE-1191')  ← NUNCA por nombre
//   objeto        texto libre sobre descripción + nomenclatura + ítems
//   proveedor     RUC o razón social; busca en postores Y adjudicados
//   desde/hasta   'YYYY-MM-DD' sobre la fecha de publicación (hora de Lima)
//   categorias[] metodos[] estados[] departamentos[] montos[]
//   conAdjudicacion, soloUnPostor
// ──────────────────────────────────────────────────────────────────────────────

import { norm } from './db.mjs';

/** Bandas de monto, en soles. Operan sobre monto_pen. */
export const MONTOS = {
  s0: { label: 'Sin monto publicado', sql: 'p.monto <= 0' },
  s1: { label: 'Hasta S/ 100 mil', sql: 'p.monto_pen > 0 AND p.monto_pen < 100000' },
  s2: { label: 'S/ 100 mil – 500 mil', sql: 'p.monto_pen >= 100000 AND p.monto_pen < 500000' },
  s3: { label: 'S/ 500 mil – 1 M', sql: 'p.monto_pen >= 500000 AND p.monto_pen < 1000000' },
  s4: { label: 'S/ 1 M – 5 M', sql: 'p.monto_pen >= 1000000 AND p.monto_pen < 5000000' },
  s5: { label: 'Más de S/ 5 M', sql: 'p.monto_pen >= 5000000' },
};

export const ORDENES = {
  reciente: 'p.fecha_dia DESC, p.ocid',
  antiguo: 'p.fecha_dia ASC, p.ocid',
  monto: 'p.monto_pen DESC NULLS LAST, p.ocid',
  cierre: 'p.cierre_ofertas ASC NULLS LAST, p.ocid',
};

/**
 * Texto del usuario → consulta FTS5 segura.
 *
 * Se envuelve cada término en comillas para que los operadores de FTS5
 * (`AND`, `OR`, `NEAR`, `*`, `^`, `-`, `:`) no se interpreten: lo que el usuario
 * escribe es texto, no sintaxis. Un abogado no debería toparse nunca con eso.
 *
 *   servicio de limpieza     → "servicio"* AND "de"* AND "limpieza"*
 *   "servicio de limpieza"   → "servicio de limpieza"      (frase exacta)
 *
 * Los términos sueltos llevan `*` (prefijo) para que "limpieza" encuentre también
 * "limpiezas" — el tokenizador no hace lematización y el español pluraliza mucho.
 * Las frases entre comillas se respetan tal cual.
 */
export function aFts(texto) {
  const t = (texto ?? '').trim();
  if (!t) return null;
  const partes = [];
  // Frases entre comillas primero; el resto se parte por espacios.
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    if (m[1]) {
      const frase = m[1].replace(/"/g, ' ').trim();
      if (frase) partes.push(`"${frase}"`);
    } else {
      const palabra = m[2].replace(/"/g, '').trim();
      if (palabra) partes.push(`"${palabra}"*`);
    }
  }
  return partes.length ? partes.join(' AND ') : null;
}

const lista = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean);
const marcas = (n) => Array(n).fill('?').join(',');

/** Construye WHERE + parámetros, compartidos por buscar(), estadísticas y vencimientos. */
function condiciones(db, f) {
  const where = [];
  const par = [];

  const ents = lista(f.entidades);
  if (ents.length) { where.push(`p.entidad_id IN (${marcas(ents.length)})`); par.push(...ents); }

  const fts = aFts(f.objeto);
  if (fts) {
    where.push('p.ocid IN (SELECT ocid FROM procesos_fts WHERE procesos_fts MATCH ?)');
    par.push(fts);
  }

  // Proveedor/postor: por RUC va directo; por nombre se resuelven primero los RUCs
  // en el índice de proveedores y luego se filtra por ellos (un LIKE sobre las
  // 1,7 M de filas de `actores` tardaba segundos).
  const prov = (f.proveedor ?? '').trim();
  if (prov) {
    const rucs = /^[\d\s-]+$/.test(prov)
      ? [prov.replace(/[\s-]/g, '')]
      : buscarProveedores(db, prov, { limite: 200 }).map((x) => x.ruc);
    if (rucs.length === 0) {
      where.push('1 = 0'); // nombre sin coincidencias ⇒ cero resultados, no "sin filtro"
    } else {
      where.push(`p.ocid IN (SELECT ocid FROM actores WHERE ruc IN (${marcas(rucs.length)}))`);
      par.push(...rucs);
    }
  }

  if (f.desde) { where.push('p.fecha_dia >= ?'); par.push(f.desde); }
  if (f.hasta) { where.push('p.fecha_dia <= ?'); par.push(f.hasta); }

  for (const [campo, col] of [['categorias', 'p.categoria'], ['metodos', 'p.metodo']]) {
    const v = lista(f[campo]);
    if (v.length) { where.push(`${col} IN (${marcas(v.length)})`); par.push(...v); }
  }

  const deps = lista(f.departamentos);
  if (deps.length) {
    where.push(`p.entidad_id IN (SELECT id FROM entidades WHERE departamento IN (${marcas(deps.length)}))`);
    par.push(...deps);
  }

  const est = lista(f.estados);
  if (est.length) {
    where.push(`p.ocid IN (SELECT ocid FROM proceso_estado WHERE estado IN (${marcas(est.length)}))`);
    par.push(...est);
  }

  const mon = lista(f.montos).filter((r) => MONTOS[r]);
  if (mon.length) where.push('(' + mon.map((r) => MONTOS[r].sql).join(' OR ') + ')');

  if (f.conAdjudicacion) where.push(`EXISTS (SELECT 1 FROM actores a WHERE a.ocid = p.ocid AND a.rol = 'supplier')`);
  if (f.soloUnPostor) where.push('p.n_postores = 1');

  return { sql: where.length ? 'WHERE ' + where.join('\n  AND ') : '', par };
}

const SELECT_PROCESO = `
  SELECT p.ocid, p.nomenclatura, p.descripcion, p.categoria, p.metodo,
         p.monto, p.moneda, p.monto_pen, p.protegido,
         p.fecha, p.fecha_dia, p.cierre_ofertas, p.tender_ini, p.tender_fin,
         p.enquiry_ini, p.enquiry_fin, p.n_postores, p.proyecto,
         e.id AS entidad_id, e.nombre AS entidad, e.departamento, e.provincia, e.distrito
  FROM procesos p
  LEFT JOIN entidades e ON e.id = p.entidad_id`;

/** Busca procesos. Devuelve { total, resultados, pagina, paginas }. */
export function buscar(db, filtros = {}, { limite = 50, pagina = 1, orden = 'reciente' } = {}) {
  const { sql, par } = condiciones(db, filtros);
  const total = db.prepare(`SELECT count(*) AS n FROM procesos p ${sql}`).get(...par).n;
  const orderBy = ORDENES[orden] ?? ORDENES.reciente;
  const offset = Math.max(0, (pagina - 1) * limite);
  const filas = db.prepare(`${SELECT_PROCESO} ${sql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...par, limite, offset);
  return {
    total,
    pagina,
    paginas: Math.max(1, Math.ceil(total / limite)),
    resultados: filas.map((r) => hidratar(db, r)),
  };
}

const qEstados = (db) => db.prepare('SELECT estado FROM proceso_estado WHERE ocid = ?');
const qDocs = (db) => db.prepare('SELECT tipo, titulo, url, formato, publicado FROM documentos WHERE ocid = ? ORDER BY publicado');
const qAdj = (db) => db.prepare(`SELECT a.monto, a.moneda, a.monto_pen, a.fecha,
    (SELECT group_concat(r.nombre, ' | ') FROM adjudicacion_ruc r WHERE r.adjudicacion_id = a.id) AS proveedores
  FROM adjudicaciones a WHERE a.ocid = ?`);
const qActores = (db) => db.prepare('SELECT ruc, nombre, rol FROM actores WHERE ocid = ? ORDER BY rol, nombre');

/** Añade a una fila de proceso sus estados, documentos, adjudicaciones y actores. */
function hidratar(db, r) {
  db._q ??= { estados: qEstados(db), docs: qDocs(db), adj: qAdj(db), act: qActores(db) };
  const actores = db._q.act.all(r.ocid);
  return {
    ...r,
    protegido: !!r.protegido,
    estados: db._q.estados.all(r.ocid).map((x) => x.estado),
    documentos: db._q.docs.all(r.ocid),
    adjudicaciones: db._q.adj.all(r.ocid).map((a) => ({
      ...a, proveedores: a.proveedores ? a.proveedores.split(' | ') : [],
    })),
    postores: actores.filter((a) => a.rol === 'tenderer'),
    proveedores: actores.filter((a) => a.rol === 'supplier'),
    // Etapas: solo las dos que el OECE publica en datos abiertos. El cronograma
    // completo vive en la ficha del SEACE y en las bases (ver API.md §5).
    etapas: [
      r.tender_ini || r.tender_fin ? {
        etapa: r.tender_ini && r.tender_fin && r.tender_ini.slice(0, 10) === r.tender_fin.slice(0, 10)
          ? 'Convocatoria (fecha de publicación)'
          : 'Convocatoria → Presentación de ofertas',
        inicio: r.tender_ini, fin: r.tender_fin,
      } : null,
      r.enquiry_ini || r.enquiry_fin
        ? { etapa: 'Consultas y observaciones', inicio: r.enquiry_ini, fin: r.enquiry_fin }
        : null,
    ].filter(Boolean),
  };
}

// ── Autocompletados ───────────────────────────────────────────────────────────

/** Entidades por nombre o sigla. Devuelve id + nombre oficial + nº de procesos.
 *
 *  Cada palabra se exige por separado en vez de buscar la frase entera: quien
 *  escribe "municipalidad de mira" espera encontrar
 *  "MUNICIPALIDAD DISTRITAL DE MIRAFLORES", y una subcadena literal no lo halla. */
export function buscarEntidades(db, texto, { limite = 20, siglas = {} } = {}) {
  const t = norm(texto);
  if (!t) return [];
  // Una sigla ('essalud') no aparece en el nombre oficial ('SEGURO SOCIAL DE SALUD'),
  // así que se traduce antes de consultar. Ver API.md §5 y siglas.json.
  const expandido = siglas[t] ? norm(siglas[t]) : t;
  const palabras = expandido.split(' ').filter(Boolean);
  const cond = palabras.map(() => 'e.nombre_norm LIKE ?').join(' AND ');
  const filas = db.prepare(`
    SELECT e.id, e.nombre, e.departamento, count(p.ocid) AS procesos
    FROM entidades e LEFT JOIN procesos p ON p.entidad_id = e.id
    WHERE ${cond}
    GROUP BY e.id
    ORDER BY (e.nombre_norm = ?) DESC, procesos DESC, length(e.nombre), e.nombre
    LIMIT ?`).all(...palabras.map((p) => '%' + p + '%'), expandido, limite);
  return filas.map((f) => ({
    ...f,
    // Marca la entidad que la sigla designa, para poder mostrarla en la lista.
    sigla: siglas[t] && norm(f.nombre).includes(expandido) ? texto.trim().toUpperCase() : null,
  }));
}

/** Proveedores/postores por RUC o razón social, desde nuestro propio índice
 *  (el endpoint de proveedores del OECE ignora la búsqueda por nombre — API.md §1).
 *
 *  Va contra la tabla `proveedores` + FTS, no contra `actores`: el LIKE sobre los
 *  1,7 M de participaciones tardaba ~8 s. */
export function buscarProveedores(db, texto, { limite = 20 } = {}) {
  const t = (texto ?? '').trim();
  if (!t) return [];
  // Todo dígitos ⇒ es un RUC (o su comienzo), aunque esté incompleto.
  if (/^\d+$/.test(t.replace(/[\s-]/g, ''))) {
    const d = t.replace(/[\s-]/g, '');
    return db.prepare(`SELECT ruc, nombre, procesos, ganados, ultimo FROM proveedores
                       WHERE ruc LIKE ? ORDER BY procesos DESC LIMIT ?`).all(d + '%', limite);
  }
  const fts = aFts(t);
  if (!fts) return [];
  return db.prepare(`
    SELECT p.ruc, p.nombre, p.procesos, p.ganados, p.ultimo
    FROM proveedores_fts f JOIN proveedores p ON p.ruc = f.ruc
    WHERE proveedores_fts MATCH ?
    ORDER BY p.procesos DESC
    LIMIT ?`).all(fts, limite);
}

// ── Estadísticas ──────────────────────────────────────────────────────────────

/**
 * Estadísticas del conjunto filtrado.
 *
 * `medida` decide qué mide cada barra:
 *   'procesos' (por defecto) → nº de procesos. Fiable siempre.
 *   'monto'                  → soles, sumando SOLO monto_pen.
 *
 * Por qué el defecto es 'procesos': apenas el 43,6 % de los procesos publica su
 * monto referencial (el SEACE lo protege hasta la buena pro). Un ranking "por
 * monto" no dice quién compra más, dice quién compra más *entre los que
 * revelaron el importe*. La cobertura se devuelve en `cobertura` para poder
 * enseñarla en pantalla en vez de esconderla en una nota al pie.
 */
export function estadisticas(db, filtros = {}, { medida = 'procesos', top = 10 } = {}) {
  const { sql, par } = condiciones(db, filtros);
  const metrica = medida === 'monto' ? 'COALESCE(sum(p.monto_pen), 0)' : 'count(*)';

  const resumen = db.prepare(`
    SELECT count(*) AS procesos,
           count(DISTINCT p.entidad_id) AS entidades,
           sum(CASE WHEN p.monto > 0 THEN 1 ELSE 0 END) AS con_monto,
           sum(CASE WHEN p.monto > 0 AND p.monto_pen IS NULL THEN 1 ELSE 0 END) AS sin_convertir,
           COALESCE(sum(p.monto_pen), 0) AS monto_total,
           COALESCE(sum(p.n_postores), 0) AS postores,
           sum(CASE WHEN p.n_postores = 1 THEN 1 ELSE 0 END) AS un_postor
    FROM procesos p ${sql}`).get(...par);

  const adjudicados = db.prepare(`SELECT count(*) AS n FROM procesos p ${sql}
    ${sql ? 'AND' : 'WHERE'} EXISTS (SELECT 1 FROM actores a WHERE a.ocid = p.ocid AND a.rol='supplier')`)
    .get(...par).n;

  const grupo = (expr, join = '') => db.prepare(`
    SELECT ${expr} AS nombre, ${metrica} AS valor, count(*) AS procesos
    FROM procesos p ${join} ${sql}
    ${sql ? 'AND' : 'WHERE'} ${expr} IS NOT NULL
    GROUP BY ${expr} ORDER BY valor DESC LIMIT ?`).all(...par, top);

  // Proveedores: se mide por el monto de SU adjudicación, no por el referencial
  // del proceso. Un proceso multi-award (medicinas, por ejemplo) se reparte entre
  // varios ganadores y atribuirle a cada uno el total del proceso lo multiplicaría.
  const proveedores = db.prepare(`
    SELECT r.nombre,
           ${medida === 'monto'
      ? `COALESCE(sum(a.monto_pen / max(1, (SELECT count(*) FROM adjudicacion_ruc r2 WHERE r2.adjudicacion_id = a.id))), 0)`
      : 'count(DISTINCT p.ocid)'} AS valor,
           count(DISTINCT p.ocid) AS procesos
    FROM procesos p
    JOIN adjudicaciones a ON a.ocid = p.ocid
    JOIN adjudicacion_ruc r ON r.adjudicacion_id = a.id
    ${sql}
    GROUP BY r.ruc ORDER BY valor DESC LIMIT ?`).all(...par, top);

  const porMes = db.prepare(`
    SELECT substr(p.fecha_dia, 1, 7) AS nombre, ${metrica} AS valor, count(*) AS procesos
    FROM procesos p ${sql}
    ${sql ? 'AND' : 'WHERE'} p.fecha_dia IS NOT NULL
    GROUP BY nombre ORDER BY nombre`).all(...par);

  return {
    medida,
    resumen: {
      ...resumen,
      adjudicados,
      // El dato que evita que alguien cite una cifra que no puede defender.
      cobertura: resumen.procesos ? +(resumen.con_monto / resumen.procesos * 100).toFixed(1) : 0,
    },
    entidades: grupo('e.nombre', 'LEFT JOIN entidades e ON e.id = p.entidad_id'),
    proveedores,
    categorias: grupo('p.categoria'),
    departamentos: grupo('e.departamento', 'LEFT JOIN entidades e ON e.id = p.entidad_id'),
    porMes,
  };
}

/** Valores disponibles para los desplegables — derivados de los datos, no hardcodeados. */
export function facetas(db) {
  const col = (s) => db.prepare(s).all();
  return {
    categorias: col(`SELECT categoria AS valor, count(*) AS n FROM procesos
                     WHERE categoria IS NOT NULL GROUP BY categoria ORDER BY n DESC`),
    metodos: col(`SELECT metodo AS valor, count(*) AS n FROM procesos
                  WHERE metodo IS NOT NULL GROUP BY metodo ORDER BY n DESC`),
    estados: col(`SELECT estado AS valor, count(*) AS n FROM proceso_estado
                  GROUP BY estado ORDER BY n DESC`),
    departamentos: col(`SELECT departamento AS valor, count(*) AS n FROM entidades
                        WHERE departamento IS NOT NULL GROUP BY departamento ORDER BY valor`),
    montos: Object.entries(MONTOS).map(([k, v]) => ({ valor: k, label: v.label })),
    rango: db.prepare('SELECT min(fecha_dia) AS desde, max(fecha_dia) AS hasta FROM procesos').get(),
  };
}

/**
 * Plazos que vencen en los próximos `dias` días.
 *
 * OJO cuál es el plazo utilizable. Medido sobre 152.173 procesos (24 meses):
 *
 *   tenderPeriod.endDate  → existe en el 94 %, pero coincide con el día de
 *                           publicación en el 95,6 % de los casos. Solo 6.653
 *                           (4,4 %) son un cierre de ofertas real, y NINGUNO
 *                           está en el futuro. No sirve para avisar de nada.
 *   enquiryPeriod.endDate → existe en el 71,1 % y sí llega al futuro.
 *
 * Así que el aviso se construye sobre el **fin de consultas y observaciones**,
 * que además es el plazo que de verdad le importa a un estudio: es la ventana
 * para cuestionar formalmente las bases. El cierre de ofertas se muestra cuando
 * existe, pero no se puede prometer.
 */
export function proximosVencimientos(db, filtros = {}, { dias = 7, limite = 50 } = {}) {
  const { sql, par } = condiciones(db, filtros);
  const hoy = hoyLima();
  const hasta = new Date(Date.parse(hoy + 'T00:00:00-05:00') + dias * 86_400_000)
    .toISOString().slice(0, 10);
  const extra = (sql ? sql + '\n  AND ' : 'WHERE ') +
    'p.enquiry_fin IS NOT NULL AND substr(p.enquiry_fin,1,10) BETWEEN ? AND ?';
  return db.prepare(`${SELECT_PROCESO} ${extra} ORDER BY p.enquiry_fin ASC LIMIT ?`)
    .all(...par, hoy, hasta, limite)
    .map((r) => ({ ...hidratar(db, r), plazo: 'Consultas y observaciones', vence: r.enquiry_fin }));
}

/** Fecha de hoy en Lima (UTC-5). NO usar toISOString() sobre la hora local: a las
 *  20:00 de Lima ya es el día siguiente en UTC y "Hoy" se quedaría sin resultados. */
export function hoyLima() {
  return new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
}
