// scripts/refresh-and-bake.mjs
//
// Corre en el GitHub Action (.github/workflows/refresh-data.yml). Trae datos
// frescos de Stripe y los hornea directo en index.html, reemplazando:
//   - let CMAP={...}
//   - let RAW=[...]
//   - let INV_DATA=[...]
//   - let CUS_MRR={...}
// más el número de build y el texto del footer ("Actualizado: ...", "NNN
// subs · mon YYYY – mon YYYY").
//
// A diferencia del botón "Actualizar" del navegador (que solo actualiza la
// memoria/localStorage de esa pestaña), esto reescribe el archivo del repo,
// así que el próximo `git pull` / deploy de Vercel ya sirve los datos
// nuevos horneados — no hace falta que nadie copie/pegue nada a mano.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fetchStripeDataset } from '../api/_stripe-data.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, '..', 'index.html');

// ---------- reemplazo seguro de literales JS (respeta strings con [ ] { } adentro) ----------
function findLiteralEnd(source, openIdx) {
  let depth = 0;
  let inString = null;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Literal sin cerrar empezando en la posición ${openIdx}`);
}

function replaceJsLiteral(source, varName, newValue) {
  const declRe = new RegExp(`(let|const)\\s+${varName}\\s*=\\s*`);
  const m = declRe.exec(source);
  if (!m) throw new Error(`No encontré "let/const ${varName} = ..." en index.html`);
  const openIdx = m.index + m[0].length;
  if (source[openIdx] !== '[' && source[openIdx] !== '{') {
    throw new Error(`${varName}: se esperaba "[" o "{" en la posición ${openIdx}`);
  }
  const endIdx = findLiteralEnd(source, openIdx);
  let semiIdx = endIdx + 1;
  while (source[semiIdx] === ' ') semiIdx++;
  if (source[semiIdx] !== ';') {
    throw new Error(`${varName}: no encontré ";" después del literal (pos ${semiIdx})`);
  }
  const before = source.slice(0, openIdx);
  const after = source.slice(semiIdx + 1);
  return before + JSON.stringify(newValue) + ';' + after;
}

// ---------- helpers de formato ----------
// OJO 1: no usamos toLocaleDateString('es-AR', ...) acá porque el ICU de
// Node en el runner de GitHub Actions puede formatear distinto que el
// navegador (probado: devuelve "a. m."/"de ago de" en vez de "22:54"/"jul").
// Armamos el mismo formato a mano para que sea determinístico.
// OJO 2: el Action corre en UTC, pero el dashboard se ve en hora de
// Argentina (UTC-3, sin horario de verano desde 2009) — restamos 3hs antes
// de extraer los componentes UTC para que coincida con lo que ve el usuario.
const AR_OFFSET_SEC = 3 * 3600;
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const pad2 = (n) => String(n).padStart(2, '0');
const toArTime = (d) => new Date(d.getTime() - AR_OFFSET_SEC * 1000);

const fmtMY = (ts) => {
  const d = toArTime(new Date(ts * 1000));
  return `${MESES[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(-2)}`;
};
const fmtStamp = (d) => {
  const ar = toArTime(d);
  return `${pad2(ar.getUTCDate())} ${MESES[ar.getUTCMonth()]} ${ar.getUTCFullYear()}, ${pad2(ar.getUTCHours())}:${pad2(ar.getUTCMinutes())}`;
};

function bumpBuildNumber(source) {
  const nums = [...source.matchAll(/build\.(\d+)/g)].map((m) => parseInt(m[1], 10));
  if (nums.length === 0) throw new Error('No encontré ningún "build.NNN" en index.html');
  const next = Math.max(...nums) + 1;
  return { next, source: source.replace(/build\.\d+/g, `build.${next}`) };
}

function updateBuildTimestamp(source, nowEpoch) {
  // "build.NNN · 1786066675" -> "build.NNN · <nowEpoch>" (las dos ocurrencias:
  // el footer estático y el template string que usa updateSidebarFooter()).
  return source.replace(/(build\.\d+ · )\d+/g, `$1${nowEpoch}`);
}

function updateStaticFooterText(source, raw, now) {
  const created = raw.map((r) => r.c);
  const minC = Math.min(...created);
  const maxC = Math.max(...created);
  const subsLine = `${raw.length} subs · ${fmtMY(minC)} – ${fmtMY(maxC)}`;
  const stampLine = fmtStamp(now);

  // Sidebar footer estático (antes de que corra ningún JS de refresh):
  // <div>721 subs · abr 2025 – may 2026</div>
  source = source.replace(
    /\d+ subs · [^<]+–[^<]+/,
    subsLine
  );
  // Badge "Actualizado: <strong id="last-updated">28 jul 2026, 22:54</strong>"
  source = source.replace(
    /(<strong id="last-updated">)[^<]*(<\/strong>)/,
    `$1${stampLine}$2`
  );
  return source;
}

async function main() {
  console.log('Trayendo datos frescos de Stripe...');
  const dataset = await fetchStripeDataset();
  console.log(
    `OK — ${dataset.counts.subscriptions} subscriptions, ${dataset.counts.invoices} invoices, ` +
    `${dataset.RAW.length} filas RAW, ${Object.keys(dataset.CUS_MRR).length} CUS_MRR, ` +
    `${dataset.INV_DATA.length} INV_DATA, ${Object.keys(dataset.CMAP).length} CMAP.`
  );

  let html = readFileSync(INDEX_PATH, 'utf8');

  html = replaceJsLiteral(html, 'CMAP', dataset.CMAP);
  html = replaceJsLiteral(html, 'RAW', dataset.RAW);
  html = replaceJsLiteral(html, 'INV_DATA', dataset.INV_DATA);
  html = replaceJsLiteral(html, 'CUS_MRR', dataset.CUS_MRR);

  const now = new Date();
  const { next: buildNumber, source: withBuild } = bumpBuildNumber(html);
  html = withBuild;
  html = updateBuildTimestamp(html, Math.floor(now.getTime() / 1000));
  html = updateStaticFooterText(html, dataset.RAW, now);

  writeFileSync(INDEX_PATH, html, 'utf8');
  console.log(`Listo — index.html horneado como build.${buildNumber}.`);
}

main().catch((err) => {
  console.error('refresh-and-bake falló:', err);
  process.exit(1);
});
