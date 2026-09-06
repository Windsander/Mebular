// nebula.js — Realistic orthographic nebula view (NASA-style)
// Single-file, vanilla JS, Canvas 2D, no dependencies
// Orthographic projection, restrained color palette, soft structures

(function(){
  'use strict';

  var Nebula = function(canvas, options){
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = Object.assign({
      // Base nebula texture (generated once)
      baseWidth: 4096,
      baseHeight: 1024,
      
      // View: orthographic, looking at galactic center region
      // Coordinates: x=longitude (-π..π), y=latitude (-π/2..π/2)
      viewLon: 0.5,      // center longitude offset (shift left ~30°)
      viewLat: 0,        // center latitude (0 = galactic plane)
      viewScale: 1.0,    // zoom (1.0 = full 360° longitude coverage)
      viewTilt: 0.6,     // tilt angle in radians (~35°)
      
      // Dynamic mist layer (very subtle)
      mistEnabled: true,
      mistSpeed: 0.0005,
      mistScale: 4.0,
      mistAlpha: 0.08,
      mistContrast: 1.8,
      mistThreshold: 0.02,
      mistParallax: 0.5,
      
      // Base parallax (very subtle - farthest layer)
      baseParallax: 0.03,
      
      // Mouse smoothing
      parallaxDamping: 0.03,
      mouseInfluence: 1.0,
      
      // Quality
      downsample: 1,  // full res for coverage
      
      seed: Date.now()
    }, options || {});

    this.W = 0;
    this.H = 0;
    this.mouseX = 0.5;
    this.mouseY = 0.5;
    this.targetMouseX = 0.5;
    this.targetMouseY = 0.5;
    this.time = 0;
    
    // Base nebula texture
    this.baseCanvas = null;
    this.baseCtx = null;
    this.baseReady = false;
    this.baseW = 0;
    this.baseH = 0;
    
    // Mist layer
    this.mistCanvas = null;
    this.mistCtx = null;
    this.mistW = 0;
    this.mistH = 0;
    this.mistDensity = null;
    this.mistOffsetX = 0;
    this.mistOffsetY = 0;
    this.mistTargetOffsetX = 0;
    this.mistTargetOffsetY = 0;
    
    // RNG
    this._rng = this._makeRNG(this.options.seed);
    this._perm = this._buildPerm();
    
    this._init();
  };

  Nebula.prototype._makeRNG = function(seed){
    var t = seed >>> 0;
    return function(){
      t += 0x6D2B79F5;
      var r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  };

  Nebula.prototype._buildPerm = function(){
    var p = new Uint8Array(512);
    for(var i=0; i<256; i++) p[i] = i;
    for(var i=255; i>0; i--){
      var j = Math.floor(this._rng() * (i + 1));
      var tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    for(var i=0; i<256; i++) p[256 + i] = p[i];
    return p;
  };

  Nebula.prototype._noise2D = function(x, y){
    var X = Math.floor(x) & 255;
    var Y = Math.floor(y) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    var u = x * x * x * (x * (x * 6 - 15) + 10);
    var v = y * y * y * (y * (y * 6 - 15) + 10);
    var A = this._perm[X] + Y;
    var B = this._perm[X + 1] + Y;
    var h0 = this._perm[A] & 15;
    var h1 = this._perm[B] & 15;
    var h2 = this._perm[A + 1] & 15;
    var h3 = this._perm[B + 1] & 15;
    var g0 = this._grad(h0, x, y);
    var g1 = this._grad(h1, x - 1, y);
    var g2 = this._grad(h2, x, y - 1);
    var g3 = this._grad(h3, x - 1, y - 1);
    var n0 = g0 + (g1 - g0) * u;
    var n1 = g2 + (g3 - g2) * u;
    return n0 + (n1 - n0) * v;
  };

  Nebula.prototype._grad = function(hash, x, y){
    var h = hash & 7;
    var u = h < 4 ? x : y;
    var v = h < 4 ? y : x;
    return ((h & 1) ? -u : u) + ((h & 2) ? -2*v : 2*v);
  };

  Nebula.prototype._fbm = function(x, y, octaves, persistence, lacunarity){
    var value = 0, amplitude = 1, frequency = 1, maxValue = 0;
    for(var i=0; i<octaves; i++){
      value += amplitude * this._noise2D(x * frequency, y * frequency);
      maxValue += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }
    return value / maxValue;
  };

  Nebula.prototype._init = function(){
    this._resize();
    this._generateBaseTexture();
    this._createMistLayer();
    
    window.addEventListener('resize', this._resize.bind(this));
    window.addEventListener('mousemove', this._onMouse.bind(this));
    window.addEventListener('touchmove', this._onTouch.bind(this), {passive:true});
  };

  Nebula.prototype._resize = function(){
    this.W = this.canvas.width = window.innerWidth;
    this.H = this.canvas.height = window.innerHeight;
    this._createMistLayer();
  };

  // ===== ORTHOGRAPHIC NEBULA GENERATION =====
  // Maps texture pixels directly to galactic coordinates (no perspective distortion)
  Nebula.prototype._generateBaseTexture = function(){
    var opt = this.options;
    var ds = opt.downsample;
    this.baseW = Math.floor(opt.baseWidth / ds);
    this.baseH = Math.floor(opt.baseHeight / ds);
    
    this.baseCanvas = document.createElement('canvas');
    this.baseCanvas.width = this.baseW;
    this.baseCanvas.height = this.baseH;
    this.baseCtx = this.baseCanvas.getContext('2d');
    
    var ctx = this.baseCtx;
    var id = ctx.createImageData(this.baseW, this.baseH);
    var data = id.data;
    
    // Orthographic: linear mapping from pixel to galactic coordinates
    var scale = opt.viewScale;
    var centerLon = opt.viewLon;
    var centerLat = opt.viewLat;
    var tilt = opt.viewTilt || 0;
    var cosT = Math.cos(tilt);
    var sinT = Math.sin(tilt);
    
    for(var y=0; y<this.baseH; y++){
      // Latitude: -π/2 to π/2 (but we only show ~±60°)
      var lat = centerLat + (y / this.baseH - 0.5) * Math.PI * scale;
      
      for(var x=0; x<this.baseW; x++){
        // Longitude: -π to π
        var lon = centerLon + (x / this.baseW - 0.5) * Math.PI * 2 * scale;
        
        // Apply tilt: rotate in (lon, lat) space
        // This tilts the galactic plane
        var lonT = lon * cosT - lat * sinT;
        var latT = lon * sinT + lat * cosT;
        
        // Add galactic warp: plane curves as sine wave in longitude
        // Real Milky Way has a warped disk
        var warp = Math.sin(lonT * 1.5) * 0.15; // amplitude ~8°
        latT += warp;
        
        // Clamp to valid range
        if(latT < -Math.PI/2 || latT > Math.PI/2 || lonT < -Math.PI || lonT > Math.PI){
          data[(y*this.baseW+x)*4] = 3;
          data[(y*this.baseW+x)*4+1] = 3;
          data[(y*this.baseW+x)*4+2] = 8;
          data[(y*this.baseW+x)*4+3] = 255;
          continue;
        }
        
        var d = this._orthographicDensity(lonT, latT);
        
        if(d < 0.005){
          data[(y*this.baseW+x)*4] = 3;
          data[(y*this.baseW+x)*4+1] = 3;
          data[(y*this.baseW+x)*4+2] = 8;
          data[(y*this.baseW+x)*4+3] = 255;
        }else{
          var clr = this._mapColorRealistic(d);
          var co = Math.pow(d * 0.5 + 0.5, 1.8); // gentler contrast
          var al = Math.min(1, co * 0.85);
          data[(y*this.baseW+x)*4] = clr.r;
          data[(y*this.baseW+x)*4+1] = clr.g;
          data[(y*this.baseW+x)*4+2] = clr.b;
          data[(y*this.baseW+x)*4+3] = al * 255;
        }
      }
    }
    
    ctx.putImageData(id, 0, 0);
    this.baseReady = true;
    console.log('[Nebula] Orthographic base baked:', this.baseW, 'x', this.baseH, 'tilt:', tilt);
  };

  // Density in galactic coordinates - realistic structure
  Nebula.prototype._orthographicDensity = function(lon, lat){
    // Galactic plane: exponential falloff from plane (VERY THIN)
    var plane = Math.exp(-Math.abs(lat) * 30); // scale height ~2° - extremely thin
    
    // Galactic center region (Sgr A*) - ELONGATED along plane as a gentle band
    var gcLon = 0, gcLat = 0;
    var gcDist2 = (lon - gcLon)*(lon - gcLon) * 0.15 + (lat - gcLat)*(lat - gcLat); // very stretched along longitude
    var core = Math.exp(-gcDist2 * 6) * 0.35; // much dimmer, broader
    
    // Spiral arms (Grand design, logarithmic)
    // Using simplified 2D arm model in lon-lat space
    var arms = 0;
    // Arm 1: Scutum-Centaurus (inner)
    // Arm 2: Sagittarius
    // Arm 3: Perseus (outer)
    // Arm 4: Outer/Cygnus
    // In longitude-latitude: arms appear as curved features near plane
    var r = Math.sqrt(lon*lon + 0.01); // approximate galactocentric radius proxy
    for(var a=0; a<4; a++){
      var armPhase = a * 1.57;
      var armLon = armPhase - Math.log(r + 0.1) * 1.8; // pitch angle ~12°
      var lonDiff = Math.abs(((lon - armLon + Math.PI) % (Math.PI*2)) - Math.PI);
      // Arms are confined to plane
      var armStrength = Math.exp(-lonDiff * lonDiff * 12) * Math.exp(-lat * lat * 30) * 0.22; // slightly stronger
      arms += armStrength;
    }
    
    // Local molecular cloud complexes (Orion, Taurus, Ophiuchus, etc.)
    // Modeled as 3D noise projected to 2D
    var clouds = 0;
    var cloudSeed = 1000;
    for(var i=0; i<4; i++){
      var cx = lon * 6 + cloudSeed + i * 200;
      var cy = lat * 6 + cloudSeed * 2 + i * 300;
      clouds += this._fbm(cx, cy, 4, 0.5, 2.0) * (0.12 - i * 0.02);
    }
    clouds *= plane * 0.7 + 0.3; // some high-latitude cirrus
    
    // Dark nebulae / absorption lanes (Barnard objects, etc.)
    var dark = 0;
    for(var i=0; i<3; i++){
      var dx = lon * 8 + 500 + i * 400;
      var dy = lat * 8 + 600 + i * 500;
      dark += this._fbm(dx, dy, 3, 0.5, 2.0) * 0.06;
    }
    dark *= plane; // mostly in plane
    
    // Large-scale gradient (integrated starlight, zodiacal light)
    var gradient = Math.exp(-r * 1.5) * 0.08;
    
    // Combine
    var total = core + arms + clouds + gradient - dark;
    total = total * 1.1; // modest boost
    return Math.min(1, Math.max(0, total));
  };

  // ===== MIST LAYER (very subtle, screen-space) =====
  Nebula.prototype._createMistLayer = function(){
    var opt = this.options;
    this.mistW = Math.max(1, Math.floor(this.W / 4));
    this.mistH = Math.max(1, Math.floor(this.H / 4));
    
    this.mistCanvas = document.createElement('canvas');
    this.mistCanvas.width = this.mistW;
    this.mistCanvas.height = this.mistH;
    this.mistCtx = this.mistCanvas.getContext('2d');
    
    this.mistDensity = new Float32Array(this.mistW * this.mistH);
    var scale = opt.mistScale;
    for(var y=0; y<this.mistH; y++){
      for(var x=0; x<this.mistW; x++){
        var nx = x / this.mistW;
        var ny = y / this.mistH;
        var cx = nx - 0.5;
        var cy = ny - 0.5;
        var d = this._fbm(cx*scale + 100, cy*scale + 200, 3, 0.5, 2.0) * 0.4;
        d += this._fbm(cx*scale*2 + 300, cy*scale*2 + 400, 2, 0.5, 2.0) * 0.25;
        d += this._fbm(cx*scale*4 + 500, cy*scale*4 + 600, 2, 0.5, 2.0) * 0.15;
        this.mistDensity[y * this.mistW + x] = Math.min(1, Math.max(0, d));
      }
    }
    this._renderMist();
  };

  Nebula.prototype._renderMist = function(){
    var opt = this.options;
    var ctx = this.mistCtx;
    var dW = this.mistW, dH = this.mistH;
    var density = this.mistDensity;
    
    var id = ctx.createImageData(dW, dH);
    var data = id.data;
    
    for(var y=0; y<dH; y++){
      for(var x=0; x<dW; x++){
        var dn = density[y * dW + x];
        if(dn < opt.mistThreshold) continue;
        var co = Math.pow(dn * 0.5 + 0.5, opt.mistContrast);
        var clr = this._mapColorRealistic(dn);
        var al = co * opt.mistAlpha;
        if(al > 1) al = 1;
        var idx = (y * dW + x) * 4;
        data[idx] = clr.r;
        data[idx+1] = clr.g;
        data[idx+2] = clr.b;
        data[idx+3] = al * 255;
      }
    }
    ctx.putImageData(id, 0, 0);
  };

  Nebula.prototype._advectMist = function(dt){
    var opt = this.options;
    var speed = opt.mistSpeed * dt * 0.001;
    var shiftX = Math.sin(this.time * 0.00002) * speed * 0.3;
    var shiftY = Math.cos(this.time * 0.000015) * speed * 0.2;
    this.mistOffsetX += shiftX;
    this.mistOffsetY += shiftY;
    this.mistOffsetX = (this.mistOffsetX % 1 + 1) % 1;
    this.mistOffsetY = (this.mistOffsetY % 1 + 1) % 1;
  };

  Nebula.prototype._onMouse = function(e){
    this.targetMouseX = e.clientX / this.W;
    this.targetMouseY = e.clientY / this.H;
  };

  Nebula.prototype._onTouch = function(e){
    if(e.touches.length){
      this.targetMouseX = e.touches[0].clientX / this.W;
      this.targetMouseY = e.touches[0].clientY / this.H;
    }
  };

  // ===== REALISTIC COLOR MAPPING (NASA/ESO style) =====
  // Based on actual emission line ratios and continuum
  Nebula.prototype._mapColorRealistic = function(d){
    // d = 0..1 density
    // Real nebulae: 
    // - Very faint: dark/black (below detection)
    // - Faint outer: reflection nebula blue (starlight scattered by dust)
    // - Ionized regions: H-alpha red (656nm) dominant, some H-beta blue-green
    // - High excitation: O-III teal (500.7nm), He-II blue
    // - Dense cores: bright red/pink (H-alpha + continuum)
    // - Stars: white/blue-white (continuum)
    
    var t = d;
    var r, g, b;
    
    if(t < 0.08){
      // Very faint: deep space with hint of reflection blue
      var u = t / 0.08;
      r = 5 + u * 15;
      g = 5 + u * 20;
      b = 12 + u * 35;
    }else if(t < 0.20){
      // Faint ionized / reflection: muted teal-blue (O-III + scattered light)
      var u = (t - 0.08) / 0.12;
      r = 15 + u * 20;
      g = 25 + u * 40;
      b = 40 + u * 30;
    }else if(t < 0.40){
      // Bright ionized: H-alpha red dominates, with O-III teal
      var u = (t - 0.20) / 0.20;
      // Transition from teal to red
      r = 35 + u * 120;
      g = 45 + u * 15;  // green stays low (H-alpha is red)
      b = 50 + u * 10;  // blue drops
    }else if(t < 0.65){
      // Strong emission: bright H-alpha red/pink
      var u = (t - 0.40) / 0.25;
      r = 155 + u * 80;
      g = 50 + u * 40;  // some green for pink
      b = 55 + u * 25;
    }else if(t < 0.85){
      // Dense cores: very bright pink/white (H-alpha + continuum)
      var u = (t - 0.65) / 0.20;
      r = 235 + u * 20;
      g = 90 + u * 80;
      b = 80 + u * 100;
    }else{
      // Brightest: near white (stellar clusters, compact H-II)
      var u = (t - 0.85) / 0.15;
      r = 255;
      g = 170 + u * 85;
      b = 180 + u * 75;
    }
    
    // Clamp and desaturate slightly for realism
    r = Math.min(255, Math.max(0, r|0));
    g = Math.min(255, Math.max(0, g|0));
    b = Math.min(255, Math.max(0, b|0));
    
    // Slight global desaturation (real nebulae aren't neon)
    var gray = (r + g + b) / 3;
    r = r * 0.9 + gray * 0.1;
    g = g * 0.9 + gray * 0.1;
    b = b * 0.9 + gray * 0.1;
    
    return { r: r|0, g: g|0, b: b|0 };
  };

  Nebula.prototype.update = function(dt){
    this.time += dt;
    
    var damping = this.options.parallaxDamping;
    this.mouseX += (this.targetMouseX - this.mouseX) * damping;
    this.mouseY += (this.targetMouseY - this.mouseY) * damping;
    
    if(this.options.mistEnabled){
      this._advectMist(dt);
      
      var mx = this.mouseX - 0.5;
      var my = this.mouseY - 0.5;
      this.mistTargetOffsetX = mx * this.W * this.options.mistParallax * this.options.mouseInfluence;
      this.mistTargetOffsetY = my * this.H * this.options.mistParallax * this.options.mouseInfluence;
      
      this.mistOffsetX += (this.mistTargetOffsetX - this.mistOffsetX) * damping;
      this.mistOffsetY += (this.mistTargetOffsetY - this.mistOffsetY) * damping;
    }
  };

  Nebula.prototype.render = function(ctx){
    if(!ctx) ctx = this.ctx;
    
    ctx.fillStyle = '#03050a';
    ctx.fillRect(0, 0, this.W, this.H);
    
    if(!this.baseReady) return;
    
    // ---- Base nebula with subtle parallax (horizontal tiling for seamless parallax) ----
    var opt = this.options;
    var mx = this.mouseX - 0.5;
    var my = this.mouseY - 0.5;
    var bx = mx * this.W * opt.baseParallax * opt.mouseInfluence;
    var by = my * this.H * opt.baseParallax * opt.mouseInfluence;
    
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(bx, by);
    
    // Texture is 4096x1024 (4:1 aspect) covering full 360° longitude
    // Tile horizontally to cover screen + parallax margin
    var texAspect = this.baseW / this.baseH; // 4.0
    var texH = this.H;
    var texW = texH * texAspect; // 4 * screen height
    
    // Calculate how many tiles needed horizontally
    var tileW = texW;
    var startX = -bx; // offset by parallax
    // Align to tile boundary
    var firstTileX = Math.floor(startX / tileW) * tileW;
    var numTiles = Math.ceil((this.W - firstTileX + tileW) / tileW) + 1;
    
    for(var t = 0; t < numTiles; t++){
      var drawX = firstTileX + t * tileW;
      ctx.drawImage(this.baseCanvas, 0, 0, this.baseW, this.baseH, drawX, 0, tileW, texH);
    }
    ctx.restore();
    
    // ---- Dynamic mist layer ----
    if(this.options.mistEnabled && this.mistCanvas){
      ctx.save();
      ctx.translate(this.mistOffsetX, this.mistOffsetY);
      ctx.drawImage(this.mistCanvas, 0, 0, this.mistW, this.mistH, 0, 0, this.W, this.H);
      ctx.restore();
    }
  };

  window.Nebula = Nebula;
})();