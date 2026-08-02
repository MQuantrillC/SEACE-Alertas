// Pruebas de cadencia y de alertas — node src/verificar-alertas.mjs
// Base temporal: no toca cuentas.db real.

import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'seace-alertas-'));
process.env.CUENTAS_DB = join(tmp, 'prueba.db');

const { abrirCuentas, crearUsuario } = await import('./cuentas.mjs');
const M = await import('./alertasModelo.mjs');
const auth = await import('./auth.mjs');

let fallos = 0;
const check = (ok, etiqueta, detalle = '') => {
  console.log(`  ${ok ? '✔' : '✘'} ${etiqueta}${detalle ? ' — ' + detalle : ''}`);
  if (!ok) fallos++;
};
const seccion = (t) => console.log(`\n── ${t} ──`);

// Un instante concreto en hora de Lima → Date UTC
const lima = (s) => new Date(s + '-05:00');
// Un ISO UTC → "YYYY-MM-DD HH:mm" en hora de Lima
const verLima = (iso) => new Date(Date.parse(iso) - 5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');

seccion('Validación de la cadencia');
check(M.frecuenciaValida({ tipo: 'diaria', horas: ['08:00'] }) === null, 'diaria a las 08:00 es válida');
check(!!M.frecuenciaValida({ tipo: 'diaria', horas: [] }), 'diaria sin hora falla');
check(!!M.frecuenciaValida({ tipo: 'dosDiarias', horas: ['08:00', '08:00'] }), 'dos horas iguales fallan');
check(!!M.frecuenciaValida({ tipo: 'diaria', horas: ['03:00'] }), 'una hora nocturna se rechaza',
  M.frecuenciaValida({ tipo: 'diaria', horas: ['03:00'] }));
check(!!M.frecuenciaValida({ tipo: 'semanal', horas: ['08:00'] }), 'semanal sin día falla');
check(!!M.frecuenciaValida({ tipo: 'inventada' }), 'un tipo desconocido falla');

seccion('Próximo envío — diaria a las 08:00');
const diaria = { tipo: 'diaria', horas: ['08:00'] };
check(verLima(M.calcularProximoEnvio(diaria, lima('2026-08-01T06:00'))) === '2026-08-01 08:00',
  'a las 06:00 → hoy 08:00', verLima(M.calcularProximoEnvio(diaria, lima('2026-08-01T06:00'))));
check(verLima(M.calcularProximoEnvio(diaria, lima('2026-08-01T09:00'))) === '2026-08-02 08:00',
  'a las 09:00 (ya pasó) → mañana 08:00', verLima(M.calcularProximoEnvio(diaria, lima('2026-08-01T09:00'))));
check(verLima(M.calcularProximoEnvio(diaria, lima('2026-08-31T23:00'))) === '2026-09-01 08:00',
  'cruza el fin de mes', verLima(M.calcularProximoEnvio(diaria, lima('2026-08-31T23:00'))));
check(verLima(M.calcularProximoEnvio(diaria, lima('2026-12-31T22:00'))) === '2027-01-01 08:00',
  'cruza el fin de año', verLima(M.calcularProximoEnvio(diaria, lima('2026-12-31T22:00'))));

seccion('Próximo envío — dos veces al día');
const dos = { tipo: 'dosDiarias', horas: ['17:00', '08:00'] }; // desordenadas a propósito
check(verLima(M.calcularProximoEnvio(dos, lima('2026-08-01T07:00'))) === '2026-08-01 08:00', 'antes de las 08:00 → 08:00');
check(verLima(M.calcularProximoEnvio(dos, lima('2026-08-01T10:00'))) === '2026-08-01 17:00', 'entre medias → 17:00');
check(verLima(M.calcularProximoEnvio(dos, lima('2026-08-01T18:00'))) === '2026-08-02 08:00', 'después → mañana 08:00');

seccion('Próximo envío — horaria, respetando el horario hábil');
const hor = { tipo: 'horaria' };
check(verLima(M.calcularProximoEnvio(hor, lima('2026-08-01T10:30'))) === '2026-08-01 11:00', 'a media mañana → hora siguiente');
check(verLima(M.calcularProximoEnvio(hor, lima('2026-08-01T21:00'))) === '2026-08-02 07:00',
  '⭐ de noche NO envía: espera a las 07:00', verLima(M.calcularProximoEnvio(hor, lima('2026-08-01T21:00'))));
check(verLima(M.calcularProximoEnvio(hor, lima('2026-08-01T03:00'))) === '2026-08-01 07:00',
  'de madrugada → 07:00 del mismo día', verLima(M.calcularProximoEnvio(hor, lima('2026-08-01T03:00'))));
check(verLima(M.calcularProximoEnvio(hor, lima('2026-08-01T19:30'))) === '2026-08-01 20:00', 'a las 19:30 → 20:00 (último)');

seccion('Próximo envío — semanal');
// 2026-08-01 es sábado; diaSemana 0 = lunes
const sem = { tipo: 'semanal', horas: ['08:00'], diaSemana: 0 };
check(verLima(M.calcularProximoEnvio(sem, lima('2026-08-01T12:00'))) === '2026-08-03 08:00',
  'sábado → lunes siguiente', verLima(M.calcularProximoEnvio(sem, lima('2026-08-01T12:00'))));
check(verLima(M.calcularProximoEnvio(sem, lima('2026-08-03T07:00'))) === '2026-08-03 08:00', 'lunes temprano → hoy');
check(verLima(M.calcularProximoEnvio(sem, lima('2026-08-03T09:00'))) === '2026-08-10 08:00', 'lunes tarde → el lunes que viene');

seccion('Siempre hacia adelante (barrido de las 24 h × 4 cadencias × 60 min)');
let malos = 0, total = 0;
const ejemplos = [];
for (let h = 0; h < 24; h++) for (const m of [0, 15, 30, 45, 59]) for (const f of [diaria, dos, hor, sem]) {
  const desde = lima(`2026-08-0${(h % 7) + 1}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  total++;
  const p = M.calcularProximoEnvio(f, desde);
  if (Date.parse(p) <= desde.getTime()) {
    malos++;
    if (ejemplos.length < 3) ejemplos.push(`${f.tipo} desde ${verLima(desde.toISOString())} → ${verLima(p)}`);
  }
}
check(malos === 0, 'el próximo envío nunca cae en el pasado',
  malos ? `${malos}/${total} · ${ejemplos.join(' | ')}` : `${total} combinaciones`);

seccion('La cadencia horaria nunca programa de madrugada');
let nocturnos = 0;
for (let h = 0; h < 24; h++) {
  const p = M.calcularProximoEnvio(hor, lima(`2026-08-01T${String(h).padStart(2, '0')}:40`));
  const hh = Number(verLima(p).slice(11, 13));
  if (hh < M.HORA_MIN || hh > M.HORA_MAX) nocturnos++;
}
check(nocturnos === 0, 'todas las horas programadas caen en horario hábil', `${nocturnos} fuera de ventana`);

seccion('Alta y programación');
const db = abrirCuentas();
const ana = crearUsuario(db, { email: 'ana@estudio.pe', nombre: 'Ana' });
const beto = crearUsuario(db, { email: 'beto@estudio.pe', nombre: 'Beto' });

const mala = M.crearAlerta(db, { usuarioId: ana.id, nombre: 'X', filtros: {}, frecuencia: { tipo: 'diaria', horas: ['02:00'] } });
check(!mala.ok, 'no deja crear una alerta a las 02:00', mala.error);

const r = M.crearAlerta(db, {
  usuarioId: ana.id, nombre: 'EsSalud limpieza',
  filtros: { objeto: 'limpieza' }, frecuencia: { tipo: 'diaria', horas: ['08:00'] },
});
check(r.ok, 'la alerta se crea');
const a = r.alerta;
check(!!a.proximo_envio, 'queda programada', verLima(a.proximo_envio));
check(auth.destinatarios(db, a.id).map((d) => d.email).join() === 'ana@estudio.pe',
  '⭐ quien la crea queda suscrito sin invitarse a sí mismo');
check(M.describirFrecuencia(a.frecuencia) === 'Cada día a las 08:00', 'la cadencia se describe en texto');

seccion('El corte se guarda como día de Lima, no como instante UTC');
check(/^\d{4}-\d{2}-\d{2}$/.test(a.ultima_fecha), 'ultima_fecha es un día suelto', a.ultima_fecha);
check(a.ultima_fecha === M.hoyLima(), 'y coincide con hoy en Lima', M.hoyLima());
// Por la tarde en Lima, el UTC ya va por el día siguiente: si se guardara el
// instante UTC, la alerta se saltaría todo lo publicado hoy.
check(M.corteADiaLima('2026-08-02T02:30:00.000Z') === '2026-08-01',
  '⭐ un ISO UTC de madrugada se traduce al día anterior en Lima',
  M.corteADiaLima('2026-08-02T02:30:00.000Z'));
check(M.corteADiaLima('2026-08-01') === '2026-08-01', 'un día ya normalizado se respeta');

seccion('Pendientes');
check(M.alertasPendientes(db).length === 0, 'todavía no toca enviarla');
db.prepare('UPDATE alertas SET proximo_envio = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', a.id);
check(M.alertasPendientes(db).length === 1, 'con el envío vencido, aparece como pendiente');
M.pausar(db, a.id, ana.id, true);
check(M.alertasPendientes(db).length === 0, 'una alerta pausada no se envía');
M.pausar(db, a.id, ana.id, false);
check(!!M.leerAlerta(db, a.id).proximo_envio, 'al reanudar se reprograma');
check(!M.pausar(db, a.id, beto.id, true).ok, 'quien no es propietario no puede pausar');

seccion('Enlaces de baja');
const f1 = M.firmaBaja(db, a.id, beto.id);
check(M.verificarBaja(db, a.id, beto.id, f1), 'la firma propia es válida');
check(!M.verificarBaja(db, a.id, ana.id, f1), 'la firma de otro usuario no vale');
check(!M.verificarBaja(db, a.id, beto.id, 'x'.repeat(f1.length)), 'una firma inventada no vale');
check(M.firmaBaja(db, a.id, beto.id) === f1, 'la firma es estable (el enlace del correo no caduca)');

seccion('Historial de envíos');
M.registrarEnvio(db, { alertaId: a.id, nProcesos: 3, destinatarios: ['ana@estudio.pe'], desde: 'x', hasta: 'y' });
check(M.historialEnvios(db, a.id).length === 1, 'el envío queda registrado');
check(M.historialEnvios(db, a.id)[0].n_procesos === 3, 'con su número de procesos');

seccion('Visibilidad');
check(M.alertasDe(db, ana.id).length === 1, 'Ana ve su alerta');
check(M.alertasDe(db, beto.id).length === 0, 'Beto no la ve hasta aceptar');
const inv = auth.invitar(db, { alertaId: a.id, email: 'beto@estudio.pe', invitadoPor: ana.id });
auth.responderInvitacion(db, inv.token, true);
check(M.alertasDe(db, beto.id).length === 1, 'tras aceptar, Beto la ve');
check(!M.borrarAlerta(db, a.id, beto.id).ok, 'un suscriptor no puede borrarla');
check(M.borrarAlerta(db, a.id, ana.id).ok, 'la propietaria sí');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(fallos === 0 ? '\n✔ Todo correcto.\n' : `\n✘ ${fallos} fallo(s).\n`);
process.exit(fallos === 0 ? 0 : 1);
