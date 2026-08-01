// Comprueba que cada sigla de siglas.json resuelve a una entidad real.
// Las siglas están escritas a mano: sin esta comprobación, una mal escrita
// simplemente devuelve 0 resultados y nadie se entera.
//   node src/verificar-siglas.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirDatos } from './db.mjs';
import { buscarEntidades } from './buscar.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const siglas = JSON.parse(readFileSync(join(ROOT, 'siglas.json'), 'utf8'));
const db = abrirDatos({ soloLectura: true });

const malas = [], ambiguas = [], buenas = [];
for (const [sigla, nombre] of Object.entries(siglas)) {
  if (sigla.startsWith('_')) continue;
  const r = buscarEntidades(db, sigla, { limite: 5, siglas });
  if (r.length === 0) malas.push([sigla, nombre]);
  else if (r.length > 3) ambiguas.push([sigla, nombre, r.length, r[0].nombre]);
  else buenas.push([sigla, r[0].nombre, r[0].procesos]);
}

console.log(`\n✔ ${buenas.length} siglas resuelven a una entidad concreta`);
for (const [s, n, p] of buenas.slice(0, 8)) console.log(`   ${s.padEnd(14)} → ${n.slice(0, 58)} (${p})`);
if (buenas.length > 8) console.log(`   … y ${buenas.length - 8} más`);

if (ambiguas.length) {
  console.log(`\n~ ${ambiguas.length} siglas devuelven muchas entidades (normal si la entidad tiene unidades ejecutoras):`);
  for (const [s, , n, primera] of ambiguas) console.log(`   ${s.padEnd(14)} → ${n}+ coincidencias · 1ª: ${primera.slice(0, 50)}`);
}

if (malas.length) {
  console.log(`\n✘ ${malas.length} siglas NO encuentran ninguna entidad — corregir el fragmento en siglas.json:`);
  for (const [s, n] of malas) console.log(`   ${s.padEnd(14)} → "${n}"`);
}

db.close();
process.exit(malas.length === 0 ? 0 : 1);
