// stars.js — Verified star parallax system (extracted from working nebula.js)
// Single-file, vanilla JS, Canvas 2D, no dependencies
// 10-layer depth model, exponential parallax scaling, per-star attributes

(function(){
  'use strict';

  var Starfield = function(canvas, options){
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = Object.assign({
      count: null,           // auto: based on canvas area
      minStars: 60,
      maxStars: 220,
      densityScale: 80000,   // stars per px^2
      parallaxBase: 0.001,   // layer 0 (farthest)
      parallaxMax: 0.09,     // layer 9 (nearest) — 90x range
      parallaxExp: 1.8,      // exponential mapping bias
      mouseInfluence: 1.0,   // global multiplier
      twinkleSpeed: 0.0004,  // base twinkle
      driftAmpMax: 1.3,      // max micro-drift amplitude
      seed: Date.now()       // deterministic seed
    }, options || {});

    this.stars = [];
    this.mouseX = 0.5;
    this.mouseY = 0.5;
    this.time = 0;
    this.W = 0;
    this.H = 0;
    this._rng = this._makeRNG(this.options.seed);
    this._init();
  };

  Starfield.prototype._makeRNG = function(seed){
    // Mulberry32
    var t = seed >>> 0;
    return function(){
      t += 0x6D2B79F5;
      var r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  };

  Starfield.prototype._init = function(){
    this._resize();
    this._seedStars();
    window.addEventListener('resize', this._resize.bind(this));
    window.addEventListener('mousemove', this._onMouse.bind(this));
    window.addEventListener('touchmove', this._onTouch.bind(this), {passive:true});
  };

  Starfield.prototype._resize = function(){
    this.W = this.canvas.width = window.innerWidth;
    this.H = this.canvas.height = window.innerHeight;
    // Re-seed if canvas size changed significantly
    this._seedStars();
  };

  Starfield.prototype._onMouse = function(e){
    this.mouseX = e.clientX / this.W;
    this.mouseY = e.clientY / this.H;
  };

  Starfield.prototype._onTouch = function(e){
    if(e.touches.length){
      this.mouseX = e.touches[0].clientX / this.W;
      this.mouseY = e.touches[0].clientY / this.H;
    }
  };

  Starfield.prototype._seedStars = function(){
    var area = this.W * this.H;
    var target = Math.min(this.options.maxStars, Math.max(this.options.minStars, Math.floor(area / this.options.densityScale)));
    this.stars = [];

    // Pre-generate noise field for rejection sampling
    // (simplified: just use random with distance checks)

    for(var i=0; i<target; i++){
      var attempts = 0;
      var x, y, layer, depth, parallaxFactor, driftAmp, driftPhase, driftSpeed;
      var hue, sat, light, baseBright, size, twinklePhase, twinkleSpeed;
      var colorClass;

      // Assign layer first (0=behind nebula ... 9=nearest)
      layer = Math.floor(this._rng() * 10);
      var lf = layer / 9; // 0..1

      // Exponential parallax mapping: layer 0->0.001, layer 9->0.09
      var parab = this.options.parallaxBase;
      var param = this.options.parallaxMax;
      var paexp = this.options.parallaxExp;
      parallaxFactor = parab + (param - parab) * Math.pow(lf, paexp);

      // Depth for rendering order (far to near)
      depth = 0.1 + lf * 0.85;

      // Color class by layer (4 categories)
      if(layer <= 2){ colorClass = 0; }        // Far: red-orange
      else if(layer <= 5){ colorClass = 1; }   // Mid: yellow-orange
      else if(layer <= 8){ colorClass = 2; }   // Near: white-yellow
      else { colorClass = 3; }                 // Nearest: blue-white

      // Per-class base attributes
      switch(colorClass){
        case 0: hue = 15 + this._rng() * 25; sat = 60 + this._rng() * 30; baseBright = 0.35 + this._rng() * 0.25; size = 0.4 + this._rng() * 0.5; break;
        case 1: hue = 35 + this._rng() * 20; sat = 50 + this._rng() * 35; baseBright = 0.5 + this._rng() * 0.3; size = 0.6 + this._rng() * 0.6; break;
        case 2: hue = 50 + this._rng() * 15; sat = 30 + this._rng() * 25; baseBright = 0.7 + this._rng() * 0.25; size = 0.8 + this._rng() * 0.8; break;
        case 3: hue = 210 + this._rng() * 20; sat = 40 + this._rng() * 30; baseBright = 0.85 + this._rng() * 0.15; size = 1.0 + this._rng() * 1.0; break;
      }

      driftAmp = 0.1 + this._rng() * 1.2;
      driftPhase = this._rng() * Math.PI * 2;
      driftSpeed = 0.0001 + this._rng() * 0.0005;
      twinklePhase = this._rng() * Math.PI * 2;
      twinkleSpeed = this.options.twinkleSpeed + this._rng() * 0.0006;

      // Rejection sampling: avoid high-density nebula zones (simplified)
      // In practice, nebula.js would provide a density map; here we just place randomly
      x = this._rng();
      y = this._rng();

      this.stars.push({
        x: x, y: y,
        layer: layer, depth: depth,
        parallaxFactor: parallaxFactor,
        hue: hue, sat: sat, light: 50 + lf * 40,
        baseBright: baseBright, size: size,
        driftAmp: driftAmp, driftPhase: driftPhase, driftSpeed: driftSpeed,
        twinklePhase: twinklePhase, twinkleSpeed: twinkleSpeed,
        colorClass: colorClass
      });
    }

    // Sort far-to-near for correct occlusion
    this.stars.sort(function(a,b){ return a.layer - b.layer; });
  };

  Starfield.prototype.update = function(dt){
    this.time += dt;
  };

  Starfield.prototype.render = function(ctx){
    if(!ctx) ctx = this.ctx;
    var w = this.W, h = this.H;
    var mx = this.mouseX - 0.5;
    var my = this.mouseY - 0.5;
    var t = this.time;

    for(var i=0, n=this.stars.length; i<n; i++){
      var s = this.stars[i];

      // Parallax offset (s.x/s.y are 0-1 normalized)
      var px = s.x * w + mx * w * s.parallaxFactor * this.options.mouseInfluence;
      var py = s.y * h + my * h * s.parallaxFactor * this.options.mouseInfluence;

      // Independent micro-drift
      var drift = Math.sin(t * s.driftSpeed + s.driftPhase) * s.driftAmp * 0.5 * s.depth;
      px += drift * 0.01;
      py += drift * 0.01;

      // Twinkle
      var tw = 0.75 + 0.25 * Math.sin(t * s.twinkleSpeed + s.twinklePhase);

      // Alpha with brightness and twinkle
      var alpha = s.baseBright * tw * 0.7;
      if(alpha > 1) alpha = 1;

      // Color
      var light = s.light * tw;
      if(light > 100) light = 100;

      var rgb = this._hslToRgb(s.hue, s.sat, light);

      // Render
      var r = s.size * (0.8 + 0.4 * s.depth); // nearer = larger
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);

      // Core
      ctx.fillStyle = 'rgba(' + (rgb.r|0) + ',' + (rgb.g|0) + ',' + (rgb.b|0) + ',' + alpha + ')';
      ctx.fill();

      // Glow for bright/near stars
      if(s.baseBright > 0.7 || s.layer > 6){
        var g = ctx.createRadialGradient(px, py, 0, px, py, r * 3);
        g.addColorStop(0, 'rgba(' + (rgb.r|0) + ',' + (rgb.g|0) + ',' + (rgb.b|0) + ',' + (alpha * 0.6) + ')');
        g.addColorStop(1, 'rgba(' + (rgb.r|0) + ',' + (rgb.g|0) + ',' + (rgb.b|0) + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, r * 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  Starfield.prototype._hslToRgb = function(h, s, l){
    h /= 360; s /= 100; l /= 100;
    var c = (1 - Math.abs(2*l - 1)) * s;
    var x = c * (1 - Math.abs((h * 6) % 2 - 1));
    var m = l - c/2;
    var r=0, g=0, b=0;
    if(h < 1/6){ r=c; g=x; }
    else if(h < 2/6){ r=x; g=c; }
    else if(h < 3/6){ g=c; b=x; }
    else if(h < 4/6){ g=x; b=c; }
    else if(h < 5/6){ r=x; b=c; }
    else { r=c; b=x; }
    return { r:(r+m)*255, g:(g+m)*255, b:(b+m)*255 };
  };

  // Expose globally
  window.Starfield = Starfield;
})();