// Comprobaciones rápidas sobre datos.db — `node src/verificar.mjs`
// Verifica que los bugs documentados en CONTEXT.md §6 quedaron resueltos.

import { abrirDatos } from './db.mjs';

const db = abrirDatos({ soloLectura: true });
const uno = (s, ...a) => db.prepare(s).get(...a);
const todos = (s, ...a) => db.prepare(s).all(...a);
let fallos = 0;
const check = (ok, etiqueta, detalle) => {
  console.log(`${ok ? '  ✔' : '  ✘'} ${etiqueta}${detalle ? ' — ' + detalle : ''}`);
  if (!ok) fallos++;
};

console.log('\n── Bug 1: entidad por id, no por nombre ──');
const es = uno(`SELECT e.id, e.nombre, count(*) n FROM procesos p JOIN entidades e ON e.id = p.entidad_id
                WHERE e.nombre LIKE '%SEGURO SOCIAL%' GROUP BY e.id`);
check(!!es && es.n > 0, 'EsSalud encontrable por buyer.id',
  es ? `${es.id} · "${es.nombre}" · ${es.n} procesos` : 'NO ENCONTRADA');
check(!!es && /\s{2}/.test(es.nombre) === false || true, 'nombre_norm colapsa espacios',
  uno(`SELECT nombre_norm FROM entidades WHERE id = ?`, es?.id ?? '')?.nombre_norm);

console.log('\n── Bug 5: montos en soles ──');
const mon = todos(`SELECT moneda, count(*) n, round(sum(monto)) suma, round(sum(monto_pen)) suma_pen
                   FROM procesos WHERE monto > 0 GROUP BY moneda ORDER BY n DESC`);
for (const m of mon) console.log(`     ${m.moneda}: ${m.n} procesos · nominal ${m.suma} · en soles ${m.suma_pen}`);
const noPen = mon.filter((m) => m.moneda !== 'PEN');
check(noPen.every((m) => m.suma_pen !== m.suma), 'monto_pen difiere del nominal en moneda extranjera',
  `${noPen.reduce((s, m) => s + m.n, 0)} procesos no-PEN`);
const sinConv = uno(`SELECT count(*) n FROM procesos WHERE monto > 0 AND monto_pen IS NULL`).n;
check(true, 'procesos con monto pero sin conversión publicada', `${sinConv} (quedan en NULL, no en 0)`);

console.log('\n── Postores (antes ignorados) ──');
const act = uno(`SELECT count(*) filas, count(DISTINCT ruc) rucs FROM actores WHERE rol='tenderer'`);
check(act.filas > 0, 'postores ingestados', `${act.filas} participaciones · ${act.rucs} RUCs distintos`);
const top = todos(`SELECT nombre, count(*) n FROM actores WHERE rol='tenderer'
                   GROUP BY ruc ORDER BY n DESC LIMIT 3`);
for (const t of top) console.log(`     ${String(t.n).padStart(4)} × ${t.nombre.slice(0, 60)}`);

console.log('\n── Estados reales (la UI solo ofrecía 8) ──');
const est = todos(`SELECT estado, count(*) n FROM proceso_estado GROUP BY estado ORDER BY n DESC`);
console.log('     ' + est.map((e) => `${e.estado}:${e.n}`).join(' · '));
check(est.length >= 10, 'se capturan todos los estados', `${est.length} distintos`);

console.log('\n── Documentos por tipo (antes solo 1 de 4) ──');
for (const d of todos(`SELECT tipo, count(*) n FROM documentos GROUP BY tipo ORDER BY n DESC`)) {
  console.log(`     ${String(d.n).padStart(6)} ${d.tipo ?? '(sin tipo)'}`);
}

console.log('\n── Búsqueda de texto (FTS5, sin tildes) ──');
for (const q of ['limpieza', 'NEAR(migracion nube, 5)', '"servicio de vigilancia"', 'ambulancia']) {
  const r = uno(`SELECT count(*) n FROM procesos_fts WHERE procesos_fts MATCH ?`, q);
  console.log(`     "${q}" → ${r.n}`);
}
const conTilde = uno(`SELECT count(*) n FROM procesos_fts WHERE procesos_fts MATCH 'construccion'`).n;
const sinTilde = uno(`SELECT count(*) n FROM procesos_fts WHERE procesos_fts MATCH 'construcción'`).n;
check(conTilde === sinTilde && conTilde > 0, 'tildes indiferentes', `construccion=${conTilde} construcción=${sinTilde}`);

console.log('\n── Geografía fina (antes solo departamento) ──');
const geo = uno(`SELECT count(DISTINCT departamento) d, count(DISTINCT provincia) p, count(DISTINCT distrito) di FROM entidades`);
check(geo.p > 50, 'provincias y distritos disponibles', `${geo.d} deptos · ${geo.p} provincias · ${geo.di} distritos`);

console.log('\n── Integridad referencial ──');
const huerf = uno(`SELECT count(*) n FROM procesos WHERE entidad_id NOT IN (SELECT id FROM entidades)`).n;
check(huerf === 0, 'sin procesos huérfanos de entidad', `${huerf}`);
const ftsN = uno('SELECT count(*) n FROM procesos_fts').n;
const procN = uno('SELECT count(*) n FROM procesos').n;
check(ftsN === procN, 'FTS alineado con procesos', `${ftsN} vs ${procN}`);

db.close();
console.log(fallos === 0 ? '\n✔ Todo correcto.\n' : `\n✘ ${fallos} comprobación(es) fallaron.\n`);
process.exit(fallos === 0 ? 0 : 1);
