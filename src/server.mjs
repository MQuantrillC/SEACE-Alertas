// ──────────────────────────────────────────────────────────────────────────────
// Servidor de SEACE Alertas — `npm run web` → http://localhost:4321
//
// Lee de datos.db (procesos, reconstruible) y cuentas.db (usuarios, irreemplazable).
// Requiere sesión para todo salvo la pantalla de acceso y los enlaces de correo.
//
// Sustituye al servidor anterior, que filtraba en memoria sobre los JSON mensuales.
// ──────────────────────────────────────────────────────────────────────────────

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirDatos, DATOS_DB } from './db.mjs';
import { abrirCuentas, ahora } from './cuentas.mjs';
import {
  buscar, buscarEntidades, buscarProveedores, facetas, estadisticas,
  proximosVencimientos, hoyLima,
} from './buscar.mjs';
import {
  solicitarAcceso, canjearAcceso, responderInvitacion, cerrarSesion,
  usuarioDeSesion, leerCookie, cookieSesion, enlaceAcceso, COOKIE,
} from './auth.mjs';
import { enviarAcceso } from './correosAuth.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4321);
const WEB = join(ROOT, 'web');

if (!existsSync(DATOS_DB)) {
  console.error('\n✘ No existe datos/datos.db. Créala primero con:\n\n    npm run ingesta\n');
  process.exit(1);
}

const datos = abrirDatos({ soloLectura: true });
const cuentas = abrirCuentas();
const siglas = JSON.parse(readFileSync(join(ROOT, 'siglas.json'), 'utf8'));

// Las facetas cambian solo cuando hay ingesta nueva; se calculan una vez.
let _facetas = null;
const getFacetas = () => (_facetas ??= facetas(datos));

// ── Utilidades HTTP ───────────────────────────────────────────────────────────

const json = (res, code, cuerpo, cabeceras = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...cabeceras });
  res.end(JSON.stringify(cuerpo));
};

const TIPOS = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
function servirArchivo(res, nombre, cabeceras = {}) {
  const ruta = join(WEB, nombre);
  if (!ruta.startsWith(WEB) || !existsSync(ruta)) { res.writeHead(404); res.end('No encontrado'); return; }
  res.writeHead(200, { 'Content-Type': `${TIPOS[extname(ruta)] ?? 'text/plain'}; charset=utf-8`, ...cabeceras });
  res.end(readFileSync(ruta));
}

const leerBody = (req) => new Promise((resolve, reject) => {
  let buf = '';
  req.on('data', (d) => { buf += d; if (buf.length > 100_000) reject(new Error('Cuerpo demasiado grande')); });
  req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new Error('JSON inválido')); } });
});

/** Página mínima para los enlaces de correo (aciertos y errores). */
const paginaAviso = (titulo, mensaje, { enlace = '/', textoEnlace = 'Ir al buscador' } = {}) => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>${titulo}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#f3f4f6;margin:0;display:flex;
min-height:100vh;align-items:center;justify-content:center;padding:20px}
.c{background:#fff;border-radius:12px;padding:36px 40px;max-width:460px;text-align:center;
box-shadow:0 4px 20px rgba(0,0,0,.06);border-top:4px solid #FF4DA6}
h1{color:#047EA9;font-size:19px;margin:0 0 12px}p{color:#374151;font-size:14px;line-height:1.6;margin:0 0 22px}
a{display:inline-block;background:#047EA9;color:#fff;padding:11px 24px;border-radius:8px;
text-decoration:none;font-size:14px;font-weight:bold}</style></head>
<body><div class="c"><h1>${titulo}</h1><p>${mensaje}</p><a href="${enlace}">${textoEnlace}</a></div></body></html>`;

// ── Lectura de filtros desde la query ─────────────────────────────────────────

function filtrosDeQuery(sp) {
  const csv = (k) => (sp.get(k) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    entidades: csv('entidades'),
    objeto: sp.get('objeto') ?? '',
    proveedor: sp.get('proveedor') ?? '',
    desde: sp.get('desde') || null,
    hasta: sp.get('hasta') || null,
    categorias: csv('categorias'),
    metodos: csv('metodos'),
    estados: csv('estados'),
    departamentos: csv('departamentos'),
    montos: csv('montos'),
    conAdjudicacion: sp.get('conAdjudicacion') === '1',
    soloUnPostor: sp.get('soloUnPostor') === '1',
  };
}

// Rutas que no exigen sesión.
const PUBLICAS = new Set(['/entrar', '/acceso', '/invitacion', '/api/acceso', '/app.css', '/app.js']);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const ruta = url.pathname;

  try {
    const sesion = leerCookie(req, COOKIE);
    const usuario = usuarioDeSesion(cuentas, sesion);

    // ── Acceso ────────────────────────────────────────────────────────────────

    if (ruta === '/entrar' && req.method === 'GET') {
      if (usuario) { res.writeHead(302, { Location: '/' }); res.end(); return; }
      servirArchivo(res, 'entrar.html');
      return;
    }

    if (ruta === '/api/acceso' && req.method === 'POST') {
      const { email } = await leerBody(req);
      const r = solicitarAcceso(cuentas, email);
      if (!r.ok) { json(res, 429, { error: r.error }); return; }
      if (r.token) {
        const enlace = enlaceAcceso(r.token);
        const enviado = await enviarAcceso(r.usuario.email, { enlace, minutos: r.minutos });
        // Sin SMTP configurado el enlace se imprime en consola: así se puede
        // trabajar en local sin montar correo. Nunca se devuelve al navegador.
        if (!enviado) console.log(`\n🔑 Enlace de acceso para ${r.usuario.email}:\n   ${enlace}\n`);
      }
      json(res, 200, { mensaje: r.mensaje });
      return;
    }

    if (ruta === '/acceso' && req.method === 'GET') {
      const r = canjearAcceso(cuentas, url.searchParams.get('token'));
      if (!r.ok) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(paginaAviso('Enlace no válido', r.error, { enlace: '/entrar', textoEnlace: 'Pedir uno nuevo' }));
        return;
      }
      res.writeHead(302, { Location: '/', 'Set-Cookie': cookieSesion(r.sesion) });
      res.end();
      return;
    }

    if (ruta === '/invitacion' && req.method === 'GET') {
      const acepta = url.searchParams.get('respuesta') !== 'no';
      const r = responderInvitacion(cuentas, url.searchParams.get('token'), acepta);
      if (!r.ok) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(paginaAviso('Invitación no válida', r.error, { enlace: '/entrar', textoEnlace: 'Ir al acceso' }));
        return;
      }
      if (!r.aceptada) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(paginaAviso('Invitación rechazada',
          'No recibirás correos de esta alerta. Puedes cerrar esta página.',
          { enlace: '/entrar', textoEnlace: 'Entrar de todos modos' }));
        return;
      }
      res.writeHead(302, { Location: '/?alerta=' + r.alertaId, 'Set-Cookie': cookieSesion(r.sesion) });
      res.end();
      return;
    }

    if (ruta === '/api/salir' && req.method === 'POST') {
      cerrarSesion(cuentas, sesion);
      json(res, 200, { ok: true }, { 'Set-Cookie': cookieSesion('', { borrar: true }) });
      return;
    }

    // ── A partir de aquí hace falta sesión ────────────────────────────────────

    if (!usuario && !PUBLICAS.has(ruta)) {
      if (ruta.startsWith('/api/')) { json(res, 401, { error: 'Necesitas iniciar sesión.' }); return; }
      res.writeHead(302, { Location: '/entrar' }); res.end();
      return;
    }

    if (ruta === '/' && req.method === 'GET') { servirArchivo(res, 'app.html'); return; }
    if (ruta === '/app.css' || ruta === '/app.js') { servirArchivo(res, ruta.slice(1)); return; }

    if (ruta === '/api/yo' && req.method === 'GET') {
      const estudio = usuario.estudio_id
        ? cuentas.prepare('SELECT nombre FROM estudios WHERE id = ?').get(usuario.estudio_id)?.nombre
        : null;
      json(res, 200, {
        usuario: { id: usuario.id, email: usuario.email, nombre: usuario.nombre, estudio },
        facetas: getFacetas(),
        hoy: hoyLima(),
      });
      return;
    }

    // ── Búsqueda ──────────────────────────────────────────────────────────────

    if (ruta === '/api/buscar' && req.method === 'GET') {
      const t0 = Date.now();
      const r = buscar(datos, filtrosDeQuery(url.searchParams), {
        limite: Math.min(100, Number(url.searchParams.get('limite')) || 25),
        pagina: Math.max(1, Number(url.searchParams.get('pagina')) || 1),
        orden: url.searchParams.get('orden') ?? 'reciente',
      });
      json(res, 200, { ...r, ms: Date.now() - t0 });
      return;
    }

    if (ruta === '/api/entidades' && req.method === 'GET') {
      json(res, 200, { entidades: buscarEntidades(datos, url.searchParams.get('q') ?? '', { siglas, limite: 12 }) });
      return;
    }

    if (ruta === '/api/proveedores' && req.method === 'GET') {
      json(res, 200, { proveedores: buscarProveedores(datos, url.searchParams.get('q') ?? '', { limite: 12 }) });
      return;
    }

    if (ruta === '/api/estadisticas' && req.method === 'GET') {
      json(res, 200, estadisticas(datos, filtrosDeQuery(url.searchParams), {
        medida: url.searchParams.get('medida') === 'monto' ? 'monto' : 'procesos',
      }));
      return;
    }

    if (ruta === '/api/vencimientos' && req.method === 'GET') {
      const dias = Math.min(90, Number(url.searchParams.get('dias')) || 14);
      json(res, 200, { dias, vencimientos: proximosVencimientos(datos, filtrosDeQuery(url.searchParams), { dias }) });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
  } catch (err) {
    console.error(`Error en ${ruta}:`, err);
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  const n = datos.prepare('SELECT count(*) AS n FROM procesos').get().n;
  const u = cuentas.prepare('SELECT count(*) AS n FROM usuarios WHERE activo = 1').get().n;
  console.log(`\n🔎 SEACE Alertas → http://localhost:${PORT}`);
  console.log(`   ${n.toLocaleString('es-PE')} procesos · ${u} usuario(s) activo(s) · hoy en Lima ${hoyLima()}`);
  if (u === 0) console.log('   ⚠ No hay usuarios. Crea el primero: npm run usuario -- --crear tu@correo.pe');
  if (!process.env.SMTP_USER) console.log('   ℹ Sin SMTP: los enlaces de acceso se imprimen aquí en la consola.');
  console.log('');
});

for (const señal of ['SIGINT', 'SIGTERM']) {
  process.on(señal, () => { datos.close(); cuentas.close(); process.exit(0); });
}
