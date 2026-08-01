// ──────────────────────────────────────────────────────────────────────────────
// Render del digest como HTML apto para clientes de correo: tablas + estilos
// inline (Gmail/Outlook ignoran <style> y CSS moderno). Colores Xertica.
// ──────────────────────────────────────────────────────────────────────────────

const AZUL = '#047EA9';
const ROSA = '#FF4DA6';
const BUSCADOR = 'https://prod2.seace.gob.pe/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fmtFecha = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' });
};

const fmtMonto = (n, moneda) => {
  if (!n || n <= 0) return null; // el SEACE oculta el monto referencial en muchos procesos
  return `${moneda === 'PEN' ? 'S/' : moneda} ${Number(n).toLocaleString('es-PE', { maximumFractionDigits: 0 })}`;
};

const CATEGORIA_ES = { goods: 'Bienes', services: 'Servicios', works: 'Obras', consultingServices: 'Consultoría' };

function chip(texto, color, bg) {
  return `<span style="display:inline-block;font-size:11px;font-weight:bold;color:${color};background:${bg};border-radius:10px;padding:2px 8px;margin-right:6px;">${esc(texto)}</span>`;
}

function tarjeta(p) {
  const cierre = p.cierreOfertas ? new Date(p.cierreOfertas) : null;
  const cierreVencido = cierre && cierre < new Date();
  const monto = fmtMonto(p.monto, p.moneda);

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:14px;">
    <tr><td style="padding:16px 18px;">
      <div style="font-size:11px;font-weight:bold;letter-spacing:.5px;color:#9ca3af;text-transform:uppercase;margin-bottom:4px;">
        ${esc(p.entidad)}
      </div>
      <div style="font-size:15px;line-height:1.45;color:#111827;font-weight:bold;margin-bottom:8px;">
        ${esc(p.descripcion || p.nomenclatura)}
      </div>
      <div style="margin-bottom:10px;">
        ${chip(CATEGORIA_ES[p.categoria] ?? p.categoria ?? 'Proceso', AZUL, '#e6f4f9')}
        ${p.metodo ? chip(p.metodo, '#6b7280', '#f3f4f6') : ''}
        ${monto ? chip(monto, '#5e7d40', '#eef5e6') : ''}
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:12px;color:#6b7280;">
        <tr>
          <td style="padding-right:16px;">📅 Publicado: <b style="color:#374151;">${fmtFecha(p.fecha)}</b></td>
          <td style="padding-right:16px;">⏳ Cierre de ofertas: <b style="color:${cierreVencido ? '#b91c1c' : '#374151'};">${p.cierreOfertas ? fmtFecha(p.cierreOfertas) + (cierreVencido ? ' (vencido)' : '') : 'no publicado aún'}</b></td>
        </tr>
      </table>
      ${(p.etapas ?? []).length > 0 ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;margin-top:10px;border:1px solid #eef0f2;border-radius:8px;">
        <tr style="background:#f9fafb;">
          <td style="padding:6px 10px;font-weight:bold;color:#6b7280;text-transform:uppercase;font-size:10px;letter-spacing:.4px;">Etapa</td>
          <td style="padding:6px 10px;font-weight:bold;color:#6b7280;text-transform:uppercase;font-size:10px;letter-spacing:.4px;">Fecha inicio</td>
          <td style="padding:6px 10px;font-weight:bold;color:#6b7280;text-transform:uppercase;font-size:10px;letter-spacing:.4px;">Fecha fin</td>
        </tr>
        ${p.etapas.map((e) => `
        <tr>
          <td style="padding:6px 10px;color:#374151;border-top:1px solid #f3f4f6;">${esc(e.etapa)}</td>
          <td style="padding:6px 10px;color:#374151;border-top:1px solid #f3f4f6;">${fmtFecha(e.inicio)}</td>
          <td style="padding:6px 10px;color:#374151;border-top:1px solid #f3f4f6;">${fmtFecha(e.fin)}</td>
        </tr>`).join('')}
        <tr>
          <td colspan="3" style="padding:6px 10px;color:#9ca3af;font-size:11px;border-top:1px solid #f3f4f6;">
            El SEACE solo publica estas etapas en datos abiertos — el cronograma completo está en las bases (PDF) y en la ficha del proceso (búscalo por su nomenclatura en el buscador).
          </td>
        </tr>
      </table>` : ''}
      <div style="margin-top:10px;font-size:12px;">
        ${p.basesUrl ? `<a href="${esc(p.basesUrl)}" style="color:${AZUL};font-weight:bold;">📄 Descargar bases</a> &nbsp;·&nbsp; ` : ''}
        <a href="${BUSCADOR}" style="color:${AZUL};">Buscar en SEACE: <b>${esc(p.nomenclatura)}</b></a>
      </div>
      ${(p.keywords ?? []).length > 0 ? `<div style="margin-top:8px;font-size:11px;color:#9ca3af;">
        Detectado por: ${esc(p.keywords.slice(0, 5).join(', '))}
      </div>` : ''}
    </td></tr>
  </table>`;
}

/** HTML completo del correo. */
export function renderEmail({ procesos, desde, hasta, totalEscaneados, titulo = '🏛️ Licitaciones TI en el SEACE', intro = null }) {
  const cuerpo =
    procesos.length > 0
      ? procesos.map(tarjeta).join('\n')
      : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px dashed #d1d5db;border-radius:10px;">
           <tr><td style="padding:28px;text-align:center;color:#6b7280;font-size:14px;">
             Sin convocatorias relevantes en este período. Se escanearon ${totalEscaneados} procesos publicados en el SEACE.
           </td></tr>
         </table>`;

  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;">

        <!-- Cabecera -->
        <tr><td style="background:${AZUL};border-radius:12px 12px 0 0;padding:22px 24px;">
          <div style="font-size:20px;font-weight:bold;color:#ffffff;">${esc(titulo)}</div>
          <div style="font-size:12px;color:#bfe3f0;margin-top:4px;">
            ${intro ? esc(intro) : 'Convocatorias públicas del Estado Peruano relevantes para Xertica'} ·
            ${fmtFecha(desde)} — ${fmtFecha(hasta)}
          </div>
        </td></tr>

        <!-- Resumen -->
        <tr><td style="background:#ffffff;border-bottom:3px solid ${ROSA};padding:14px 24px;">
          <span style="font-size:13px;color:#374151;">
            <b style="color:${AZUL};font-size:16px;">${procesos.length}</b> convocatoria${procesos.length === 1 ? '' : 's'} relevante${procesos.length === 1 ? '' : 's'}
            de <b>${totalEscaneados}</b> procesos escaneados, ordenadas por afinidad.
          </span>
        </td></tr>

        <!-- Tarjetas -->
        <tr><td style="padding:18px 0;">
          ${cuerpo}
        </td></tr>

        <!-- Pie -->
        <tr><td style="padding:6px 24px 24px;text-align:center;">
          <div style="font-size:11px;color:#9ca3af;line-height:1.6;">
            Fuente: API abierta OCDS del OECE (datos oficiales del SEACE) ·
            <a href="${BUSCADOR}" style="color:${AZUL};">Buscador público SEACE 3.0</a><br>
            Generado automáticamente por <b style="color:${ROSA};">seace-alertas</b> · Xertica Revenue Operations
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
