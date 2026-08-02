// ──────────────────────────────────────────────────────────────────────────────
// Runner de alertas — `npm run alertas`
//
// Prográmalo CADA HORA y olvídate: el runner decide qué toca. Solo procesa las
// alertas cuyo `proximo_envio` ya venció, y al terminar cada una la reprograma
// según su propia cadencia. Añadir cadencias nuevas no vuelve a tocar el
// Programador de tareas.
//
//   npm run alertas              procesa lo que toque
//   npm run alertas -- --seco    dice qué haría, sin enviar nada
//   npm run alertas -- --todas   fuerza todas, aunque no toque (para probar)
//
// Sustituye a src/alertas.mjs, que leía alertas.json y filtraba en memoria.
// ──────────────────────────────────────────────────────────────────────────────

import { existsSync } from 'node:fs';
import { abrirDatos, DATOS_DB } from './db.mjs';
import { abrirCuentas, limpiar } from './cuentas.mjs';
import { alertasPendientes, alertasActivas, describirFrecuencia, reprogramar } from './alertasModelo.mjs';
import { evaluar, enviarAlerta } from './enviarAlerta.mjs';
import { destinatarios } from './auth.mjs';

const args = process.argv.slice(2);
const SECO = args.includes('--seco');
const TODAS = args.includes('--todas');

if (!existsSync(DATOS_DB)) {
  console.error('\n✘ No existe datos/datos.db. Ejecuta primero: npm run ingesta\n');
  process.exit(1);
}

const datos = abrirDatos({ soloLectura: true });
const cuentas = abrirCuentas();

const lista = TODAS ? alertasActivas(cuentas) : alertasPendientes(cuentas);

const total = cuentas.prepare('SELECT count(*) AS n FROM alertas').get().n;
console.log(`\n🔔 Runner de alertas${SECO ? ' (simulación)' : ''}`);
console.log(`   ${total} alerta(s) en total · ${lista.length} por procesar ahora\n`);

if (lista.length === 0) {
  const proxima = cuentas.prepare(
    'SELECT proximo_envio FROM alertas WHERE pausada = 0 AND proximo_envio IS NOT NULL ORDER BY proximo_envio LIMIT 1'
  ).get();
  if (proxima) {
    const enLima = new Date(Date.parse(proxima.proximo_envio) - 5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`   Nada que enviar. La próxima toca el ${enLima} (hora de Lima).\n`);
  } else {
    console.log('   No hay alertas activas. Créalas desde el buscador: npm run web\n');
  }
} else {
  let enviadas = 0, sinNovedad = 0;
  for (const a of lista) {
    const gente = destinatarios(cuentas, a.id);
    const etiqueta = `"${a.nombre}" [${describirFrecuencia(a.frecuencia)}]`;

    if (gente.length === 0) {
      console.log(`   · ${etiqueta}: nadie ha aceptado la invitación todavía — no se envía.`);
      if (!SECO) reprogramar(cuentas, a);
      continue;
    }

    if (SECO) {
      const { total: n, corte } = evaluar(datos, a);
      console.log(`   · ${etiqueta} → ${n} proceso(s) desde ${corte} · a ${gente.map((g) => g.email).join(', ')}`);
      continue;
    }

    const r = await enviarAlerta(datos, cuentas, a);
    if (r.enviado) {
      enviadas++;
      console.log(`   ✉ ${etiqueta}: ${r.total} proceso(s) → ${r.destinatarios.join(', ')}`);
    } else {
      sinNovedad++;
      console.log(`   · ${etiqueta}: ${r.motivo ?? 'sin envío'}`);
    }
  }
  if (!SECO) console.log(`\n✔ ${enviadas} correo(s) enviado(s) · ${sinNovedad} sin novedades`);
}

if (!SECO) {
  const p = limpiar(cuentas);
  if (p.tokens || p.sesiones) console.log(`   (purgados ${p.tokens} token(s) y ${p.sesiones} sesión(es) caducadas)`);
}

datos.close();
cuentas.close();
console.log('');
