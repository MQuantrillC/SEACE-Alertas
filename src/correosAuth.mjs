// ──────────────────────────────────────────────────────────────────────────────
// Correos de acceso e invitación. HTML con estilos en línea, como el digest:
// Gmail y Outlook ignoran <style> y casi todo el CSS moderno.
// ──────────────────────────────────────────────────────────────────────────────

import { enviar } from './send.mjs';

const AZUL = '#047EA9';
const ROSA = '#FF4DA6';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function plantilla({ titulo, saludo, cuerpo, boton, enlace, pie, botonSecundario = null }) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
 <tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
   <tr><td style="background:${AZUL};border-radius:12px 12px 0 0;padding:22px 24px;">
     <div style="font-size:19px;font-weight:bold;color:#fff;">${esc(titulo)}</div>
   </td></tr>
   <tr><td style="background:#fff;padding:24px;border-bottom:3px solid ${ROSA};border-radius:0 0 12px 12px;">
     <p style="margin:0 0 14px;font-size:14px;color:#374151;line-height:1.6;">${saludo}</p>
     <p style="margin:0 0 20px;font-size:14px;color:#374151;line-height:1.6;">${cuerpo}</p>
     <table role="presentation" cellpadding="0" cellspacing="0"><tr>
       <td style="background:${AZUL};border-radius:8px;">
         <a href="${esc(enlace)}" style="display:inline-block;padding:12px 26px;color:#fff;font-size:14px;font-weight:bold;text-decoration:none;">${esc(boton)}</a>
       </td>
       ${botonSecundario ? `<td style="padding-left:10px;">
         <a href="${esc(botonSecundario.enlace)}" style="display:inline-block;padding:12px 20px;color:#6b7280;font-size:14px;text-decoration:underline;">${esc(botonSecundario.texto)}</a>
       </td>` : ''}
     </tr></table>
     <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;line-height:1.6;">${pie}</p>
     <p style="margin:12px 0 0;font-size:11px;color:#c3c7ce;word-break:break-all;">
       Si el botón no funciona, copia esta dirección en tu navegador:<br>${esc(enlace)}
     </p>
   </td></tr>
   <tr><td style="padding:14px 24px;text-align:center;font-size:11px;color:#9ca3af;">
     SEACE Alertas · Licitaciones públicas del Estado Peruano
   </td></tr>
  </table>
 </td></tr>
</table>
</body></html>`;
}

/** Enlace mágico de acceso. */
export function correoAcceso({ enlace, minutos }) {
  return plantilla({
    titulo: '🔑 Tu enlace de acceso',
    saludo: 'Hola,',
    cuerpo: `Pulsa el botón para entrar a SEACE Alertas. El enlace vale <b>${minutos} minutos</b> y solo se puede usar una vez.`,
    boton: 'Entrar',
    enlace,
    pie: 'Si no pediste este enlace, ignora este correo: nadie puede entrar sin él y caduca solo.',
  });
}

/** Invitación a una alerta. Mientras no acepte, esa persona NO recibe avisos. */
export function correoInvitacion({ enlace, enlaceRechazo, quienInvita, nombreAlerta, resumenFiltros, dias }) {
  return plantilla({
    titulo: '🔔 Te invitaron a una alerta',
    saludo: `<b>${esc(quienInvita)}</b> te invitó a recibir la alerta <b>${esc(nombreAlerta)}</b> de SEACE Alertas.`,
    cuerpo: `Avisa por correo cuando el SEACE publique convocatorias que cumplan: <i>${esc(resumenFiltros)}</i>.<br><br>
             <b>No recibirás nada hasta que aceptes.</b> La invitación caduca en ${dias} días.`,
    boton: 'Aceptar y ver la alerta',
    enlace,
    botonSecundario: { texto: 'No, gracias', enlace: enlaceRechazo },
    pie: 'Si no conoces a quien te invita, pulsa "No, gracias" o simplemente ignora este correo.',
  });
}

export const enviarAcceso = (destino, datos) =>
  enviar({ html: correoAcceso(datos), asunto: '🔑 Tu enlace de acceso a SEACE Alertas', destinatarios: [destino] });

export const enviarInvitacion = (destino, datos) =>
  enviar({
    html: correoInvitacion(datos),
    asunto: `🔔 ${datos.quienInvita} te invitó a la alerta "${datos.nombreAlerta}"`,
    destinatarios: [destino],
  });
