// ──────────────────────────────────────────────────────────────────────────────
// Filtro y scoring: decide qué convocatorias son relevantes para Xertica.
// Comparación sin tildes ni mayúsculas sobre descripción + ítems + nomenclatura.
// Dos niveles de keywords (alta/media) para ordenar el digest por relevancia.
//
// Cada entrada de config puede ser:
//   · texto plano  → búsqueda por subcadena ("nube" matchea "MIGRACIÓN A LA NUBE")
//   · "/regex/"    → expresión regular, ej: "/migraci.n (a la |de datos a )?nube/"
// Ambas corren sobre el texto YA plegado (minúsculas y sin tildes) — escribe los
// patrones sin tildes: "migraci.n" o "migracion", no "migración".
// ──────────────────────────────────────────────────────────────────────────────

export const fold = (s) =>
  (s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

/** "texto" → matcher por subcadena · "/patrón/flags" → matcher regex. */
export function toMatcher(entry) {
  const asRegex = /^\/(.+)\/([a-z]*)$/.exec(String(entry).trim());
  if (asRegex) {
    try {
      const re = new RegExp(asRegex[1], asRegex[2].includes('i') ? asRegex[2] : asRegex[2] + 'i');
      return { label: entry, test: (hay) => re.test(hay) };
    } catch (err) {
      console.warn(`⚠ Regex inválida en config.json, se ignora: ${entry} (${err.message})`);
      return { label: entry, test: () => false };
    }
  }
  const needle = fold(entry);
  return { label: entry, test: (hay) => hay.includes(needle) };
}

/** Devuelve los procesos relevantes, con score y keywords que dispararon. */
export function filtrarRelevantes(procesos, config) {
  const alta = (config.palabrasAlta ?? []).map(toMatcher);
  const media = (config.palabrasMedia ?? []).map(toMatcher);
  const excluir = (config.palabrasExcluir ?? []).map(toMatcher);

  const relevantes = [];
  for (const p of procesos) {
    const hay = fold([p.descripcion, p.nomenclatura, ...p.items].join(' \n '));

    const matchAlta = alta.filter((m) => m.test(hay));
    const matchMedia = media.filter((m) => m.test(hay));
    if (matchAlta.length === 0 && matchMedia.length === 0) continue;

    // Exclusión solo si NO hay señal fuerte: "cámaras de video" descarta el
    // proceso salvo que también hable de nube/datacenter/etc.
    if (matchAlta.length === 0 && excluir.some((m) => m.test(hay))) continue;

    const score = matchAlta.length * 10 + matchMedia.length;
    relevantes.push({ ...p, score, keywords: [...matchAlta, ...matchMedia].map((m) => m.label) });
  }

  relevantes.sort((a, b) => b.score - a.score || new Date(b.fecha ?? 0) - new Date(a.fecha ?? 0));
  return relevantes;
}
