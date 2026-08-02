// ──────────────────────────────────────────────────────────────────────────────
// Alertas: cadencia, programación y evaluación.
//
// Idea central: **el planificador del sistema es tonto y la app es lista.**
// El Programador de tareas (o Cloud Scheduler) invoca el runner CADA HORA, sin
// saber nada. El runner mira qué alertas tienen `proximo_envio` vencido y solo
// procesa esas. Añadir una cadencia nueva no vuelve a tocar el planificador.
// ──────────────────────────────────────────────────────────────────────────────

import { randomBytes, createHmac } from 'node:crypto';
import { ahora } from './cuentas.mjs';

// Perú no aplica horario de verano: siempre UTC-5. Por eso se puede trabajar con
// un desfase fijo en vez de arrastrar una librería de zonas horarias.
export const LIMA_OFFSET_MS = 5 * 3600_000;

// Ventana en la que se permite enviar. Nadie quiere un correo de licitaciones
// a las 3 de la mañana.
export const HORA_MIN = 7;
export const HORA_MAX = 20;

export const TIPOS = ['horaria', 'diaria', 'dosDiarias', 'semanal'];
export const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

/** Partes de la fecha en hora de Lima. */
function enLima(fecha) {
  const d = new Date(fecha.getTime() - LIMA_OFFSET_MS);
  return {
    anio: d.getUTCFullYear(), mes: d.getUTCMonth(), dia: d.getUTCDate(),
    hora: d.getUTCHours(), minuto: d.getUTCMinutes(),
    // 0 = lunes … 6 = domingo
    diaSemana: (d.getUTCDay() + 6) % 7,
  };
}

/** Construye un instante UTC a partir de una fecha/hora de Lima. */
function desdeLima({ anio, mes, dia, hora, minuto = 0 }) {
  return new Date(Date.UTC(anio, mes, dia, hora, minuto) + LIMA_OFFSET_MS);
}

/**
 * Fecha de hoy en Lima, 'YYYY-MM-DD'.
 *
 * El corte de una alerta se compara contra `procesos.fecha_dia`, que es un día en
 * hora de Lima. Guardar ahí un instante UTC hace que por la tarde el corte salte
 * al día siguiente y la alerta se salte en silencio todo lo publicado hoy.
 */
export const hoyLima = () => new Date(Date.now() - LIMA_OFFSET_MS).toISOString().slice(0, 10);

/** Normaliza un corte guardado (ISO completo o ya 'YYYY-MM-DD') a día de Lima. */
export function corteADiaLima(valor) {
  if (!valor) return hoyLima();
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor;
  return new Date(Date.parse(valor) - LIMA_OFFSET_MS).toISOString().slice(0, 10);
}

export function frecuenciaValida(f) {
  if (!f || !TIPOS.includes(f.tipo)) return 'Cadencia no reconocida.';
  const horas = f.horas ?? [];
  const bien = (h) => /^([01]\d|2[0-3]):[0-5]\d$/.test(h ?? '');
  if (f.tipo === 'diaria' || f.tipo === 'semanal') {
    if (horas.length !== 1 || !bien(horas[0])) return 'Indica una hora.';
  }
  if (f.tipo === 'dosDiarias') {
    if (horas.length !== 2 || !horas.every(bien)) return 'Indica dos horas.';
    if (horas[0] === horas[1]) return 'Las dos horas deben ser distintas.';
  }
  for (const h of horas) {
    const n = Number(h.slice(0, 2));
    if (n < HORA_MIN || n > HORA_MAX) return `Elige una hora entre las ${HORA_MIN}:00 y las ${HORA_MAX}:00.`;
  }
  if (f.tipo === 'semanal' && !(f.diaSemana >= 0 && f.diaSemana <= 6)) return 'Indica el día de la semana.';
  return null;
}

/**
 * Próximo envío, en ISO UTC, estrictamente posterior a `desde`.
 *
 * `horaria` no significa "cada hora del día": revisa cada hora dentro del
 * horario hábil y por la noche se acumula hasta las 07:00.
 */
export function calcularProximoEnvio(frecuencia, desde = new Date()) {
  const f = frecuencia;
  const l = enLima(desde);
  const hoy = { anio: l.anio, mes: l.mes, dia: l.dia };

  if (f.tipo === 'horaria') {
    const siguiente = desdeLima({ ...hoy, hora: l.hora + 1 });
    const sl = enLima(siguiente);
    if (sl.hora >= HORA_MIN && sl.hora <= HORA_MAX) return siguiente.toISOString();
    // Fuera del horario hábil: a las HORA_MIN del día DEL CANDIDATO, no del día
    // de partida. A las 23:15 la hora siguiente ya cae en la jornada siguiente, y
    // usar el día de hoy devolvía las 07:00 de esta mañana — una fecha pasada.
    const base = { anio: sl.anio, mes: sl.mes, dia: sl.dia };
    const alAmanecer = desdeLima({ ...base, hora: HORA_MIN });
    return (alAmanecer > siguiente ? alAmanecer : desdeLima({ ...base, dia: sl.dia + 1, hora: HORA_MIN })).toISOString();
  }

  const aMinutos = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
  const ahoraMin = l.hora * 60 + l.minuto;

  if (f.tipo === 'diaria' || f.tipo === 'dosDiarias') {
    const horas = [...(f.horas ?? [])].sort();
    for (const h of horas) {
      if (aMinutos(h) > ahoraMin) {
        return desdeLima({ ...hoy, hora: Number(h.slice(0, 2)), minuto: Number(h.slice(3, 5)) }).toISOString();
      }
    }
    // Ya pasaron todas las de hoy → la primera de mañana.
    const h = horas[0];
    return desdeLima({ ...hoy, dia: l.dia + 1, hora: Number(h.slice(0, 2)), minuto: Number(h.slice(3, 5)) }).toISOString();
  }

  // Semanal
  const h = f.horas[0];
  const [hh, mm] = [Number(h.slice(0, 2)), Number(h.slice(3, 5))];
  let delta = (f.diaSemana - l.diaSemana + 7) % 7;
  if (delta === 0 && aMinutos(h) <= ahoraMin) delta = 7;
  return desdeLima({ ...hoy, dia: l.dia + delta, hora: hh, minuto: mm }).toISOString();
}

/** Texto legible de la cadencia, para la interfaz y los correos. */
export function describirFrecuencia(f) {
  if (!f) return '—';
  switch (f.tipo) {
    case 'horaria': return `Apenas se publique (cada hora, ${HORA_MIN}–${HORA_MAX} h)`;
    case 'diaria': return `Cada día a las ${f.horas[0]}`;
    case 'dosDiarias': return `Dos veces al día (${[...f.horas].sort().join(' y ')})`;
    case 'semanal': return `Cada ${DIAS[f.diaSemana]} a las ${f.horas[0]}`;
    default: return '—';
  }
}

// ── Enlaces de baja ───────────────────────────────────────────────────────────
// Firmados con HMAC en vez de guardar un token por envío: no crecen tablas, no
// caducan (un enlace de baja que caduca es una trampa) y no se pueden falsificar.

function secreto(db) {
  db.exec('CREATE TABLE IF NOT EXISTS config (clave TEXT PRIMARY KEY, valor TEXT NOT NULL)');
  const fila = db.prepare("SELECT valor FROM config WHERE clave = 'secreto_baja'").get();
  if (fila) return fila.valor;
  const nuevo = randomBytes(32).toString('hex');
  db.prepare("INSERT INTO config (clave, valor) VALUES ('secreto_baja', ?)").run(nuevo);
  return nuevo;
}

export function firmaBaja(db, alertaId, usuarioId) {
  return createHmac('sha256', secreto(db)).update(`${alertaId}:${usuarioId}`).digest('base64url').slice(0, 32);
}

export function verificarBaja(db, alertaId, usuarioId, firma) {
  const esperada = firmaBaja(db, alertaId, usuarioId);
  return firma != null && firma.length === esperada.length && firma === esperada;
}

// ── Alertas ───────────────────────────────────────────────────────────────────

export function crearAlerta(db, { usuarioId, nombre, filtros, frecuencia, enviarVacios = false }) {
  const error = frecuenciaValida(frecuencia);
  if (error) return { ok: false, error };
  const n = String(nombre ?? '').trim().slice(0, 90) || 'Alerta SEACE';

  const bus = db.prepare('INSERT INTO busquedas (usuario_id, nombre, filtros, creado) VALUES (?,?,?,?)')
    .run(usuarioId, n, JSON.stringify(filtros ?? {}), ahora());
  const ale = db.prepare(`INSERT INTO alertas
      (busqueda_id, propietario_id, frecuencia, proximo_envio, ultima_fecha, enviar_vacios, creado)
      VALUES (?,?,?,?,?,?,?)`)
    // El corte se guarda como DÍA DE LIMA, no como instante UTC: se compara con
    // procesos.fecha_dia, que también lo es.
    .run(bus.lastInsertRowid, usuarioId, JSON.stringify(frecuencia),
      calcularProximoEnvio(frecuencia), hoyLima(), enviarVacios ? 1 : 0, ahora());

  // Quien crea la alerta queda suscrito y aceptado: no hace falta que se invite
  // a sí mismo por correo.
  db.prepare(`INSERT INTO alerta_suscriptor (alerta_id, usuario_id, estado, actualizado)
              VALUES (?,?, 'aceptada', ?)`).run(ale.lastInsertRowid, usuarioId, ahora());

  return { ok: true, alerta: leerAlerta(db, Number(ale.lastInsertRowid)) };
}

const SELECT_ALERTA = `
  SELECT a.*, b.nombre, b.filtros, u.email AS propietario_email
  FROM alertas a
  JOIN busquedas b ON b.id = a.busqueda_id
  JOIN usuarios u ON u.id = a.propietario_id`;

const hidratarAlerta = (r) => r && ({
  ...r,
  filtros: JSON.parse(r.filtros ?? '{}'),
  frecuencia: JSON.parse(r.frecuencia ?? '{}'),
  pausada: !!r.pausada,
  enviar_vacios: !!r.enviar_vacios,
});

export const leerAlerta = (db, id) => hidratarAlerta(db.prepare(`${SELECT_ALERTA} WHERE a.id = ?`).get(id));

/** Alertas visibles para un usuario: las suyas y aquellas a las que está suscrito. */
export function alertasDe(db, usuarioId) {
  return db.prepare(`${SELECT_ALERTA}
    WHERE a.propietario_id = ?
       OR a.id IN (SELECT alerta_id FROM alerta_suscriptor WHERE usuario_id = ? AND estado = 'aceptada')
    ORDER BY a.creado DESC`).all(usuarioId, usuarioId).map(hidratarAlerta);
}

/** Todas las alertas activas, sin mirar la programación (para --todas). */
export const alertasActivas = (db) =>
  db.prepare(`${SELECT_ALERTA} WHERE a.pausada = 0 ORDER BY a.creado`).all().map(hidratarAlerta);

/** Alertas que toca enviar ahora. */
export function alertasPendientes(db, cuando = ahora()) {
  return db.prepare(`${SELECT_ALERTA}
    WHERE a.pausada = 0 AND a.proximo_envio IS NOT NULL AND a.proximo_envio <= ?
    ORDER BY a.proximo_envio`).all(cuando).map(hidratarAlerta);
}

export function reprogramar(db, alerta, { ultimaFecha = null, hubEnvio = false } = {}) {
  db.prepare(`UPDATE alertas SET proximo_envio = ?, ultima_fecha = COALESCE(?, ultima_fecha),
              ultimo_envio = COALESCE(?, ultimo_envio) WHERE id = ?`)
    .run(calcularProximoEnvio(alerta.frecuencia), ultimaFecha, hubEnvio ? ahora() : null, alerta.id);
}

export function registrarEnvio(db, { alertaId, nProcesos, destinatarios, desde, hasta, error = null }) {
  db.prepare(`INSERT INTO envios (alerta_id, fecha, n_procesos, destinatarios, corte_desde, corte_hasta, error)
              VALUES (?,?,?,?,?,?,?)`)
    .run(alertaId, ahora(), nProcesos, JSON.stringify(destinatarios), desde, hasta, error);
}

export const historialEnvios = (db, alertaId, limite = 10) =>
  db.prepare('SELECT * FROM envios WHERE alerta_id = ? ORDER BY fecha DESC LIMIT ?').all(alertaId, limite);

export function borrarAlerta(db, id, usuarioId) {
  const a = leerAlerta(db, id);
  if (!a) return { ok: false, error: 'La alerta no existe.' };
  if (a.propietario_id !== usuarioId) return { ok: false, error: 'Solo quien creó la alerta puede borrarla.' };
  db.prepare('DELETE FROM alertas WHERE id = ?').run(id);
  db.prepare('DELETE FROM busquedas WHERE id = ?').run(a.busqueda_id);
  return { ok: true };
}

export function pausar(db, id, usuarioId, pausada) {
  const a = leerAlerta(db, id);
  if (!a) return { ok: false, error: 'La alerta no existe.' };
  if (a.propietario_id !== usuarioId) return { ok: false, error: 'Solo quien creó la alerta puede pausarla.' };
  db.prepare('UPDATE alertas SET pausada = ?, proximo_envio = ? WHERE id = ?')
    .run(pausada ? 1 : 0, pausada ? null : calcularProximoEnvio(a.frecuencia), id);
  return { ok: true };
}
