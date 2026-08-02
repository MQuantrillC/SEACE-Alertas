// ──────────────────────────────────────────────────────────────────────────────
// Envío por SMTP (Gmail / Google Workspace con contraseña de aplicación).
//
// Sin SMTP_USER y SMTP_PASS no se envía nada y se devuelve false — la app sigue
// funcionando y los enlaces de acceso se imprimen en la consola del servidor.
//
// Diagnóstico:  npm run correo
// ──────────────────────────────────────────────────────────────────────────────

let _transporte = null;

/** Configuración leída del entorno, ya normalizada. */
export function configSmtp() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  const puerto = Number(SMTP_PORT || 465);
  return {
    host: SMTP_HOST || 'smtp.gmail.com',
    port: puerto,
    // 465 es TLS directo; 587 es STARTTLS, que en nodemailer se pide con secure:false.
    secure: puerto === 465,
    user: SMTP_USER || null,
    // Google muestra la contraseña de aplicación en grupos de cuatro
    // ("abcd efgh ijkl mnop") y casi todo el mundo la pega tal cual. Los espacios
    // no forman parte de la contraseña: si se envían, la autenticación falla.
    pass: SMTP_PASS ? SMTP_PASS.replace(/\s+/g, '') : null,
    from: SMTP_FROM || `"SEACE Alertas" <${SMTP_USER}>`,
  };
}

export const smtpConfigurado = () => {
  const c = configSmtp();
  return !!(c.user && c.pass);
};

async function transporte() {
  if (_transporte) return _transporte;
  const c = configSmtp();
  const { default: nodemailer } = await import('nodemailer');
  _transporte = nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure,
    auth: { user: c.user, pass: c.pass },
  });
  return _transporte;
}

/** Comprueba conexión y credenciales SIN enviar ningún mensaje. */
export async function verificarSmtp() {
  const c = configSmtp();
  if (!c.user || !c.pass) {
    return { ok: false, error: 'Faltan SMTP_USER o SMTP_PASS en .env', config: c };
  }
  try {
    await (await transporte()).verify();
    return { ok: true, config: c };
  } catch (err) {
    return { ok: false, error: err.message, codigo: err.code, respuesta: err.response, config: c };
  }
}

export async function enviar({ html, asunto, destinatarios, texto = null }) {
  const c = configSmtp();
  if (!c.user || !c.pass) {
    console.log('✉ Envío omitido: faltan SMTP_USER y SMTP_PASS (ver .env.example).');
    return false;
  }
  try {
    await (await transporte()).sendMail({
      from: c.from,
      to: destinatarios.join(', '),
      subject: asunto,
      html,
      ...(texto ? { text: texto } : {}),
    });
    console.log(`✉ Enviado a: ${destinatarios.join(', ')}`);
    return true;
  } catch (err) {
    // Se traga el error a propósito: que falle un correo no debe tumbar el runner
    // ni dejar a medias una tanda de alertas. Quien llama decide qué hacer.
    console.error(`✘ No se pudo enviar a ${destinatarios.join(', ')}: ${err.message}`);
    return false;
  }
}
