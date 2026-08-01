// ──────────────────────────────────────────────────────────────────────────────
// Acceso por enlace mágico e invitaciones con aceptación.
//
// Por qué sin contraseña: el correo YA es la identidad del producto (las alertas
// llegan ahí), un estudio no tiene equipo de TI para gestionar restablecimientos,
// y sobre todo — entrar por el correo VERIFICA el correo, que es justo lo que hace
// falta para no mandarle avisos a quien no los pidió.
// ──────────────────────────────────────────────────────────────────────────────

import {
  ahora, enMinutos, enDias, normEmail, emailValido, nuevoToken, hashToken,
  buscarUsuarioPorEmail, crearUsuario, usuarioPorId,
  TTL_LOGIN_MIN, TTL_INVITACION_DIAS, TTL_SESION_DIAS,
} from './cuentas.mjs';

export const COOKIE = 'seace_sesion';

/** Registro cerrado salvo que se diga lo contrario: pedir un enlace con un correo
 *  desconocido no crea cuenta ni envía nada. Se entra por invitación o por CLI. */
export const registroAbierto = () => process.env.REGISTRO_ABIERTO === '1';

// ── Límites anti-abuso ────────────────────────────────────────────────────────
// Sin esto, cualquiera puede usar el formulario de acceso para bombardear el buzón
// de otra persona: escribe su correo y pulsa "enviar" cien veces.
const MIN_ENTRE_ENVIOS_S = 60;
const MAX_POR_HORA = 5;

function limitado(db, usuarioId) {
  const ultimo = db.prepare(
    `SELECT creado FROM tokens WHERE usuario_id = ? AND tipo = 'login' ORDER BY creado DESC LIMIT 1`
  ).get(usuarioId);
  if (ultimo && Date.now() - Date.parse(ultimo.creado) < MIN_ENTRE_ENVIOS_S * 1000) {
    return `Acabamos de enviarte un enlace. Espera ${MIN_ENTRE_ENVIOS_S} segundos antes de pedir otro.`;
  }
  const haceUnaHora = new Date(Date.now() - 3_600_000).toISOString();
  const n = db.prepare(
    `SELECT count(*) AS n FROM tokens WHERE usuario_id = ? AND tipo = 'login' AND creado > ?`
  ).get(usuarioId, haceUnaHora).n;
  if (n >= MAX_POR_HORA) return 'Demasiados intentos de acceso. Inténtalo dentro de una hora.';
  return null;
}

// ── Acceso ────────────────────────────────────────────────────────────────────

/**
 * Pide un enlace de acceso.
 *
 * Devuelve SIEMPRE el mismo mensaje, exista el correo o no: si dijéramos "ese
 * correo no está registrado" cualquiera podría averiguar quién usa el sistema.
 * `enlace` solo viene cuando de verdad hay que enviarlo.
 */
export function solicitarAcceso(db, email) {
  const mensajeNeutro = 'Si ese correo tiene cuenta, te acabamos de enviar un enlace de acceso.';
  const e = normEmail(email);
  if (!emailValido(e)) return { ok: false, error: 'Ese correo no parece válido.' };

  let usuario = buscarUsuarioPorEmail(db, e);
  if (!usuario) {
    if (!registroAbierto()) return { ok: true, mensaje: mensajeNeutro, enlace: null };
    usuario = crearUsuario(db, { email: e });
  }
  if (!usuario.activo) return { ok: true, mensaje: mensajeNeutro, enlace: null };

  const aviso = limitado(db, usuario.id);
  if (aviso) return { ok: false, error: aviso };

  const { claro, hash } = nuevoToken();
  db.prepare(`INSERT INTO tokens (hash, tipo, usuario_id, datos, creado, expira)
              VALUES (?, 'login', ?, NULL, ?, ?)`)
    .run(hash, usuario.id, ahora(), enMinutos(TTL_LOGIN_MIN));
  return { ok: true, mensaje: mensajeNeutro, usuario, token: claro, minutos: TTL_LOGIN_MIN };
}

/** Canjea el token del enlace por una sesión. Un solo uso. */
export function canjearAcceso(db, token) {
  const fila = db.prepare(`SELECT * FROM tokens WHERE hash = ? AND tipo = 'login'`).get(hashToken(token ?? ''));
  if (!fila) return { ok: false, error: 'Ese enlace no es válido.' };
  if (fila.usado) return { ok: false, error: 'Ese enlace ya se usó. Pide uno nuevo.' };
  if (fila.expira < ahora()) return { ok: false, error: `El enlace caducó (dura ${TTL_LOGIN_MIN} minutos). Pide uno nuevo.` };

  db.prepare('UPDATE tokens SET usado = ? WHERE hash = ?').run(ahora(), fila.hash);
  db.prepare('UPDATE usuarios SET ultimo_acceso = ? WHERE id = ?').run(ahora(), fila.usuario_id);
  return { ok: true, ...crearSesion(db, fila.usuario_id) };
}

export function crearSesion(db, usuarioId) {
  const { claro, hash } = nuevoToken();
  db.prepare('INSERT INTO sesiones (hash, usuario_id, creado, expira, ultimo_uso) VALUES (?,?,?,?,?)')
    .run(hash, usuarioId, ahora(), enDias(TTL_SESION_DIAS), ahora());
  return { sesion: claro, usuario: usuarioPorId(db, usuarioId), dias: TTL_SESION_DIAS };
}

/** Usuario de una sesión, o null. Renueva `ultimo_uso`. */
export function usuarioDeSesion(db, sesion) {
  if (!sesion) return null;
  const fila = db.prepare('SELECT * FROM sesiones WHERE hash = ?').get(hashToken(sesion));
  if (!fila || fila.expira < ahora()) return null;
  db.prepare('UPDATE sesiones SET ultimo_uso = ? WHERE hash = ?').run(ahora(), fila.hash);
  const u = usuarioPorId(db, fila.usuario_id);
  return u?.activo ? u : null;
}

export function cerrarSesion(db, sesion) {
  if (!sesion) return false;
  return db.prepare('DELETE FROM sesiones WHERE hash = ?').run(hashToken(sesion)).changes > 0;
}

// ── Invitaciones ──────────────────────────────────────────────────────────────

/**
 * Invita a alguien a una alerta. Queda en 'pendiente': **no recibe nada** hasta
 * que acepte desde su propio correo. Es la misma maquinaria del enlace mágico,
 * y por eso la aceptación también verifica su dirección.
 */
export function invitar(db, { alertaId, email, invitadoPor }) {
  const e = normEmail(email);
  if (!emailValido(e)) return { ok: false, error: `Correo inválido: ${email}` };

  const alerta = db.prepare('SELECT * FROM alertas WHERE id = ?').get(alertaId);
  if (!alerta) return { ok: false, error: 'La alerta no existe.' };
  if (alerta.propietario_id !== invitadoPor) {
    return { ok: false, error: 'Solo quien creó la alerta puede invitar.' };
  }

  // Se crea la cuenta destino aunque el registro esté cerrado: una invitación de
  // un usuario legítimo ES la vía de alta prevista. Hereda el estudio de quien invita.
  const anfitrion = usuarioPorId(db, invitadoPor);
  const usuario = crearUsuario(db, { email: e, estudioId: anfitrion?.estudio_id ?? null });

  const ya = db.prepare('SELECT * FROM alerta_suscriptor WHERE alerta_id = ? AND usuario_id = ?')
    .get(alertaId, usuario.id);
  if (ya?.estado === 'aceptada') return { ok: true, yaAceptada: true, usuario };

  db.prepare(`INSERT INTO alerta_suscriptor (alerta_id, usuario_id, estado, invitado_por, actualizado)
              VALUES (?, ?, 'pendiente', ?, ?)
              ON CONFLICT(alerta_id, usuario_id) DO UPDATE
                SET estado = 'pendiente', invitado_por = excluded.invitado_por, actualizado = excluded.actualizado`)
    .run(alertaId, usuario.id, invitadoPor, ahora());

  const { claro, hash } = nuevoToken();
  db.prepare(`INSERT INTO tokens (hash, tipo, usuario_id, datos, creado, expira)
              VALUES (?, 'invitacion', ?, ?, ?, ?)`)
    .run(hash, usuario.id, JSON.stringify({ alertaId }), ahora(), enDias(TTL_INVITACION_DIAS));

  return { ok: true, usuario, token: claro, dias: TTL_INVITACION_DIAS };
}

/** Acepta (o rechaza) una invitación. Al aceptar, además, deja la sesión iniciada. */
export function responderInvitacion(db, token, aceptar = true) {
  const fila = db.prepare(`SELECT * FROM tokens WHERE hash = ? AND tipo = 'invitacion'`).get(hashToken(token ?? ''));
  if (!fila) return { ok: false, error: 'Esa invitación no es válida.' };
  if (fila.usado) return { ok: false, error: 'Esa invitación ya se respondió.' };
  if (fila.expira < ahora()) return { ok: false, error: `La invitación caducó (dura ${TTL_INVITACION_DIAS} días). Pide que te la reenvíen.` };

  const { alertaId } = JSON.parse(fila.datos ?? '{}');
  db.prepare('UPDATE tokens SET usado = ? WHERE hash = ?').run(ahora(), fila.hash);
  db.prepare(`UPDATE alerta_suscriptor SET estado = ?, actualizado = ?
              WHERE alerta_id = ? AND usuario_id = ?`)
    .run(aceptar ? 'aceptada' : 'baja', ahora(), alertaId, fila.usuario_id);

  if (!aceptar) return { ok: true, aceptada: false, alertaId };
  db.prepare('UPDATE usuarios SET ultimo_acceso = ? WHERE id = ?').run(ahora(), fila.usuario_id);
  return { ok: true, aceptada: true, alertaId, ...crearSesion(db, fila.usuario_id) };
}

/** Baja de una alerta. El enlace va en cada correo — sin esto no deberíamos enviar. */
export function darDeBaja(db, alertaId, usuarioId) {
  return db.prepare(`UPDATE alerta_suscriptor SET estado = 'baja', actualizado = ?
                     WHERE alerta_id = ? AND usuario_id = ?`).run(ahora(), alertaId, usuarioId).changes > 0;
}

/**
 * Destinatarios REALES de una alerta: solo quien aceptó.
 * Es la función que impide mandar correo a quien no lo consintió — cualquier
 * envío debe pasar por aquí, nunca por una lista de correos suelta.
 */
export function destinatarios(db, alertaId) {
  return db.prepare(`
    SELECT u.id, u.email, u.nombre
    FROM alerta_suscriptor s JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.alerta_id = ? AND s.estado = 'aceptada' AND u.activo = 1
    ORDER BY u.email`).all(alertaId);
}

/** Suscriptores con su estado, para la pantalla de gestión de la alerta. */
export function suscriptores(db, alertaId) {
  return db.prepare(`
    SELECT u.id, u.email, u.nombre, s.estado, s.actualizado
    FROM alerta_suscriptor s JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.alerta_id = ? ORDER BY s.estado, u.email`).all(alertaId);
}

// ── Cookies ───────────────────────────────────────────────────────────────────

export function leerCookie(req, nombre = COOKIE) {
  const bruto = req.headers?.cookie;
  if (!bruto) return null;
  for (const parte of bruto.split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nombre) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}

/** httpOnly: el JS de la página no puede leerla (ni un XSS robaría la sesión).
 *  SameSite=Lax: no viaja en peticiones de otros sitios, que es la defensa básica
 *  contra CSRF. Secure solo si se sirve por HTTPS (en localhost lo impediría). */
export function cookieSesion(valor, { borrar = false } = {}) {
  const seguro = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  const edad = borrar ? 0 : TTL_SESION_DIAS * 86_400;
  return `${COOKIE}=${borrar ? '' : encodeURIComponent(valor)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${edad}${seguro}`;
}

export const baseUrl = () => (process.env.BASE_URL || `http://localhost:${process.env.PORT || 4321}`).replace(/\/$/, '');
export const enlaceAcceso = (t) => `${baseUrl()}/acceso?token=${encodeURIComponent(t)}`;
export const enlaceInvitacion = (t) => `${baseUrl()}/invitacion?token=${encodeURIComponent(t)}`;
