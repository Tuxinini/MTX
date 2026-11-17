const fs = require('fs');
const path = require('path');

const ROOT = 'D:\\Proyectos Mecha Labs\\MTX\\apple-tienda-oficial';
const OUT = 'D:\\Proyectos Mecha Labs\\MTX\\apple-tienda-oficial\\artifact.html';

function read(p) { return fs.readFileSync(p, 'utf8'); }

// ---------- 1. Build base64 image map ----------
const imgDir = path.join(ROOT, 'assets', 'img'); // already cut out at build time
const imgFiles = fs.readdirSync(imgDir);
const dataUriByFilename = {};
imgFiles.forEach(f => {
  const buf = fs.readFileSync(path.join(imgDir, f));
  dataUriByFilename[f] = `data:image/webp;base64,${buf.toString('base64')}`;
});
const mtxLogoBuf = fs.readFileSync(path.join(ROOT, 'assets', 'mtx-logo.webp'));
const mtxLogoDataUri = `data:image/webp;base64,${mtxLogoBuf.toString('base64')}`;

let missingCount = 0;
const usedImages = new Set();

// Product photos are referenced 3-6x each across pages (grid + list + promo +
// hub card, etc). Inlining a fresh base64 copy at every occurrence bloated
// the artifact past the 16MB cap, so instead each occurrence becomes a
// lightweight `data-img="filename.webp"` placeholder, and a single shared
// IMG_MAP (one base64 copy per file) hydrates every placeholder at load time.
function inlineImages(html) {
  html = html.replace(/https:\/\/digitalmtx\.com\/wp-content\/uploads\/([^'")\s]+\.webp)/g, (m, file) => {
    const decoded = decodeURIComponent(file);
    if (dataUriByFilename[decoded]) return dataUriByFilename[decoded];
    if (dataUriByFilename[file]) return dataUriByFilename[file];
    console.warn('MISSING IMAGE:', file);
    missingCount++;
    return m;
  });
  html = html.replace(/style="background-image:url\('(?:\.\.\/)?assets\/img\/([^']+\.webp)'\)"/g, (m, file) => {
    if (!dataUriByFilename[file]) { console.warn('MISSING LOCAL IMAGE:', file); missingCount++; return m; }
    usedImages.add(file);
    return `data-img="${file}"`;
  });
  html = html.replace(/src="(?:\.\.\/)?assets\/img\/([^"]+\.webp)"/g, (m, file) => {
    if (!dataUriByFilename[file]) { console.warn('MISSING LOCAL IMAGE:', file); missingCount++; return m; }
    usedImages.add(file);
    return `data-img="${file}"`;
  });
  // photos are already cut out at build time: drop the runtime-processing markers
  html = html.replace(/ data-enhance-cutout| data-enhance-shadow| data-enhance(?=[ >])| data-cutout(?=[ >])/g, '');
  html = html.replace(/\.\.\/assets\/mtx-logo\.webp/g, mtxLogoDataUri);
  html = html.replace(/(?<!\.\.\/)assets\/mtx-logo\.webp/g, mtxLogoDataUri);
  return html;
}

// ---------- 2. Extract unique body per page ----------
function extractBody(html) {
  const startMarker = '<div id="chromeSpacer"></div>';
  const endMarker = '<footer>';
  const s = html.indexOf(startMarker);
  const e = html.indexOf(endMarker);
  if (s === -1 || e === -1) throw new Error('markers not found');
  return html.slice(s + startMarker.length, e).trim();
}

const pages = ['iphone', 'mac', 'ipad', 'watch', 'airpods', 'accesorios'];
const pageBodies = {};
pages.forEach(p => {
  const html = read(path.join(ROOT, p, 'index.html'));
  pageBodies[p] = extractBody(html);
});
const homeHtml = read(path.join(ROOT, 'index.html'));
pageBodies['home'] = extractBody(homeHtml);

// ---------- 3. Collect union of <symbol> defs ----------
const allFiles = [homeHtml, ...pages.map(p => read(path.join(ROOT, p, 'index.html')))];
const symbolMap = {};
allFiles.forEach(html => {
  const re = /<symbol id="([^"]+)"[\s\S]*?<\/symbol>/g;
  let m;
  while ((m = re.exec(html))) symbolMap[m[1]] = m[0];
});
const spriteSymbols = Object.values(symbolMap).join('\n');

// ---------- 4. Fix internal links in each page body, then inline images ----------
function fixLinks(html) {
  // crumbs: "../" -> "#/", "../#hub" -> "#/"
  html = html.replace(/href="\.\.\/#hub"/g, 'href="#/"');
  html = html.replace(/href="\.\.\/"/g, 'href="#/"');
  // sibling page links: "../iphone/" etc -> "#/iphone"
  html = html.replace(/href="\.\.\/(iphone|mac|ipad|watch|airpods|accesorios)\/"/g, 'href="#/$1"');
  // local script/style refs (to be removed entirely later) - leave for now
  return html;
}

pages.concat('home').forEach(p => {
  pageBodies[p] = inlineImages(fixLinks(pageBodies[p]));
});

// home page body has its own-relative hub/footer-less links like href="iphone/" (no ../ prefix, since index.html is at root)
pageBodies['home'] = pageBodies['home'].replace(/href="(iphone|mac|ipad|watch|airpods|accesorios)\/"/g, 'href="#/$1"');
pageBodies['home'] = pageBodies['home'].replace(/href="#hub"/g, 'href="#catalogo-anchor"'); // opener CTA scrolls to hub grid; handle via JS smooth scroll after route render
pageBodies['home'] = pageBodies['home'].replace(/href="#novedades"/g, 'href="#novedades-anchor"'); // "Nuevos" hub card scrolls to the novedades section

// ---------- 5. Shared chrome (hash-routed) ----------
const chrome = `
  <div class="chrome" id="chrome">
    <header class="head" id="siteHead">
      <a class="mtxwrap" href="https://digitalmtx.com/" target="_blank" rel="noopener" aria-label="Ir a Digital MTX"><img src="${mtxLogoDataUri}" alt="Digital MTX"></a>
      <nav class="nav" id="mainNav">
        <a class="home-btn" href="#/" aria-label="Volver al inicio" data-route="home">
          <svg><use href="#i-home"/></svg><span>Inicio</span>
        </a>
        <span class="sep"></span>
        <a href="#/iphone" data-route="iphone">iPhone</a>
        <a href="#/mac" data-route="mac">Mac</a>
        <a href="#/ipad" data-route="ipad">iPad</a>
        <a href="#/watch" data-route="watch">Watch</a>
        <a href="#/airpods" data-route="airpods">AirPods</a>
        <a href="#/accesorios" data-route="accesorios">Accesorios</a>
      </nav>
      <div class="actions">
        <button type="button" class="icon-btn" aria-label="Buscar" data-search-toggle>
          <svg width="17" height="17"><use href="#i-search"/></svg>
        </button>
        <a class="icon-btn" href="https://digitalmtx.com/carrito/" target="_blank" rel="noopener" aria-label="Carrito">
          <svg width="18" height="18"><use href="#i-cart"/></svg>
        </a>
        <button type="button" class="menu-toggle icon-btn" aria-label="Abrir men\u00fa" id="menuToggle">
          <svg width="20" height="20"><use href="#i-menu"/></svg>
        </button>
      </div>
    </header>
    <nav class="mobile-nav" id="mobileNav" hidden>
      <a href="#/iphone" data-route="iphone">iPhone</a>
      <a href="#/mac" data-route="mac">Mac</a>
      <a href="#/ipad" data-route="ipad">iPad</a>
      <a href="#/watch" data-route="watch">Watch</a>
      <a href="#/airpods" data-route="airpods">AirPods</a>
      <a href="#/accesorios" data-route="accesorios">Accesorios</a>
    </nav>
  </div>
  <div id="chromeSpacer"></div>`;

// ---------- 6. Footer (real Digital MTX footer, hash-routed where internal) ----------
// footer: taken verbatim from index.html (identical to the Logitech subpage footer), with its two images inlined
const footerLogoUri = `data:image/webp;base64,${fs.readFileSync(path.join(ROOT, "assets", "footer-logo.webp")).toString("base64")}`;
const mechaLogoUri = `data:image/webp;base64,${fs.readFileSync(path.join(ROOT, "assets", "mecha-labs.webp")).toString("base64")}`;
const footer = '\n  ' + homeHtml.match(/<footer>[\s\S]*?<\/footer>/)[0]
  .replace(/assets\/footer-logo\.webp/g, footerLogoUri)
  .replace(/assets\/mecha-labs\.webp/g, mechaLogoUri);

// ---------- 7. CSS + JS ----------
let css = read(path.join(ROOT, 'assets', 'site.css'));
let siteJs = read(path.join(ROOT, 'assets', 'site.js'));
let productsJs = read(path.join(ROOT, 'assets', 'products.js'));

// products.js keeps its original live-CDN image URLs as plain text (cheap) —
// the search-panel thumbnail renderer resolves each one through IMG_MAP by
// filename at render time instead of duplicating another base64 copy here.

// add page routing CSS
css += `
.page[hidden]{display:none;}
.mobile-nav{display:none;flex-direction:column;background:var(--paper);border-top:1px solid var(--line);padding:8px 20px 14px;}
.mobile-nav a{padding:12px 4px;font-size:15px;font-weight:600;color:var(--ink);border-bottom:1px solid var(--line);}
.mobile-nav a:last-child{border-bottom:none;}
.mobile-nav.open{display:flex;}
`;

// router + mobile menu JS appended to siteJs
const routerJs = `
// ===== Hash router (single-file build) =====
(function(){
  var pages = ['home','iphone','mac','ipad','watch','airpods','accesorios'];
  var pageEls = {};
  pages.forEach(function(p){ pageEls[p] = document.getElementById('page-' + p); });
  var navLinks = document.querySelectorAll('[data-route]');

  function currentRoute(){
    var h = location.hash.replace(/^#\\/?/, '');
    return pages.indexOf(h) !== -1 ? h : 'home';
  }

  function render(){
    var route = currentRoute();
    pages.forEach(function(p){
      if(!pageEls[p]) return;
      pageEls[p].hidden = (p !== route);
    });
    navLinks.forEach(function(l){
      l.classList.toggle('active', l.getAttribute('data-route') === route);
    });
    document.getElementById('mobileNav') && document.getElementById('mobileNav').classList.remove('open');
    window.scrollTo(0, 0);
    // re-run count-up + scrub progress for the now-visible page
    window.requestAnimationFrame(function(){
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
    });
  }

  window.addEventListener('hashchange', render);
  render();

  // in-page anchors on home (opener CTA -> hub, "Nuevos" card -> novedades)
  var anchorTargets = {'#catalogo-anchor': 'hub', '#novedades-anchor': 'novedades'};
  document.addEventListener('click', function(e){
    var a = e.target.closest('a[href="#catalogo-anchor"], a[href="#novedades-anchor"]');
    if(!a) return;
    e.preventDefault();
    var targetId = anchorTargets[a.getAttribute('href')];
    var target = targetId && document.getElementById(targetId);
    if(target) target.scrollIntoView({behavior:'smooth'});
  });

  // mobile menu toggle
  var menuToggle = document.getElementById('menuToggle');
  var mobileNav = document.getElementById('mobileNav');
  if(menuToggle && mobileNav){
    menuToggle.addEventListener('click', function(){ mobileNav.classList.toggle('open'); });
  }
})();
`;

siteJs = siteJs + '\n' + routerJs;

// ---------- 8. Assemble page div wrappers ----------
function wrapPage(id, bodyHtml, visible) {
  return `  <div class="page" id="page-${id}"${visible ? '' : ' hidden'}>\n${bodyHtml}\n  </div>`;
}

const pageDivs = [
  wrapPage('home', pageBodies['home'], true),
  wrapPage('iphone', pageBodies['iphone'], false),
  wrapPage('mac', pageBodies['mac'], false),
  wrapPage('ipad', pageBodies['ipad'], false),
  wrapPage('watch', pageBodies['watch'], false),
  wrapPage('airpods', pageBodies['airpods'], false),
  wrapPage('accesorios', pageBodies['accesorios'], false),
].join('\n\n');

// ---------- 8b. Shared image map (one base64 copy per file, deduped) ----------
const imgMapEntries = Array.from(usedImages).map(f => `${JSON.stringify(f)}:${JSON.stringify(dataUriByFilename[f])}`);
const imgMapJs = `
// One base64 copy of each product photo, shared by every [data-img] placeholder
// (a photo can appear in the grid, a list row, a promo card AND a hub card —
// inlining it separately at each spot blew past the 16MB artifact cap).
window.IMG_MAP = {${imgMapEntries.join(',')}};
document.querySelectorAll('[data-img]').forEach(function(el){
  var uri = window.IMG_MAP[el.getAttribute('data-img')];
  if(!uri) return;
  if(el.tagName === 'IMG') el.src = uri;
  else el.style.backgroundImage = "url('" + uri + "')";
});
`;

// ---------- 9. Final assembly (Artifact format: no doctype/html/head/body) ----------
const finalHtml = `<title>Apple Digital MTX</title>
<style>
${css}
</style>

<svg width="0" height="0" style="position:absolute" aria-hidden="true">
<defs>
${spriteSymbols}
</defs>
</svg>

<div class="site">
${chrome}

${pageDivs}

${footer}
</div>

<script>
${imgMapJs}
</script>
<script>
${productsJs}
</script>
<script>
${siteJs}
</script>
`;

fs.writeFileSync(OUT, finalHtml, 'utf8');
console.log('WRITTEN:', OUT);
console.log('size bytes:', Buffer.byteLength(finalHtml, 'utf8'));
console.log('size MB:', (Buffer.byteLength(finalHtml, 'utf8') / 1024 / 1024).toFixed(2));
console.log('missing images:', missingCount);
