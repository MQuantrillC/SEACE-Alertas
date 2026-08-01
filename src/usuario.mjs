// ──────────────────────────────────────────────────────────────────────────────
// Gestión de cuentas desde la terminal — `npm run usuario`
//
// El registro por web está cerrado, así que esta es la puerta de entrada del
// primer usuario. A partir de ahí, la gente entra por invitación.
//
//   npm run usuario -- --listar
//   npm run usuario -- --crear ana@estudio.pe --nombre "Ana Pérez" --estudio "Estudio Legal X"
//   npm run usuario -- --enlace ana@estudio.pe      (genera un acceso sin enviar correo)
//   npm run usuario -- --desactivar ana@estudio.pe
//   npm run usuario -- --activar ana@estudio.pe
// ──────────────────────────────────────────────────────────────────────────────

import { abrirCuentas, crearUsuario, crearEstudio, buscarUsuarioPorEmail, normEmail, limpiar } from './cuentas.mjs';
import { solicitarAcceso, enlaceAcceso } from './auth.mjs';

const args = process.argv.slice(2);
const val = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
const tiene = (n) => args.includes('--' + n);

const db = abrirCuentas();

function listar() {
  const filas = db.prepare(`
    SELECT u.id, u.email, u.nombre, u.activo, u.creado, u.ultimo_acceso, e.nombre AS estudio,
      (SELECT count(*) FROM alertas a WHERE a.propietario_id = u.id) AS alertas
    FROM usuarios u LEFT JOIN estudios e ON e.id = u.estudio_id ORDER BY u.creado`).all();
  if (filas.length === 0) {
    console.log('\nNo hay usuarios todavía. Crea el primero:');
    console.log('  npm run usuario -- --crear tu@correo.pe --nombre "Tu Nombre" --estudio "Tu Estudio"\n');
    return;
  }
  console.log(`\n${filas.length} usuario(s):\n`);
  for (const u of filas) {
    console.log(`  ${u.activo ? '●' : '○'} ${u.email.padEnd(32)} ${(u.nombre ?? '—').padEnd(20)} ` +
      `${(u.estudio ?? 'sin estudio').padEnd(24)} ${u.alertas} alerta(s)` +
      `${u.ultimo_acceso ? ' · último acceso ' + u.ultimo_acceso.slice(0, 16).replace('T', ' ') : ' · nunca entró'}`);
  }
  console.log('');
}

if (tiene('listar') || args.length === 0) {
  listar();
} else if (tiene('crear')) {
  const email = normEmail(val('crear'));
  const nombreEstudio = val('estudio');
  let estudioId = null;
  if (nombreEstudio) {
    const ya = db.prepare('SELECT * FROM estudios WHERE nombre = ?').get(nombreEstudio);
    estudioId = (ya ?? crearEstudio(db, nombreEstudio)).id;
  }
  const antes = buscarUsuarioPorEmail(db, email);
  const u = crearUsuario(db, { email, nombre: val('nombre'), estudioId });
  if (antes) {
    console.log(`\n· ${u.email} ya existía (id ${u.id}). Sin cambios.\n`);
  } else {
    console.log(`\n✔ Usuario creado: ${u.email} (id ${u.id})${nombreEstudio ? ` · estudio "${nombreEstudio}"` : ''}`);
    console.log(`  Genera su enlace de acceso con:  npm run usuario -- --enlace ${u.email}\n`);
  }
} else if (tiene('enlace')) {
  const email = normEmail(val('enlace'));
  const r = solicitarAcceso(db, email);
  if (!r.ok) { console.error(`\n✘ ${r.error}\n`); process.exit(1); }
  if (!r.token) {
    console.error(`\n✘ ${email} no tiene cuenta. Créala primero con --crear.\n`);
    process.exit(1);
  }
  console.log(`\n✔ Enlace de acceso para ${email} (vale ${r.minutos} minutos, un solo uso):\n`);
  console.log(`   ${enlaceAcceso(r.token)}\n`);
  console.log('  Pégalo en el navegador. No se envió ningún correo.\n');
} else if (tiene('desactivar') || tiene('activar')) {
  const activar = tiene('activar');
  const email = normEmail(val(activar ? 'activar' : 'desactivar'));
  const u = buscarUsuarioPorEmail(db, email);
  if (!u) { console.error(`\n✘ No existe ${email}\n`); process.exit(1); }
  db.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(activar ? 1 : 0, u.id);
  if (!activar) db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(u.id);
  console.log(`\n✔ ${email} ${activar ? 'activado' : 'desactivado (y sus sesiones cerradas)'}\n`);
} else if (tiene('limpiar')) {
  const r = limpiar(db);
  console.log(`\n✔ Purgados ${r.tokens} token(s) y ${r.sesiones} sesión(es) caducadas.\n`);
} else {
  console.log('\nOpciones: --listar · --crear <email> [--nombre N] [--estudio E] · --enlace <email> · --activar/--desactivar <email> · --limpiar\n');
}

db.close();
