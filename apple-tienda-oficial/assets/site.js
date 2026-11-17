document.documentElement.classList.add('js');

// reveal on scroll
(function(){
  var toReveal = document.querySelectorAll('.reveal, .zoomreveal');
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){ e.target.classList.add('in-view'); io.unobserve(e.target); }
    });
  }, {threshold:.15, rootMargin:'0px 0px -60px 0px'});
  toReveal.forEach(function(el){ io.observe(el); });
})();

// count-up animated stats inside feature cards
(function(){
  var counters = document.querySelectorAll('.fstat[data-count]');
  function runCount(el){
    var target = parseFloat(el.getAttribute('data-count'));
    var suffix = el.getAttribute('data-suffix') || '';
    var start = null;
    var dur = 1100;
    function step(ts){
      if(start === null) start = ts;
      var p = Math.min(1, (ts - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      var val = Math.round(target * eased);
      el.textContent = val + suffix;
      if(p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  var countIo = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){ runCount(e.target); countIo.unobserve(e.target); }
    });
  }, {threshold:.6});
  counters.forEach(function(el){ countIo.observe(el); });
})();

// ===== Search =====
(function(){
  var searchBtns = document.querySelectorAll('[data-search-toggle]');
  if(!searchBtns.length || typeof APPLE_PRODUCTS === 'undefined') return;

  var overlay = document.createElement('div');
  overlay.className = 'search-overlay';
  document.body.appendChild(overlay);

  var lineLabels = {iphone:'iPhone', mac:'Mac', ipad:'iPad', watch:'Watch', airpods:'AirPods', accesorios:'Accesorios'};
  var chipDefs = [['','Todos'], ['iphone','iPhone'], ['mac','Mac'], ['ipad','iPad'], ['watch','Watch'], ['airpods','AirPods'], ['accesorios','Accesorios']];

  var panel = document.createElement('div');
  panel.className = 'search-panel';
  panel.innerHTML =
    '<div class="search-inner">' +
      '<div class="search-box">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
        '<input type="text" placeholder="Buscar iPhone, Mac, iPad, Watch, AirPods…" autocomplete="off" id="searchInput">' +
        '<button type="button" class="search-close" aria-label="Cerrar búsqueda"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '</div>' +
      '<div class="search-chips">' +
        chipDefs.map(function(c){
          return '<button type="button" class="search-chip' + (c[0] === '' ? ' active' : '') + '" data-line="' + c[0] + '">' + c[1] + '</button>';
        }).join('') +
      '</div>' +
      '<div class="search-results" id="searchResults"></div>' +
    '</div>';
  document.body.appendChild(panel);

  var input = panel.querySelector('#searchInput');
  var resultsEl = panel.querySelector('#searchResults');
  var chips = panel.querySelectorAll('.search-chip');
  var activeLine = '';

  function fmtCOP(n){ return '$' + Math.round(n).toLocaleString('es-CO'); }
  function norm(s){ return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
  function esc(s){ return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  // in the single-file artifact build, window.IMG_MAP holds one shared base64
  // copy per filename \u2014 resolve through it when present, otherwise fall back
  // to the product's own (live or local) image URL as-is.
  function resolveImg(url){
    if(!window.IMG_MAP) return url;
    var file = String(url || '').split('/').pop();
    return window.IMG_MAP[file] || url;
  }

  function render(){
    var q = norm(input.value.trim());
    var list = APPLE_PRODUCTS.filter(function(p){
      var matchesLine = !activeLine || p.l === activeLine;
      var matchesQuery = !q || norm(p.n).indexOf(q) !== -1;
      return matchesLine && matchesQuery;
    });
    if(!list.length){
      resultsEl.innerHTML = '<p class="search-empty">No encontramos productos con esos filtros.</p>';
      return;
    }
    var shown = list.slice(0, 24);
    resultsEl.innerHTML = shown.map(function(p){
      return '<a class="search-row" href="' + p.u + '" target="_blank" rel="noopener">' +
        '<span class="search-thumb" style="background-image:url(\'' + resolveImg(p.i) + '\')"></span>' +
        '<span class="search-info"><b>' + esc(p.n) + '</b><span>' + (lineLabels[p.l] || p.l) + '</span></span>' +
        '<span class="search-price">' + fmtCOP(p.p) + '</span>' +
      '</a>';
    }).join('') + (list.length > shown.length ? '<p class="search-count">Mostrando ' + shown.length + ' de ' + list.length + '</p>' : '');
  }

  function openSearch(){
    overlay.classList.add('open');
    panel.classList.add('open');
    document.documentElement.classList.add('modal-open');
    render();
    setTimeout(function(){ input.focus(); }, 300);
  }
  function closeSearch(){
    overlay.classList.remove('open');
    panel.classList.remove('open');
    document.documentElement.classList.remove('modal-open');
  }

  searchBtns.forEach(function(btn){ btn.addEventListener('click', openSearch); });
  overlay.addEventListener('click', closeSearch);
  panel.querySelector('.search-close').addEventListener('click', closeSearch);
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeSearch(); });
  input.addEventListener('input', render);
  chips.forEach(function(chip){
    chip.addEventListener('click', function(){
      chips.forEach(function(c){ c.classList.remove('active'); });
      chip.classList.add('active');
      activeLine = chip.getAttribute('data-line');
      render();
    });
  });
})();

// fixed chrome: size the spacer and expose the header height as --chrome-h
(function(){
  var chrome = document.getElementById('chrome');
  var head = document.getElementById('siteHead');
  var spacer = document.getElementById('chromeSpacer');
  if(!chrome || !head) return;
  function layoutChrome(){
    var h = chrome.offsetHeight;
    if(spacer) spacer.style.height = h + 'px';
    document.documentElement.style.setProperty('--chrome-h', h + 'px');
  }
  window.addEventListener('resize', layoutChrome);
  layoutChrome();

  function updateHead(){
    var y = window.scrollY || window.pageYOffset;
    head.classList.toggle('scrolled', y > 30);
  }
  document.addEventListener('scroll', updateHead, {passive:true});
  updateHead();
})();

// ===== Home page: full-catalog chip filter (one unified list, no forced separation) =====
(function(){
  var chipsWrap = document.getElementById('catalogChips');
  var list = document.getElementById('catalogList');
  if(!chipsWrap || !list) return;
  var chips = chipsWrap.querySelectorAll('.search-chip');
  var rows = list.querySelectorAll('.prow');
  var emptyMsg = document.createElement('p');
  emptyMsg.className = 'catalog-empty';
  emptyMsg.textContent = 'No encontramos productos en esta categoría.';
  emptyMsg.hidden = true;
  list.appendChild(emptyMsg);

  chips.forEach(function(chip){
    chip.addEventListener('click', function(){
      chips.forEach(function(c){ c.classList.remove('active'); });
      chip.classList.add('active');
      var line = chip.getAttribute('data-filter-line');
      var shown = 0;
      rows.forEach(function(row){
        var match = !line || row.getAttribute('data-line') === line;
        row.hidden = !match;
        if(match) shown++;
      });
      emptyMsg.hidden = shown > 0;
    });
  });
})();

// gentle parallax on static hero product images
(function(){
  var parallaxEls = document.querySelectorAll('[data-parallax]');
  if(!parallaxEls.length) return;
  function onParallax(){
    parallaxEls.forEach(function(el){
      var r = el.getBoundingClientRect();
      var center = r.top + r.height/2 - window.innerHeight/2;
      var t = Math.max(-1, Math.min(1, center / (window.innerHeight/2)));
      el.style.transform = 'translateY(' + (t * -22) + 'px) scale(' + (1 + Math.abs(t) * -0.02) + ')';
    });
  }
  document.addEventListener('scroll', function(){ window.requestAnimationFrame(onParallax); }, {passive:true});
  onParallax();
})();

// ===== Scroll-scrubbed product showcase =====
// Pins a stage for the section's scroll distance and maps scroll progress (0-1)
// to: the active frame image, fading spec callouts, and a progress bar —
// the same mechanism apple.com uses on pages like /mac-studio/ (there, driven
// by a 100+ frame CG render sequence; here, driven by the product's real photos).
(function(){
  var sections = document.querySelectorAll('.scrub');
  if(!sections.length) return;

  function initScrub(section){
    var sticky = section.querySelector('.scrub-sticky');
    var frames = section.querySelectorAll('.scrub-frame');
    var callouts = section.querySelectorAll('.scrub-callout');
    var intro = section.querySelector('.scrub-intro');
    var bar = section.querySelector('.scrub-bar');
    var hint = section.querySelector('.scrub-hint');
    var lastIdx = -1;

    function update(){
      var rect = section.getBoundingClientRect();
      var topOffset = parseFloat(getComputedStyle(sticky).top) || 0;
      var stickyHeight = sticky.offsetHeight;
      var total = rect.height - stickyHeight;
      var progress = total > 0 ? Math.min(1, Math.max(0, (topOffset - rect.top) / total)) : 0;

      if(frames.length){
        var idx = Math.min(frames.length - 1, Math.floor(progress * frames.length));
        if(idx !== lastIdx){
          frames.forEach(function(f, i){ f.classList.toggle('active', i === idx); });
          lastIdx = idx;
        }
        // subtle turntable rotation tied to scroll position: swings from -9deg
        // to +9deg across the section, like slowly turning the product in hand
        var rot = (progress - 0.5) * 18;
        frames[idx].style.setProperty('--frame-rot', rot.toFixed(2) + 'deg');
      }
      callouts.forEach(function(c){
        var range = c.getAttribute('data-range').split(',').map(Number);
        c.classList.toggle('active', progress >= range[0] && progress <= range[1]);
      });
      if(intro) intro.classList.toggle('faded', progress > 0.05);
      if(hint) hint.classList.toggle('faded', progress > 0.04);
      if(bar) bar.style.width = (progress * 100) + '%';
    }

    // "Ver productos" shortcut: jumps past the animation to the product grid
    var line = section.nextElementSibling;
    var grid = line && line.querySelector('.pgrid');
    if(grid){
      var skip = document.createElement('button');
      skip.type = 'button';
      skip.className = 'scrub-skip';
      skip.innerHTML = 'Ver productos <svg><use href="#i-arrow"/></svg>';
      skip.addEventListener('click', function(){
        var chromeH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chrome-h')) || 90;
        var y = grid.getBoundingClientRect().top + window.pageYOffset - chromeH - 24;
        window.scrollTo({top: y, behavior: 'smooth'});
      });
      sticky.appendChild(skip);
    }

    window.addEventListener('scroll', function(){ requestAnimationFrame(update); }, {passive:true});
    window.addEventListener('resize', function(){ requestAnimationFrame(update); });
    update();
  }

  sections.forEach(initScrub);
})();

// ===== 3D tilt-on-hover for product cards (rotation effect on cursor move) =====
(function(){
  if(!window.matchMedia || !window.matchMedia('(pointer:fine)').matches) return;
  var cards = document.querySelectorAll('.pcard, .promo-card');
  cards.forEach(function(card){
    var img = card.querySelector('.pcard-img, .promo-img');
    if(!img) return;
    var raf = null, pending = null;
    img.style.transition = 'transform .5s cubic-bezier(.16,1,.3,1)';
    card.addEventListener('pointermove', function(e){
      var r = card.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width;
      var py = (e.clientY - r.top) / r.height;
      pending = {
        rx: (0.5 - py) * 16,
        ry: (px - 0.5) * 16
      };
      if(raf) return;
      raf = requestAnimationFrame(function(){
        img.style.transition = 'transform .12s ease-out';
        img.style.transform = 'rotateX(' + pending.rx.toFixed(2) + 'deg) rotateY(' + pending.ry.toFixed(2) + 'deg) scale3d(1.05,1.05,1.05)';
        raf = null;
      });
    });
    card.addEventListener('pointerleave', function(){
      if(raf){ cancelAnimationFrame(raf); raf = null; }
      img.style.transition = 'transform .5s cubic-bezier(.16,1,.3,1)';
      img.style.transform = '';
    });
  });
})();

// ===== opener banner: cursor-tracked spotlight + logo parallax tilt =====
(function(){
  var banner = document.getElementById('openerBanner');
  if(!banner) return;
  var mark = banner.querySelector('.opener-banner-mark');
  var fine = window.matchMedia && window.matchMedia('(pointer:fine)').matches;
  var raf = null, pending = null;
  banner.addEventListener('pointermove', function(e){
    var r = banner.getBoundingClientRect();
    var px = (e.clientX - r.left) / r.width;
    var py = (e.clientY - r.top) / r.height;
    pending = {px: px, py: py};
    if(raf) return;
    raf = requestAnimationFrame(function(){
      banner.style.setProperty('--mx', (pending.px * 100).toFixed(1) + '%');
      banner.style.setProperty('--my', (pending.py * 100).toFixed(1) + '%');
      if(fine && mark){
        mark.style.transform = 'rotateX(' + ((0.5 - pending.py) * 10).toFixed(2) + 'deg) rotateY(' + ((pending.px - 0.5) * 10).toFixed(2) + 'deg)';
      }
      raf = null;
    });
  });
  banner.addEventListener('pointerleave', function(){
    if(raf){ cancelAnimationFrame(raf); raf = null; }
    if(mark) mark.style.transform = '';
  });
})();
