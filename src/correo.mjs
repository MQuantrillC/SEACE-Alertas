// ──────────────────────────────────────────────────────────────────────────────
// Diagnóstico del correo — `npm run correo`
//
//   npm run correo                        comprueba conexión y credenciales
//   npm run correo -- --enviar tu@correo  manda un mensaje de prueba real
//
// Por defecto NO envía nada: solo abre la conexión y autentica, que es lo que
// falla el 95 % de las veces.
// ──────────────────────────────────────────────────────────────────────────────

import { configSmtp, verificarSmtp, enviar } from './send.mjs';
import { baseUrl } from './auth.mjs';

const args = process.argv.slice(2);
const i = args.indexOf('--enviar');
const destino = i >= 0 ? args[i + 1] : null;

const c = configSmtp();
console.log('\n📬 Configuración de correo\n');
console.log(`   SMTP_HOST   ${c.host}`);
console.log(`   SMTP_PORT   ${c.port}  (${c.secure ? 'TLS directo' : 'STARTTLS'})`);
console.log(`   SMTP_USER   ${c.user ?? '⚠ sin definir'}`);
console.log(`   SMTP_PASS   ${c.pass ? `definida, ${c.pass.length} caracteres` : '⚠ sin definir'}`);
console.log(`   Remitente   ${c.from}`);
console.log(`   BASE_URL    ${baseUrl()}   ← los enlaces de los correos apuntan aquí`);

if (c.pass && c.pass.length !== 16 && c.host.includes('gmail')) {
  console.log(`\n   ⚠ Una contraseña de aplicación de Google tiene 16 caracteres; la tuya tiene ${c.pass.length}.`);
  console.log('     (Los espacios ya se quitan solos, así que pegarla con espacios no es problema.)');
}

console.log('\n🔌 Probando conexión y credenciales…');
const r = await verificarSmtp();

if (r.ok) {
  console.log('   ✔ Conectado y autenticado correctamente.\n');
} else {
  console.log(`   ✘ ${r.error}`);
  if (r.codigo) console.log(`     código: ${r.codigo}`);
  if (r.respuesta) console.log(`     respuesta del servidor: ${String(r.respuesta).trim()}`);
  console.log('');
  const t = String(r.error ?? '') + String(r.respuesta ?? '');
  if (/Username and Password not accepted|BadCredentials|535/i.test(t)) {
    console.log('   Suele ser una de estas tres:');
    console.log('     1. Estás usando tu contraseña normal. Google exige una CONTRASEÑA DE');
    console.log('        APLICACIÓN: https://myaccount.google.com/apppasswords');
    console.log('     2. La cuenta no tiene verificación en dos pasos activada — sin ella');
    console.log('        Google no deja crear contraseñas de aplicación.');
    console.log('     3. Xertica (Workspace) tiene bloqueado el acceso SMTP para tu cuenta;');
    console.log('        lo habilita un administrador en la consola de Admin.');
  } else if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ESOCKET/i.test(t)) {
    console.log('   Parece un problema de red, no de credenciales:');
    console.log('     · un cortafuegos o una VPN bloqueando el puerto ' + c.port);
    console.log('     · prueba SMTP_PORT=587 (STARTTLS), que suele estar menos filtrado');
  }
  process.exit(1);
}

if (!destino) {
  console.log('   Para mandar un mensaje de prueba real:');
  console.log('     npm run correo -- --enviar tu@correo.pe\n');
  process.exit(0);
}

console.log(`✉ Enviando mensaje de prueba a ${destino}…`);
const ok = await enviar({
  destinatarios: [destino],
  asunto: '✅ Prueba de SEACE Alertas',
  texto: 'Si lees esto, el correo de SEACE Alertas funciona.',
  html: `<div style="font-family:Arial,Helvetica,sans-serif;background:#f3f4f6;padding:28px;">
    <div style="max-width:460px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border-top:4px solid #FF4DA6;">
      <div style="background:#047EA9;color:#fff;padding:18px 22px;font-size:17px;font-weight:bold;">
        ✅ El correo funciona
      </div>
      <div style="padding:22px;color:#374151;font-size:14px;line-height:1.6;">
        Si estás leyendo esto, SEACE Alertas ya puede enviar enlaces de acceso,
        invitaciones y alertas.
        <p style="color:#9ca3af;font-size:12px;margin:18px 0 0;">
          Enviado desde <b>${c.user}</b> vía ${c.host}:${c.port}.<br>
          Los enlaces de los correos apuntarán a <b>${baseUrl()}</b>.
        </p>
      </div>
    </div></div>`,
});

console.log(ok
  ? `\n   ✔ Enviado. Revisa la bandeja de ${destino} (y la carpeta de spam la primera vez).\n`
  : '\n   ✘ No se pudo enviar. Mira el error de arriba.\n');
process.exit(ok ? 0 : 1);
