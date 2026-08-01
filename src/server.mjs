// ──────────────────────────────────────────────────────────────────────────────
// Buscador local de licitaciones SEACE — `npm run web` → http://localhost:4321
// Busca sobre los archivos mensuales del OECE (src/bulk.mjs). Filtros: periodo
// (presets o rango de calendario), categoría, método, entidad, departamento,
// estado, bandas de monto, solo-TI y con-adjudicación. Además gestiona las
// ALERTAS por correo (alertas.json) que ejecuta `npm run alertas`.
// ──────────────────────────────────────────────────────────────────────────────

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadRecentMonths } from './bulk.mjs';
import { aplicarFiltros, mesesParaCubrir, MONTO_RANGOS } from './search.mjs';
import { normalize } from './seace.mjs';
import { fold } from './digest.mjs';
import { cargarAlertas, guardarAlertas, cargarSeguimientos, guardarSeguimientos } from './alertasStore.mjs';

const OECE = 'https://contratacionesabiertas.oece.gob.pe';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4321);
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));

// Cache en memoria por nº de meses cargados (el disco ya cachea las descargas;
// esto evita re-parsear 10-30 MB de JSON en cada tecleo).
const memCache = new Map(); // nMeses → { at, procesos }
const MEM_TTL_MS = 30 * 60 * 1000;

async function getProcesos(nMeses) {
  const hit = memCache.get(nMeses);
  if (hit && Date.now() - hit.at < MEM_TTL_MS) return hit.procesos;
  const procesos = await loadRecentMonths(nMeses, { onProgress: (msg) => console.log('   ' + msg) });
  memCache.set(nMeses, { at: Date.now(), procesos });
  return procesos;
}

// Catálogo de entidades del OECE (buyers.json, ~3.3k) — cacheado 24 h en memoria.
let _entidades = null;
let _entidadesAt = 0;
async function getEntidades() {
  if (_entidades && Date.now() - _entidadesAt < 24 * 60 * 60 * 1000) return _entidades;
  const r = await fetch(`${OECE}/static/buyers.json`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`buyers.json HTTP ${r.status}`);
  const data = await r.json();
  _entidades = Object.entries(data).map(([id, nombre]) => ({ id, nombre: String(nombre) }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
  _entidadesAt = Date.now();
  return _entidades;
}

// query params → objeto de filtros de aplicarFiltros()
function filtrosDeQuery(sp) {
  const csv = (k) => (sp.get(k) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    q: sp.get('q') ?? '',
    categoria: sp.get('categoria') ?? '',
    metodo: sp.get('metodo') ?? '',
    entidad: sp.get('entidad') ?? '',
    soloTI: sp.get('soloTI') === '1',
    conAdjudicacion: sp.get('conAdjudicacion') === '1',
    desde: sp.get('desde') || null,
    hasta: sp.get('hasta') || null,
    montoRangos: csv('montoRangos'),
    departamentos: csv('departamentos'),
    estados: csv('estados'),
  };
}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const leerBody = (req) => new Promise((resolve, reject) => {
  let buf = '';
  req.on('data', (d) => { buf += d; if (buf.length > 100_000) reject(new Error('body demasiado grande')); });
  req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(ROOT, 'web', 'index.html')));
      return;
    }

    if (url.pathname === '/api/buscar' && req.method === 'GET') {
      const filtros = filtrosDeQuery(url.searchParams);
      const procesos = await getProcesos(mesesParaCubrir(filtros.desde));
      const resultados = aplicarFiltros(procesos, filtros, config);
      json(res, 200, {
        total: resultados.length,
        universo: procesos.length,
        resultados: resultados.slice(0, 150),
        truncado: resultados.length > 150,
      });
      return;
    }

    if (url.pathname === '/entidad' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(ROOT, 'web', 'entidad.html')));
      return;
    }

    // ── Catálogo de entidades (buyers.json del OECE, cacheado 24 h) ──
    if (url.pathname === '/api/entidades' && req.method === 'GET') {
      json(res, 200, { entidades: await getEntidades() });
      return;
    }

    // ── Historial de compras de una entidad (buyerProcesses + buyerContracts) ──
    if (url.pathname === '/api/entidad' && req.method === 'GET') {
      const idParam = (url.searchParams.get('id') ?? '').trim();
      const nombreParam = (url.searchParams.get('nombre') ?? '').trim();
      const entidades = await getEntidades();
      let ent = idParam ? entidades.find((e) => e.id === idParam) : null;
      if (!ent && nombreParam) {
        const objetivo = fold(nombreParam);
        ent = entidades.find((e) => fold(e.nombre) === objetivo) ??
              entidades.find((e) => fold(e.nombre).includes(objetivo));
      }
      if (!ent) { json(res, 404, { error: 'Entidad no encontrada en el catálogo del OECE' }); return; }

      // OJO parámetros (reverse-engineered del portal): el id va en `buyerID`
      // (con `buyer` la API ignora el filtro y devuelve TODO el dataset), y los
      // procesos se ordenan con `order_processes_date=desc`. Los contratos no
      // aceptan orden — se toma la primera página como muestra y se ordena aquí.
      const traer = async (ep, extra) => {
        const r = await fetch(`${OECE}/api/v1/${ep}?format=json&buyerID=${encodeURIComponent(ent.id)}&page=1&paginateBy=50${extra}`,
          { headers: { accept: 'application/json' } });
        if (!r.ok) return { results: [], pagination: null };
        return r.json();
      };
      const [pr, ct] = await Promise.all([
        traer('buyerProcesses', '&order_processes_date=desc'),
        traer('buyerContracts', ''),
      ]);

      const procesos = (pr.results ?? []).map((x) => normalize(x.compiledRelease ?? x));
      const contratos = (ct.results ?? []).map((c) => ({
        titulo: [c.title, c.description].filter(Boolean).join(' — ') || '(sin título)',
        firmado: c.dateSigned ?? c.contractDate ?? null,
        monto: c.value?.amount ?? 0,
        moneda: c.value?.currency ?? 'PEN',
        inicio: c.period?.startDate ?? null,
        fin: c.period?.endDate ?? null,
        proveedores: (c.suppliers ?? []).map((s) => s.name ?? s).filter(Boolean),
      })).sort((a, b) => new Date(b.firmado ?? 0) - new Date(a.firmado ?? 0));

      json(res, 200, {
        entidad: ent.nombre,
        id: ent.id,
        totalProcesos: pr.pagination?.total_results ?? procesos.length,
        totalContratos: ct.pagination?.total_results ?? contratos.length,
        procesos: procesos.slice(0, 50),
        contratos: contratos.slice(0, 50),
        nota: 'Procesos: los 50 más recientes. Contratos: muestra de 50 (la API del OECE no permite ordenarlos; el total real está en totalContratos).',
      });
      return;
    }

    // ── Estadísticas sobre los procesos que pasan los filtros actuales ──
    if (url.pathname === '/api/stats' && req.method === 'GET') {
      const filtros = filtrosDeQuery(url.searchParams);
      const procesos = await getProcesos(mesesParaCubrir(filtros.desde));
      const sel = aplicarFiltros(procesos, filtros, config);

      const top = (map, n = 10) => [...map.entries()].sort((a, b) => b[1].monto - a[1].monto || b[1].n - a[1].n)
        .slice(0, n).map(([k, v]) => ({ nombre: k, monto: Math.round(v.monto), procesos: v.n }));
      const acc = () => new Map();
      const add = (m, k, monto) => {
        if (!k) return;
        const e = m.get(k) ?? { monto: 0, n: 0 };
        e.monto += monto; e.n += 1; m.set(k, e);
      };

      const porEntidad = acc(), porProveedor = acc(), porCategoria = acc(), porDepartamento = acc(), porMes = acc();
      let montoTotal = 0, conMonto = 0;
      for (const p of sel) {
        const m = p.monto > 0 ? p.monto : 0;
        if (m > 0) { montoTotal += m; conMonto++; }
        add(porEntidad, p.entidad, m);
        // Proveedores: monto ADJUDICADO real de cada award (no el referencial del
        // proceso — un proceso multi-award repartiría su total a cada ganador).
        for (const adj of p.adjudicaciones ?? []) {
          const provs = adj.proveedores ?? [];
          const cuota = provs.length > 0 ? (adj.monto ?? 0) / provs.length : 0;
          for (const prov of provs) add(porProveedor, prov, cuota);
        }
        add(porCategoria, p.categoria, m);
        add(porDepartamento, p.departamento, m);
        add(porMes, (p.fecha ?? '').slice(0, 7), m);
      }
      json(res, 200, {
        procesos: sel.length,
        montoTotal: Math.round(montoTotal),
        procesosConMonto: conMonto,
        topEntidades: top(porEntidad),
        topProveedores: top(porProveedor),
        porCategoria: top(porCategoria, 8),
        porDepartamento: top(porDepartamento, 26),
        porMes: [...porMes.entries()].sort().map(([k, v]) => ({ nombre: k, monto: Math.round(v.monto), procesos: v.n })),
      });
      return;
    }

    // ── Seguimientos por proceso (🔔 en una tarjeta) ──
    if (url.pathname === '/api/seguimientos' && req.method === 'GET') {
      const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
      json(res, 200, { seguimientos: cargarSeguimientos().filter((s) => !email || s.emails.includes(email)) });
      return;
    }

    if (url.pathname === '/api/seguimientos' && req.method === 'POST') {
      const body = await leerBody(req);
      const emails = [...new Set(String(body.emails ?? body.email ?? '').split(',').concat(Array.isArray(body.emails) ? body.emails : [])
        .map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
      if (emails.length === 0 || emails.some((e) => !EMAIL_RE.test(e))) {
        json(res, 400, { error: 'Hay un correo inválido (sepáralos por coma)' }); return;
      }
      const ocid = String(body.ocid ?? '').trim();
      if (!ocid) { json(res, 400, { error: 'Falta el ocid del proceso' }); return; }
      const seguimientos = cargarSeguimientos();
      if (seguimientos.some((s) => s.ocid === ocid && emails.every((e) => s.emails.includes(e)))) {
        json(res, 200, { ok: true, yaExistia: true }); return;
      }
      const seg = {
        id: randomUUID(),
        ocid,
        emails,
        titulo: String(body.titulo ?? '').slice(0, 140),
        entidad: String(body.entidad ?? '').slice(0, 120),
        creadaEl: new Date().toISOString(),
        // Snapshot para detectar cambios (estados/adjudicación/cierre) en cada corrida.
        snapshot: {
          estados: Array.isArray(body.estados) ? body.estados : [],
          proveedores: Array.isArray(body.proveedores) ? body.proveedores : [],
          cierreOfertas: body.cierreOfertas ?? null,
        },
      };
      seguimientos.push(seg);
      guardarSeguimientos(seguimientos);
      json(res, 200, { ok: true, seguimiento: seg });
      return;
    }

    if (url.pathname === '/api/seguimientos' && req.method === 'DELETE') {
      const id = url.searchParams.get('id') ?? '';
      const seguimientos = cargarSeguimientos();
      const next = seguimientos.filter((s) => s.id !== id);
      guardarSeguimientos(next);
      json(res, 200, { ok: true, borrado: seguimientos.length !== next.length });
      return;
    }

    // ── Inspector de la ficha del SEACE ──
    // GET /api/ficha?id=<GUID o número>  (acepta pegar "…&ptoRetorno=LOCAL")
    // Trae la página de fichaSeleccion con ese id y devuelve TODO lo que el
    // servidor del SEACE responde: status, título, formularios, inputs ocultos,
    // tablas y texto visible. Sirve para comprobar qué expone realmente esa
    // página fuera de una sesión del buscador (spoiler: el esqueleto sin datos —
    // la ficha carga sus datos desde la SESIÓN de navegación del buscador).
    if (url.pathname === '/api/ficha' && req.method === 'GET') {
      const rawId = (url.searchParams.get('id') ?? '').trim();
      const id = rawId.split('&')[0].trim();
      if (!id) { json(res, 400, { error: 'Falta ?id= (GUID o número de la ficha)' }); return; }
      const target = `https://prod2.seace.gob.pe/seacebus-uiwd-pub/fichaSeleccion/fichaSeleccion.xhtml?id=${encodeURIComponent(id)}&ptoRetorno=LOCAL`;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      let r, html;
      try {
        r = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; seace-alertas/1.0)' }, signal: ctrl.signal });
        html = await r.text();
      } finally {
        clearTimeout(timer);
      }

      const strip = (s) => s
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, '\n')
        .replace(/&nbsp;/g, ' ')
        .replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í')
        .replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&ntilde;/g, 'ñ')
        .replace(/[ \t]+/g, ' ')
        .split('\n').map((l) => l.trim()).filter(Boolean);

      // Tablas → filas → celdas (texto plano)
      const tablas = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].slice(0, 30).map((m) => {
        const filas = [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].slice(0, 25).map((tr) =>
          [...tr[0].matchAll(/<t[hd][\s\S]*?<\/t[hd]>/gi)].map((td) => strip(td[0]).join(' ').trim()).filter(Boolean)
        ).filter((f) => f.length > 0);
        return filas;
      }).filter((t) => t.length > 0);

      json(res, 200, {
        urlConsultada: target,
        http: { status: r.status, contentType: r.headers.get('content-type'), bytes: html.length },
        titulo: (html.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? null,
        esPaginaDeError: /pagina no encontrada/i.test(html),
        formularios: [...html.matchAll(/<form[^>]*id="([^"]+)"/g)].map((m) => m[1]),
        inputsOcultos: [...html.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)]
          .slice(0, 20).map((m) => ({ name: m[1], value: m[2].slice(0, 80) })),
        tablas,
        textoVisible: strip(html).slice(0, 400),
        nota: 'Si "tablas" y "textoVisible" no muestran datos del proceso, es porque la ficha del SEACE carga sus datos desde la sesión del buscador (el id solo no basta fuera de esa sesión).',
      });
      return;
    }

    // ── Alertas por correo ──
    if (url.pathname === '/api/alertas' && req.method === 'GET') {
      const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
      const alertas = cargarAlertas().filter((a) => (a.emails ?? [a.email]).includes(email));
      json(res, 200, { alertas });
      return;
    }

    if (url.pathname === '/api/alertas' && req.method === 'POST') {
      const body = await leerBody(req);
      // Uno o varios correos: "a@x.com, b@x.com" o ["a@x.com","b@x.com"].
      const emails = [...new Set(
        (Array.isArray(body.emails) ? body.emails : String(body.email ?? body.emails ?? '').split(','))
          .map((e) => String(e).trim().toLowerCase())
          .filter(Boolean)
      )];
      if (emails.length === 0 || emails.some((e) => !EMAIL_RE.test(e))) {
        json(res, 400, { error: 'Hay un correo inválido (sepáralos por coma)' }); return;
      }
      if (emails.length > 20) { json(res, 400, { error: 'Máximo 20 correos por alerta' }); return; }
      const alertas = cargarAlertas();
      if (alertas.filter((a) => (a.emails ?? [a.email]).includes(emails[0])).length >= 10) {
        json(res, 400, { error: 'Máximo 10 alertas por correo' }); return;
      }
      const alerta = {
        id: randomUUID(),
        emails,
        nombre: String(body.nombre ?? '').slice(0, 80) || 'Alerta SEACE',
        filtros: { ...(body.filtros ?? {}), desde: null, hasta: null }, // el periodo lo pone el runner
        creadaEl: new Date().toISOString(),
        // El runner solo envía procesos publicados DESPUÉS de este corte.
        ultimaFecha: new Date().toISOString(),
      };
      alertas.push(alerta);
      guardarAlertas(alertas);
      json(res, 200, { ok: true, alerta });
      return;
    }

    if (url.pathname === '/api/alertas' && req.method === 'DELETE') {
      const id = url.searchParams.get('id') ?? '';
      const alertas = cargarAlertas();
      const next = alertas.filter((a) => a.id !== id);
      guardarAlertas(next);
      json(res, 200, { ok: true, borrada: alertas.length !== next.length });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('No encontrado');
  } catch (err) {
    console.error(`Error en ${url.pathname}:`, err);
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`🔎 Buscador SEACE → http://localhost:${PORT}`);
  console.log('   (la primera búsqueda de cada rango descarga los archivos mensuales del OECE — luego es instantáneo)');
});
