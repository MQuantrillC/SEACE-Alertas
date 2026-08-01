// Prueba de humo de la capa de búsqueda — node src/verificar-buscar.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirDatos } from './db.mjs';
import { buscar, buscarEntidades, buscarProveedores, facetas, proximosVencimientos, aFts, hoyLima } from './buscar.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const siglas = JSON.parse(readFileSync(join(ROOT, 'siglas.json'), 'utf8'));
const db = abrirDatos({ soloLectura: true });
const ms = (f) => { const t = process.hrtime.bigint(); const r = f(); return [r, Number(process.hrtime.bigint() - t) / 1e6]; };
const log = (etiqueta, n, t) => console.log(`   ${String(Math.round(t)).padStart(5)} ms  ${String(n).padStart(7)}  ${etiqueta}`);

console.log('\n── Traducción de texto a FTS5 ──');
for (const q of ['servicio de limpieza', '"obra de saneamiento"', 'nube AND OR NEAR', 'a"b -c*']) {
  console.log(`   ${JSON.stringify(q).padEnd(28)} → ${aFts(q)}`);
}

console.log('\n── Búsquedas (tiempo · resultados) ──');
const ess = buscarEntidades(db, 'essalud', { siglas })[0];
const casos = [
  ['todo (sin filtros)', {}],
  ['objeto: limpieza', { objeto: 'limpieza' }],
  ['objeto: frase exacta', { objeto: '"servicio de vigilancia"' }],
  ['entidad: EsSalud (por id)', { entidades: [ess.id] }],
  ['EsSalud + limpieza', { entidades: [ess.id], objeto: 'limpieza' }],
  ['proveedor por nombre', { proveedor: 'lumayje' }],
  ['estado APELADO', { estados: ['APELADO'] }],
  ['Lima + obras + >5M', { departamentos: ['LIMA'], categorias: ['works'], montos: ['s5'] }],
  ['con adjudicación 2026', { conAdjudicacion: true, desde: '2026-01-01' }],
  ['un solo postor', { soloUnPostor: true }],
];
for (const [etiqueta, f] of casos) {
  const [r, t] = ms(() => buscar(db, f, { limite: 20 }));
  log(etiqueta, r.total, t);
}

console.log('\n── Paginación ──');
const [p1] = ms(() => buscar(db, { objeto: 'limpieza' }, { limite: 20, pagina: 1 }));
const [p9] = ms(() => buscar(db, { objeto: 'limpieza' }, { limite: 20, pagina: 9 }));
console.log(`   total ${p1.total} · ${p1.paginas} páginas · pág.1 ≠ pág.9: ${p1.resultados[0].ocid !== p9.resultados[0]?.ocid}`);

console.log('\n── Orden ──');
for (const orden of ['reciente', 'monto', 'cierre']) {
  const [r] = ms(() => buscar(db, { objeto: 'limpieza' }, { limite: 3, orden }));
  console.log(`   ${orden.padEnd(9)} → ${r.resultados.map((x) => orden === 'monto' ? Math.round(x.monto_pen ?? 0) : orden === 'cierre' ? (x.cierre_ofertas ?? '—').slice(0, 10) : x.fecha_dia).join(' · ')}`);
}

console.log('\n── Autocompletados ──');
for (const q of ['essalud', 'municipalidad de mira', 'trujillo']) {
  const [r, t] = ms(() => buscarEntidades(db, q, { siglas }));
  console.log(`   ${String(Math.round(t)).padStart(4)} ms  "${q}" → ${r.slice(0, 2).map((e) => `${e.nombre.slice(0, 42)} (${e.procesos})`).join(' | ')}`);
}
for (const q of ['lumayje', '20504', 'consorcio vial']) {
  const [r, t] = ms(() => buscarProveedores(db, q));
  console.log(`   ${String(Math.round(t)).padStart(4)} ms  "${q}" → ${r.slice(0, 2).map((p) => `${p.nombre.slice(0, 34)} RUC ${p.ruc} (${p.procesos}p/${p.ganados}g)`).join(' | ')}`);
}

console.log('\n── Un proceso completo (hidratado) ──');
const uno = buscar(db, { conAdjudicacion: true, objeto: 'obra' }, { limite: 1 }).resultados[0];
if (uno) {
  console.log(`   ${uno.entidad} · ${uno.departamento}`);
  console.log(`   ${(uno.descripcion || uno.nomenclatura).slice(0, 88)}`);
  console.log(`   estados=${uno.estados.join(',')} · postores=${uno.postores.length} · adjudicaciones=${uno.adjudicaciones.length} · docs=${uno.documentos.length}`);
  console.log(`   tipos de documento: ${[...new Set(uno.documentos.map((d) => d.tipo))].join(', ')}`);
  console.log(`   etapas: ${uno.etapas.map((e) => e.etapa).join(' | ') || '—'}`);
}

console.log('\n── Facetas y próximos vencimientos ──');
const [fa, tf] = ms(() => facetas(db));
console.log(`   ${Math.round(tf)} ms · ${fa.metodos.length} métodos · ${fa.estados.length} estados · ${fa.departamentos.length} deptos · rango ${fa.rango.desde} → ${fa.rango.hasta}`);
const [cier, tc] = ms(() => proximosVencimientos(db, {}, { dias: 30 }));
console.log(`   hoy en Lima = ${hoyLima()} · vencen en 30 días: ${cier.length} (${Math.round(tc)} ms)`);
for (const c of cier.slice(0, 4)) console.log(`     ${c.vence.slice(0, 10)} · ${c.entidad.slice(0, 40)} · ${(c.descripcion || '').slice(0, 40)}`);

db.close();
console.log('');
