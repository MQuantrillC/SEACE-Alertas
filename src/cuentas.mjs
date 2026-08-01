// ──────────────────────────────────────────────────────────────────────────────
// cuentas.db — usuarios, alertas, carteras e invitaciones.
//
// Al revés que datos.db, esta base es IRREEMPLAZABLE: nada de lo que hay aquí se
// puede volver a bajar del OECE. Es la única que hay que respaldar.
//
// Decisiones de seguridad, todas deliberadas:
//   · Los tokens (login y sesión) se guardan HASHEADOS. Si alguien se lleva el
//     fichero .db no puede suplantar a nadie: el valor en claro solo existe en el
//     correo del usuario y en su cookie.
//   · El registro está CERRADO por defecto: pedir un enlace con un correo
//     desconocido no crea cuenta ni envía nada. Se entra por invitación o por
//     `npm run usuario`. Un producto para un estudio no debe dejar que cualquiera
//     se dé de alta.
//   · Los correos nunca reciben avisos sin aceptar antes la invitación.
// ──────────────────────────────────────────────────────────────────────────────

import Database from 'better-sqlite3';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CUENTAS_DB = process.env.CUENTAS_DB || join(ROOT, 'datos', 'cuentas.db');

export const TTL_LOGIN_MIN = 15;        // el enlace mágico caduca pronto a propósito
export const TTL_INVITACION_DIAS = 7;
export const TTL_SESION_DIAS = 30;

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS estudios (
  id     INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  creado TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usuarios (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,   -- siempre en minúsculas
  nombre        TEXT,
  estudio_id    INTEGER REFERENCES estudios(id),
  creado        TEXT NOT NULL,
  ultimo_acceso TEXT,
  activo        INTEGER NOT NULL DEFAULT 1
);

-- Tokens de un solo uso: enlace mágico de acceso e invitaciones.
-- Se guarda el sha256, nunca el token.
CREATE TABLE IF NOT EXISTS tokens (
  hash       TEXT PRIMARY KEY,
  tipo       TEXT NOT NULL,             -- 'login' | 'invitacion'
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  datos      TEXT,                      -- JSON (p. ej. {"alerta_id":3})
  creado     TEXT NOT NULL,
  expira     TEXT NOT NULL,
  usado      TEXT
);
CREATE INDEX IF NOT EXISTS ix_tok_usuario ON tokens(usuario_id, tipo, creado);

CREATE TABLE IF NOT EXISTS sesiones (
  hash       TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  creado     TEXT NOT NULL,
  expira     TEXT NOT NULL,
  ultimo_uso TEXT
);
CREATE INDEX IF NOT EXISTS ix_ses_usuario ON sesiones(usuario_id);

-- Carteras: grupos de entidades reutilizables ("Sector Salud", "Cliente Fulano").
CREATE TABLE IF NOT EXISTS carteras (
  id         INTEGER PRIMARY KEY,
  estudio_id INTEGER REFERENCES estudios(id),
  nombre     TEXT NOT NULL,
  creado     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cartera_entidad (
  cartera_id INTEGER NOT NULL REFERENCES carteras(id) ON DELETE CASCADE,
  entidad_id TEXT NOT NULL,             -- 'PE-CONSUCODE-…' (vive en datos.db)
  nombre     TEXT,                      -- copia para poder mostrarla sin cruzar bases
  PRIMARY KEY (cartera_id, entidad_id)
);

-- Búsqueda guardada: los filtros. Una alerta es una búsqueda con cadencia.
CREATE TABLE IF NOT EXISTS busquedas (
  id         INTEGER PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  nombre     TEXT NOT NULL,
  filtros    TEXT NOT NULL,             -- JSON
  creado     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alertas (
  id             INTEGER PRIMARY KEY,
  busqueda_id    INTEGER NOT NULL REFERENCES busquedas(id) ON DELETE CASCADE,
  propietario_id INTEGER NOT NULL REFERENCES usuarios(id),
  frecuencia     TEXT NOT NULL,         -- JSON {tipo,horas[],diaSemana,tz}
  proximo_envio  TEXT,                  -- ISO UTC; NULL = pausada sin programar
  ultima_fecha   TEXT,                  -- corte: solo se envía lo publicado después
  ultimo_envio   TEXT,
  enviar_vacios  INTEGER NOT NULL DEFAULT 0,
  pausada        INTEGER NOT NULL DEFAULT 0,
  creado         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ale_proximo ON alertas(proximo_envio) WHERE pausada = 0;

-- Quién recibe cada alerta. 'pendiente' NO recibe nada hasta aceptar.
CREATE TABLE IF NOT EXISTS alerta_suscriptor (
  alerta_id  INTEGER NOT NULL REFERENCES alertas(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  estado     TEXT NOT NULL,             -- 'pendiente' | 'aceptada' | 'baja'
  invitado_por INTEGER REFERENCES usuarios(id),
  actualizado TEXT NOT NULL,
  PRIMARY KEY (alerta_id, usuario_id)
);

CREATE TABLE IF NOT EXISTS seguimientos (
  id         INTEGER PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  ocid       TEXT NOT NULL,
  titulo     TEXT,
  snapshot   TEXT,                      -- JSON del estado al empezar a seguirlo
  creado     TEXT NOT NULL,
  UNIQUE (usuario_id, ocid)
);

-- Historial de envíos. No es opcional: es la única forma de responder a
-- "¿por qué no me avisaron de este proceso?".
CREATE TABLE IF NOT EXISTS envios (
  id            INTEGER PRIMARY KEY,
  alerta_id     INTEGER REFERENCES alertas(id) ON DELETE CASCADE,
  fecha         TEXT NOT NULL,
  n_procesos    INTEGER NOT NULL,
  destinatarios TEXT,                   -- JSON de correos
  corte_desde   TEXT,
  corte_hasta   TEXT,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS ix_env_alerta ON envios(alerta_id, fecha DESC);
`;

export function abrirCuentas({ soloLectura = false } = {}) {
  mkdirSync(dirname(CUENTAS_DB), { recursive: true });
  const db = new Database(CUENTAS_DB, { readonly: soloLectura });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  if (!soloLectura) db.exec(ESQUEMA);
  return db;
}

// ── Utilidades ────────────────────────────────────────────────────────────────

export const ahora = () => new Date().toISOString();
export const enMinutos = (n) => new Date(Date.now() + n * 60_000).toISOString();
export const enDias = (n) => new Date(Date.now() + n * 86_400_000).toISOString();

/** Correo normalizado. Se compara y se guarda siempre así. */
export const normEmail = (e) => String(e ?? '').trim().toLowerCase();

/** Validación deliberadamente simple: el correo se verifica ENVIÁNDOLO, no con
 *  una expresión regular. Esto solo descarta erratas evidentes. */
export const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normEmail(e));

/** Token en claro (para el enlace) + su hash (para la base). */
export function nuevoToken() {
  const claro = randomBytes(32).toString('base64url');
  return { claro, hash: hashToken(claro) };
}
export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');

/** Comparación en tiempo constante, por si acaso se usa fuera del índice. */
export function iguales(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ── Usuarios y estudios ───────────────────────────────────────────────────────

export function crearEstudio(db, nombre) {
  const r = db.prepare('INSERT INTO estudios (nombre, creado) VALUES (?, ?)').run(nombre, ahora());
  return { id: r.lastInsertRowid, nombre };
}

export function buscarUsuarioPorEmail(db, email) {
  return db.prepare('SELECT * FROM usuarios WHERE email = ?').get(normEmail(email)) ?? null;
}

export function crearUsuario(db, { email, nombre = null, estudioId = null }) {
  const e = normEmail(email);
  if (!emailValido(e)) throw new Error(`Correo inválido: ${email}`);
  const existe = buscarUsuarioPorEmail(db, e);
  if (existe) return existe;
  const r = db.prepare(`INSERT INTO usuarios (email, nombre, estudio_id, creado) VALUES (?, ?, ?, ?)`)
    .run(e, nombre, estudioId, ahora());
  return db.prepare('SELECT * FROM usuarios WHERE id = ?').get(r.lastInsertRowid);
}

export const usuarioPorId = (db, id) => db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id) ?? null;

/** Borra tokens y sesiones caducados. Barato; conviene llamarlo de vez en cuando. */
export function limpiar(db) {
  const t = ahora();
  const a = db.prepare('DELETE FROM tokens WHERE expira < ? OR usado IS NOT NULL').run(t).changes;
  const b = db.prepare('DELETE FROM sesiones WHERE expira < ?').run(t).changes;
  return { tokens: a, sesiones: b };
}
