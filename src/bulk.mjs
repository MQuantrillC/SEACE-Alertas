// ──────────────────────────────────────────────────────────────────────────────
// Descarga y cachea los ARCHIVOS MENSUALES del OECE — la vía rápida de búsqueda.
// Cada mes es un zip de ~1 MB con TODOS los procesos del mes (compiledRelease,
// que además incluye adjudicaciones/proveedores cuando el proceso avanzó).
//   https://contratacionesabiertas.oece.gob.pe/api/v1/file/seace_v3/json/YYYY/MM/
// Cache en out/cache/: el mes en curso se refresca cada 6 h (el OECE lo
// regenera a diario); los meses pasados son inmutables y se guardan para siempre.
// ──────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { normalize } from './seace.mjs';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'cache');
const CURRENT_MONTH_TTL_MS = 6 * 60 * 60 * 1000;

const monthUrl = (y, m) =>
  `https://contratacionesabiertas.oece.gob.pe/api/v1/file/seace_v3/json/${y}/${String(m).padStart(2, '0')}/`;

/** Descarga y descomprime el JSON de un mes → ruta local, o null si no existe (404). */
async function ensureMonthFile(y, m) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${y}-${String(m).padStart(2, '0')}.json`);

  const now = new Date();
  const isCurrentMonth = y === now.getFullYear() && m === now.getMonth() + 1;
  if (existsSync(file)) {
    const fresh = !isCurrentMonth || Date.now() - statSync(file).mtimeMs < CURRENT_MONTH_TTL_MS;
    if (fresh) return file;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(monthUrl(y, m), { signal: ctrl.signal });
    if (res.status === 404) return existsSync(file) ? file : null; // mes aún no publicado
    if (!res.ok) throw new Error(`HTTP ${res.status} bajando ${y}-${m}`);
    const zipBuf = Buffer.from(await res.arrayBuffer());
    const zip = new AdmZip(zipBuf);
    const entry = zip.getEntries().find((e) => e.entryName.endsWith('.json'));
    if (!entry) throw new Error(`zip de ${y}-${m} sin .json dentro`);
    writeFileSync(file, entry.getData());
    return file;
  } catch (err) {
    // Red caída pero hay copia vieja → úsala antes que fallar.
    if (existsSync(file)) {
      console.warn(`⚠ No se pudo refrescar ${y}-${m} (${err.message}); usando copia en cache.`);
      return file;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Carga los últimos `nMeses` meses (incluido el actual) como procesos
 * normalizados, deduplicados por ocid (el más reciente gana). Los meses que el
 * OECE aún no publica se omiten en silencio.
 */
export async function loadRecentMonths(nMeses = 1, { onProgress = () => {} } = {}) {
  const now = new Date();
  const months = [];
  for (let i = 0; i < nMeses; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push([d.getFullYear(), d.getMonth() + 1]);
  }

  const byOcid = new Map();
  for (const [y, m] of months) {
    onProgress(`descargando/cargando ${y}-${String(m).padStart(2, '0')}…`);
    let file;
    try {
      file = await ensureMonthFile(y, m);
    } catch (err) {
      console.warn(`⚠ Mes ${y}-${m} falló: ${err.message}`);
      continue;
    }
    if (!file) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    for (const rec of pkg.records ?? []) {
      const rel = rec.compiledRelease ?? rec;
      if (!rel?.tender) continue;
      const n = normalize(rel);
      if (!byOcid.has(n.ocid)) byOcid.set(n.ocid, n); // meses recorridos de nuevo→viejo
    }
  }
  return [...byOcid.values()];
}
