// Sync the Apple microsite catalog with the live WooCommerce Store API.
//
// What it does, every run:
//   1. Fetches every product tagged brand=159 (Apple) from digitalmtx.com's Store API.
//   2. Classifies each into a site line (iphone/mac/ipad/watch/airpods/accesorios) by
//      product title (not the full marketing description, which mentions other devices).
//   3. Downloads any product photo not already in assets-originales, runs it through the
//      same cutout/whiten/enhance pipeline as every existing photo, and installs the
//      processed copy into assets/img.
//   4. Regenerates each subpage's product grid, the homepage's full catalog list, the
//      search index (products.js), and the "Desde $X" price on each homepage hub card.
//   5. Rebuilds the single-file artifact.html bundle.
//
// What it does NOT do: upload anything to the live digitalmtx.com server. That step
// needs the FTP password, which — by design — only gets used when the user pastes it
// into the chat for that specific run; it can't be pulled from stored memory and used
// unattended. Run tools/deploy-ftp.md's steps (or ask Claude) once this script reports
// changes, to push the regenerated files live.
//
// Usage: node tools/sync-catalog.js

const fs = require('fs');
const path = require('path');
const https = require('https');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');                              // apple-tienda-oficial/
const ORIGINALS = path.join(ROOT, '..', 'apple-tienda-originales');   // sibling project folder
const ORIG_IMG = path.join(ORIGINALS, 'img');
const SITE_IMG = path.join(ROOT, 'assets', 'img');
const CUTOUT_PIPELINE_SRC = path.join(ORIGINALS, 'tools', 'cutout-pipeline.js');
const PROCESSED_DIR = path.join(__dirname, 'processed');

const API_BASE = 'https://digitalmtx.com/wp-json/wc/store/v1/products';
const BRAND_ID = 159;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'apple-tienda-sync/1.0' } }, res => {
      if (res.statusCode >= 400) { reject(new Error(`${res.statusCode} ${url}`)); return; }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ body: data, headers: res.headers }));
    }).on('error', reject);
  });
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'apple-tienda-sync/1.0' } }, res => {
      if (res.statusCode >= 400) { reject(new Error(`${res.statusCode} ${url}`)); return; }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

async function fetchAllApple() {
  const perPage = 100;
  let page = 1, all = [], totalPages = 1;
  do {
    const { body, headers } = await get(`${API_BASE}?brand=${BRAND_ID}&per_page=${perPage}&page=${page}`);
    all = all.concat(JSON.parse(body));
    totalPages = Number(headers['x-wp-totalpages'] || 1);
    page++;
  } while (page <= totalPages);
  return all;
}

function decodeEntities(s) {
  return s
    .replace(/&#8243;/g, '"').replace(/&#8211;/g, '-').replace(/&#215;/g, 'x')
    .replace(/&amp;/g, '&').replace(/&#8217;/g, "'").replace(/&#8220;|&#8221;/g, '"');
}
function cleanTitle(name) {
  const d = decodeEntities(name);
  const idx = d.indexOf(' - ');
  return (idx === -1 ? d : d.slice(0, idx)).trim();
}
function classify(title) {
  const n = title.toLowerCase();
  if (/macbook|mac\s*mini|mac\s*studio|\bimac\b|\bmac\b/.test(n)) return 'mac';
  if (/\biphone\b/.test(n)) return 'iphone';
  if (/\bipad\b/.test(n)) return 'ipad';
  if (/\bwatch\b/.test(n)) return 'watch';
  if (/airpods|earpods/.test(n)) return 'airpods';
  return 'accesorios';
}
function shortDesc(html) {
  let t = decodeEntities((html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  if (t.length > 78) { t = t.slice(0, 78); t = t.slice(0, t.lastIndexOf(' ')) + '…'; }
  return t;
}
function fmtCOP(n) { return '$' + Math.round(n).toLocaleString('es-CO').replace(/,/g, '.'); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ---------- image pipeline (mirrors tools/process-images-reference.js) ----------
// cutout-pipeline.js is the runtime chunk lifted out of site.js — it also carries
// browser-only IIFEs at the end (they touch `document`), so pull out just the three
// named functions instead of eval'ing the whole file.
const pipelineFile = fs.readFileSync(CUTOUT_PIPELINE_SRC, 'utf8');
function grabFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing function in cutout-pipeline.js: ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
const pipelineCode = ['boxBlurChannel', 'enhanceImageData', 'polishAlpha', 'cutoutBackground']
  .map(name => grabFn(pipelineFile, name)).join('\n');
const pipeline = new Function(pipelineCode + '\nreturn {enhanceImageData, cutoutBackground, polishAlpha};')();

function morphCross(m, w, h, dilate) {
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const c = m[i];
    const l = x > 0 ? m[i - 1] : (dilate ? 0 : 1), r = x < w - 1 ? m[i + 1] : (dilate ? 0 : 1);
    const u = y > 0 ? m[i - w] : (dilate ? 0 : 1), d = y < h - 1 ? m[i + w] : (dilate ? 0 : 1);
    o[i] = dilate ? (c | l | r | u | d) : (c & l & r & u & d);
  }
  return o;
}
function refineSilhouette(px, w, h, light, bigClose, CR) {
  const n = w * h;
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = px[i * 4 + 3];
  const lumAt = (i) => (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
  if (light) {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = a[i] > 127 ? 1 : 0;
    const hw = w >> 1, hh = h >> 1;
    let lo = new Uint8Array(hw * hh);
    for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) lo[y * hw + x] = b[(2 * y) * w + 2 * x];
    for (let k = 0; k < CR; k++) lo = morphCross(lo, hw, hh, true);
    for (let k = 0; k < CR; k++) lo = morphCross(lo, hw, hh, false);
    const cl = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cl[y * w + x] = lo[Math.min(hh - 1, y >> 1) * hw + Math.min(hw - 1, x >> 1)];
    for (let i = 0; i < n; i++) if (cl[i] && !b[i] && lumAt(i) > 190) { a[i] = 255; b[i] = 1; }
    const opened = morph2(morph2(b, w, h, 3, false), w, h, 3, true);
    for (let i = 0; i < n; i++) if (b[i] && !opened[i] && lumAt(i) > 200) a[i] = 0;
    const clear = new Uint8Array(n);
    for (let i = 0; i < n; i++) clear[i] = a[i] === 0 ? 1 : 0;
    const near = morph2(clear, w, h, 2, true);
    for (let i = 0; i < n; i++) if (a[i] > 0 && near[i] && lumAt(i) > 226) a[i] = Math.round(a[i] * 0.25);
  }
  let src = a;
  for (let pass = 0; pass < 2; pass++) {
    const dst = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sum = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        sum += src[yy * w + xx]; c++;
      }
      dst[y * w + x] = Math.round(sum / c);
    }
    src = dst;
  }
  for (let i = 0; i < n; i++) px[i * 4 + 3] = src[i];
}
function morph2(mask, w, h, r, dilate) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const keep = dilate ? 1 : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let k = -r; k <= r; k++) {
      const xx = x + k; const m = xx < 0 || xx >= w ? (dilate ? 0 : 1) : mask[y * w + xx];
      if (dilate ? m : !m) { v = keep; break; }
    }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let k = -r; k <= r; k++) {
      const yy = y + k; const m = yy < 0 || yy >= h ? (dilate ? 0 : 1) : tmp[yy * w + x];
      if (dilate ? m : !m) { v = keep; break; }
    }
    out[y * w + x] = v;
  }
  return out;
}
function shadowUnder(data, w, h, box) {
  const cx = (box.minX + box.maxX) / 2;
  const footY = box.maxY - (box.maxY - box.minY) * 0.03;
  const rx = (box.maxX - box.minX) * 0.4;
  const ry = rx * 0.22;
  if (rx < 4) return;
  const y0 = Math.max(0, Math.floor(footY - ry)), y1 = Math.min(h - 1, Math.ceil(footY + ry));
  const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(w - 1, Math.ceil(cx + rx));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = (x - cx) / rx, dy = (y - footY) / ry;
    const rr = Math.sqrt(dx * dx + dy * dy);
    if (rr >= 1) continue;
    const sa = rr < 0.7 ? 0.14 + (0.05 - 0.14) * (rr / 0.7) : 0.05 * (1 - (rr - 0.7) / 0.3);
    const p = (y * w + x) * 4;
    const a = data[p + 3] / 255, outA = a + sa * (1 - a);
    if (outA <= 0) continue;
    data[p] = Math.round(data[p] * a / outA);
    data[p + 1] = Math.round(data[p + 1] * a / outA);
    data[p + 2] = Math.round(data[p + 2] * a / outA);
    data[p + 3] = Math.round(outA * 255);
  }
}
async function autoCropMargin(buf) {
  const probeMax = 360;
  const meta = await sharp(buf).metadata();
  const scale = Math.min(1, probeMax / Math.max(meta.width, meta.height));
  const pw = Math.max(1, Math.round(meta.width * scale)), ph = Math.max(1, Math.round(meta.height * scale));
  const raw = await sharp(buf).resize(pw, ph, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer();
  const px = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length);
  const corners = [0, (pw - 1) * 4, (ph - 1) * pw * 4, ((ph - 1) * pw + pw - 1) * 4];
  const ref = [px[corners[0]], px[corners[0] + 1], px[corners[0] + 2]];
  const spread = corners.reduce((m, c) => Math.max(m, Math.abs(px[c] - ref[0]) + Math.abs(px[c + 1] - ref[1]) + Math.abs(px[c + 2] - ref[2])), 0);
  if (spread > 30) return null;
  const box = { data: px };
  pipeline.cutoutBackground(box, pw, ph, 16);
  let minX = pw, maxX = -1, minY = ph, maxY = -1;
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    if (px[(y * pw + x) * 4 + 3] > 40) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX < 0) return null;
  const marginFrac = Math.min(minX, pw - 1 - maxX, minY, ph - 1 - maxY) / Math.min(pw, ph);
  if (marginFrac < 0.035) return null;
  const pad = 0.05;
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const x0 = Math.max(0, minX - cw * pad) / pw, x1 = Math.min(pw, maxX + 1 + cw * pad) / pw;
  const y0 = Math.max(0, minY - ch * pad) / ph, y1 = Math.min(ph, maxY + 1 + ch * pad) / ph;
  const left = Math.round(x0 * meta.width), top = Math.round(y0 * meta.height);
  const width = Math.min(meta.width - left, Math.round((x1 - x0) * meta.width));
  const height = Math.min(meta.height - top, Math.round((y1 - y0) * meta.height));
  if (width < 20 || height < 20) return null;
  return sharp(buf).extract({ left, top, width, height }).toBuffer();
}
async function processOne(fname) {
  const CR = 60;
  let inBuf = fs.readFileSync(path.join(ORIG_IMG, fname));
  const cropped = await autoCropMargin(inBuf);
  if (cropped) inBuf = cropped;
  const meta = await sharp(inBuf).metadata();
  const scale = 1.25, SS = 2;
  const W = Math.round(meta.width * scale), H = Math.round(meta.height * scale);
  const probeRaw = await sharp(inBuf).resize(W, H, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer();
  const strict = { data: new Uint8ClampedArray(probeRaw) };
  pipeline.cutoutBackground(strict, W, H, 4);
  let solid = 0, bright = 0;
  for (let q = 0; q < strict.data.length; q += 4) {
    if (strict.data[q + 3] < 200) continue;
    solid++;
    if ((strict.data[q] + strict.data[q + 1] + strict.data[q + 2]) / 3 > 205) bright++;
  }
  const light = solid > 0 && bright / solid > 0.42;
  const w = W, h = H;
  let px;
  if (light) {
    px = new Uint8ClampedArray(probeRaw.buffer, probeRaw.byteOffset, probeRaw.length);
    pipeline.enhanceImageData({ data: px }, w, h);
  } else {
    const w2 = W * SS, h2 = H * SS;
    const hi = await sharp(inBuf).resize(w2, h2, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer();
    const hiPx = new Uint8ClampedArray(hi.buffer, hi.byteOffset, hi.length);
    pipeline.cutoutBackground({ data: hiPx }, w2, h2, 9);
    refineSilhouette(hiPx, w2, h2, false, false, CR);
    const lo = await sharp(Buffer.from(hiPx.buffer, hiPx.byteOffset, hiPx.length), { raw: { width: w2, height: h2, channels: 4 } })
      .resize(W, H, { kernel: 'lanczos3' }).raw().toBuffer();
    px = new Uint8ClampedArray(lo.buffer, lo.byteOffset, lo.length);
    pipeline.enhanceImageData({ data: px }, w, h);
    let minX = w, maxX = 0, minY = h, maxY = 0, any = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 40) { any = true; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (any) shadowUnder(px, w, h, { minX, maxX, minY, maxY });
  }
  const outBuf = await sharp(Buffer.from(px.buffer, px.byteOffset, px.length), { raw: { width: w, height: h, channels: 4 } })
    .webp({ quality: 86, alphaQuality: 92, effort: 5 }).toBuffer();
  fs.mkdirSync(PROCESSED_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROCESSED_DIR, fname), outBuf);
}

// ---------- HTML regeneration (mirrors the one-off gen_catalog.js) ----------
const pages = {
  iphone: 'iphone/index.html', mac: 'mac/index.html', ipad: 'ipad/index.html',
  watch: 'watch/index.html', airpods: 'airpods/index.html', accesorios: 'accesorios/index.html'
};
const hubHref = { iphone: 'iphone/', mac: 'mac/', ipad: 'ipad/', watch: 'watch/', airpods: 'airpods/', accesorios: 'accesorios/' };
const order = ['iphone', 'mac', 'ipad', 'watch', 'airpods', 'accesorios'];

function regenerateSite(rows) {
  const byLine = {};
  rows.forEach(r => { (byLine[r.l] = byLine[r.l] || []).push(r); });
  Object.values(byLine).forEach(list => list.sort((a, b) => b.p - a.p));

  Object.entries(pages).forEach(([line, file]) => {
    const list = byLine[line] || [];
    const cards = list.map((r, i) => {
      const priceOld = r.po ? `<span class="price-old">${fmtCOP(r.po)}</span>` : '';
      return `          <a class="pcard reveal" href="${r.u}" target="_blank" rel="noopener" style="--d:${(i % 6) * 60}ms">
            <span class="pcard-img" style="background-image:url('../assets/img/${r.imgfile}')"></span>
            <b>${esc(r.n)}</b>
            <span class="pcard-sub">${esc(r.sub)}</span>
            <span class="pcard-price">${fmtCOP(r.p)}${priceOld}</span>
          </a>`;
    }).join('\n');
    const p = path.join(ROOT, file);
    let html = fs.readFileSync(p, 'utf8');
    const re = /(<div class="pgrid[^"]*">\n)([\s\S]*?)(\n {4}<\/div>)/;
    if (!re.test(html)) throw new Error('pgrid marker not found in ' + file);
    html = html.replace(re, (m, open, _old, close) => open + cards + close);
    fs.writeFileSync(p, html);
  });

  const rowsHtml = order.map(line => (byLine[line] || []).map(r => {
    const priceOld = r.po ? `<span class="price-old">${fmtCOP(r.po)}</span>` : '';
    return `          <a class="prow reveal" data-line="${line}" href="${r.u}" target="_blank" rel="noopener">
            <span class="prow-img" style="background-image:url('assets/img/${r.imgfile}')"></span>
            <span class="prow-info"><b>${esc(r.n)}</b><span>${esc(r.sub)}</span></span>
            <span class="prow-price">${fmtCOP(r.p)}${priceOld}</span>
          </a>`;
  }).join('\n')).join('\n');

  {
    const p = path.join(ROOT, 'index.html');
    let html = fs.readFileSync(p, 'utf8');
    const re = /(<div class="plist" id="catalogList">\n)([\s\S]*?)(\n {4}<\/div>)/;
    if (!re.test(html)) throw new Error('plist marker not found');
    html = html.replace(re, (m, open, _old, close) => open + rowsHtml + close);

    const minByLine = {};
    order.forEach(l => { minByLine[l] = Math.min(...(byLine[l] || []).map(r => r.p)); });
    Object.entries(hubHref).forEach(([line, href]) => {
      const re2 = new RegExp(`(<a class="hubcard[^>]*href="${href}">[\\s\\S]*?<b class="hubcard-price">)Desde \\$[\\d.,]+(</b>)`);
      html = html.replace(re2, (m, pre, post) => pre + 'Desde ' + fmtCOP(minByLine[line]) + post);
    });
    fs.writeFileSync(p, html);
  }

  {
    const items = rows.map(r => ({ n: r.n, p: r.p, i: r.img, u: r.u, l: r.l }));
    fs.writeFileSync(path.join(ROOT, 'assets', 'products.js'), 'var APPLE_PRODUCTS = ' + JSON.stringify(items) + ';\n');
  }
}

// ---------- main ----------
(async () => {
  console.log('Fetching Apple-brand catalog from the Store API…');
  const raw = await fetchAllApple();
  console.log(`  ${raw.length} products returned`);

  const rows = raw.map(p => {
    const title = cleanTitle(p.name);
    const price = Number(p.prices.price);
    const regular = Number(p.prices.regular_price);
    const onSale = p.on_sale && regular > price;
    const img = p.images[0] ? p.images[0].src : null;
    return {
      id: p.id, n: title, p: price, po: onSale ? regular : null, img,
      u: p.permalink, l: classify(title), sub: shortDesc(p.short_description),
      imgfile: img ? decodeURIComponent(img.split('/').pop()) : null
    };
  }).filter(r => r.imgfile);

  const have = new Set(fs.readdirSync(ORIG_IMG));
  const needed = [...new Map(rows.filter(r => !have.has(r.imgfile)).map(r => [r.imgfile, r.img])).entries()];

  if (needed.length === 0) {
    console.log('No new products since the last sync — catalog already up to date.');
  } else {
    console.log(`${needed.length} new product photo(s) to download and process:`);
    needed.forEach(([f]) => console.log('  ' + f));
    for (const [fname, url] of needed) {
      await download(url, path.join(ORIG_IMG, fname));
    }
    console.log('Downloaded. Running the cutout/enhance pipeline…');
    for (const [fname] of needed) {
      await processOne(fname);
      const processedPath = path.join(PROCESSED_DIR, fname);
      fs.copyFileSync(processedPath, path.join(SITE_IMG, fname));
    }
    console.log('Processed and installed', needed.length, 'photo(s).');
  }

  console.log('Regenerating product grids, catalog list, search index, hub prices…');
  regenerateSite(rows);

  console.log('Rebuilding artifact.html…');
  require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'build-artifact.js')], { stdio: 'inherit' });

  const byLine = {};
  rows.forEach(r => { byLine[r.l] = (byLine[r.l] || 0) + 1; });
  console.log('\nDone. Current catalog:', JSON.stringify(byLine));
  if (needed.length > 0) {
    console.log(`\n${needed.length} new product(s) were added. The local files and artifact.html are updated.`);
    console.log('Production (digitalmtx.com) was NOT touched — that upload needs the FTP password given fresh in chat each time.');
  }
})().catch(err => { console.error('SYNC FAILED:', err); process.exit(1); });
