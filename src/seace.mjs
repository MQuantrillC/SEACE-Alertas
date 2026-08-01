// ──────────────────────────────────────────────────────────────────────────────
// Cliente de la API abierta OCDS del OECE (ex-OSCE) — datos oficiales del SEACE.
//   https://contratacionesabiertas.oece.gob.pe/api/v1/releases
// Sin API key, sin login. La API pagina de 20 en 20 ordenada por fecha de
// publicación del release (desc). Cada "release" es una convocatoria con su
// entidad compradora, descripción, ítems, montos, plazos y documentos (bases).
// ──────────────────────────────────────────────────────────────────────────────

const API = 'https://contratacionesabiertas.oece.gob.pe/api/v1/releases';
const PAGE_SIZE = 20; // máximo que devuelve la API aunque se pida más

async function fetchPage(page) {
  const url = `${API}?page=${page}&pageSize=${PAGE_SIZE}&order=desc`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
    const json = await res.json();
    return json.releases ?? [];
  } finally {
    clearTimeout(timer);
  }
}

/** Aplana un release OCDS (o compiledRelease del bulk mensual) a lo que
 *  necesitan el digest y el buscador. Exportado: lo reutiliza src/bulk.mjs. */
export function normalize(rel) {
  const t = rel.tender ?? {};
  const items = (t.items ?? []).map((i) => i.description ?? '').filter(Boolean);
  // El monto referencial suele venir en 0 (protegido hasta la buena pro); se
  // muestra solo cuando existe.
  const amount = t.value?.amount || (t.items ?? []).reduce((s, i) => s + (i.totalValue?.amount ?? 0), 0) || 0;
  const bases = (t.documents ?? []).find((d) => d.documentType === 'biddingDocuments') ?? (t.documents ?? [])[0] ?? null;

  // Etapas con fechas. OJO: la publicación OCDS del OECE solo expone DOS periodos
  // (verificado escaneando 300 procesos): tenderPeriod (convocatoria→presentación
  // de ofertas) y, a veces, enquiryPeriod (consultas y observaciones). El
  // cronograma completo etapa-por-etapa solo existe en la ficha del SEACE (que no
  // admite deep-link) y en las bases PDF — el correo enlaza a ambos caminos.
  const etapas = [];
  const tpIni = t.tenderPeriod?.startDate ?? null;
  const tpFin = t.tenderPeriod?.endDate ?? null;
  if (tpIni || tpFin) {
    // OJO semántica: tenderPeriod es la VENTANA DEL PROCESO (convocatoria →
    // presentación de ofertas), NUNCA la duración del contrato. Y cuando inicio
    // y fin son el mismo día, el SEACE solo publicó la fecha de convocatoria —
    // etiquetarlo como "presentación de ofertas" induciría a error.
    const mismoDia = tpIni && tpFin && tpIni.slice(0, 10) === tpFin.slice(0, 10);
    etapas.push({
      etapa: mismoDia ? 'Convocatoria (fecha de publicación)' : 'Convocatoria → Presentación de ofertas',
      inicio: tpIni,
      fin: tpFin,
    });
  }
  if (t.enquiryPeriod?.startDate || t.enquiryPeriod?.endDate) {
    etapas.push({ etapa: 'Consultas y observaciones', inicio: t.enquiryPeriod?.startDate ?? null, fin: t.enquiryPeriod?.endDate ?? null });
  }
  // Cierre de ofertas "real": solo cuando el fin de la ventana es posterior a la
  // publicación (si coinciden, el SEACE aún no publicó el cierre).
  const cierreReal = tpFin && (t.datePublished ?? '').slice(0, 10) !== tpFin.slice(0, 10) ? tpFin : null;
  return {
    ocid: rel.ocid,
    // Fecha de publicación real de la convocatoria (el release.date es la hora
    // del lote de conversión OCDS, igual para cientos de procesos).
    fecha: t.datePublished ?? rel.date ?? null,
    nomenclatura: t.title ?? '',
    descripcion: t.description ?? '',
    items,
    entidad: rel.buyer?.name ?? t.procuringEntity?.name ?? 'Entidad no especificada',
    categoria: t.mainProcurementCategory ?? '',
    metodo: t.procurementMethodDetails ?? '',
    monto: amount,
    moneda: t.value?.currency ?? 'PEN',
    cierreOfertas: cierreReal,
    etapas,
    basesUrl: bases?.url ?? null,
    // Departamento de la entidad convocante (extensión OCDS del OECE) — presente
    // en el 100% de los records del bulk mensual.
    departamento: (rel.parties ?? []).find((p) => (p.roles ?? []).some((r) => r === 'buyer' || r === 'procuringEntity'))
      ?.address?.department ?? null,
    // Estados del proceso a nivel ítem (CONVOCADO/ADJUDICADO/DESIERTO/CONTRATADO…).
    estados: [...new Set((t.items ?? []).map((i) => i.statusDetails).filter(Boolean))],
    // Proveedores adjudicados (aparecen en el compiledRelease cuando el proceso
    // avanza a buena pro/contrato) — permiten buscar también por competidor.
    proveedores: (rel.parties ?? [])
      .filter((p) => (p.roles ?? []).includes('supplier'))
      .map((p) => p.name)
      .filter(Boolean),
    // Adjudicaciones CON SU MONTO REAL por award. Crítico para estadísticas: un
    // proceso de medicinas se adjudica ítem por ítem a varios laboratorios — el
    // monto de cada proveedor es el de SU award, no el referencial del proceso.
    adjudicaciones: (rel.awards ?? []).map((a) => ({
      monto: a.value?.amount ?? 0,
      moneda: a.value?.currency ?? 'PEN',
      proveedores: (a.suppliers ?? []).map((s) => s.name).filter(Boolean),
      fecha: a.date ?? null,
    })),
  };
}

/**
 * Descarga releases recientes. OJO: la API ordena por la fecha del LOTE de
 * publicación OCDS (release.date), no por la fecha de la convocatoria — un
 * lote de hoy puede traer procesos convocados ayer. Por eso se pagina mientras
 * el lote siga dentro del rango (release.date >= cutoff) y se filtra cada
 * proceso por su fecha real (tender.datePublished). Deduplica por ocid.
 */
export async function fetchRecent({ cutoff, maxPaginas = 300, onProgress = () => {} }) {
  const byOcid = new Map();
  let capReached = true;
  for (let page = 1; page <= maxPaginas; page++) {
    let rels;
    try {
      rels = await fetchPage(page);
    } catch (err) {
      // Fallo transitorio: reintenta una vez, luego corta con lo acumulado.
      try {
        rels = await fetchPage(page);
      } catch {
        console.warn(`⚠ Página ${page} falló dos veces (${err.message}); se continúa con lo descargado.`);
        capReached = false;
        break;
      }
    }
    if (rels.length === 0) { capReached = false; break; }

    let batchInRange = false;
    for (const rel of rels) {
      const batchDate = rel.date ? new Date(rel.date) : null;
      if (batchDate && batchDate >= cutoff) batchInRange = true;
      const n = normalize(rel);
      const d = n.fecha ? new Date(n.fecha) : batchDate;
      if (d && d >= cutoff && !byOcid.has(n.ocid)) byOcid.set(n.ocid, n);
    }
    onProgress(page, byOcid.size);
    if (!batchInRange) { capReached = false; break; }
  }
  return { procesos: [...byOcid.values()], capAlcanzado: capReached };
}
