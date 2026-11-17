// Build-time image pipeline (cutout + enhance). Source of truth for imgproc/process_images.js.
// Removed from the production site.js — photos in assets/img are already processed.
// ===== Product photo enhancement pipeline =====
// The source photos come straight from the store's product-photography batch:
// slightly soft, a bit low-contrast, small resolution. This pipeline (all
// client-side canvas work, no external service) does three things per image:
//  1. gentle stepped upscale (reduces the "blurry web thumbnail" look)
//  2. auto white-balance + contrast stretch, then an unsharp mask
//  3. flood-fill background removal from the four corners (so a white AirPod
//     on a white backdrop stays intact — only pixels CONNECTED to the border
//     go transparent) + edge feathering, optionally topped with a soft
//     synthetic contact shadow so the cut-out product doesn't look pasted.

function stepUpscale(img, targetScale){
  var w = img.naturalWidth, h = img.naturalHeight;
  var canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  var ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  var scale = 1;
  while(scale < targetScale - 0.001){
    var step = Math.min(1.5, targetScale / scale);
    var nw = Math.round(w * scale * step), nh = Math.round(h * scale * step);
    var next = document.createElement('canvas');
    next.width = nw; next.height = nh;
    var nctx = next.getContext('2d');
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = 'high';
    nctx.drawImage(canvas, 0, 0, nw, nh);
    canvas = next; ctx = nctx; scale *= step;
  }
  return canvas;
}

function boxBlurChannel(src, dst, w, h, radius){
  var tmp = new Float32Array(src.length);
  for(var y = 0; y < h; y++){
    var rowStart = y * w * 4;
    for(var x = 0; x < w; x++){
      var r=0,g=0,b=0,count=0;
      for(var dx = -radius; dx <= radius; dx++){
        var xx = x + dx;
        if(xx < 0 || xx >= w) continue;
        var idx = rowStart + xx*4;
        r += src[idx]; g += src[idx+1]; b += src[idx+2]; count++;
      }
      var o = rowStart + x*4;
      tmp[o]=r/count; tmp[o+1]=g/count; tmp[o+2]=b/count;
    }
  }
  for(var x2 = 0; x2 < w; x2++){
    for(var y2 = 0; y2 < h; y2++){
      var r2=0,g2=0,b2=0,count2=0;
      for(var dy = -radius; dy <= radius; dy++){
        var yy = y2 + dy;
        if(yy < 0 || yy >= h) continue;
        var idx2 = (yy*w + x2) * 4;
        r2 += tmp[idx2]; g2 += tmp[idx2+1]; b2 += tmp[idx2+2]; count2++;
      }
      var o2 = (y2*w + x2) * 4;
      dst[o2]=r2/count2; dst[o2+1]=g2/count2; dst[o2+2]=b2/count2;
    }
  }
}

// auto-levels (per-channel percentile stretch) + contrast lift + unsharp mask
function enhanceImageData(imgData, w, h){
  var data = imgData.data;
  var n = w * h;
  var histR = new Uint32Array(256), histG = new Uint32Array(256), histB = new Uint32Array(256);
  var counted = 0;
  for(var i = 0; i < n; i++){
    var p = i*4;
    if(data[p+3] < 40) continue; // ignore removed-backdrop pixels
    histR[data[p]]++; histG[data[p+1]]++; histB[data[p+2]]++; counted++;
  }
  if(!counted) return;
  function bounds(hist){
    var clip = counted * 0.006, lo = 0, hi = 255, acc = 0;
    for(lo = 0; lo < 255; lo++){ acc += hist[lo]; if(acc > clip) break; }
    acc = 0;
    for(hi = 255; hi > 0; hi--){ acc += hist[hi]; if(acc > clip) break; }
    if(hi <= lo){ lo = 0; hi = 255; }
    return [lo, hi];
  }
  var bR = bounds(histR), bG = bounds(histG), bB = bounds(histB);
  function stretch(v, lo, hi){ return Math.max(0, Math.min(255, ((v - lo) / (hi - lo || 1)) * 255)); }
  var contrast = 1.06, mid = 128;
  for(var j = 0; j < n; j++){
    var q = j*4;
    data[q]   = Math.max(0, Math.min(255, (stretch(data[q],   bR[0], bR[1]) - mid) * contrast + mid));
    data[q+1] = Math.max(0, Math.min(255, (stretch(data[q+1], bG[0], bG[1]) - mid) * contrast + mid));
    data[q+2] = Math.max(0, Math.min(255, (stretch(data[q+2], bB[0], bB[1]) - mid) * contrast + mid));
  }
  var blurred = new Uint8ClampedArray(data.length);
  boxBlurChannel(data, blurred, w, h, 2);
  var amount = 0.5;
  for(var k = 0; k < n; k++){
    var s = k*4;
    for(var c = 0; c < 3; c++){
      var v2 = data[s+c] + (data[s+c] - blurred[s+c]) * amount;
      data[s+c] = Math.max(0, Math.min(255, v2));
    }
  }
}

// edge polish: (1) drop tiny isolated specks left by compression noise,
// (2) soften the stair-stepped edge with a 3x3 average of alpha, only on
// pixels that sit on the boundary.
function polishAlpha(data, w, h){
  var n = w * h;
  var seen = new Uint8Array(n);
  var minKeep = Math.max(24, n * 0.0006);
  for(var s = 0; s < n; s++){
    if(seen[s] || data[s*4+3] === 0) continue;
    var comp = [s], head = 0;
    seen[s] = 1;
    while(head < comp.length){
      var cur = comp[head++], cx = cur % w, cy = (cur / w) | 0;
      var nb = [];
      if(cx > 0) nb.push(cur - 1);
      if(cx < w - 1) nb.push(cur + 1);
      if(cy > 0) nb.push(cur - w);
      if(cy < h - 1) nb.push(cur + w);
      for(var k = 0; k < nb.length; k++){
        var m = nb[k];
        if(seen[m] || data[m*4+3] === 0) continue;
        seen[m] = 1; comp.push(m);
      }
    }
    if(comp.length < minKeep){
      for(var z = 0; z < comp.length; z++) data[comp[z]*4+3] = 0;
    }
  }
  var src = new Uint8Array(n);
  for(var i = 0; i < n; i++) src[i] = data[i*4+3];
  for(var y = 1; y < h - 1; y++){
    for(var x = 1; x < w - 1; x++){
      var idx = y*w + x, a = src[idx];
      var l = src[idx-1], r = src[idx+1], u = src[idx-w], d = src[idx+w];
      if(a === l && a === r && a === u && a === d) continue;
      var sum = a*4 + l + r + u + d + src[idx-w-1] + src[idx-w+1] + src[idx+w-1] + src[idx+w+1];
      data[idx*4+3] = Math.round(sum / 12);
    }
  }
}

// flood-fill background removal + feather, mutates imgData in place, returns
// the object's pixel bounding box (for the synthetic shadow) or null.
function cutoutBackground(imgData, w, h, tolOverride){
  var data = imgData.data;
  var n = w * h;
  var mask = new Uint8Array(n);
  var visited = new Uint8Array(n);
  var ref = [data[0], data[1], data[2]];
  // strict tolerance: white products (AirPods, keyboards) have bright
  // highlights close to the backdrop white — a loose fill leaks into them
  var tol = tolOverride || 9;

  function dist(i, c){
    var p = i * 4;
    var dr = data[p] - c[0], dg = data[p+1] - c[1], db = data[p+2] - c[2];
    return Math.sqrt(dr*dr + dg*dg + db*db);
  }

  var stack = [];
  for(var x = 0; x < w; x++){ stack.push(x); stack.push((h-1)*w + x); }
  for(var y = 0; y < h; y++){ stack.push(y*w); stack.push(y*w + (w-1)); }

  while(stack.length){
    var i = stack.pop();
    if(visited[i]) continue;
    visited[i] = 1;
    if(dist(i, ref) > tol) continue;
    mask[i] = 1;
    var xi = i % w, yi = (i / w) | 0;
    if(xi > 0) stack.push(i - 1);
    if(xi < w - 1) stack.push(i + 1);
    if(yi > 0) stack.push(i - w);
    if(yi < h - 1) stack.push(i + w);
  }

  // enclosed backdrop: the loop of a watch band (or any hole) shows the white
  // backdrop through it but isn't connected to the image border — drop any
  // large backdrop-coloured pocket too. Small pockets (specular highlights,
  // white text on a screen) stay.
  var minPocket = n * 0.004;
  var seen = new Uint8Array(n);
  for(var s0 = 0; s0 < n; s0++){
    if(mask[s0] || seen[s0] || dist(s0, ref) > tol) continue;
    var comp = [s0], head = 0;
    seen[s0] = 1;
    while(head < comp.length){
      var cur = comp[head++];
      var cx0 = cur % w, cy0 = (cur / w) | 0;
      var nb = [];
      if(cx0 > 0) nb.push(cur - 1);
      if(cx0 < w - 1) nb.push(cur + 1);
      if(cy0 > 0) nb.push(cur - w);
      if(cy0 < h - 1) nb.push(cur + w);
      for(var q0 = 0; q0 < nb.length; q0++){
        var m0 = nb[q0];
        if(mask[m0] || seen[m0] || dist(m0, ref) > tol) continue;
        seen[m0] = 1; comp.push(m0);
      }
    }
    if(comp.length >= minPocket){
      for(var z = 0; z < comp.length; z++) mask[comp[z]] = 1;
    }
  }

  // feather: two 1px rings just outside the background get a partial alpha
  // (from how far each pixel is from the backdrop color), and their colour is
  // "un-mixed" from the white backdrop so no light halo is left on dark cards.
  var featherBand = 46;
  var soft = new Uint8Array(n); // 1 = already feathered
  var ring = [];
  function touches(idx, x2, y2, arr){
    return (x2 > 0 && arr[idx-1]) || (x2 < w-1 && arr[idx+1]) ||
           (y2 > 0 && arr[idx-w]) || (y2 < h-1 && arr[idx+w]);
  }
  for(var pass = 0; pass < 2; pass++){
    ring.length = 0;
    for(var y3 = 0; y3 < h; y3++){
      for(var x3 = 0; x3 < w; x3++){
        var k = y3*w + x3;
        if(mask[k] || soft[k]) continue;
        if(!(touches(k, x3, y3, mask) || touches(k, x3, y3, soft))) continue;
        var dd = dist(k, ref);
        if(dd >= featherBand) continue;
        ring.push(k, Math.max(0, Math.min(1, (dd - tol) / (featherBand - tol))));
      }
    }
    for(var r = 0; r < ring.length; r += 2){
      var ki = ring[r], a = ring[r+1];
      soft[ki] = 1;
      if(a < 0.12){ data[ki*4+3] = 0; continue; }
      data[ki*4+3] = Math.round(255 * a);
      for(var c = 0; c < 3; c++){
        var un = (data[ki*4+c] - ref[c] * (1 - a)) / a;
        data[ki*4+c] = un < 0 ? 0 : (un > 255 ? 255 : un);
      }
    }
  }
  var minX = w, maxX = 0, minY = h, maxY = 0, hasObject = false;
  for(var y2 = 0; y2 < h; y2++){
    for(var x2 = 0; x2 < w; x2++){
      var idx = y2*w + x2;
      if(mask[idx] || (soft[idx] && data[idx*4+3] === 0)) continue;
      hasObject = true;
      if(x2 < minX) minX = x2; if(x2 > maxX) maxX = x2;
      if(y2 < minY) minY = y2; if(y2 > maxY) maxY = y2;
    }
  }
  for(var i2 = 0; i2 < n; i2++){
    if(mask[i2]) data[i2*4+3] = 0;
  }
  polishAlpha(data, w, h);
  return hasObject ? {minX:minX, maxX:maxX, minY:minY, maxY:maxY} : null;
}

function drawContactShadow(ctx, w, h, box){
  var cx = (box.minX + box.maxX) / 2;
  var footY = box.maxY - (box.maxY - box.minY) * 0.03;
  var rx = (box.maxX - box.minX) * 0.4;
  var ry = rx * 0.22;
  if(rx < 4) return;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-over';
  var grd = ctx.createRadialGradient(cx, footY, 0, cx, footY, rx);
  grd.addColorStop(0, 'rgba(0,0,0,.14)');
  grd.addColorStop(0.7, 'rgba(0,0,0,.05)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.ellipse(cx, footY, rx, ry, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.restore();
}

// opts: {cutout:bool, shadow:bool, upscale:number}
function processProductImage(img, opts){
  return new Promise(function(resolve){
    var w = img.naturalWidth, h = img.naturalHeight;
    if(!w || !h){ resolve(null); return; }
    var canvas = opts.upscale && opts.upscale > 1 ? stepUpscale(img, opts.upscale) : null;
    if(!canvas){
      canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    }
    var ctx = canvas.getContext('2d');
    var cw = canvas.width, ch = canvas.height;
    var imgData;
    try{
      imgData = ctx.getImageData(0, 0, cw, ch);
    }catch(e){
      resolve(null); // cross-origin canvas read blocked — leave the image as-is
      return;
    }
    // cut out on the ORIGINAL pixels first — enhancing first pushes bright
    // highlights toward pure white and makes the fill leak into the product
    var box = null;
    var light = false;
    if(opts.cutout){
      // White/silver products (AirPods, keyboards) have highlights the same
      // colour as the white backdrop, so no colour-based cutout can separate
      // them cleanly. Probe on a copy: if most of the product is very light,
      // keep the original opaque photo (caller shows it on a white tile).
      // measure lightness with a near-exact backdrop fill (tol 4) so leaks
      // into bright highlights can't hide how light the product really is
      var strict = new ImageData(new Uint8ClampedArray(imgData.data), cw, ch);
      cutoutBackground(strict, cw, ch, 4);
      var pd = strict.data, solid = 0, bright = 0;
      for(var q = 0; q < pd.length; q += 4){
        if(pd[q+3] < 200) continue;
        solid++;
        if((pd[q] + pd[q+1] + pd[q+2]) / 3 > 205) bright++;
      }
      light = solid > 0 && bright / solid > 0.42;
      // light products: only pixels that are essentially the pure backdrop
      // colour (tol 2) may go transparent, so highlights on the white product
      // can't be mistaken for background
      box = cutoutBackground(imgData, cw, ch, light ? 2 : 9);
    }
    if(opts.onMeta) opts.onMeta({light: false});
    enhanceImageData(imgData, cw, ch);
    ctx.putImageData(imgData, 0, 0);
    if(opts.shadow && box) drawContactShadow(ctx, cw, ch, box);
    // data: URL (not blob:) — the artifact sandbox's CSP only admits data: images
    canvas.toBlob(function(blob){
      if(!blob){ resolve(null); return; }
      var reader = new FileReader();
      reader.onload = function(){ resolve(reader.result); };
      reader.onerror = function(){ resolve(null); };
      reader.readAsDataURL(blob);
    }, 'image/png');
  });
}

(function(){
  var toCut = document.querySelectorAll('.scrub-frame[data-cutout]');
  toCut.forEach(function(img){
    function run(){
      processProductImage(img, {cutout:true, shadow:true, upscale:1.5, onMeta:function(m){
        if(m.light) img.classList.add('is-light');
      }}).then(function(url){
        if(url) img.src = url;
      });
    }
    if(img.complete && img.naturalWidth) run();
    else img.addEventListener('load', run, {once:true});
  });
})();

// same pipeline for card/row/promo thumbnails — some are plain <img> tags,
// most are CSS background-images (load the url into an offscreen Image first).
(function(){
  var toEnhance = document.querySelectorAll('[data-enhance]:not(.scrub-frame)');
  toEnhance.forEach(function(el){
    var isImgTag = el.tagName === 'IMG';
    var src = isImgTag ? el.getAttribute('src') : (function(){
      var m = /url\((['"]?)(.*?)\1\)/.exec(el.style.backgroundImage || '');
      return m ? m[2] : null;
    })();
    if(!src) return;
    var cutout = el.hasAttribute('data-enhance-cutout');
    var shadow = el.hasAttribute('data-enhance-shadow') || cutout;
    function run(sourceImg){
      processProductImage(sourceImg, {cutout:cutout, shadow:shadow, upscale:1.4, onMeta:function(m){
        if(m.light) el.classList.add('is-light');
      }}).then(function(url){
        if(!url) return;
        if(isImgTag) el.src = url; else el.style.backgroundImage = "url('" + url + "')";
      });
    }
    if(isImgTag){
      if(el.complete && el.naturalWidth) run(el);
      else el.addEventListener('load', function(){ run(el); }, {once:true});
    }else{
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function(){ run(img); };
      img.src = src;
    }
  });
})();
