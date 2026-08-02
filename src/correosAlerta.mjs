// ──────────────────────────────────────────────────────────────────────────────
// Correo de una alerta. Estilos en línea y tablas: Gmail y Outlook ignoran
// <style> y buena parte del CSS moderno.
//
// Trabaja con la forma que devuelve buscar.mjs (entidad, fecha_dia, monto_pen,
// documentos…), no con la del antiguo normalize().
// ──────────────────────────────────────────────────────────────────────────────

const AZUL = '#047EA9';
const ROSA = '#FF4DA6';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fecha = (v) => v
  ? new Date(v.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' })
  : '—';

const soles = (n) => {
  if (!n || n <= 0) return null;
  if (n >= 1e6) return 'S/ ' + (n / 1e6).toFixed(1) + ' M';
  if (n >= 1e3) return 'S/ ' + Math.round(n / 1e3) + ' mil';
  return 'S/ ' + Math.round(n);
};

const CATEGORIAS = { goods: 'Bienes', services: 'Servicios', works: 'Obras' };
const DOCS = {
  biddingDocuments: '📄 Bases',
  clarifications: '❓ Consultas y observaciones',
  awardNotice: '🏆 Buena pro',
  evaluationReports: '📋 Evaluación',
};
const ESTADOS_ALERTA = new Set(['APELADO', 'SUSPENDIDO', 'NULO', 'CANCELADO',
  'RETROTRAIDO_POR_RESOLUCION', 'DEJAR_SIN_EFECTO_ADJUDICACION']);

const etiqueta = (texto, color, fondo) =>
  `<span style="display:inline-block;font-size:11px;font-weight:bold;color:${color};background:${fondo};border-radius:10px;padding:2px 8px;margin:0 5px 4px 0;">${esc(texto)}</span>`;

function tarjeta(p) {
  const monto = soles(p.monto_pen);
  const cat = p.es_consultoria ? 'Consultoría de obra' : (CATEGORIAS[p.categoria] ?? p.categoria ?? 'Proceso');
  const docs = [...new Map((p.documentos ?? []).map((d) => [d.tipo, d])).values()];

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:12px;">
   <tr><td style="padding:15px 17px;">
    <div style="font-size:11px;font-weight:bold;letter-spacing:.4px;color:#9ca3af;text-transform:uppercase;margin-bottom:4px;">
      ${esc(p.entidad ?? 'Entidad no especificada')}
    </div>
    <div style="font-size:14px;line-height:1.5;color:#111827;font-weight:bold;margin-bottom:9px;">
      ${esc(p.descripcion || p.nomenclatura)}
    </div>
    <div style="margin-bottom:8px;">
      ${etiqueta(cat, AZUL, '#e6f4f9')}
      ${p.departamento ? etiqueta('📍 ' + p.departamento, '#7c3aed', '#f3e8ff') : ''}
      ${(p.estados ?? []).map((e) => ESTADOS_ALERTA.has(e)
        ? etiqueta(e, '#991b1b', '#fee2e2') : etiqueta(e, '#0369a1', '#e0f2fe')).join('')}
      ${monto ? etiqueta(monto, '#5e7d40', '#eef5e6') : ''}
      ${(p.proveedores ?? []).map((x) => etiqueta('🏆 ' + x.nombre, '#92400e', '#fef3c7')).join('')}
    </div>
    <div style="font-size:12px;color:#6b7280;">
      📅 Publicado <b style="color:#374151;">${fecha(p.fecha_dia)}</b>
      ${p.n_postores > 0 ? ` &nbsp;·&nbsp; 👥 <b style="color:#374151;">${p.n_postores}</b> postor${p.n_postores === 1 ? '' : 'es'}` : ''}
      ${p.enquiry_fin ? ` &nbsp;·&nbsp; ❓ Consultas hasta <b style="color:#374151;">${fecha(p.enquiry_fin)}</b>` : ''}
    </div>
    <div style="font-size:11px;color:#9ca3af;margin-top:5px;font-family:monospace;">${esc(p.nomenclatura)}</div>
    ${docs.length ? `<div style="margin-top:9px;font-size:12px;">
      ${docs.map((d) => `<a href="${esc(d.url)}" style="color:${AZUL};text-decoration:none;margin-right:12px;">${DOCS[d.tipo] ?? '📎 Documento'}</a>`).join('')}
    </div>` : ''}
   </td></tr>
  </table>`;
}

/**
 * @param {object} o
 * @param {Array}  o.procesos       resultados nuevos
 * @param {string} o.nombreAlerta
 * @param {string} o.cadencia       texto legible
 * @param {string} o.enlaceBusqueda ver la búsqueda completa en la app
 * @param {string} o.enlaceBaja     obligatorio: sin baja no se envía
 * @param {number} o.totalReal      total antes de recortar
 * @param {boolean} o.esPrueba
 */
export function correoAlerta({ procesos, nombreAlerta, cadencia, enlaceBusqueda, enlaceBaja, totalReal, esPrueba = false }) {
  const n = procesos.length;
  const recortado = totalReal > n;

  const cuerpo = n === 0
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px dashed #d1d5db;border-radius:10px;">
         <tr><td style="padding:28px;text-align:center;color:#6b7280;font-size:14px;">
           Sin convocatorias nuevas para esta alerta.
         </td></tr></table>`
    : procesos.map(tarjeta).join('\n');

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
 <tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;">

   <tr><td style="background:${AZUL};border-radius:12px 12px 0 0;padding:20px 24px;">
     <div style="font-size:19px;font-weight:bold;color:#fff;">
       ${esPrueba ? '🧪 Prueba · ' : '🔔 '}${esc(nombreAlerta)}
     </div>
     <div style="font-size:12px;color:#bfe3f0;margin-top:4px;">${esc(cadencia)}</div>
   </td></tr>

   <tr><td style="background:#fff;border-bottom:3px solid ${ROSA};padding:13px 24px;font-size:13px;color:#374151;">
     ${esPrueba
      ? `Así se vería tu alerta. <b>Es una prueba</b>: no se ha enviado a nadie más y no altera el seguimiento.`
      : `<b style="color:${AZUL};font-size:16px;">${n}</b> convocatoria${n === 1 ? '' : 's'} nueva${n === 1 ? '' : 's'}`}
     ${recortado ? `<br><span style="color:#b45309;">Hay ${totalReal} en total; este correo trae las ${n} más recientes. Afina los filtros para recibir menos.</span>` : ''}
   </td></tr>

   <tr><td style="padding:16px 0;">${cuerpo}</td></tr>

   <tr><td style="padding:0 24px 8px;text-align:center;">
     <a href="${esc(enlaceBusqueda)}" style="display:inline-block;background:${AZUL};color:#fff;padding:11px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:bold;">
       Ver en SEACE Alertas
     </a>
   </td></tr>

   <tr><td style="padding:16px 24px 24px;text-align:center;">
     <div style="font-size:11px;color:#9ca3af;line-height:1.7;">
       Fuente: datos abiertos del OECE (SEACE).<br>
       <a href="${esc(enlaceBaja)}" style="color:#9ca3af;">Dejar de recibir esta alerta</a>
     </div>
   </td></tr>

  </table>
 </td></tr>
</table>
</body></html>`;
}
