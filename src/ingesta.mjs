// ──────────────────────────────────────────────────────────────────────────────
// Ingesta de los archivos mensuales del OECE → datos.db
//
//   npm run ingesta              # últimos 24 meses (salta los ya ingestados)
//   npm run ingesta -- --meses 6
//   npm run ingesta -- --desde 2025-01
//   npm run ingesta -- --rehacer # re-ingesta también los meses ya cargados
//
// El mes en curso siempre se re-ingesta (el OECE lo regenera a diario). Los meses
// pasados son inmutables: una vez cargados, se saltan.
// ──────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { ensureMonthFile } from './bulk.mjs';
import { abrirDatos, mesesIngestados, norm, limpiar } from './db.mjs';

const args = process.argv.slice(2);
const flag = (n, def) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const REHACER = args.includes('--rehacer');
const DESDE = flag('desde', null);            // 'YYYY-MM'
const N_MESES = Number(flag('meses', 24));

/** Lista de [año, mes] a procesar, del más reciente al más antiguo. */
function mesesObjetivo() {
  const now = new Date();
  const out = [];
  if (DESDE) {
    const [y0, m0] = DESDE.split('-').map(Number);
    let y = now.getFullYear(), m = now.getMonth() + 1;
    while (y > y0 || (y === y0 && m >= m0)) {
      out.push([y, m]);
      if (--m === 0) { m = 12; y--; }
      if (out.length > 240) break;
    }
    return out;
  }
  for (let i = 0; i < N_MESES; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push([d.getFullYear(), d.getMonth() + 1]);
  }
  return out;
}

// ── Extracción desde el OCDS crudo ────────────────────────────────────────────
// Se lee el release directamente (no vía normalize()) porque normalize() aplana y
// pierde justo lo que aquí interesa: postores, RUCs, dirección y amount_PEN.

/** Monto en soles, o null si no se puede saber.
 *
 *  `amount_PEN` NO está siempre: entre los procesos con monto > 0 falta en el 10 %
 *  de los USD y en algunos EUR (verificado). Rellenar con 0 en esos casos haría que
 *  un proceso de USD 2 M contara como cero y nadie lo notaría. Se deja en NULL:
 *  SUM() lo ignora y, sobre todo, se puede CONTAR y declarar en la interfaz. */
function enSoles(monto, moneda, montoPen) {
  if (!monto || monto <= 0) return 0;
  if (montoPen > 0) return montoPen;
  if (moneda === 'PEN') return monto;
  return null;
}

const rucDe = (party) => {
  const m = /^PE-RUC-(.+)$/.exec(party?.id ?? '');
  if (m) return m[1];
  const ai = (party?.additionalIdentifiers ?? []).find((x) => x.scheme === 'PE-RUC');
  return ai?.id ?? null;
};

function entidadDe(rel) {
  const id = rel.buyer?.id ?? rel.tender?.procuringEntity?.id;
  if (!id) return null;
  const p = (rel.parties ?? []).find((x) => x.id === id) ?? {};
  const nombre = limpiar(rel.buyer?.name ?? p.name ?? rel.tender?.procuringEntity?.name ?? '(sin nombre)');
  return {
    id,
    nombre,
    nombre_norm: norm(nombre),
    ruc: rucDe(p),
    departamento: p.address?.department ?? null,
    provincia: p.address?.region ?? null,
    distrito: p.address?.locality ?? null,
    direccion: p.address?.streetAddress ?? null,
    telefono: p.contactPoint?.telephone ?? null,
    web: p.contactPoint?.url ?? null,
  };
}

/**
 * ¿Es "Consultoría de Obra"?
 *
 * SEACE tiene 4 objetos de contratación pero OCDS solo publica 3
 * (`goods`/`services`/`works`), y consultoría de obra va metida en `services`.
 * Se reconstruye con dos señales del propio dato, no con adivinanzas de texto:
 *
 *   · UNSPSC familia 8110 — "servicios profesionales de ingeniería", que es
 *     exactamente supervisión de obra y elaboración de expediente técnico.
 *     Ojo: 8111 es informática, por eso se compara la familia de 4 dígitos y
 *     no el segmento 81 entero.
 *   · procurementMethodDetails con "consultor" (Concurso Público para
 *     Consultoría, Selección de Consultores Individuales).
 */
function esConsultoriaObra(t) {
  if (t.mainProcurementCategory !== 'services') return 0;
  if (/consultor/i.test(t.procurementMethodDetails ?? '')) return 1;
  for (const it of t.items ?? []) {
    for (const c of it.additionalClassifications ?? []) {
      if (c.scheme === 'UNSPSC' && String(c.id).startsWith('8110')) return 1;
    }
  }
  return 0;
}

function procesoDe(rel, mes) {
  const t = rel.tender ?? {};
  const monto = t.value?.amount ?? 0;
  const montoPen = enSoles(monto, t.value?.currency, t.value?.amount_PEN);
  const tpIni = t.tenderPeriod?.startDate ?? null;
  const tpFin = t.tenderPeriod?.endDate ?? null;
  const fecha = t.datePublished ?? rel.date ?? null;
  // Las fechas del OECE ya vienen con offset -05:00, así que los 10 primeros
  // caracteres SON el día en hora de Lima. No usar toISOString() (daría UTC).
  return {
    ocid: rel.ocid,
    mes,
    tender_id: t.id ?? null,
    nomenclatura: t.title ?? '',
    descripcion: t.description ?? '',
    entidad_id: rel.buyer?.id ?? t.procuringEntity?.id ?? null,
    categoria: t.mainProcurementCategory ?? null,
    metodo: t.procurementMethodDetails ?? null,
    monto,
    moneda: t.value?.currency ?? 'PEN',
    monto_pen: montoPen,
    protegido: t.hasTenderInformationProtectedByLaw ? 1 : 0,
    fecha,
    fecha_dia: fecha ? fecha.slice(0, 10) : null,
    // Cierre de ofertas: solo si es ESTRICTAMENTE POSTERIOR a la publicación.
    //
    // No es quisquillosidad. De los 6.653 procesos que traían un `tenderPeriod.endDate`
    // distinto del día de publicación, 5.229 (el 79 %) lo tenían ANTERIOR — un plazo
    // que venció meses antes de que el proceso se publicara. Enseñar eso en una
    // ficha es peor que no enseñar nada. Con este filtro quedan 1.424 en 24 meses:
    // el 0,9 % de los procesos. La conclusión honesta es que el cierre de ofertas
    // prácticamente no se publica en datos abiertos (ver API.md §2).
    cierre_ofertas: tpFin && fecha && tpFin.slice(0, 10) > fecha.slice(0, 10) ? tpFin : null,
    tender_ini: tpIni,
    tender_fin: tpFin,
    enquiry_ini: t.enquiryPeriod?.startDate ?? null,
    enquiry_fin: t.enquiryPeriod?.endDate ?? null,
    n_postores: t.numberOfTenderers ?? (t.tenderers ?? []).length,
    proyecto: rel.planning?.budget?.project ?? null,
    proyecto_id: rel.planning?.budget?.projectID ?? null,
    es_consultoria: esConsultoriaObra(t),
  };
}

// ── Ingesta ───────────────────────────────────────────────────────────────────

const db = abrirDatos();
const yaIngestados = mesesIngestados(db);

const sql = {
  entidad: db.prepare(`INSERT INTO entidades (id,nombre,nombre_norm,ruc,departamento,provincia,distrito,direccion,telefono,web)
    VALUES (@id,@nombre,@nombre_norm,@ruc,@departamento,@provincia,@distrito,@direccion,@telefono,@web)
    ON CONFLICT(id) DO UPDATE SET nombre=excluded.nombre, nombre_norm=excluded.nombre_norm,
      ruc=COALESCE(excluded.ruc,ruc), departamento=COALESCE(excluded.departamento,departamento),
      provincia=COALESCE(excluded.provincia,provincia), distrito=COALESCE(excluded.distrito,distrito),
      direccion=COALESCE(excluded.direccion,direccion), telefono=COALESCE(excluded.telefono,telefono),
      web=COALESCE(excluded.web,web)`),
  proceso: db.prepare(`INSERT OR REPLACE INTO procesos
    (ocid,mes,tender_id,nomenclatura,descripcion,entidad_id,categoria,metodo,monto,moneda,monto_pen,
     protegido,fecha,fecha_dia,cierre_ofertas,tender_ini,tender_fin,enquiry_ini,enquiry_fin,
     n_postores,proyecto,proyecto_id,es_consultoria)
    VALUES (@ocid,@mes,@tender_id,@nomenclatura,@descripcion,@entidad_id,@categoria,@metodo,@monto,@moneda,
     @monto_pen,@protegido,@fecha,@fecha_dia,@cierre_ofertas,@tender_ini,@tender_fin,@enquiry_ini,
     @enquiry_fin,@n_postores,@proyecto,@proyecto_id,@es_consultoria)`),
  estado: db.prepare('INSERT OR IGNORE INTO proceso_estado (ocid,estado) VALUES (?,?)'),
  item: db.prepare(`INSERT INTO items (id,ocid,posicion,descripcion,cantidad,unidad,monto,estado,cubso_id,cubso_desc,unspsc_id,unspsc_desc)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
  actor: db.prepare('INSERT OR IGNORE INTO actores (ocid,ruc,nombre,nombre_norm,rol) VALUES (?,?,?,?,?)'),
  adj: db.prepare('INSERT OR REPLACE INTO adjudicaciones (id,ocid,fecha,monto,moneda,monto_pen) VALUES (?,?,?,?,?,?)'),
  adjRuc: db.prepare('INSERT OR IGNORE INTO adjudicacion_ruc (adjudicacion_id,ruc,nombre) VALUES (?,?,?)'),
  contrato: db.prepare(`INSERT OR REPLACE INTO contratos (id,ocid,award_id,titulo,firmado,inicio,fin,monto,moneda,monto_pen)
    VALUES (?,?,?,?,?,?,?,?,?,?)`),
  doc: db.prepare('INSERT INTO documentos (id,ocid,tipo,titulo,url,formato,publicado) VALUES (?,?,?,?,?,?,?)'),
  marcarMes: db.prepare('INSERT OR REPLACE INTO meses (mes,procesos,publicado,ingestado_el) VALUES (?,?,?,?)'),
};

/** Borra todo lo de un mes para poder re-ingestarlo sin duplicar. */
const borrarMes = db.transaction((mes) => {
  const ocids = db.prepare('SELECT ocid FROM procesos WHERE mes = ?').all(mes).map((r) => r.ocid);
  if (ocids.length === 0) return 0;
  const chunk = 400; // tope de variables por statement
  for (let i = 0; i < ocids.length; i += chunk) {
    const parte = ocids.slice(i, i + chunk);
    const ph = parte.map(() => '?').join(',');
    db.prepare(`DELETE FROM adjudicacion_ruc WHERE adjudicacion_id IN
                (SELECT id FROM adjudicaciones WHERE ocid IN (${ph}))`).run(...parte);
    for (const tabla of ['documentos', 'contratos', 'adjudicaciones', 'actores', 'items', 'proceso_estado']) {
      db.prepare(`DELETE FROM ${tabla} WHERE ocid IN (${ph})`).run(...parte);
    }
    db.prepare(`DELETE FROM procesos WHERE ocid IN (${ph})`).run(...parte);
  }
  return ocids.length;
});

const insertarMes = db.transaction((registros, mes) => {
  let n = 0, postores = 0;
  for (const rec of registros) {
    const rel = rec.compiledRelease ?? rec;
    const t = rel.tender;
    if (!t || !rel.ocid) continue;

    const ent = entidadDe(rel);
    if (ent) sql.entidad.run(ent);

    const p = procesoDe(rel, mes);
    sql.proceso.run(p);
    n++;

    const items = t.items ?? [];
    for (const e of new Set(items.map((i) => i.statusDetails).filter(Boolean))) sql.estado.run(p.ocid, e);

    for (const it of items) {
      const uns = (it.additionalClassifications ?? []).find((c) => c.scheme === 'UNSPSC');
      sql.item.run(
        String(it.id ?? ''), p.ocid, it.position ?? null, it.description ?? '',
        it.quantity ?? null, it.unit?.name ?? null, it.totalValue?.amount ?? null,
        it.statusDetails ?? null,
        it.classification?.scheme === 'CUBSO' ? String(it.classification.id) : null,
        it.classification?.scheme === 'CUBSO' ? it.classification.description : null,
        uns ? String(uns.id) : null, uns ? uns.description : null,
      );
    }

    // Postores y adjudicados. Una misma parte puede tener los dos roles.
    for (const party of rel.parties ?? []) {
      const roles = (party.roles ?? []).filter((r) => r === 'tenderer' || r === 'supplier');
      if (roles.length === 0) continue;
      const ruc = rucDe(party);
      if (!ruc || !party.name) continue;
      for (const rol of roles) {
        sql.actor.run(p.ocid, ruc, party.name, norm(party.name), rol);
        if (rol === 'tenderer') postores++;
      }
    }

    for (const a of rel.awards ?? []) {
      const id = String(a.id ?? `${p.ocid}-award`);
      const moneda = a.value?.currency ?? 'PEN';
      sql.adj.run(id, p.ocid, a.date ?? null, a.value?.amount ?? 0, moneda,
        enSoles(a.value?.amount ?? 0, moneda, a.value?.amount_PEN));
      for (const s of a.suppliers ?? []) {
        const ruc = rucDe(s);
        if (ruc && s.name) sql.adjRuc.run(id, ruc, s.name);
      }
    }

    for (const c of rel.contracts ?? []) {
      const moneda = c.value?.currency ?? 'PEN';
      sql.contrato.run(String(c.id ?? ''), p.ocid, c.awardID ?? null, c.title ?? c.description ?? null,
        c.dateSigned ?? null, c.period?.startDate ?? null, c.period?.endDate ?? null,
        c.value?.amount ?? 0, moneda, enSoles(c.value?.amount ?? 0, moneda, c.value?.amount_PEN));
    }

    for (const d of t.documents ?? []) {
      sql.doc.run(String(d.id ?? ''), p.ocid, d.documentType ?? null, d.title ?? null,
        d.url ?? null, d.format ?? null, d.datePublished ?? null);
    }
  }
  return { n, postores };
});

// ── Bucle principal ───────────────────────────────────────────────────────────

// Del más ANTIGUO al más reciente a propósito: un proceso convocado en junio
// reaparece en el archivo de julio con su estado más fresco (adjudicación, etc.).
// Al ir en este orden, el archivo más nuevo es el que gana el INSERT OR REPLACE.
const objetivo = mesesObjetivo().reverse();
console.log(`📥 Ingesta a datos.db — ${objetivo.length} mes(es) objetivo${REHACER ? ' (rehaciendo todo)' : ''}`);

// Catálogo completo de entidades ANTES que los procesos: el autocompletado debe
// ofrecer las 3.3k entidades del Estado, no solo las que convocaron algo este mes.
// Los datos de dirección/RUC los rellena después la ingesta de procesos.
try {
  const r = await fetch('https://contratacionesabiertas.oece.gob.pe/static/buyers.json',
    { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const cat = await r.json();
  const insertarCatalogo = db.transaction((entradas) => {
    for (const [id, nombre] of entradas) {
      const n = limpiar(String(nombre));
      sql.entidad.run({
        id, nombre: n, nombre_norm: norm(n),
        ruc: null, departamento: null, provincia: null, distrito: null,
        direccion: null, telefono: null, web: null,
      });
    }
  });
  const entradas = Object.entries(cat);
  insertarCatalogo(entradas);
  console.log(`   catálogo de entidades: ${entradas.length}`);
} catch (err) {
  console.warn(`   ⚠ no se pudo refrescar el catálogo de entidades (${err.message}); se sigue con las de los procesos.`);
}

const ahora = new Date();
const mesActual = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`;
let totalProcesos = 0, totalPostores = 0, saltados = 0, fallidos = 0, huboCambios = false;
const t0 = Date.now();

for (const [y, m] of objetivo) {
  const mes = `${y}-${String(m).padStart(2, '0')}`;
  // Los meses pasados son inmutables; solo el actual se refresca.
  if (!REHACER && yaIngestados.has(mes) && mes !== mesActual) { saltados++; continue; }

  let file;
  try {
    process.stdout.write(`   ${mes} … descargando`);
    file = await ensureMonthFile(y, m);
  } catch (err) {
    console.log(`\r   ${mes} ⚠ descarga falló: ${err.message}`);
    fallidos++;
    continue;
  }
  if (!file) { console.log(`\r   ${mes} · aún no publicado`); continue; }

  let pkg;
  try {
    process.stdout.write(`\r   ${mes} … leyendo    `);
    pkg = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.log(`\r   ${mes} ⚠ JSON ilegible: ${err.message}`);
    fallidos++;
    continue;
  }

  process.stdout.write(`\r   ${mes} … insertando `);
  borrarMes(mes);
  const { n, postores } = insertarMes(pkg.records ?? [], mes);
  sql.marcarMes.run(mes, n, pkg.publishedDate ?? null, new Date().toISOString());
  totalProcesos += n;
  totalPostores += postores;
  huboCambios = true;
  console.log(`\r   ${mes} ✔ ${String(n).padStart(5)} procesos · ${String(postores).padStart(5)} postores`);
}

// El índice de texto se RECONSTRUYE entero, no se mantiene incrementalmente.
// Motivo: un proceso convocado en junio reaparece en el archivo de julio y cambia
// de `mes`, así que un borrado por mes deja huérfana su fila vieja del índice.
// Reconstruir cuesta segundos y elimina esa clase de bug de raíz.
// También se reconstruye si los índices derivados quedaron desalineados —
// p. ej. tras añadir una tabla nueva al esquema sobre una base ya ingestada,
// donde no hay "cambios" que detectar pero el índice está vacío.
const nProc = db.prepare('SELECT count(*) n FROM procesos').get().n;
const desalineado = nProc > 0 && (
  db.prepare('SELECT count(*) n FROM procesos_fts').get().n !== nProc ||
  db.prepare('SELECT count(*) n FROM proveedores').get().n === 0);

if (huboCambios || desalineado) {
  if (!huboCambios) console.log('   índices desalineados con los datos — reconstruyendo.');
  process.stdout.write('   reconstruyendo índice de texto…');
  db.transaction(() => {
    db.exec('DELETE FROM procesos_fts');
    db.exec(`INSERT INTO procesos_fts (ocid, descripcion, nomenclatura, items)
             SELECT p.ocid, p.descripcion, p.nomenclatura,
                    COALESCE((SELECT group_concat(i.descripcion, ' ')
                              FROM items i WHERE i.ocid = p.ocid), '')
             FROM procesos p`);
  })();

  process.stdout.write('\r   reconstruyendo índice de proveedores…');
  db.transaction(() => {
    db.exec('DELETE FROM proveedores');
    // El nombre de un RUC puede variar entre procesos (razón social actualizada,
    // erratas). Se toma el del proceso más reciente: MAX(fecha) arrastra el nombre.
    db.exec(`INSERT INTO proveedores (ruc, nombre, nombre_norm, procesos, ganados, ultimo)
             SELECT a.ruc,
                    substr(max(p.fecha_dia || '' || a.nombre), 12),
                    substr(max(p.fecha_dia || '' || a.nombre_norm), 12),
                    count(DISTINCT a.ocid),
                    count(DISTINCT CASE WHEN a.rol = 'supplier' THEN a.ocid END),
                    max(p.fecha_dia)
             FROM actores a JOIN procesos p ON p.ocid = a.ocid
             GROUP BY a.ruc`);
    db.exec('DELETE FROM proveedores_fts');
    db.exec('INSERT INTO proveedores_fts (ruc, nombre) SELECT ruc, nombre FROM proveedores');
  })();
  console.log('\r   índices reconstruidos.                    ');
}

db.pragma('optimize');
const resumen = db.prepare(`SELECT
  (SELECT count(*) FROM procesos)  AS procesos,
  (SELECT count(*) FROM entidades) AS entidades,
  (SELECT count(DISTINCT ruc) FROM actores) AS actores,
  (SELECT count(*) FROM documentos) AS documentos,
  (SELECT count(*) FROM meses) AS meses`).get();
db.close();

console.log(`\n✔ Listo en ${((Date.now() - t0) / 1000).toFixed(0)} s` +
  (saltados ? ` · ${saltados} mes(es) ya estaban` : '') +
  (fallidos ? ` · ⚠ ${fallidos} fallaron` : ''));
console.log(`   ${totalProcesos} procesos nuevos en esta corrida (${totalPostores} postores).`);
console.log(`   Base: ${resumen.meses} meses · ${resumen.procesos} procesos · ${resumen.entidades} entidades · ` +
  `${resumen.actores} RUCs distintos · ${resumen.documentos} documentos.`);
