const CR = parseInt(process.env.CR || '36', 10);
// Build-time port of the browser pipeline: reuses the exact algorithm source from site.js
// (cutoutBackground / polishAlpha / enhanceImageData) so results match what was approved.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = 'D:\\Proyectos Mecha Labs\\MTX\\apple-tienda-oficial';
const IMG = "D:/Proyectos Mecha Labs/MTX/apple-tienda-originales/img"; // untouched originals
const OUT = path.join(__dirname, 'processed');
fs.mkdirSync(OUT, { recursive: true });

const src = fs.readFileSync("D:/Proyectos Mecha Labs/MTX/apple-tienda-originales/tools/cutout-pipeline.js", "utf8");
function grab(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
const code = ['boxBlurChannel', 'enhanceImageData', 'polishAlpha', 'cutoutBackground'].map(grab).join('\n');
const lib = new Function(code + '\nreturn {enhanceImageData, cutoutBackground};')();

function shadowUnder(data, w, h, box) {
  const cx = (box.minX + box.maxX) / 2;
  const footY = box.maxY - (box.maxY - box.minY) * 0.03;
  const rx = (box.maxX - box.minX) * 0.4;
  const ry = rx * 0.22;
  if (rx < 4) return;
  const y0 = Math.max(0, Math.floor(footY - ry)), y1 = Math.min(h - 1, Math.ceil(footY + ry));
  const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(w - 1, Math.ceil(cx + rx));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / rx, dy = (y - footY) / ry;
      const rr = Math.sqrt(dx * dx + dy * dy); // ellipse radius, 0 centre .. 1 edge
      if (rr >= 1) continue;
      const sa = rr < 0.7 ? 0.14 + (0.05 - 0.14) * (rr / 0.7) : 0.05 * (1 - (rr - 0.7) / 0.3);
      const p = (y * w + x) * 4;
      const a = data[p + 3] / 255;
      const outA = a + sa * (1 - a);
      if (outA <= 0) continue;
      data[p] = Math.round(data[p] * a / outA);
      data[p + 1] = Math.round(data[p + 1] * a / outA);
      data[p + 2] = Math.round(data[p + 2] * a / outA);
      data[p + 3] = Math.round(outA * 255);
    }
  }
}

// separable square erode/dilate on a binary mask
function morph(mask, w, h, r, dilate) {
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

// one 4-neighbour dilate/erode step (repeat r times for a diamond of radius r)
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

// 2x-resolution silhouette clean-up: drop thin bright slivers/specks, trim the
// near-white fringe, then soften the alpha edge (anti-aliased once downscaled).
function refineSilhouette(px, w, h, light, bigClose) {
  const n = w * h;
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = px[i * 4 + 3];
  const lumAt = (i) => (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
  if (light) {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = a[i] > 127 ? 1 : 0;
    // closing (diamond, r=22): a white highlight the same colour as the backdrop can
    // leave a "bite" in the silhouette (EarPods dome, charger flank) — fill narrow
    // bites/channels back in, but only with near-white pixels.
    // run the closing on a half-resolution mask (4x cheaper), then map back
    const hw = w >> 1, hh = h >> 1;
    let lo = new Uint8Array(hw * hh);
    for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) lo[y * hw + x] = b[(2 * y) * w + 2 * x];
    // big shapes (case, charger) only get a gentle closing — a large one grows
    // wedges in their corners; small pieces (EarPods bud + cable) get the large one
    const label = new Int32Array(hw * hh), areas = [0];
    for (let s0 = 0; s0 < hw * hh; s0++) {
      if (!lo[s0] || label[s0]) continue;
      const id = areas.length; let cnt = 0; const q = [s0]; label[s0] = id;
      while (q.length) {
        const c = q.pop(); cnt++;
        const cx = c % hw, cy = (c / hw) | 0;
        const nb = [cx > 0 ? c - 1 : -1, cx < hw - 1 ? c + 1 : -1, cy > 0 ? c - hw : -1, cy < hh - 1 ? c + hw : -1];
        for (const m of nb) if (m >= 0 && lo[m] && !label[m]) { label[m] = id; q.push(m); }
      }
      areas.push(cnt);
    }
    let small = new Uint8Array(hw * hh), big = new Uint8Array(hw * hh);
    for (let i = 0; i < hw * hh; i++) if (lo[i]) (areas[label[i]] < 0.04 * hw * hh ? small : big)[i] = 1;
    for (let k = 0; k < CR; k++) small = morphCross(small, hw, hh, true);
    for (let k = 0; k < CR; k++) small = morphCross(small, hw, hh, false);
    const BR = bigClose ? CR : 10;
    for (let k = 0; k < BR; k++) big = morphCross(big, hw, hh, true);
    for (let k = 0; k < BR; k++) big = morphCross(big, hw, hh, false);
    for (let i = 0; i < hw * hh; i++) lo[i] = small[i] | big[i];
    const cl = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cl[y * w + x] = lo[Math.min(hh - 1, y >> 1) * hw + Math.min(hw - 1, x >> 1)];
    let filled = 0, cand = 0; for (let i = 0; i < n; i++) if (cl[i] && !b[i]) { cand++; if (lumAt(i) > 190) { a[i] = 255; b[i] = 1; filled++; } } if (process.env.DEBUG) console.log("closing cand", cand, "filled", filled, "of", n);
    const opened = morph(morph(b, w, h, 3, false), w, h, 3, true);
    for (let i = 0; i < n; i++) if (b[i] && !opened[i] && lumAt(i) > 200) a[i] = 0;
    const clear = new Uint8Array(n);
    for (let i = 0; i < n; i++) clear[i] = a[i] === 0 ? 1 : 0;
    const near = morph(clear, w, h, 2, true);
    for (let i = 0; i < n; i++) if (a[i] > 0 && near[i] && lumAt(i) > 226) a[i] = Math.round(a[i] * 0.25);
  }
  // two 3x3 box passes on alpha
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

// Trim the excess studio-backdrop margin so the product fills its frame — a
// product shot on a big square canvas with lots of plain border around it
// renders small inside the (landscape) hero stage, leaving dead space where
// callout text ends up floating disconnected from the product. Skip images
// that are full-bleed (a screen-recording thumbnail, no real backdrop).
async function autoCropMargin(buf) {
  const probeMax = 360;
  const meta = await sharp(buf).metadata();
  const scale = Math.min(1, probeMax / Math.max(meta.width, meta.height));
  const pw = Math.max(1, Math.round(meta.width * scale)), ph = Math.max(1, Math.round(meta.height * scale));
  const raw = await sharp(buf).resize(pw, ph, { kernel: "lanczos3" }).ensureAlpha().raw().toBuffer();
  const px = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length);
  const corners = [0, (pw - 1) * 4, (ph - 1) * pw * 4, ((ph - 1) * pw + pw - 1) * 4];
  const ref = [px[corners[0]], px[corners[0] + 1], px[corners[0] + 2]];
  const cornerSpread = corners.reduce((m, c) => Math.max(m, Math.abs(px[c] - ref[0]) + Math.abs(px[c + 1] - ref[1]) + Math.abs(px[c + 2] - ref[2])), 0);
  if (cornerSpread > 30) return null; // corners disagree -> no uniform backdrop, leave as-is
  const box = { data: px };
  lib.cutoutBackground(box, pw, ph, 16);
  let minX = pw, maxX = -1, minY = ph, maxY = -1;
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    if (px[(y * pw + x) * 4 + 3] > 40) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX < 0) return null;
  const marginFrac = Math.min(minX, pw - 1 - maxX, minY, ph - 1 - maxY) / Math.min(pw, ph);
  if (marginFrac < 0.035) return null; // already tight (or full-bleed) — nothing worth trimming
  const pad = 0.05; // keep a small breathing margin around the product
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const x0 = Math.max(0, minX - cw * pad) / pw, x1 = Math.min(pw, maxX + 1 + cw * pad) / pw;
  const y0 = Math.max(0, minY - ch * pad) / ph, y1 = Math.min(ph, maxY + 1 + ch * pad) / ph;
  const left = Math.round(x0 * meta.width), top = Math.round(y0 * meta.height);
  const width = Math.min(meta.width - left, Math.round((x1 - x0) * meta.width));
  const height = Math.min(meta.height - top, Math.round((y1 - y0) * meta.height));
  if (width < 20 || height < 20) return null;
  return sharp(buf).extract({ left, top, width, height }).toBuffer();
}

(async () => {
  const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const files = fs.readdirSync(IMG).filter(f => f.endsWith('.webp') && (!ONLY || ONLY.some(o => f.startsWith(o))));
  let totalIn = 0, totalOut = 0;
  const report = [];
  for (const f of files) {
    let inBuf = fs.readFileSync(path.join(IMG, f));
    totalIn += inBuf.length;
    const cropped = await autoCropMargin(inBuf);
    if (cropped) inBuf = cropped;
    const meta = await sharp(inBuf).metadata();
    const scale = 1.25, SS = 2;                 // final scale, supersampling factor
    const W = Math.round(meta.width * scale), H = Math.round(meta.height * scale);

    // 1) lightness probe at final resolution (same rule as before)
    const probeRaw = await sharp(inBuf).resize(W, H, { kernel: "lanczos3" }).ensureAlpha().raw().toBuffer();
    const strict = { data: new Uint8ClampedArray(probeRaw) };
    lib.cutoutBackground(strict, W, H, 4);
    let solid = 0, bright = 0;
    for (let q = 0; q < strict.data.length; q += 4) {
      if (strict.data[q + 3] < 200) continue;
      solid++;
      if ((strict.data[q] + strict.data[q + 1] + strict.data[q + 2]) / 3 > 205) bright++;
    }
    const light = solid > 0 && bright / solid > 0.42;

    const w = W, h = H;
    // Photos now sit on white tiles/pages, so instead of cutting them out we just make the
    // studio backdrop pure white (flood-filled from the border, composited over white):
    // no transparency, no holes, no fringe — highlights that match the backdrop simply
    // stay white. Photos whose border is not white (full-frame screenshots) are left as-is.
    const px = new Uint8ClampedArray(probeRaw.buffer, probeRaw.byteOffset, probeRaw.length);
    const refLight = Math.min(px[0], px[1], px[2]) >= 235;
    if (refLight) {
      lib.cutoutBackground({ data: px }, w, h, light ? 3 : 9);
      for (let i = 0; i < w * h; i++) {
        const p = i * 4, a = px[p + 3] / 255;
        px[p] = Math.round(px[p] * a + 255 * (1 - a));
        px[p + 1] = Math.round(px[p + 1] * a + 255 * (1 - a));
        px[p + 2] = Math.round(px[p + 2] * a + 255 * (1 - a));
        px[p + 3] = 255;
      }
    }
    lib.enhanceImageData({ data: px }, w, h);
    const outBuf = await sharp(Buffer.from(px.buffer, px.byteOffset, px.length), { raw: { width: w, height: h, channels: 4 } })
      .webp({ quality: 86, alphaQuality: 92, effort: 5 })
      .toBuffer();
    fs.writeFileSync(path.join(OUT, f), outBuf);
    totalOut += outBuf.length;
    report.push(`${f.slice(0, 44).padEnd(44)} ${light ? 'light' : 'dark '} ${(inBuf.length / 1024).toFixed(0)}KB -> ${(outBuf.length / 1024).toFixed(0)}KB`);
  }
  console.log(report.join('\n'));
  console.log(`TOTAL in ${(totalIn / 1024 / 1024).toFixed(2)}MB  out ${(totalOut / 1024 / 1024).toFixed(2)}MB  files ${files.length}`);
})();
