// ──────────────────────────────────────────────────────────────────────────────
// Evaluar una alerta y enviarla. Lo comparten el runner programado y el botón
// "Probar ahora" del navegador, para que la prueba muestre EXACTAMENTE lo que
// llegaría de verdad.
// ──────────────────────────────────────────────────────────────────────────────

import { buscar } from './buscar.mjs';
import { enviar } from './send.mjs';
import { correoAlerta } from './correosAlerta.mjs';
import { destinatarios } from './auth.mjs';
import { describirFrecuencia, firmaBaja, registrarEnvio, reprogramar, corteADiaLima } from './alertasModelo.mjs';
import { baseUrl } from './auth.mjs';

// Una alerta sin filtros casa con todo lo publicado en el día: cientos de
// procesos y un correo de varios MB que Gmail recorta por su cuenta.
export const MAX_POR_CORREO = 40;

const enlaceBusqueda = (filtros) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filtros ?? {})) {
    if (Array.isArray(v) ? v.length : v) p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return `${baseUrl()}/?${p}`;
};

/**
 * Qué habría que enviar de una alerta, sin enviar nada.
 * Solo procesos publicados DESPUÉS del corte (`ultima_fecha`).
 */
export function evaluar(datos, alerta, { limite = MAX_POR_CORREO } = {}) {
  const corte = corteADiaLima(alerta.ultima_fecha ?? alerta.creado);
  const filtros = { ...(alerta.filtros ?? {}) };
  // El periodo lo pone el corte, no los filtros guardados.
  filtros.desde = corte;
  filtros.hasta = null;
  const r = buscar(datos, filtros, { limite, pagina: 1, orden: 'reciente' });
  return { total: r.total, procesos: r.resultados, corte };
}

/**
 * Envía una alerta. Devuelve { enviado, total, destinatarios }.
 *
 * `soloA` fuerza un único destinatario — lo usa "Probar ahora" para que la prueba
 * no le llegue al resto de suscriptores.
 */
export async function enviarAlerta(datos, cuentas, alerta, { esPrueba = false, soloA = null } = {}) {
  const gente = soloA ? [soloA] : destinatarios(cuentas, alerta.id);
  if (gente.length === 0) {
    return { enviado: false, total: 0, destinatarios: [], motivo: 'Nadie ha aceptado esta alerta todavía.' };
  }

  const { total, procesos, corte } = evaluar(datos, alerta);
  if (total === 0 && !alerta.enviar_vacios && !esPrueba) {
    return { enviado: false, total: 0, destinatarios: [], motivo: 'Sin novedades.' };
  }

  const cadencia = describirFrecuencia(alerta.frecuencia);
  let enviados = 0;
  let fallo = null;

  // Un correo por persona: el enlace de baja es distinto para cada una.
  for (const p of gente) {
    const html = correoAlerta({
      procesos, nombreAlerta: alerta.nombre, cadencia, totalReal: total, esPrueba,
      enlaceBusqueda: enlaceBusqueda(alerta.filtros),
      enlaceBaja: `${baseUrl()}/baja?a=${alerta.id}&u=${p.id}&f=${firmaBaja(cuentas, alerta.id, p.id)}`,
    });
    const asunto = esPrueba
      ? `🧪 Prueba · ${alerta.nombre}`
      : `🔔 ${alerta.nombre} · ${total} convocatoria${total === 1 ? '' : 's'} nueva${total === 1 ? '' : 's'}`;
    try {
      if (await enviar({ html, asunto, destinatarios: [p.email] })) enviados++;
    } catch (err) {
      fallo = err.message;
      console.error(`   ⚠ fallo enviando a ${p.email}: ${err.message}`);
    }
  }

  if (!esPrueba) {
    // El corte avanza a la publicación más reciente ENVIADA, no a "ahora": si el
    // OECE regenera el archivo con horas de retraso, saltar a ahora se comería
    // los procesos de ese hueco y nadie se enteraría.
    const maxFecha = procesos.reduce((mx, p) => (p.fecha_dia > mx ? p.fecha_dia : mx), '');
    registrarEnvio(cuentas, {
      alertaId: alerta.id, nProcesos: total, destinatarios: gente.map((g) => g.email),
      desde: corte, hasta: maxFecha || corte, error: fallo,
    });
    reprogramar(cuentas, alerta, {
      ultimaFecha: enviados > 0 && maxFecha ? maxFecha : null,
      hubEnvio: enviados > 0,
    });
  }

  return { enviado: enviados > 0, enviados, total, destinatarios: gente.map((g) => g.email), motivo: fallo };
}
