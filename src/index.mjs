// ──────────────────────────────────────────────────────────────────────────────
// seace-alertas · v1
// Baja las convocatorias recientes del SEACE (API abierta OCDS del OECE),
// filtra las relevantes para Xertica por keywords y genera un digest HTML de
// correo en out/. Con `--send` (y SMTP_* configurado) además lo envía.
//
//   npm run digest          → genera out/digest-YYYY-MM-DD.html
//   npm run digest:send     → genera y envía por correo
// ──────────────────────────────────────────────────────────────────────────────

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchRecent } from './seace.mjs';
import { filtrarRelevantes } from './digest.mjs';
import { renderEmail } from './emailHtml.mjs';
import { enviar } from './send.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));

const hasta = new Date();
const cutoff = new Date(hasta.getTime() - (config.diasHaciaAtras ?? 2) * 86_400_000);

console.log(`🏛️ SEACE Alertas — buscando convocatorias desde ${cutoff.toISOString().slice(0, 10)}…`);

const { procesos, capAlcanzado } = await fetchRecent({
  cutoff,
  maxPaginas: config.maxPaginas ?? 120,
  onProgress: (page, total) => {
    if (page % 20 === 0) console.log(`   página ${page} · ${total} procesos en rango…`);
  },
});
console.log(`   ${procesos.length} procesos publicados en el período.`);
if (capAlcanzado) {
  console.warn('⚠ Se alcanzó maxPaginas: puede haber procesos del período sin escanear (sube maxPaginas en config.json).');
}

const relevantes = filtrarRelevantes(procesos, config);
console.log(`   ${relevantes.length} relevantes para Xertica.`);
for (const p of relevantes.slice(0, 15)) {
  console.log(`   • [${p.score}] ${p.entidad.slice(0, 45)} — ${(p.descripcion || p.nomenclatura).slice(0, 70)}`);
}

const html = renderEmail({
  procesos: relevantes,
  desde: cutoff.toISOString(),
  hasta: hasta.toISOString(),
  totalEscaneados: procesos.length,
});

mkdirSync(join(ROOT, 'out'), { recursive: true });
const outFile = join(ROOT, 'out', `digest-${hasta.toISOString().slice(0, 10)}.html`);
writeFileSync(outFile, html, 'utf8');
console.log(`📄 Digest generado: ${outFile}`);

if (process.argv.includes('--send')) {
  const asunto = `${config.asuntoPrefijo ?? 'SEACE'} · ${relevantes.length} convocatoria${relevantes.length === 1 ? '' : 's'} · ${hasta.toLocaleDateString('es-PE')}`;
  await enviar({ html, asunto, destinatarios: config.destinatarios ?? [] });
}
