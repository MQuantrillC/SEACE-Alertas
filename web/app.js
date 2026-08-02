/* SEACE Alertas — lógica del buscador. Sin framework, sin dependencias. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Los 4 objetos de contratación del SEACE. 'consultoriaObra' no viene en el dato
// del OECE (que solo trae 3): se reconstruye en la ingesta — ver API.md §6.
const CATEGORIAS = {
  goods: 'Bienes',
  services: 'Servicios',
  works: 'Obras',
  consultoriaObra: 'Consultoría de obra',
};
const DOCS = {
  biddingDocuments: '📄 Bases',
  clarifications: '❓ Consultas y observaciones',
  awardNotice: '🏆 Buena pro',
  evaluationReports: '📋 Evaluación',
};
// Estados que a un estudio le interesan de inmediato: litigio o incidencia.
const ESTADOS_ALERTA = new Set(['APELADO', 'SUSPENDIDO', 'NULO', 'CANCELADO',
  'RETROTRAIDO_POR_RESOLUCION', 'DEJAR_SIN_EFECTO_ADJUDICACION']);

const estado = {
  entidades: [],        // [{id, nombre}]
  objeto: '',
  proveedor: '',
  pagina: 1,
  orden: 'reciente',
  stats: false,
  medida: 'procesos',
};
let facetas = null;
let hoy = new Date().toISOString().slice(0, 10);

// ── Formato ─────────────────────────────────────────────────────────────────

const fmtFecha = (v) => v
  ? new Date(v.slice(0, 10) + 'T12:00:00').toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' })
  : '—';
const fmtNum = (n) => Number(n || 0).toLocaleString('es-PE');
const fmtSoles = (n) => {
  if (!n || n <= 0) return null;
  if (n >= 1e9) return 'S/ ' + (n / 1e9).toFixed(1) + ' mil M';
  if (n >= 1e6) return 'S/ ' + (n / 1e6).toFixed(1) + ' M';
  if (n >= 1e3) return 'S/ ' + Math.round(n / 1e3) + ' mil';
  return 'S/ ' + Math.round(n);
};
const diasHasta = (iso) => Math.ceil((Date.parse(iso.slice(0, 10) + 'T00:00:00-05:00') - Date.parse(hoy + 'T00:00:00-05:00')) / 86400000);

// ── Desplegables con casillas ───────────────────────────────────────────────

/**
 * Desplegable de casillas. Todas marcadas de entrada = "sin filtrar".
 *
 * Convención (importa): si están TODAS marcadas no se manda el filtro al
 * servidor. No es lo mismo que mandar la lista entera — hay procesos sin
 * departamento o sin método, y enumerar todos los valores conocidos los dejaría
 * fuera sin que nadie entienda por qué. "Ninguno" sí es un estado real: cero
 * resultados a propósito, y se avisa en pantalla.
 */
function montarMulti(id, titulo, opciones) {
  const det = $(id);
  det.querySelector('.lista').innerHTML =
    `<div class="acciones">
       <button type="button" data-accion="todos">Todos</button>
       <button type="button" data-accion="ninguno">Ninguno</button>
     </div>` +
    opciones.map((o) =>
      `<label><input type="checkbox" value="${esc(o.valor)}" checked> <span>${esc(o.label)}</span>` +
      `${o.n != null ? `<span class="cuenta">${fmtNum(o.n)}</span>` : ''}</label>`).join('');

  det.addEventListener('change', () => { resumenMulti(det, titulo); estado.pagina = 1; buscar(); });
  for (const b of det.querySelectorAll('.acciones button')) {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const marcar = b.dataset.accion === 'todos';
      for (const c of det.querySelectorAll('input[type=checkbox]')) c.checked = marcar;
      resumenMulti(det, titulo);
      estado.pagina = 1;
      buscar();
    });
  }
  det.dataset.titulo = titulo;
  resumenMulti(det, titulo);
}

function resumenMulti(det, titulo) {
  const total = det.querySelectorAll('input[type=checkbox]').length;
  const n = det.querySelectorAll('input[type=checkbox]:checked').length;
  const s = det.querySelector('summary');
  s.textContent = n === total ? titulo : n === 0 ? `${titulo} (ninguno)` : `${titulo} (${n})`;
  s.classList.toggle('filtrado', n !== total);
}

/** → { valores, todos, ninguno } */
function valoresMulti(id) {
  const cbs = [...$(id).querySelectorAll('input[type=checkbox]')];
  const valores = cbs.filter((c) => c.checked).map((c) => c.value);
  return { valores, todos: valores.length === cbs.length, ninguno: valores.length === 0 };
}

/** Restaura desde la URL. Sin valores en la URL ⇒ todas marcadas. */
function fijarMulti(id, valores, titulo) {
  const cbs = [...$(id).querySelectorAll('input[type=checkbox]')];
  const set = new Set(valores);
  for (const c of cbs) c.checked = set.size === 0 ? true : set.has(c.value);
  resumenMulti($(id), titulo);
}

document.addEventListener('click', (e) => {
  for (const d of document.querySelectorAll('details.multi')) if (!d.contains(e.target)) d.open = false;
  for (const s of document.querySelectorAll('.sugerencias')) {
    if (!s.parentElement.contains(e.target)) s.hidden = true;
  }
});

// ── Periodo ─────────────────────────────────────────────────────────────────

function fechas() {
  const v = $('periodo').value;
  if (v === 'custom') return { desde: $('desde').value || null, hasta: $('hasta').value || null };
  if (!v) return { desde: null, hasta: null };
  if (v === 'hoy') return { desde: hoy, hasta: null };
  // Fechas en hora de Lima: el servidor manda `hoy` ya calculado, así no depende
  // del reloj ni de la zona del navegador.
  const d = new Date(hoy + 'T00:00:00-05:00');
  d.setDate(d.getDate() - Number(v));
  return { desde: d.toISOString().slice(0, 10), hasta: null };
}

$('periodo').addEventListener('change', () => {
  $('rangoFechas').hidden = $('periodo').value !== 'custom';
  if ($('periodo').value !== 'custom') { estado.pagina = 1; buscar(); }
});
for (const id of ['desde', 'hasta']) $(id).addEventListener('change', () => { estado.pagina = 1; buscar(); });
for (const id of ['conAdjudicacion', 'soloUnPostor']) $(id).addEventListener('change', () => { estado.pagina = 1; buscar(); });

// ── Autocompletado ──────────────────────────────────────────────────────────

function autocompletar(inputId, cajaId, url, pintar, elegir) {
  const input = $(inputId), caja = $(cajaId);
  let timer;
  // Sin caché de "última consulta": guardarla ahorraba una petición de 10 ms pero
  // dejaba la lista oculta al volver a escribir lo mismo tras elegir algo.
  // Cada búsqueda lleva número: si llegan dos respuestas desordenadas, la vieja
  // no puede pisar a la nueva.
  let peticion = 0;

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { caja.hidden = true; return; }
    // "Buscando…" desde ya. Antes se veía "Sin coincidencias" durante el viaje de
    // ida y vuelta, que es decirle al usuario que no hay nada cuando aún no se sabe.
    caja.innerHTML = '<div class="vacio">Buscando…</div>';
    caja.hidden = false;
    timer = setTimeout(async () => {
      const mia = ++peticion;
      try {
        const r = await (await fetch(`${url}?q=${encodeURIComponent(q)}`)).json();
        if (mia !== peticion) return;              // llegó tarde: ya hay otra en curso
        const items = r.entidades ?? r.proveedores ?? [];
        caja.innerHTML = items.length
          ? items.map((x, i) => `<div data-i="${i}">${pintar(x)}</div>`).join('')
          : `<div class="vacio">Sin coincidencias para “${esc(q)}”</div>`;
        caja.hidden = false;
        caja.querySelectorAll('div[data-i]').forEach((el) => {
          el.addEventListener('click', () => { elegir(items[Number(el.dataset.i)]); caja.hidden = true; input.value = ''; });
        });
      } catch {
        if (mia === peticion) caja.innerHTML = '<div class="vacio">No se pudo consultar. Reintenta.</div>';
      }
    }, 180);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') caja.hidden = true; });
}

autocompletar('entidad', 'sugEntidad', '/api/entidades',
  (e) => `${e.sigla ? `<span class="sigla">${esc(e.sigla)}</span>` : ''}${esc(e.nombre)}` +
    `<div class="n">${fmtNum(e.procesos)} procesos${e.departamento ? ' · ' + esc(e.departamento) : ''}</div>`,
  (e) => {
    if (!estado.entidades.some((x) => x.id === e.id)) estado.entidades.push({ id: e.id, nombre: e.nombre });
    pintarFichas(); estado.pagina = 1; buscar();
  });

autocompletar('proveedor', 'sugProveedor', '/api/proveedores',
  (p) => `${esc(p.nombre)}<div class="n">RUC ${esc(p.ruc)} · ${fmtNum(p.procesos)} procesos · ${fmtNum(p.ganados)} ganados</div>`,
  (p) => { estado.proveedor = p.ruc; $('proveedor').value = `${p.nombre} (${p.ruc})`; estado.pagina = 1; buscar(); });

$('proveedor').addEventListener('input', () => {
  // Si el usuario reescribe a mano, deja de valer el RUC que había elegido.
  if (!$('proveedor').value.trim()) estado.proveedor = '';
});

function pintarFichas() {
  $('fichasEntidad').innerHTML = estado.entidades.map((e, i) =>
    `<span class="ficha">${esc(e.nombre)}<button data-i="${i}" title="Quitar">×</button></span>`).join('');
  $('fichasEntidad').querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      estado.entidades.splice(Number(b.dataset.i), 1);
      pintarFichas(); estado.pagina = 1; buscar();
    });
  });
}

// ── Filtros → parámetros ────────────────────────────────────────────────────

const MULTIS = [
  ['mCategoria', 'categorias', 'Categoría'],
  ['mEstado', 'estados', 'Estado'],
  ['mMonto', 'montos', 'Monto'],
  ['mDepartamento', 'departamentos', 'Departamento'],
  ['mMetodo', 'metodos', 'Método'],
];

/** Si algún desplegable está en "ninguno", devuelve su título. */
function filtroVacio() {
  for (const [id, , titulo] of MULTIS) if (valoresMulti(id).ninguno) return titulo;
  return null;
}

function parametros() {
  const { desde, hasta } = fechas();
  const p = new URLSearchParams();
  const poner = (k, v) => { if (v && v.length) p.set(k, Array.isArray(v) ? v.join(',') : v); };
  poner('entidades', estado.entidades.map((e) => e.id));
  poner('objeto', $('objeto').value.trim());
  poner('proveedor', estado.proveedor || $('proveedor').value.trim());
  poner('desde', desde); poner('hasta', hasta);
  for (const [id, clave] of MULTIS) {
    const m = valoresMulti(id);
    if (!m.todos) poner(clave, m.valores);   // "todos" ⇒ no se manda el filtro
  }
  if ($('conAdjudicacion').checked) p.set('conAdjudicacion', '1');
  if ($('soloUnPostor').checked) p.set('soloUnPostor', '1');
  return p;
}

/** Vuelca el estado a la barra de direcciones: los enlaces son compartibles
 *  entre los abogados del estudio, que es como trabajan de verdad. */
function guardarEnUrl() {
  const p = parametros();
  p.set('periodo', $('periodo').value);
  if (estado.pagina > 1) p.set('pagina', estado.pagina);
  if (estado.orden !== 'reciente') p.set('orden', estado.orden);
  if (estado.stats) p.set('stats', '1');
  if (estado.entidades.length) p.set('nombres', estado.entidades.map((e) => e.nombre).join('|'));
  history.replaceState(null, '', p.toString() ? '?' + p : location.pathname);
}

function leerDeUrl() {
  const p = new URLSearchParams(location.search);
  if (!p.toString()) return;
  const ids = (p.get('entidades') ?? '').split(',').filter(Boolean);
  const nombres = (p.get('nombres') ?? '').split('|');
  estado.entidades = ids.map((id, i) => ({ id, nombre: nombres[i] ?? id }));
  $('objeto').value = p.get('objeto') ?? '';
  estado.proveedor = p.get('proveedor') ?? '';
  if (estado.proveedor) $('proveedor').value = estado.proveedor;
  if (p.get('periodo') !== null) $('periodo').value = p.get('periodo');
  $('rangoFechas').hidden = $('periodo').value !== 'custom';
  $('desde').value = p.get('desde') ?? '';
  $('hasta').value = p.get('hasta') ?? '';
  $('conAdjudicacion').checked = p.get('conAdjudicacion') === '1';
  $('soloUnPostor').checked = p.get('soloUnPostor') === '1';
  estado.pagina = Number(p.get('pagina')) || 1;
  estado.orden = p.get('orden') ?? 'reciente';
  estado.stats = p.get('stats') === '1';
  return p;
}

// ── Tarjeta de resultado ────────────────────────────────────────────────────

function tarjeta(p) {
  const monto = p.monto_pen > 0 ? fmtSoles(p.monto_pen) : null;
  const extranjera = p.moneda !== 'PEN' && p.monto > 0;
  const vence = p.enquiry_fin ? diasHasta(p.enquiry_fin) : null;
  const docs = [...new Map((p.documentos ?? []).map((d) => [d.tipo, d])).values()];

  return `<div class="tarjeta">
    <div class="cab">
      <div style="min-width:0;">
        <div class="entidad">${esc(p.entidad ?? 'Entidad no especificada')}</div>
        <div class="titulo">${esc(p.descripcion || p.nomenclatura)}</div>
      </div>
      <div class="acciones">
        <button class="btn chico copiar" data-nom="${esc(p.nomenclatura)}"
          title="Copiar la nomenclatura para pegarla en el buscador del SEACE">Copiar nº</button>
      </div>
    </div>
    <div>
      <span class="etiqueta et-cat">${esc(CATEGORIAS[p.categoria] ?? p.categoria ?? 'Proceso')}</span>
      ${p.departamento ? `<span class="etiqueta et-dep">📍 ${esc(p.departamento)}</span>` : ''}
      ${(p.estados ?? []).map((e) => `<span class="etiqueta ${ESTADOS_ALERTA.has(e) ? 'et-alerta' : 'et-est'}">${esc(e)}</span>`).join('')}
      ${p.metodo ? `<span class="etiqueta et-met">${esc(p.metodo)}</span>` : ''}
      ${monto ? `<span class="etiqueta et-monto">${esc(monto)}</span>` : ''}
      ${extranjera && !monto ? `<span class="etiqueta et-met" title="El SEACE no publicó la conversión a soles">${esc(p.moneda)} ${fmtNum(Math.round(p.monto))}</span>` : ''}
      ${(p.proveedores ?? []).map((x) => `<span class="etiqueta et-gana" title="Adjudicado">🏆 ${esc(x.nombre)}</span>`).join('')}
    </div>
    <div class="meta">
      <span>📅 Publicado <b>${fmtFecha(p.fecha_dia)}</b></span>
      ${p.n_postores > 0 ? `<span>👥 <b>${p.n_postores}</b> postor${p.n_postores === 1 ? '' : 'es'}</span>` : ''}
      ${vence !== null && vence >= 0
      ? `<span title="Fin del plazo para consultas y observaciones">❓ Consultas hasta <b>${fmtFecha(p.enquiry_fin)}</b> ${vence === 0 ? '(hoy)' : `(en ${vence} día${vence === 1 ? '' : 's'})`}</span>`
      : ''}
      ${p.cierre_ofertas ? `<span>⏳ Cierre <b>${fmtFecha(p.cierre_ofertas)}</b></span>` : ''}
      <span class="nomen">${esc(p.nomenclatura)}</span>
    </div>
    ${docs.length ? `<div class="docs">${docs.map((d) =>
        `<a href="${esc(d.url)}" target="_blank" rel="noopener">${DOCS[d.tipo] ?? '📎 Documento'}</a>`).join('')}</div>` : ''}
  </div>`;
}

// ── Búsqueda ────────────────────────────────────────────────────────────────

let buscando = false;
async function buscar() {
  if (buscando) return;
  buscando = true;
  $('buscar').disabled = true;
  $('resumen').innerHTML = '<span class="cargando">Buscando…</span>';
  guardarEnUrl();

  // "Ninguno" en un desplegable no se consulta: por definición no hay nada que
  // encontrar, y decirlo es más útil que devolver una lista vacía sin motivo.
  const vacio = filtroVacio();
  if (vacio) {
    $('resumen').innerHTML = '<b>0</b> resultados';
    $('resultados').innerHTML = `<div class="vacio-msg">
      <b>Ningún valor seleccionado en “${esc(vacio)}”</b>
      <div class="sug">Con ese filtro en blanco no puede haber resultados.
      Abre <b>${esc(vacio)}</b> y pulsa <b>Todos</b> para restaurarlo.</div></div>`;
    $('paginacion').innerHTML = '';
    buscando = false; $('buscar').disabled = false;
    return;
  }

  try {
    const p = parametros();
    p.set('pagina', estado.pagina);
    p.set('orden', estado.orden);
    p.set('limite', '25');
    const j = await (await fetch('/api/buscar?' + p)).json();
    if (j.error) throw new Error(j.error);

    $('resumen').innerHTML = `
      <b>${fmtNum(j.total)}</b> ${j.total === 1 ? 'resultado' : 'resultados'}
      <span style="color:var(--tenue);">· ${j.ms} ms</span>
      <span class="der">
        <label style="font-size:12px;color:var(--suave);">Ordenar</label>
        <select id="orden">
          <option value="reciente">Más recientes</option>
          <option value="antiguo">Más antiguos</option>
          <option value="monto">Mayor monto</option>
          <option value="cierre">Próximos a cerrar</option>
        </select>
        <button class="btn" id="btnStats">📊 Estadísticas</button>
      </span>`;
    $('orden').value = estado.orden;
    $('orden').addEventListener('change', (e) => { estado.orden = e.target.value; estado.pagina = 1; buscar(); });
    $('btnStats').addEventListener('click', () => {
      estado.stats = !estado.stats;
      $('panelStats').hidden = !estado.stats;
      guardarEnUrl();
      if (estado.stats) cargarStats();
    });

    $('resultados').innerHTML = j.resultados.length
      ? j.resultados.map(tarjeta).join('')
      : mensajeVacio();
    for (const b of document.querySelectorAll('.copiar')) {
      b.addEventListener('click', async () => {
        await navigator.clipboard.writeText(b.dataset.nom);
        const antes = b.textContent;
        b.textContent = '✓ Copiado';
        setTimeout(() => { b.textContent = antes; }, 1400);
      });
    }
    pintarPaginacion(j);
    if (estado.stats) cargarStats();
  } catch (err) {
    $('resumen').innerHTML = '';
    $('resultados').innerHTML = `<div class="vacio-msg"><b>No se pudo buscar.</b><div class="sug">${esc(err.message)}</div></div>`;
  } finally {
    buscando = false;
    $('buscar').disabled = false;
  }
}

/** Nunca "0 resultados" a secas: siempre se explica qué filtro es el culpable
 *  probable y se ofrece una salida. */
function mensajeVacio() {
  const motivos = [];
  if (estado.entidades.length) motivos.push(`la${estado.entidades.length > 1 ? 's' : ''} entidad${estado.entidades.length > 1 ? 'es' : ''} seleccionada${estado.entidades.length > 1 ? 's' : ''}`);
  if ($('objeto').value.trim()) motivos.push(`el texto “${esc($('objeto').value.trim())}”`);
  if ($('proveedor').value.trim()) motivos.push(`ese proveedor`);
  const periodo = $('periodo').selectedOptions[0]?.textContent.toLowerCase();
  return `<div class="vacio-msg">
    <b>Sin resultados</b>
    <div class="sug">
      ${motivos.length ? `No hay procesos que combinen ${motivos.join(' y ')}` : 'No hay procesos'}
      dentro de <b>${esc(periodo ?? 'el periodo elegido')}</b>.
      <br><br>Prueba a ampliar el periodo, quitar un filtro o buscar una sola palabra.
    </div>
  </div>`;
}

function pintarPaginacion(j) {
  if (j.paginas <= 1) { $('paginacion').innerHTML = ''; return; }
  $('paginacion').innerHTML = `
    <button class="btn" id="ant" ${j.pagina <= 1 ? 'disabled' : ''}>← Anterior</button>
    <span>Página ${fmtNum(j.pagina)} de ${fmtNum(j.paginas)}</span>
    <button class="btn" id="sig" ${j.pagina >= j.paginas ? 'disabled' : ''}>Siguiente →</button>`;
  $('ant').addEventListener('click', () => { estado.pagina--; buscar(); scrollTo(0, 0); });
  $('sig').addEventListener('click', () => { estado.pagina++; buscar(); scrollTo(0, 0); });
}

// ── Estadísticas ────────────────────────────────────────────────────────────

function barras(titulo, items, color, medida, alPulsar) {
  if (!items?.length) return '';
  const max = Math.max(...items.map((i) => i.valor), 1);
  return `<div class="grupo"><h3>${esc(titulo)}</h3>${items.map((i, n) => `
    <div class="barra">
      <a class="nom" data-g="${esc(titulo)}" data-i="${n}" title="${esc(i.nombre)}">${esc(i.nombre || '—')}</a>
      <div class="pista"><div class="relleno" style="width:${Math.max(2, Math.round(i.valor / max * 100))}%;background:${color};"></div></div>
      <span class="val">${medida === 'monto' ? (fmtSoles(i.valor) ?? '—') : fmtNum(i.valor)}</span>
      <span class="sec">${medida === 'monto' ? fmtNum(i.procesos) + ' proc.' : ''}</span>
    </div>`).join('')}</div>`;
}

async function cargarStats() {
  const caja = $('panelStats');
  caja.innerHTML = '<div class="cargando">Calculando…</div>';
  const p = parametros();
  p.set('medida', estado.medida);
  const j = await (await fetch('/api/estadisticas?' + p)).json();
  if (j.error) { caja.innerHTML = `<div class="cargando">${esc(j.error)}</div>`; return; }

  const r = j.resumen;
  const esMonto = estado.medida === 'monto';
  caja.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
      <h3 style="margin:0;font-size:14px;color:var(--azul);">📊 Estadísticas del conjunto filtrado</h3>
      <span class="der" style="margin-left:auto;display:flex;gap:6px;">
        <button class="btn chico ${!esMonto ? 'primario' : ''}" data-medida="procesos">Nº de procesos</button>
        <button class="btn chico ${esMonto ? 'primario' : ''}" data-medida="monto">Monto S/</button>
      </span>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="v">${fmtNum(r.procesos)}</div><div class="e">Procesos</div></div>
      <div class="kpi"><div class="v">${fmtNum(r.entidades)}</div><div class="e">Entidades</div></div>
      <div class="kpi"><div class="v">${fmtNum(r.adjudicados)}</div><div class="e">Adjudicados</div></div>
      <div class="kpi"><div class="v">${fmtNum(r.un_postor)}</div><div class="e">Con un solo postor</div></div>
      <div class="kpi ${r.cobertura < 60 ? 'aviso-cobertura' : ''}">
        <div class="v">${r.cobertura}%</div><div class="e">Publican su monto</div>
      </div>
      <div class="kpi"><div class="v">${fmtSoles(r.monto_total) ?? '—'}</div><div class="e">Monto publicado</div></div>
    </div>

    ${barras('Entidades', j.entidades, 'var(--azul)', estado.medida)}
    ${barras('Proveedores adjudicados', j.proveedores, '#92400e', estado.medida)}
    ${barras('Categoría', j.categorias.map((c) => ({ ...c, nombre: CATEGORIAS[c.nombre] ?? c.nombre })), 'var(--rosa)', estado.medida)}
    ${barras('Departamento', j.departamentos, '#7c3aed', estado.medida)}
    ${barras('Por mes', j.porMes, 'var(--verde)', estado.medida)}

    <div class="nota-datos">
      Calculado sobre los <b>${fmtNum(r.procesos)}</b> procesos que cumplen tus filtros, no solo los mostrados arriba.
      Solo el <b>${r.cobertura}%</b> publica su monto referencial — el SEACE lo protege hasta la buena pro,
      así que un ranking por monto ordena únicamente a quienes lo revelaron.
      ${r.sin_convertir > 0 ? `<br>${fmtNum(r.sin_convertir)} proceso(s) en moneda extranjera sin conversión publicada quedan fuera de las sumas.` : ''}
      <br>Cuando una adjudicación tiene varios proveedores, su monto se reparte entre ellos por partes iguales.
    </div>`;

  for (const b of caja.querySelectorAll('[data-medida]')) {
    b.addEventListener('click', () => { estado.medida = b.dataset.medida; cargarStats(); });
  }
  // Pulsar una barra de Entidades la añade al filtro.
  for (const a of caja.querySelectorAll('.nom[data-g="Entidades"]')) {
    a.addEventListener('click', () => {
      const nombre = j.entidades[Number(a.dataset.i)].nombre;
      fetch('/api/entidades?q=' + encodeURIComponent(nombre)).then((r) => r.json()).then((x) => {
        const e = (x.entidades ?? [])[0];
        if (e && !estado.entidades.some((y) => y.id === e.id)) {
          estado.entidades.push({ id: e.id, nombre: e.nombre });
          pintarFichas(); estado.pagina = 1; buscar();
          scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    });
  }
}

// ── Navegación entre vistas ─────────────────────────────────────────────────

const VISTAS = { buscar: 'vistaBuscar', alertas: 'vistaAlertas', carteras: 'vistaCarteras' };

function irA(vista) {
  for (const [nombre, id] of Object.entries(VISTAS)) $(id).hidden = nombre !== vista;
  for (const n of ['Buscar', 'Alertas', 'Carteras']) {
    $('nav' + n).classList.toggle('activo', n.toLowerCase() === vista);
  }
  if (location.hash.slice(1) !== vista) history.replaceState(null, '', '#' + vista);
  if (vista === 'alertas') cargarAlertas();
  if (vista === 'carteras') cargarCarteras();
}
for (const [n, v] of [['navBuscar', 'buscar'], ['navAlertas', 'alertas'], ['navCarteras', 'carteras']]) {
  $(n).addEventListener('click', (e) => { e.preventDefault(); irA(v); });
}
$('irABuscar').addEventListener('click', (e) => { e.preventDefault(); irA('buscar'); });

// ── Carteras ────────────────────────────────────────────────────────────────

let carteras = [];
let entidadesCartera = [];

autocompletar('carteraEntidad', 'sugCartera', '/api/entidades',
  (e) => `${e.sigla ? `<span class="sigla">${esc(e.sigla)}</span>` : ''}${esc(e.nombre)}` +
    `<div class="n">${fmtNum(e.procesos)} procesos${e.departamento ? ' · ' + esc(e.departamento) : ''}</div>`,
  (e) => {
    if (!entidadesCartera.some((x) => x.id === e.id)) entidadesCartera.push({ id: e.id, nombre: e.nombre });
    pintarFichasCartera();
  });

function pintarFichasCartera() {
  $('fichasCartera').innerHTML = entidadesCartera.map((e, i) =>
    `<span class="ficha">${esc(e.nombre)}<button data-i="${i}" title="Quitar">×</button></span>`).join('');
  $('fichasCartera').querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => { entidadesCartera.splice(Number(b.dataset.i), 1); pintarFichasCartera(); });
  });
}

async function cargarCarteras() {
  const j = await (await fetch('/api/carteras')).json();
  carteras = j.carteras ?? [];
  $('listaCarteras').innerHTML = carteras.length
    ? carteras.map((c) => `<div class="item">
        <div class="cab">
          <div><h3>📁 ${esc(c.nombre)}</h3>
            <div class="cad">${c.entidades.length} entidad${c.entidades.length === 1 ? '' : 'es'}</div></div>
          <div class="der">
            <button class="btn chico usarCartera" data-id="${c.id}">Buscar con esta cartera</button>
            <button class="btn chico borrarCartera" data-id="${c.id}">Eliminar</button>
          </div>
        </div>
        <div class="fichas">${c.entidades.map((e) => `<span class="ficha">${esc(e.nombre)}</span>`).join('')}</div>
      </div>`).join('')
    : '<div class="vacio-msg"><b>Todavía no hay carteras</b><div class="sug">Crea una arriba: busca entidades, añádelas y ponle nombre.</div></div>';

  for (const b of $('listaCarteras').querySelectorAll('.usarCartera')) {
    b.addEventListener('click', () => { aplicarCartera(Number(b.dataset.id)); irA('buscar'); });
  }
  for (const b of $('listaCarteras').querySelectorAll('.borrarCartera')) {
    b.addEventListener('click', async () => {
      const c = carteras.find((x) => x.id === Number(b.dataset.id));
      if (!confirm(`¿Eliminar la cartera “${c.nombre}”? Las alertas que la usaran conservan sus entidades.`)) return;
      await fetch('/api/carteras?id=' + b.dataset.id, { method: 'DELETE' });
      cargarCarteras(); refrescarSelectorCarteras();
    });
  }
  refrescarSelectorCarteras();
}

function refrescarSelectorCarteras() {
  const s = $('aplicarCartera');
  s.innerHTML = '<option value="">Usar una cartera…</option>' +
    carteras.map((c) => `<option value="${c.id}">📁 ${esc(c.nombre)} (${c.entidades.length})</option>`).join('');
}

function aplicarCartera(id) {
  const c = carteras.find((x) => x.id === id);
  if (!c) return;
  for (const e of c.entidades) {
    if (!estado.entidades.some((x) => x.id === e.id)) estado.entidades.push({ id: e.id, nombre: e.nombre });
  }
  pintarFichas(); estado.pagina = 1; buscar();
}

$('aplicarCartera').addEventListener('change', (e) => {
  if (e.target.value) { aplicarCartera(Number(e.target.value)); e.target.value = ''; }
});

$('crearCartera').addEventListener('click', async () => {
  const nombre = $('carteraNombre').value.trim();
  if (!nombre) { alert('Ponle un nombre a la cartera.'); return; }
  if (entidadesCartera.length === 0) { alert('Añade al menos una entidad.'); return; }
  const r = await (await fetch('/api/carteras', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre, entidades: entidadesCartera }),
  })).json();
  if (r.error) { alert(r.error); return; }
  $('carteraNombre').value = '';
  entidadesCartera = [];
  pintarFichasCartera();
  cargarCarteras();
});

// ── Alertas ─────────────────────────────────────────────────────────────────

const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

function montarSelectoresHora() {
  // 07:00–20:00: fuera de esa franja el servidor no programa envíos.
  const horas = [];
  for (let h = 7; h <= 20; h++) horas.push(`${String(h).padStart(2, '0')}:00`);
  const opciones = (sel) => horas.map((h) => `<option value="${h}"${h === sel ? ' selected' : ''}>${h}</option>`).join('');
  $('hora1').innerHTML = opciones('08:00');
  $('hora2a').innerHTML = opciones('08:00');
  $('hora2b').innerHTML = opciones('17:00');
  $('hora3').innerHTML = opciones('08:00');
  $('diaSemana').innerHTML = DIAS.map((d, i) => `<option value="${i}">${d}</option>`).join('');
}

function frecuenciaElegida() {
  const tipo = document.querySelector('input[name=frec]:checked').value;
  if (tipo === 'horaria') return { tipo };
  if (tipo === 'diaria') return { tipo, horas: [$('hora1').value] };
  if (tipo === 'dosDiarias') return { tipo, horas: [$('hora2a').value, $('hora2b').value] };
  return { tipo, horas: [$('hora3').value], diaSemana: Number($('diaSemana').value) };
}

/** Descripción en castellano de los filtros actuales, para el diálogo. */
function resumenFiltros() {
  const partes = [];
  if (estado.entidades.length) partes.push(estado.entidades.map((e) => e.nombre).join(', '));
  if ($('objeto').value.trim()) partes.push(`“${$('objeto').value.trim()}”`);
  if ($('proveedor').value.trim()) partes.push(`proveedor ${$('proveedor').value.trim()}`);
  for (const [id, , titulo] of MULTIS) {
    const m = valoresMulti(id);
    if (!m.todos && !m.ninguno) partes.push(`${titulo.toLowerCase()}: ${m.valores.length}`);
  }
  if ($('conAdjudicacion').checked) partes.push('con ganador');
  if ($('soloUnPostor').checked) partes.push('un solo postor');
  return partes.length ? partes.join(' · ') : 'todas las convocatorias nuevas (sin filtros)';
}

$('nuevaAlerta').addEventListener('click', () => {
  const vacio = filtroVacio();
  if (vacio) { alert(`El filtro “${vacio}” está en “Ninguno”: la alerta nunca encontraría nada.`); return; }
  $('resumenFiltrosAlerta').innerHTML = 'Filtros: <b>' + esc(resumenFiltros()) + '</b>';
  $('alertaNombre').value = estado.entidades[0]?.nombre?.slice(0, 40)
    ?? ($('objeto').value.trim() || 'Alerta SEACE');
  $('avisoAlerta').hidden = true;
  $('veloAlerta').hidden = false;
});
const cerrarDialogo = () => { $('veloAlerta').hidden = true; };
$('cancelarAlerta').addEventListener('click', cerrarDialogo);
// Clic en el fondo oscuro, y Escape: las dos salidas que la gente prueba.
$('veloAlerta').addEventListener('click', (e) => { if (e.target.id === 'veloAlerta') cerrarDialogo(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('veloAlerta').hidden) cerrarDialogo(); });

$('guardarAlerta').addEventListener('click', async () => {
  const filtros = Object.fromEntries(parametros());
  // Los multivalor viajan como CSV en la query; la alerta los guarda como listas.
  for (const clave of ['entidades', 'categorias', 'estados', 'montos', 'departamentos', 'metodos']) {
    if (filtros[clave]) filtros[clave] = filtros[clave].split(',');
  }
  filtros.conAdjudicacion = filtros.conAdjudicacion === '1';
  filtros.soloUnPostor = filtros.soloUnPostor === '1';
  delete filtros.desde; delete filtros.hasta;   // el periodo lo pone el corte de la alerta

  const r = await (await fetch('/api/alertas', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nombre: $('alertaNombre').value, filtros,
      frecuencia: frecuenciaElegida(), enviarVacios: $('enviarVacios').checked,
    }),
  })).json();

  if (!r.ok) {
    $('avisoAlerta').textContent = r.error;
    $('avisoAlerta').className = 'aviso error';
    $('avisoAlerta').hidden = false;
    return;
  }
  $('veloAlerta').hidden = true;
  irA('alertas');
});

async function cargarAlertas() {
  $('listaAlertas').innerHTML = '<div class="cargando">Cargando…</div>';
  const j = await (await fetch('/api/alertas')).json();
  const alertas = j.alertas ?? [];
  if (alertas.length === 0) {
    $('listaAlertas').innerHTML = `<div class="vacio-msg"><b>Todavía no tienes alertas</b>
      <div class="sug">Ve a <a href="#buscar" id="sinAlertas">Buscar</a>, ajusta los filtros
      y pulsa “Crear alerta con estos filtros”.</div></div>`;
    $('sinAlertas')?.addEventListener('click', (e) => { e.preventDefault(); irA('buscar'); });
    return;
  }

  $('listaAlertas').innerHTML = alertas.map((a) => `
    <div class="item ${a.pausada ? 'pausada' : ''}">
      <div class="cab">
        <div style="min-width:0;">
          <h3>${esc(a.nombre)}</h3>
          <div class="cad">${esc(a.cadencia)}${a.pausada ? '' :
      a.proximoEnvio ? ` · próximo envío ${fmtFechaHora(a.proximoEnvio)}` : ''}</div>
          <div class="filtrosRes">${esc(resumirFiltrosCliente(a.filtros))}</div>
        </div>
        <div class="der">
          <button class="btn chico probar" data-id="${a.id}">Probar ahora</button>
          ${a.esPropietario ? `
            <button class="btn chico pausar" data-id="${a.id}" data-p="${a.pausada ? 0 : 1}">${a.pausada ? 'Reanudar' : 'Pausar'}</button>
            <button class="btn chico borrar" data-id="${a.id}">Eliminar</button>` : ''}
        </div>
      </div>

      <div class="seccion">
        <h4>Quién la recibe</h4>
        ${a.suscriptores.map((s) => `<div class="suscriptor">
          <span>${esc(s.nombre || s.email)}</span>
          <span class="est est-${s.estado}">${s.estado === 'aceptada' ? 'recibe' : s.estado === 'pendiente' ? 'invitación pendiente' : 'dado de baja'}</span>
          ${a.esPropietario || s.email === USUARIO.email
      ? `<button class="btn chico quitar" data-id="${a.id}" data-u="${s.id}">Quitar</button>` : ''}
        </div>`).join('')}
        ${a.esPropietario ? `<div class="fila" style="margin-top:9px;gap:6px;">
          <input type="email" class="invEmail" data-id="${a.id}" placeholder="correo@estudio.pe" style="flex:1;min-width:180px;">
          <button class="btn chico invitar" data-id="${a.id}">Invitar</button>
        </div>
        <div class="pista" style="margin-top:6px;">No recibirá nada hasta que acepte desde su correo.</div>` : ''}
      </div>

      ${a.historial.length ? `<div class="seccion"><h4>Últimos envíos</h4>
        <div class="historial">${a.historial.map((h) =>
        `<div><span class="fecha">${fmtFechaHora(h.fecha)}</span> — ${h.n_procesos} proceso(s)${h.error ? ' · ⚠ ' + esc(h.error) : ''}</div>`).join('')}
        </div></div>` : ''}
    </div>`).join('');

  enlazarAcciones();
}

function enlazarAcciones() {
  const post = (url, cuerpo) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
  }).then((r) => r.json());

  for (const b of $('listaAlertas').querySelectorAll('.probar')) {
    b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = 'Enviando…';
      const r = await post('/api/alertas/probar', { id: Number(b.dataset.id) });
      alert(r.mensaje ?? r.error ?? 'Listo');
      b.disabled = false; b.textContent = 'Probar ahora';
    });
  }
  for (const b of $('listaAlertas').querySelectorAll('.pausar')) {
    b.addEventListener('click', async () => {
      await post('/api/alertas/pausar', { id: Number(b.dataset.id), pausada: b.dataset.p === '1' });
      cargarAlertas();
    });
  }
  for (const b of $('listaAlertas').querySelectorAll('.borrar')) {
    b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta alerta? Dejará de enviarse a todos sus suscriptores.')) return;
      await fetch('/api/alertas?id=' + b.dataset.id, { method: 'DELETE' });
      cargarAlertas();
    });
  }
  for (const b of $('listaAlertas').querySelectorAll('.quitar')) {
    b.addEventListener('click', async () => {
      await fetch(`/api/alertas/suscriptor?id=${b.dataset.id}&usuario=${b.dataset.u}`, { method: 'DELETE' });
      cargarAlertas();
    });
  }
  for (const b of $('listaAlertas').querySelectorAll('.invitar')) {
    b.addEventListener('click', async () => {
      const input = $('listaAlertas').querySelector(`.invEmail[data-id="${b.dataset.id}"]`);
      if (!input.value.trim()) { input.focus(); return; }
      b.disabled = true;
      const r = await post('/api/alertas/invitar', { id: Number(b.dataset.id), email: input.value.trim() });
      alert(r.mensaje ?? r.error);
      b.disabled = false;
      if (!r.error) { input.value = ''; cargarAlertas(); }
    });
  }
}

const fmtFechaHora = (iso) => {
  if (!iso) return '—';
  // Se muestra en hora de Lima, que es la que entiende el usuario.
  const d = new Date(Date.parse(iso) - 5 * 3600e3);
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' h';
};

function resumirFiltrosCliente(f = {}) {
  const partes = [];
  if (f.entidades?.length) partes.push(`${f.entidades.length} entidad${f.entidades.length === 1 ? '' : 'es'}`);
  if (f.objeto) partes.push(`“${f.objeto}”`);
  if (f.proveedor) partes.push(`proveedor ${f.proveedor}`);
  if (f.categorias?.length) partes.push(f.categorias.map((c) => CATEGORIAS[c] ?? c).join('/'));
  if (f.departamentos?.length) partes.push(f.departamentos.join('/'));
  if (f.estados?.length) partes.push(f.estados.join('/'));
  if (f.conAdjudicacion) partes.push('con ganador');
  if (f.soloUnPostor) partes.push('un solo postor');
  return partes.length ? 'Filtros: ' + partes.join(' · ') : 'Sin filtros: todas las convocatorias nuevas';
}

// ── Arranque ────────────────────────────────────────────────────────────────

$('buscar').addEventListener('click', () => { estado.pagina = 1; buscar(); });
$('objeto').addEventListener('keydown', (e) => { if (e.key === 'Enter') { estado.pagina = 1; buscar(); } });
$('limpiar').addEventListener('click', () => {
  estado.entidades = []; estado.proveedor = ''; estado.pagina = 1;
  $('objeto').value = ''; $('proveedor').value = '';
  $('periodo').value = '30'; $('rangoFechas').hidden = true;
  $('desde').value = ''; $('hasta').value = '';
  $('conAdjudicacion').checked = false; $('soloUnPostor').checked = false;
  for (const [id, , titulo] of MULTIS) fijarMulti(id, [], titulo);
  pintarFichas(); buscar();
});
$('salir').addEventListener('click', async () => {
  await fetch('/api/salir', { method: 'POST' });
  location.href = '/entrar';
});

let USUARIO = {};

(async function iniciar() {
  const yo = await (await fetch('/api/yo')).json();
  if (yo.error) { location.href = '/entrar'; return; }
  facetas = yo.facetas;
  hoy = yo.hoy;
  USUARIO = yo.usuario;
  $('quienSoy').textContent = [yo.usuario.nombre || yo.usuario.email, yo.usuario.estudio].filter(Boolean).join(' · ');
  montarSelectoresHora();

  montarMulti('mCategoria', 'Categoría', facetas.categorias.map((c) => ({ valor: c.valor, label: CATEGORIAS[c.valor] ?? c.valor, n: c.n })));
  montarMulti('mEstado', 'Estado', facetas.estados.map((e) => ({ valor: e.valor, label: e.valor.replace(/_/g, ' '), n: e.n })));
  montarMulti('mMonto', 'Monto', facetas.montos.map((m) => ({ valor: m.valor, label: m.label })));
  montarMulti('mDepartamento', 'Departamento', facetas.departamentos.map((d) => ({ valor: d.valor, label: d.valor, n: d.n })));
  montarMulti('mMetodo', 'Método', facetas.metodos.map((m) => ({ valor: m.valor, label: m.valor, n: m.n })));

  const p = leerDeUrl();
  if (p) for (const [id, clave, titulo] of MULTIS) {
    fijarMulti(id, (p.get(clave) ?? '').split(',').filter(Boolean), titulo);
  }
  $('panelStats').hidden = !estado.stats;
  pintarFichas();
  await cargarCarteras();          // llena el selector de carteras del buscador
  buscar();

  const vista = location.hash.slice(1);
  if (VISTAS[vista]) irA(vista);
})();
