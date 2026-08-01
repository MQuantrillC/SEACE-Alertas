// Persistencia mínima de alertas (por filtros) y seguimientos (por proceso) —
// JSON en la raíz del proyecto (gitignored: contienen correos). Compartida por
// el server y el runner.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function cargar(file) {
  const p = join(ROOT, file);
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    console.warn(`⚠ ${file} ilegible — se trata como vacío.`);
    return [];
  }
}
const guardar = (file, data) => writeFileSync(join(ROOT, file), JSON.stringify(data, null, 2), 'utf8');

export const cargarAlertas = () => cargar('alertas.json');
export const guardarAlertas = (a) => guardar('alertas.json', a);
export const cargarSeguimientos = () => cargar('seguimientos.json');
export const guardarSeguimientos = (s) => guardar('seguimientos.json', s);
