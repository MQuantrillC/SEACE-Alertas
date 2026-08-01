// ──────────────────────────────────────────────────────────────────────────────
// Envío opcional por SMTP (Gmail/Workspace con contraseña de aplicación).
// Solo se usa con `npm run digest:send` y si las variables SMTP_* existen —
// sin ellas, el digest queda igualmente generado en out/ como HTML.
// ──────────────────────────────────────────────────────────────────────────────

export async function enviar({ html, asunto, destinatarios }) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_USER || !SMTP_PASS) {
    console.log('✉ Envío omitido: define SMTP_USER y SMTP_PASS (ver .env.example).');
    return false;
  }
  const { default: nodemailer } = await import('nodemailer');
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST || 'smtp.gmail.com',
    port: Number(SMTP_PORT || 465),
    secure: Number(SMTP_PORT || 465) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transporter.sendMail({
    from: `"SEACE Alertas · Xertica" <${SMTP_USER}>`,
    to: destinatarios.join(', '),
    subject: asunto,
    html,
  });
  console.log(`✉ Digest enviado a: ${destinatarios.join(', ')}`);
  return true;
}
