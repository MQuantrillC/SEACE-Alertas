// Pruebas del acceso y las invitaciones — node src/verificar-cuentas.mjs
// Se ejecuta sobre una base temporal: no toca datos.db ni cuentas.db reales.
//
// Aquí un fallo silencioso significa dar acceso a quien no debe o mandar correo a
// quien no lo pidió, así que conviene probarlo de verdad.

import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'seace-cuentas-'));
process.env.CUENTAS_DB = join(tmp, 'prueba.db');
delete process.env.REGISTRO_ABIERTO;

const { abrirCuentas, crearUsuario, crearEstudio, ahora, hashToken } = await import('./cuentas.mjs');
const auth = await import('./auth.mjs');

const db = abrirCuentas();
let fallos = 0;
const check = (ok, etiqueta, detalle = '') => {
  console.log(`  ${ok ? '✔' : '✘'} ${etiqueta}${detalle ? ' — ' + detalle : ''}`);
  if (!ok) fallos++;
};
const seccion = (t) => console.log(`\n── ${t} ──`);

// ── Preparación ───────────────────────────────────────────────────────────────
const estudio = crearEstudio(db, 'Estudio de Prueba');
const ana = crearUsuario(db, { email: 'Ana@Estudio.PE', nombre: 'Ana', estudioId: estudio.id });
const beto = crearUsuario(db, { email: 'beto@estudio.pe', nombre: 'Beto', estudioId: estudio.id });

seccion('Usuarios');
check(ana.email === 'ana@estudio.pe', 'el correo se normaliza a minúsculas', ana.email);
check(crearUsuario(db, { email: 'ana@estudio.pe' }).id === ana.id, 'no se duplica un usuario existente');

seccion('Acceso por enlace mágico');
const s1 = auth.solicitarAcceso(db, 'ana@estudio.pe');
check(s1.ok && !!s1.token, 'usuario conocido recibe token');

const desconocido = auth.solicitarAcceso(db, 'nadie@ajeno.com');
check(desconocido.ok && !desconocido.token, 'registro cerrado: desconocido NO genera token');
check(desconocido.mensaje === s1.mensaje, 'mensaje idéntico: no se filtra quién tiene cuenta');
check(!db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get('nadie@ajeno.com'),
  'un correo desconocido no crea cuenta');

check(!db.prepare('SELECT 1 FROM tokens WHERE hash = ?').get(s1.token),
  'el token en claro NO está en la base (se guarda hasheado)');
check(!!db.prepare('SELECT 1 FROM tokens WHERE hash = ?').get(hashToken(s1.token)),
  'el hash del token sí está');

const c1 = auth.canjearAcceso(db, s1.token);
check(c1.ok && !!c1.sesion, 'el token se canjea por una sesión');
check(auth.usuarioDeSesion(db, c1.sesion)?.id === ana.id, 'la sesión identifica al usuario');

const c2 = auth.canjearAcceso(db, s1.token);
check(!c2.ok, 'un token usado no vale dos veces', c2.error);
check(!auth.canjearAcceso(db, 'inventado').ok, 'un token inventado no vale');

// Caducidad
const exp = auth.solicitarAcceso(db, 'beto@estudio.pe');
db.prepare('UPDATE tokens SET expira = ? WHERE hash = ?')
  .run(new Date(Date.now() - 1000).toISOString(), hashToken(exp.token));
check(!auth.canjearAcceso(db, exp.token).ok, 'un token caducado no vale');

seccion('Límites anti-abuso');
const r1 = auth.solicitarAcceso(db, 'ana@estudio.pe');
check(!r1.ok && /segundos/.test(r1.error ?? ''), 'no deja pedir dos enlaces seguidos', r1.error);
// Simula 5 peticiones repartidas en la última hora (la más reciente hace 4 min,
// para que no salte antes el límite de "un enlace por minuto").
db.prepare('DELETE FROM tokens WHERE usuario_id = ?').run(ana.id);
const dentroDeUnRato = new Date(Date.now() + 900_000).toISOString();
for (let i = 0; i < 5; i++) {
  db.prepare(`INSERT INTO tokens (hash,tipo,usuario_id,creado,expira) VALUES (?,'login',?,?,?)`)
    .run('hash-simulado-' + i, ana.id, new Date(Date.now() - (i + 2) * 120_000).toISOString(), dentroDeUnRato);
}
const r2 = auth.solicitarAcceso(db, 'ana@estudio.pe');
check(!r2.ok && /hora/.test(r2.error ?? ''), 'corta tras 5 intentos en una hora', r2.error);

seccion('Cierre de sesión');
check(auth.cerrarSesion(db, c1.sesion), 'la sesión se cierra');
check(auth.usuarioDeSesion(db, c1.sesion) === null, 'una sesión cerrada ya no identifica');

seccion('Invitaciones');
const bus = db.prepare('INSERT INTO busquedas (usuario_id,nombre,filtros,creado) VALUES (?,?,?,?)')
  .run(ana.id, 'EsSalud limpieza', JSON.stringify({ objeto: 'limpieza' }), ahora());
const ale = db.prepare(`INSERT INTO alertas (busqueda_id,propietario_id,frecuencia,creado)
  VALUES (?,?,?,?)`).run(bus.lastInsertRowid, ana.id, JSON.stringify({ tipo: 'diaria', horas: ['08:00'] }), ahora());
const alertaId = Number(ale.lastInsertRowid);

check(auth.destinatarios(db, alertaId).length === 0, 'una alerta nueva no tiene destinatarios todavía');

const inv = auth.invitar(db, { alertaId, email: 'beto@estudio.pe', invitadoPor: ana.id });
check(inv.ok && !!inv.token, 'Ana puede invitar a Beto');
check(auth.destinatarios(db, alertaId).length === 0,
  '⭐ invitado pero SIN aceptar → no recibe nada');
check(auth.suscriptores(db, alertaId)[0].estado === 'pendiente', 'aparece como pendiente en la gestión');

const ajeno = auth.invitar(db, { alertaId, email: 'x@y.pe', invitadoPor: beto.id });
check(!ajeno.ok, 'quien no es propietario no puede invitar', ajeno.error);

const acc = auth.responderInvitacion(db, inv.token, true);
check(acc.ok && acc.aceptada, 'Beto acepta la invitación');
check(auth.destinatarios(db, alertaId).map((d) => d.email).join() === 'beto@estudio.pe',
  '⭐ tras aceptar sí recibe');
check(!!acc.sesion && auth.usuarioDeSesion(db, acc.sesion)?.id === beto.id,
  'aceptar también deja la sesión iniciada (y verifica el correo)');
check(!auth.responderInvitacion(db, inv.token, true).ok, 'la invitación no se puede reutilizar');

seccion('Baja');
check(auth.darDeBaja(db, alertaId, beto.id), 'Beto se da de baja');
check(auth.destinatarios(db, alertaId).length === 0, 'tras la baja deja de recibir');

const inv2 = auth.invitar(db, { alertaId, email: 'beto@estudio.pe', invitadoPor: ana.id });
auth.responderInvitacion(db, inv2.token, false);
check(auth.destinatarios(db, alertaId).length === 0, 'rechazar la invitación tampoco suscribe');

seccion('Cookies');
const ck = auth.cookieSesion('abc123');
check(/HttpOnly/.test(ck) && /SameSite=Lax/.test(ck), 'la cookie es HttpOnly y SameSite=Lax', ck.slice(0, 60));
check(/Max-Age=0/.test(auth.cookieSesion('', { borrar: true })), 'borrar la cookie usa Max-Age=0');
check(auth.leerCookie({ headers: { cookie: 'otra=1; seace_sesion=xyz; z=2' } }) === 'xyz', 'se lee la cookie correcta');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(fallos === 0 ? '\n✔ Todo correcto.\n' : `\n✘ ${fallos} fallo(s).\n`);
process.exit(fallos === 0 ? 0 : 1);
