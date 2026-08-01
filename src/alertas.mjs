// ──────────────────────────────────────────────────────────────────────────────
// Runner de alertas — `npm run alertas`
// Para cada alerta guardada (alertas.json, creadas desde el buscador web):
//   1. carga los procesos del mes en curso (bulk mensual),
//   2. aplica los filtros de la alerta SOLO sobre lo publicado después de su
//      último corte (ultimaFecha),
//   3. si hay novedades, envía el correo y avanza el corte.
// Programa este comando (Task Scheduler / cron) 1-2 veces al día.
// ──────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRecentMonths } from './bulk.mjs';
import { aplicarFiltros } from './search.mjs';
import { renderEmail } from './emailHtml.mjs';
import { enviar } from './send.mjs';
import { cargarAlertas, guardarAlertas, cargarSeguimientos, guardarSeguimientos } from './alertasStore.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));

const alertas = cargarAlertas();
const seguimientos = cargarSeguimientos();
if (alertas.length === 0 && seguimientos.length === 0) {
  console.log('No hay alertas ni seguimientos guardados (créalos desde el buscador: npm run web).');
  process.exit(0);
}

console.log(`🔔 ${alertas.length} alerta(s) + ${seguimientos.length} seguimiento(s) — cargando procesos del mes…`);
// 2 meses por si una alerta quedó sin correr varias semanas cruzando de mes.
const procesos = await loadRecentMonths(2, { onProgress: (m) => console.log('   ' + m) });

let enviadas = 0;
for (const alerta of alertas) {
  const destinatarios = alerta.emails ?? [alerta.email]; // compat con alertas viejas
  const corte = new Date(alerta.ultimaFecha ?? alerta.creadaEl);
  const candidatos = procesos.filter((p) => p.fecha && new Date(p.fecha) > corte);
  const nuevos = aplicarFiltros(candidatos, alerta.filtros ?? {}, config);

  if (nuevos.length === 0) {
    console.log(`   · "${alerta.nombre}" <${destinatarios.join(', ')}>: sin novedades desde ${corte.toISOString().slice(0, 16)}`);
    continue;
  }

  console.log(`   · "${alerta.nombre}" <${destinatarios.join(', ')}>: ${nuevos.length} proceso(s) nuevo(s)`);
  // Tope por correo: una alerta sin filtros matchea TODO lo nuevo del día
  // (cientos de procesos) y generaría un email de varios MB que Gmail recorta.
  const MAX_POR_CORREO = 50;
  const html = renderEmail({
    procesos: nuevos.slice(0, MAX_POR_CORREO),
    desde: corte.toISOString(),
    hasta: new Date().toISOString(),
    totalEscaneados: candidatos.length,
  });
  if (nuevos.length > MAX_POR_CORREO) {
    console.warn(`     ⚠ ${nuevos.length} coincidencias — el correo lleva las ${MAX_POR_CORREO} primeras. Afina los filtros de esta alerta.`);
  }
  const ok = await enviar({
    html,
    asunto: `🔔 SEACE · ${alerta.nombre} · ${nuevos.length} nueva${nuevos.length === 1 ? '' : 's'} convocatoria${nuevos.length === 1 ? '' : 's'}`,
    destinatarios,
  });

  if (ok) {
    // Avanza el corte a la publicación más reciente enviada (no a "ahora": si el
    // bulk se regenera con horas de retraso, no queremos saltarnos ese hueco).
    const maxFecha = nuevos.reduce((mx, p) => (p.fecha > mx ? p.fecha : mx), alerta.ultimaFecha ?? '');
    alerta.ultimaFecha = maxFecha;
    enviadas++;
  }
}

guardarAlertas(alertas);

// ── Seguimientos por proceso: detectar cambios de estado/adjudicación/cierre ──
const porOcid = new Map(procesos.map((p) => [p.ocid, p]));
for (const seg of seguimientos) {
  const p = porOcid.get(seg.ocid);
  if (!p) continue; // el proceso ya no está en los últimos 2 meses — sin datos nuevos

  const cambios = [];
  const antes = seg.snapshot ?? {};
  const nuevosEstados = (p.estados ?? []).filter((e) => !(antes.estados ?? []).includes(e));
  if (nuevosEstados.length) cambios.push(`Nuevo estado: ${nuevosEstados.join(', ')}`);
  const nuevosProv = (p.proveedores ?? []).filter((x) => !(antes.proveedores ?? []).includes(x));
  if (nuevosProv.length) cambios.push(`Adjudicado a: ${nuevosProv.join('; ')}`);
  if ((p.cierreOfertas ?? null) !== (antes.cierreOfertas ?? null)) {
    cambios.push(`Cierre de ofertas: ${antes.cierreOfertas?.slice(0, 10) ?? 'sin fecha'} → ${p.cierreOfertas?.slice(0, 10) ?? 'sin fecha'}`);
  }
  if (cambios.length === 0) {
    console.log(`   · 🔎 "${(seg.titulo || seg.ocid).slice(0, 50)}": sin cambios`);
    continue;
  }

  console.log(`   · 🔎 "${(seg.titulo || seg.ocid).slice(0, 50)}": ${cambios.join(' | ')}`);
  const html = renderEmail({
    procesos: [p],
    desde: seg.creadaEl,
    hasta: new Date().toISOString(),
    totalEscaneados: 1,
    titulo: '🔎 Cambio en un proceso que sigues',
    intro: cambios.join(' · '),
  });
  const ok = await enviar({
    html,
    asunto: `🔎 SEACE · ${cambios[0]} · ${(seg.titulo || seg.entidad || seg.ocid).slice(0, 60)}`,
    destinatarios: seg.emails,
  });
  if (ok) {
    seg.snapshot = { estados: p.estados ?? [], proveedores: p.proveedores ?? [], cierreOfertas: p.cierreOfertas ?? null };
    enviadas++;
  }
}
guardarSeguimientos(seguimientos);

console.log(`✔ Listo: ${enviadas} correo(s) enviado(s).`);
