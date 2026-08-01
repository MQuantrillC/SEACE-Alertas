// ──────────────────────────────────────────────────────────────────────────────
// Filtro compartido del buscador y de las alertas por correo.
// `filtros` es un objeto plano (viene de la query del server o de alertas.json):
//   q, categoria, metodo, entidad, soloTI, conAdjudicacion,
//   desde / hasta (ISO yyyy-mm-dd, sobre fecha de publicación),
//   montoRangos: ['s0','s1',...]  · departamentos: [...] · estados: [...]
// ──────────────────────────────────────────────────────────────────────────────

import { filtrarRelevantes, fold, toMatcher } from './digest.mjs';

// Bandas de monto en soles. s0 = el SEACE no publicó el monto referencial.
export const MONTO_RANGOS = {
  s0: { label: 'Sin monto publicado', test: (m) => !m || m <= 0 },
  s1: { label: 'Hasta S/ 100 mil', test: (m) => m > 0 && m < 100_000 },
  s2: { label: 'S/ 100 mil – 500 mil', test: (m) => m >= 100_000 && m < 500_000 },
  s3: { label: 'S/ 500 mil – 1 M', test: (m) => m >= 500_000 && m < 1_000_000 },
  s4: { label: 'S/ 1 M – 5 M', test: (m) => m >= 1_000_000 && m < 5_000_000 },
  s5: { label: 'Más de S/ 5 M', test: (m) => m >= 5_000_000 },
};

export function aplicarFiltros(procesos, filtros, config) {
  const q = (filtros.q ?? '').trim();
  const categoria = filtros.categoria ?? '';
  const metodo = fold(filtros.metodo ?? '');
  const entidad = fold(filtros.entidad ?? '');
  const soloTI = !!filtros.soloTI;
  const conAdjudicacion = !!filtros.conAdjudicacion;
  const desde = filtros.desde ? new Date(filtros.desde + 'T00:00:00') : null;
  const hasta = filtros.hasta ? new Date(filtros.hasta + 'T23:59:59') : null;
  const rangos = (filtros.montoRangos ?? []).filter((r) => MONTO_RANGOS[r]);
  const departamentos = new Set((filtros.departamentos ?? []).map(fold));
  const estados = new Set((filtros.estados ?? []).map((e) => String(e).toUpperCase()));

  let base = procesos;
  if (soloTI) base = filtrarRelevantes(base, config); // añade score + keywords

  const matcher = q ? toMatcher(q) : null;
  const out = [];
  for (const p of base) {
    if (categoria && p.categoria !== categoria) continue;
    if (metodo && !fold(p.metodo).includes(metodo)) continue;
    if (entidad && !fold(p.entidad).includes(entidad)) continue;
    if (conAdjudicacion && p.proveedores.length === 0) continue;
    if (departamentos.size > 0 && !departamentos.has(fold(p.departamento ?? ''))) continue;
    if (estados.size > 0 && !(p.estados ?? []).some((e) => estados.has(e))) continue;
    if (rangos.length > 0 && !rangos.some((r) => MONTO_RANGOS[r].test(p.monto))) continue;
    if (desde || hasta) {
      const f = p.fecha ? new Date(p.fecha) : null;
      if (!f) continue;
      if (desde && f < desde) continue;
      if (hasta && f > hasta) continue;
    }
    if (matcher) {
      const hay = fold([p.descripcion, p.nomenclatura, p.entidad, ...p.items, ...p.proveedores].join(' \n '));
      if (!matcher.test(hay)) continue;
    }
    out.push(p);
  }

  // Solo-TI ordena por afinidad; el resto por fecha de publicación descendente.
  out.sort(soloTI
    ? (a, b) => (b.score ?? 0) - (a.score ?? 0) || new Date(b.fecha ?? 0) - new Date(a.fecha ?? 0)
    : (a, b) => new Date(b.fecha ?? 0) - new Date(a.fecha ?? 0));
  return out;
}

/** Cuántos meses de archivos mensuales hay que cargar para cubrir `desde`. */
export function mesesParaCubrir(desdeISO) {
  if (!desdeISO) return 1;
  const desde = new Date(desdeISO + 'T00:00:00');
  const now = new Date();
  const n = (now.getFullYear() - desde.getFullYear()) * 12 + (now.getMonth() - desde.getMonth()) + 1;
  return Math.min(12, Math.max(1, n));
}
