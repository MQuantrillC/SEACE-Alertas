// ──────────────────────────────────────────────────────────────────────────────
// datos.db — base de datos de PROCESOS, reconstruible desde el OECE.
//
// Regla de oro: esta base es DESECHABLE. Si se corrompe o cambia el esquema, se
// borra y se re-ingesta (`npm run ingesta`). Nada que el usuario haya creado vive
// aquí — eso va en cuentas.db, que sí es irreemplazable.
//
// El esquema sale del inventario real de la fuente (ver API.md): entidades por
// buyer.id (coincide 100% con el catálogo), postores con RUC, montos normalizados
// a soles y documentos con su tipo.
// ──────────────────────────────────────────────────────────────────────────────

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATOS_DB = join(ROOT, 'datos', 'datos.db');

export const ESQUEMA_VERSION = 1;

/** Plegado para comparar/buscar: sin tildes, minúsculas y SIN espacios dobles.
 *  El colapso de espacios no es cosmético: el catálogo del OECE dice
 *  "SEGURO SOCIAL DE SALUD" y el bulk "SEGURO SOCIAL DE  SALUD". */
/** Limpia un nombre para MOSTRAR: conserva mayúsculas y tildes, pero colapsa los
 *  espacios. Sin esto el catálogo y el bulk discrepan ("SEGURO SOCIAL DE SALUD" vs
 *  "SEGURO SOCIAL DE  SALUD") y la misma entidad se ve escrita de dos formas. */
export const limpiar = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

export const norm = (s) =>
  (s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS meta (clave TEXT PRIMARY KEY, valor TEXT);

-- Meses ya ingestados, para poder reanudar y refrescar solo lo que cambió.
CREATE TABLE IF NOT EXISTS meses (
  mes           TEXT PRIMARY KEY,   -- 'YYYY-MM'
  procesos      INTEGER NOT NULL,
  publicado     TEXT,               -- publishedDate del paquete OCDS
  ingestado_el  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entidades (
  id           TEXT PRIMARY KEY,    -- 'PE-CONSUCODE-1191'
  nombre       TEXT NOT NULL,
  nombre_norm  TEXT NOT NULL,
  ruc          TEXT,
  departamento TEXT,
  provincia    TEXT,
  distrito     TEXT,
  direccion    TEXT,
  telefono     TEXT,
  web          TEXT
);
CREATE INDEX IF NOT EXISTS ix_ent_norm ON entidades(nombre_norm);
CREATE INDEX IF NOT EXISTS ix_ent_dep  ON entidades(departamento);

CREATE TABLE IF NOT EXISTS procesos (
  ocid           TEXT PRIMARY KEY,
  mes            TEXT NOT NULL,
  tender_id      TEXT,
  nomenclatura   TEXT,
  descripcion    TEXT,
  entidad_id     TEXT REFERENCES entidades(id),
  categoria      TEXT,
  metodo         TEXT,
  monto          REAL,
  moneda         TEXT,
  monto_pen      REAL,              -- ⭐ usar SIEMPRE este para sumar
  protegido      INTEGER,           -- hasTenderInformationProtectedByLaw
  fecha          TEXT,              -- ISO con offset (-05:00)
  fecha_dia      TEXT,              -- 'YYYY-MM-DD' en hora de Lima
  cierre_ofertas TEXT,
  tender_ini     TEXT,
  tender_fin     TEXT,
  enquiry_ini    TEXT,
  enquiry_fin    TEXT,
  n_postores     INTEGER DEFAULT 0,
  proyecto       TEXT,
  proyecto_id    TEXT
);
CREATE INDEX IF NOT EXISTS ix_proc_fecha   ON procesos(fecha_dia DESC);
CREATE INDEX IF NOT EXISTS ix_proc_entidad ON procesos(entidad_id);
CREATE INDEX IF NOT EXISTS ix_proc_mes     ON procesos(mes);
CREATE INDEX IF NOT EXISTS ix_proc_cierre  ON procesos(cierre_ofertas);
CREATE INDEX IF NOT EXISTS ix_proc_cat     ON procesos(categoria);
CREATE INDEX IF NOT EXISTS ix_proc_metodo  ON procesos(metodo);

-- Estados a nivel proceso (distinct de items[].statusDetails).
CREATE TABLE IF NOT EXISTS proceso_estado (
  ocid   TEXT NOT NULL REFERENCES procesos(ocid),
  estado TEXT NOT NULL,
  PRIMARY KEY (ocid, estado)
);
CREATE INDEX IF NOT EXISTS ix_est_estado ON proceso_estado(estado);

CREATE TABLE IF NOT EXISTS items (
  id          TEXT,
  ocid        TEXT NOT NULL REFERENCES procesos(ocid),
  posicion    INTEGER,
  descripcion TEXT,
  cantidad    REAL,
  unidad      TEXT,
  monto       REAL,
  estado      TEXT,
  cubso_id    TEXT,
  cubso_desc  TEXT,
  unspsc_id   TEXT,
  unspsc_desc TEXT
);
CREATE INDEX IF NOT EXISTS ix_item_ocid  ON items(ocid);
CREATE INDEX IF NOT EXISTS ix_item_cubso ON items(cubso_id);

-- ⭐ Postores Y adjudicados. Es el índice que la API no permite consultar:
--    /suppliers ignora toda búsqueda por nombre (ver API.md §1).
CREATE TABLE IF NOT EXISTS actores (
  ocid        TEXT NOT NULL REFERENCES procesos(ocid),
  ruc         TEXT NOT NULL,        -- '10455833081' (sin el prefijo PE-RUC-)
  nombre      TEXT NOT NULL,
  nombre_norm TEXT NOT NULL,
  rol         TEXT NOT NULL,        -- 'tenderer' | 'supplier'
  PRIMARY KEY (ocid, ruc, rol)
);
CREATE INDEX IF NOT EXISTS ix_act_ruc  ON actores(ruc);
CREATE INDEX IF NOT EXISTS ix_act_norm ON actores(nombre_norm);
CREATE INDEX IF NOT EXISTS ix_act_rol  ON actores(rol);

CREATE TABLE IF NOT EXISTS adjudicaciones (
  id        TEXT PRIMARY KEY,
  ocid      TEXT NOT NULL REFERENCES procesos(ocid),
  fecha     TEXT,
  monto     REAL,
  moneda    TEXT,
  monto_pen REAL
);
CREATE INDEX IF NOT EXISTS ix_adj_ocid ON adjudicaciones(ocid);

CREATE TABLE IF NOT EXISTS adjudicacion_ruc (
  adjudicacion_id TEXT NOT NULL REFERENCES adjudicaciones(id),
  ruc             TEXT NOT NULL,
  nombre          TEXT NOT NULL,
  PRIMARY KEY (adjudicacion_id, ruc)
);

CREATE TABLE IF NOT EXISTS contratos (
  id        TEXT PRIMARY KEY,
  ocid      TEXT NOT NULL REFERENCES procesos(ocid),
  award_id  TEXT,
  titulo    TEXT,
  firmado   TEXT,
  inicio    TEXT,
  fin       TEXT,
  monto     REAL,
  moneda    TEXT,
  monto_pen REAL
);
CREATE INDEX IF NOT EXISTS ix_con_ocid ON contratos(ocid);

CREATE TABLE IF NOT EXISTS documentos (
  id        TEXT,
  ocid      TEXT NOT NULL REFERENCES procesos(ocid),
  tipo      TEXT,                   -- biddingDocuments | clarifications | awardNotice | evaluationReports
  titulo    TEXT,
  url       TEXT,
  formato   TEXT,
  publicado TEXT
);
CREATE INDEX IF NOT EXISTS ix_doc_ocid ON documentos(ocid);
CREATE INDEX IF NOT EXISTS ix_doc_tipo ON documentos(tipo);

-- Índice de proveedores/postores, derivado de la tabla actores. Existe por
-- rendimiento: un LIKE '%texto%' sobre sus 1,7 M de filas tarda ~8 s; aquí son
-- ~170 k filas con índice de texto y baja a milisegundos.
CREATE TABLE IF NOT EXISTS proveedores (
  ruc         TEXT PRIMARY KEY,
  nombre      TEXT NOT NULL,
  nombre_norm TEXT NOT NULL,
  procesos    INTEGER NOT NULL,   -- en cuántos se presentó
  ganados     INTEGER NOT NULL,   -- en cuántos fue adjudicado
  ultimo      TEXT                -- fecha del proceso más reciente
);
CREATE INDEX IF NOT EXISTS ix_prov_norm ON proveedores(nombre_norm);
CREATE INDEX IF NOT EXISTS ix_prov_proc ON proveedores(procesos DESC);

-- Búsqueda de texto. 'remove_diacritics 2' hace en el motor lo que fold() hacía a
-- mano, así que "migración" y "migracion" son la misma consulta.
CREATE VIRTUAL TABLE IF NOT EXISTS procesos_fts USING fts5(
  ocid UNINDEXED,
  descripcion,
  nomenclatura,
  items,
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE VIRTUAL TABLE IF NOT EXISTS proveedores_fts USING fts5(
  ruc UNINDEXED,
  nombre,
  tokenize = "unicode61 remove_diacritics 2"
);
`;

/** Abre datos.db (creándola si hace falta) con el esquema aplicado. */
export function abrirDatos({ soloLectura = false } = {}) {
  mkdirSync(dirname(DATOS_DB), { recursive: true });
  const db = new Database(DATOS_DB, { readonly: soloLectura });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  if (!soloLectura) {
    db.pragma('synchronous = NORMAL');
    db.exec(ESQUEMA);
    db.prepare('INSERT OR REPLACE INTO meta (clave, valor) VALUES (?, ?)')
      .run('esquema_version', String(ESQUEMA_VERSION));
  }
  return db;
}

/** Meses ya ingestados → Map('YYYY-MM' → fila). */
export function mesesIngestados(db) {
  return new Map(db.prepare('SELECT * FROM meses').all().map((r) => [r.mes, r]));
}
