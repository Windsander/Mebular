(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var bgCanvas = document.getElementById('bg-canvas');
  var bgCtx = bgCanvas.getContext('2d');
  var netCanvas = document.getElementById('net-canvas');
  var ctx = netCanvas.getContext('2d');
  var pages = Array.prototype.slice.call(document.querySelectorAll('.page'));
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('[data-page-link]'));
  var pageIndexEl = document.getElementById('page-index');
  var pageHint = document.getElementById('page-hint');
  var consoleShell = document.getElementById('console-shell');
  var domainButtons = Array.prototype.slice.call(document.querySelectorAll('.domain-button'));
  var domainCount = document.getElementById('domain-count');
  var domainState = document.getElementById('domain-state');
  var consoleTabs = Array.prototype.slice.call(document.querySelectorAll('.console-tab'));
  var legendLeft = document.getElementById('console-legend-left');
  var legendRight = document.getElementById('console-legend-right');
  var taskButton = document.getElementById('task-button');
  var taskPhase = document.getElementById('task-phase');
  var taskStepLaptop = document.getElementById('task-step-laptop');
  var taskStateEl = document.getElementById('task-state');
  var taskLog = document.getElementById('task-log');
  var langToggle = document.getElementById('lang-toggle');

  var language = 'zh';
  var W = 0;
  var H = 0;
  var DPR = 1;
  var page = 0;
  var activeDomain = 'product';
  var consoleView = 'starmap';
  var task = { state: 'idle', start: 0, duration: 1550 };
  var domainPulseStart = 0;
  var hovered = null;
  var pointer = { x: 0, y: 0 };
  var bgTarget = { x: .5, y: .5 };
  var bgSmooth = { x: .5, y: .5 };
  var bgNebula = null;
  var bgStars = null;
  var lastTime = 0;
  var scrollTick = false;

  var nodes = [
    { id: 'studio', label: 'studio', role: '本机', roleEn: 'Local', x: -0.49, y: -0.23, depth: .52, domains: ['product', 'research'] },
    { id: 'laptop', label: 'laptop', role: '助手 B', roleEn: 'Assistant B', x: 0.42, y: -0.31, depth: .78, domains: ['product', 'home'] },
    { id: 'mini', label: 'mini', role: '书房主机', roleEn: 'Study Mac', x: 0.53, y: 0.16, depth: .96, domains: ['product', 'research'] },
    { id: 'phone', label: 'phone', role: '助手 C', roleEn: 'Assistant C', x: -0.33, y: 0.45, depth: .36, domains: ['home'] },
    { id: 'tablet', label: 'tablet', role: '离线', roleEn: 'Offline', x: 0.06, y: 0.54, depth: .62, domains: ['research', 'home'] }
  ];
  var domains = {
    product: { label: '产品', labelEn: 'Product', ids: ['studio', 'laptop', 'mini'] },
    research: { label: '研究', labelEn: 'Research', ids: ['studio', 'mini', 'tablet'] },
    home: { label: '家庭', labelEn: 'Home', ids: ['laptop', 'phone', 'tablet'] }
  };

  var EN = {
    '系统': 'System',
    '网络': 'Network',
    '任务': 'Tasks',
    '产品': 'Product',
    '安全': 'Security',
    '开始': 'Start',
    '一份记忆': 'One memory',
    '每个助手，每台设备。': 'Every assistant, every device.',
    '一份记忆，': 'One memory,',
    '每个助手，': 'every assistant,',
    '每台设备。': 'every device.',
    '共同订阅': 'Shared subscriptions',
    '任务派发': 'Task dispatch',
    '上下文跟随过去。': 'Context follows along.',
    '上下文跟随过去': 'Context follows along',
    '交给另一台': 'Hand it on',
    '上下文一起过去。': 'Context goes with it.',
    '同一张图': 'One graph',
    '就是控制台。': 'is the console.',
    '安全结构化': 'Structured security',
    '设备就是边界。': 'Devices are the boundary.',
    '共同围成边界': 'A shared boundary',
    '不是中心。': 'Not a center.',
    '自己生长': 'Let it grow',
    '从一台设备开始。': 'Start with one device.',
    '这里没有中心服务器。每台设备都持有自己的记忆，沿着共同订阅的关系相遇。': 'No central server. Each device holds its own memory and meets others through shared subscriptions.',
    '下载桌面 App': 'Download desktop App',
    '进入网络': 'Enter the network',
    '本地优先': 'Local-first',
    '无中心协调者': 'No central coordinator',
    '向下翻页，跟着一条记忆走': 'Scroll to follow one memory',
    '01 / 网络': '01 / Network',
    '没有中心。': 'No center.',
    '只有共同订阅。': 'Only shared subscriptions.',
    '记忆不属于主服务器。它出现在每一台共同订阅的设备上，直接沿设备之间的关系同步。': 'Memory does not belong to a server. It appears on every device subscribed to a domain and syncs directly along their relationships.',
    'MEMORY DOMAIN / 选择领域': 'MEMORY DOMAIN / CHOOSE',
    '研究': 'Research',
    '家庭': 'Home',
    '台设备共同订阅': 'devices subscribed',
    '02 / 任务': '02 / Tasks',
    '下一步，': 'The next step,',
    '沿着关系流动。': 'follows relationships.',
    '任务带着上下文，从一台设备直接交给另一台。接手时，前因后果已经在。': 'A task carries its context directly from one device to another. By the time it arrives, the history is already there.',
    'studio 整理发布要点': 'studio collects release notes',
    'laptop 生成双语草稿': 'laptop drafts the bilingual release',
    '人工确认后发布': 'Human review before publishing',
    'CONTEXT / 91E1…7C4A': 'CONTEXT / 91E1…7C4A',
    '03 / 本机控制台': '03 / Local console',
    '网络就是': 'The network is',
    '控制台。': 'the console.',
    '进入本机视角，网络直接成为 Console。星图与任务航道是同一张图的两种看法。': 'Enter the local view and the network becomes the console. Star map and task lanes are two views of the same graph.',
    '同一张网络': 'Same network',
    '本机视角': 'Local view',
    '04 / 信任边界': '04 / Trust boundary',
    '边界由设备': 'The boundary is',
    '共同围成。': 'drawn by devices.',
    '设备用一次性邀请与证书链进入同一信任边界。边界内订阅自主，没有围绕中心的权限塔。': 'Devices join the same trust boundary through one-time invitations and certificate chains. Subscriptions remain autonomous; there is no central permission tower.',
    '无额外门槛': 'No extra gate',
    '动态码确认': 'Dynamic code',
    '首次会签': 'First-join co-sign',
    '信任链仍然有效。': 'The trust chain still applies.',
    '本机动作门槛。': 'A local action gate.',
    '另一台受信设备批准。': 'Another trusted device approves.',
    '信任边界内没有“A 能读、B 不能读”的域内 ACL。要断开设备，就显式移出它。': 'There is no in-domain ACL where A can read but B cannot. To disconnect a device, explicitly remove it.',
    '查看已知边界': 'Read known limitations',
    '05 / 开始': '05 / Start',
    '从一台设备开始，': 'Start with one device,',
    '让网络自己生长。': 'let the network grow.',
    '桌面 App 自带运行环境，五分钟创建或加入忆云。也可以从 DSH、MCP 或 CLI 接到同一个本机守护。': 'The desktop app includes its runtime; create or join a memory cloud in five minutes. DSH, MCP, or CLI connects to the same local daemon.',
    '下载 v0.2.0': 'Download v0.2.0',
    '5 分钟开始': 'Quickstart',
    '桌面 App': 'Desktop App',
    '同一套 Console': 'Same Console',
    '托管 Relay、Trust Anchor 与团队能力仍在探索。这里不展示虚构的正式套餐；先把本机网络跑起来。': 'Hosted Relay, Trust Anchor, and team capabilities remain exploratory. No fictional plans here; start with a local network first.',
    '已知边界': 'Known limitations',
    '变更日志': 'Changelog',
    'star / 本机视角': 'studio / Local view',
    'studio / 本机视角': 'studio / Local view',
    '星图 · 设备关系': 'Star map · Devices',
    '任务航道 · 双向可达': 'Task lanes · Reachability'
  };

  var DYN = {
    zh: {
      pageHint: '滚轮 / ↑↓ 翻页',
      taskPhase: { idle: '等待派发', moving: '交接中', done: '已接住' },
      taskButton: { idle: '把任务交给 laptop', moving: '正在交接', done: '再次派发' },
      taskLog: {
        idle: '任务尚未离开本机。',
        moving: '任务带着上下文离开 studio，沿关系抵达 laptop…',
        done: 'laptop 已接住任务，前因后果一并到达。'
      },
      legendStar: '共同订阅的设备直接相连',
      legendRightStar: '5 DEVICES / NO CENTRAL NODE',
      legendLanes: '蓝线可发出 / 金线可接收 / 灰线不可达',
      legendRightLanes: 'LOCAL VIEW / STUDIO',
      domainLive: 'LIVE'
    },
    en: {
      pageHint: 'Wheel / ↑↓ to turn',
      taskPhase: { idle: 'Waiting', moving: 'Handing off', done: 'Received' },
      taskButton: { idle: 'Hand to laptop', moving: 'Handing off', done: 'Hand off again' },
      taskLog: {
        idle: 'The task has not left this device.',
        moving: 'The task leaves studio with its context and follows the relationship to laptop…',
        done: 'laptop received the task, context and history included.'
      },
      legendStar: 'Devices with shared subscriptions connect directly',
      legendRightStar: '5 DEVICES / NO CENTRAL NODE',
      legendLanes: 'Blue sends / Gold receives / Gray unreachable',
      legendRightLanes: 'LOCAL VIEW / STUDIO',
      domainLive: 'LIVE'
    }
  };

  // Each page is a camera state, not a new scene.
  var camera = { zoom: 1, tx: 0, ty: 0 };
  var cameraFrom = { zoom: 1, tx: 0, ty: 0 };
  var cameraTo = { zoom: 1, tx: 0, ty: 0 };
  var cameraStart = 0;
  var cameraDuration = 900;
  var staticTextNodes = [];
  var titleAnimRaf = 0;
  var DYNAMIC_IDS = ['task-phase', 'task-state', 'task-log', 'task-button', 'domain-state', 'console-legend-left', 'console-legend-right', 'page-hint'];

  function splitTitles() {
    document.querySelectorAll('.page-copy h1, .page-copy h2').forEach(function (title) {
      if (title.dataset.titleSplit === 'true') return;
      var parts = title.innerHTML.split(/<br\s*\/?>/i).map(function (part) { return part.trim(); }).filter(Boolean);
      if (!parts.length) return;
      title.innerHTML = parts.map(function (part, i) {
        return '<span class="title-line" data-line="' + i + '">' + part + '</span>';
      }).join('');
      title.dataset.titleSplit = 'true';
    });
  }

  function animateTitle(index, delay) {
    var copy = pages[index] && pages[index].querySelector('.page-copy');
    var title = copy && copy.querySelector('h1, h2');
    var lines = title ? Array.prototype.slice.call(title.querySelectorAll('.title-line')) : [];
    if (!lines.length) return;
    var subtitle = copy.querySelector('.page-subtitle');

    if (titleAnimRaf) {
      cancelAnimationFrame(titleAnimRaf);
      titleAnimRaf = 0;
    }

    var scan = copy.querySelector('.title-scan:not(.subtitle-scan)');
    if (!scan) {
      scan = document.createElement('span');
      scan.className = 'title-scan';
      scan.setAttribute('aria-hidden', 'true');
      copy.appendChild(scan);
    }
    var subtitleScan = copy.querySelector('.subtitle-scan');
    if (!subtitleScan) {
      subtitleScan = document.createElement('span');
      subtitleScan.className = 'title-scan subtitle-scan';
      subtitleScan.setAttribute('aria-hidden', 'true');
      copy.appendChild(subtitleScan);
    }

    lines.forEach(function (line) {
      line.style.opacity = '.18';
      line.style.filter = 'blur(6px) contrast(2.2)';
      line.style.clipPath = 'inset(0 100% 0 0)';
    });
    if (subtitle) {
      subtitle.style.opacity = '.18';
      subtitle.style.filter = 'blur(4px) contrast(1.8)';
      subtitle.style.clipPath = 'inset(0 100% 0 0)';
    }

    if (reduceMotion) {
      lines.forEach(function (line) {
        line.style.opacity = '1';
        line.style.filter = 'none';
        line.style.clipPath = 'none';
      });
      if (subtitle) {
        subtitle.style.opacity = '1';
        subtitle.style.filter = 'none';
        subtitle.style.clipPath = 'none';
      }
      scan.style.opacity = '0';
      subtitleScan.style.opacity = '0';
      return;
    }

    var copyRect = copy.getBoundingClientRect();
    var keyRect = lines[0].getBoundingClientRect();
    scan.style.top = (keyRect.top - copyRect.top) + 'px';
    scan.style.height = keyRect.height + 'px';
    scan.style.left = (keyRect.left - copyRect.left) + 'px';
    scan.style.opacity = '1';

    var subRect = subtitle ? subtitle.getBoundingClientRect() : null;
    if (subRect) {
      subtitleScan.style.top = (subRect.top - copyRect.top) + 'px';
      subtitleScan.style.height = subRect.height + 'px';
      subtitleScan.style.left = (subRect.left - copyRect.left) + 'px';
      subtitleScan.style.opacity = '0';
    }

    var start = performance.now() + (delay || 0);
    var duration = 620;
    var subtitleStart = 300;

    function frame(now) {
      var elapsed = now - start;
      lines.forEach(function (line, i) {
        var lineStart = i === 0 ? 70 : 250 + (i - 1) * 90;
        var p = clamp((elapsed - lineStart) / duration, 0, 1);
        var eased = easeInOut(p);
        line.style.opacity = String(.18 + .82 * eased);
        line.style.filter = 'blur(' + ((1 - eased) * 6) + 'px) contrast(' + (1 + (1 - eased) * 1.2) + ')';
        line.style.clipPath = 'inset(0 ' + ((1 - eased) * 100) + '% 0 0)';
      });
      var keyP = easeInOut(clamp((elapsed - 70) / duration, 0, 1));
      scan.style.left = (keyRect.left - copyRect.left + keyRect.width * keyP) + 'px';
      scan.style.opacity = keyP >= 1 ? '0' : '1';

      if (subtitle && subRect) {
        var sp = clamp((elapsed - subtitleStart) / 520, 0, 1);
        var se = easeInOut(sp);
        subtitle.style.opacity = String(.18 + .82 * se);
        subtitle.style.filter = 'blur(' + ((1 - se) * 4) + 'px) contrast(' + (1 + (1 - se) * .8) + ')';
        subtitle.style.clipPath = 'inset(0 ' + ((1 - se) * 100) + '% 0 0)';
        subtitleScan.style.left = (subRect.left - copyRect.left + subRect.width * se) + 'px';
        subtitleScan.style.opacity = (elapsed >= subtitleStart && se < 1) ? '.8' : '0';
      }

      if (elapsed < 1250) {
        titleAnimRaf = requestAnimationFrame(frame);
      } else {
        lines.forEach(function (line) {
          line.style.opacity = '1';
          line.style.filter = 'none';
          line.style.clipPath = 'none';
        });
        if (subtitle) {
          subtitle.style.opacity = '1';
          subtitle.style.filter = 'none';
          subtitle.style.clipPath = 'none';
        }
        scan.style.opacity = '0';
        subtitleScan.style.opacity = '0';
        titleAnimRaf = 0;
      }
    }
    titleAnimRaf = requestAnimationFrame(frame);
  }

  function cacheStaticText() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var parent = node.parentElement;
      if (!parent || parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') continue;
      if (DYNAMIC_IDS.some(function (id) { return !!parent.closest('#' + id); })) continue;
      if (node.nodeValue.trim()) staticTextNodes.push({ node: node, zh: node.nodeValue });
    }
  }

  function translateStatic() {
    staticTextNodes.forEach(function (item) {
      var key = item.zh.trim();
      if (language === 'en' && EN[key]) {
        item.node.nodeValue = item.zh.replace(key, EN[key]);
      } else {
        item.node.nodeValue = item.zh;
      }
    });
  }

  function setLanguage(next) {
    language = next === 'en' ? 'en' : 'zh';
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en-US';
    translateStatic();
    pageHint.textContent = DYN[language].pageHint;
    domainState.textContent = DYN[language].domainLive;
    setTaskDom(task.state);
    setConsoleView(consoleView);
    langToggle.textContent = language === 'zh' ? 'EN' : '中文';
    langToggle.setAttribute('aria-label', language === 'zh' ? 'Switch to English' : '切换为中文');
    document.title = language === 'zh' ? 'Mebular · 本地优先的 AI 记忆网络' : 'Mebular · Local-first AI memory network';
    try { localStorage.setItem('mebular-site-language', language); } catch (err) {}
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function easeInOut(t) { return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  function isDesktop() { return window.innerWidth > 780; }
  function stageGeometry() {
    if (isDesktop()) {
      return { cx: W * .673, cy: H * .49, r: Math.min(W * .34, H * .52) };
    }
    return { cx: W * .54, cy: H * .24, r: Math.min(W * .36, H * .20) };
  }

  function nodePosition(node) {
    var geom = stageGeometry();
    var scale = camera.zoom;
    var ampX = isDesktop() ? 82 : 30;
    var ampY = isDesktop() ? 52 : 20;
    var parallaxX = (bgSmooth.x - .5) * ampX * node.depth;
    var parallaxY = (bgSmooth.y - .5) * ampY * node.depth;
    return {
      x: geom.cx + camera.tx + node.x * geom.r * scale + parallaxX,
      y: geom.cy + camera.ty + node.y * geom.r * scale + parallaxY,
      r: geom.r * scale
    };
  }

  function cameraTarget(index) {
    var geom = stageGeometry();
    var views = [
      { zoom: 1, tx: 0, ty: 0 },
      { zoom: 1.04, tx: -geom.r * .012, ty: 0 },
      { zoom: 1.42, tx: geom.r * .045, ty: geom.r * .38 },
      { zoom: 1.03, tx: 0, ty: 0 },
      { zoom: .87, tx: 0, ty: 0 },
      { zoom: 1.02, tx: 0, ty: 0 }
    ];
    return views[index] || views[0];
  }

  function startCamera(index) {
    cameraFrom = { zoom: camera.zoom, tx: camera.tx, ty: camera.ty };
    cameraTo = cameraTarget(index);
    cameraStart = performance.now();
    if (reduceMotion) {
      camera.zoom = cameraTo.zoom;
      camera.tx = cameraTo.tx;
      camera.ty = cameraTo.ty;
    }
  }

  function updateCamera(now) {
    if (reduceMotion) return;
    var t = clamp((now - cameraStart) / cameraDuration, 0, 1);
    var e = easeInOut(t);
    camera.zoom = cameraFrom.zoom + (cameraTo.zoom - cameraFrom.zoom) * e;
    camera.tx = cameraFrom.tx + (cameraTo.tx - cameraFrom.tx) * e;
    camera.ty = cameraFrom.ty + (cameraTo.ty - cameraFrom.ty) * e;
  }

  function edgePairs(ids) {
    var pairs = [];
    for (var i = 0; i < ids.length; i++) {
      for (var j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]]);
    }
    return pairs;
  }

  function activeIds() { return domains[activeDomain] ? domains[activeDomain].ids : domains.product.ids; }

  function setPage(index, navigate) {
    index = clamp(index, 0, pages.length - 1);
    if (index === page && navigate !== true) return;
    page = index;
    pages.forEach(function (section, i) {
      section.classList.toggle('active', i === index);
      section.setAttribute('aria-hidden', String(i !== index));
    });
    navLinks.forEach(function (link) {
      if (link.classList.contains('nav-link')) {
        link.classList.toggle('active', Number(link.dataset.pageLink) === index);
      }
    });
    pageIndexEl.textContent = String(index + 1).padStart(2, '0');
    pageHint.classList.toggle('hidden', index === pages.length - 1);
    try {
      var base = location.pathname + location.search;
      history.replaceState(null, '', index === 0 ? base : '#' + pages[index].id);
    } catch (err) {}
    consoleShell.classList.toggle('visible', index === 3);
    consoleShell.setAttribute('aria-hidden', String(index !== 3));
    startCamera(index);
    animateTitle(index, navigate ? 80 : 0);
    if (navigate && !isDesktop()) {
      pages[index].scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    }
  }

  function goNext() { if (page < pages.length - 1) setPage(page + 1, true); }
  function goPrev() { if (page > 0) setPage(page - 1, true); }

  function setDomain(domain) {
    if (!domains[domain]) return;
    activeDomain = domain;
    domainButtons.forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.domain === domain));
    });
    domainCount.textContent = String(activeIds().length).padStart(2, '0');
    domainState.textContent = 'SYNC / ' + (language === 'zh' ? domains[domain].label : domains[domain].labelEn);
    domainPulseStart = performance.now();
    window.setTimeout(function () { domainState.textContent = DYN[language].domainLive; }, 900);
  }

  function setTaskDom(state) {
    var text = DYN[language];
    if (state === 'idle') {
      taskPhase.textContent = text.taskPhase.idle;
      taskStepLaptop.className = 'task-step';
      taskStateEl.textContent = 'WAITING';
      taskLog.textContent = text.taskLog.idle;
      taskButton.disabled = false;
      taskButton.textContent = text.taskButton.idle;
    } else if (state === 'moving') {
      taskPhase.textContent = text.taskPhase.moving;
      taskStepLaptop.className = 'task-step running';
      taskStateEl.textContent = 'RECEIVING';
      taskLog.textContent = text.taskLog.moving;
      taskButton.disabled = true;
      taskButton.textContent = text.taskButton.moving;
    } else {
      taskPhase.textContent = text.taskPhase.done;
      taskStepLaptop.className = 'task-step done';
      taskStateEl.textContent = 'RUNNING';
      taskLog.textContent = text.taskLog.done;
      taskButton.disabled = false;
      taskButton.textContent = text.taskButton.done;
    }
  }

  function startTask() {
    if (task.state === 'moving') return;
    if (task.state === 'done') task.state = 'idle';
    task.state = 'moving';
    task.start = performance.now();
    setTaskDom('moving');
  }

  function finishTask() {
    task.state = 'done';
    setTaskDom('done');
  }

  function setConsoleView(view) {
    consoleView = view;
    consoleTabs.forEach(function (tab) {
      tab.setAttribute('aria-pressed', String(tab.dataset.consoleView === view));
    });
    var text = DYN[language];
    if (view === 'lanes') {
      legendLeft.textContent = text.legendLanes;
      legendRight.textContent = text.legendRightLanes;
    } else {
      legendLeft.textContent = text.legendStar;
      legendRight.textContent = text.legendRightStar;
    }
  }

  function drawEdge(from, to, color, width, dash) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    var mx = (from.x + to.x) / 2;
    var my = (from.y + to.y) / 2;
    var dx = to.x - from.x;
    var dy = to.y - from.y;
    var len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    var bend = Math.min(20, len * .06) * (from.x < to.x ? 1 : -1);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(mx - dy / len * bend, my + dx / len * bend, to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }

  function quadPoint(a, b, c, t) {
    var mt = 1 - t;
    return {
      x: mt * mt * a.x + 2 * mt * t * b.x + t * t * c.x,
      y: mt * mt * a.y + 2 * mt * t * b.y + t * t * c.y
    };
  }

  function drawTaskPath(pos, time) {
    var a = pos.studio;
    var b = pos.laptop;
    if (!a || !b) return;
    var control = { x: (a.x + b.x) / 2 + 60, y: Math.min(a.y, b.y) - 100 };
    var active = task.state !== 'idle';
    ctx.save();
    ctx.strokeStyle = active ? 'rgba(223,188,128,.72)' : 'rgba(223,188,128,.18)';
    ctx.lineWidth = active ? 1.35 : .8;
    ctx.setLineDash(active ? [] : [3, 8]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(control.x, control.y, b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (active) {
      var p = task.state === 'moving' ? clamp((time - task.start) / task.duration, 0, 1) : 1;
      var dot = quadPoint(a, control, b, easeInOut(p));
      var g = ctx.createRadialGradient(dot.x, dot.y, 0, dot.x, dot.y, 20);
      g.addColorStop(0, 'rgba(223,188,128,.6)');
      g.addColorStop(1, 'rgba(223,188,128,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#f0d8aa';
      ctx.fill();
      ctx.font = '9px "IBM Plex Mono", monospace';
      ctx.fillStyle = 'rgba(223,188,128,.9)';
      ctx.textAlign = 'left';
      ctx.fillText(task.state === 'moving' ? 'HANDOFF' : 'RECEIVED', dot.x + 11, dot.y - 10);
    }
    ctx.restore();
  }

  function convexHull(points) {
    if (points.length < 3) return points.slice();
    var pts = points.slice().sort(function (a, b) { return a.x === b.x ? a.y - b.y : a.x - b.x; });
    function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
    var lower = [];
    pts.forEach(function (p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    });
    var upper = [];
    for (var i = pts.length - 1; i >= 0; i--) {
      var q = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
      upper.push(q);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  function drawBoundary(pos, time) {
    var geom = stageGeometry();
    var points = nodes.map(function (n) {
      var p = pos[n.id];
      var dx = p.x - geom.cx;
      var dy = p.y - geom.cy;
      var len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      return { x: p.x + dx / len * 62, y: p.y + dy / len * 62 };
    });
    var hull = convexHull(points);
    if (hull.length < 3) return;
    ctx.save();
    ctx.beginPath();
    hull.forEach(function (p, i) { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
    ctx.closePath();
    ctx.fillStyle = 'rgba(120,208,243,.018)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(223,188,128,.45)';
    ctx.lineWidth = .9;
    ctx.setLineDash([3, 8]);
    ctx.stroke();
    ctx.setLineDash([]);
    var top = hull.reduce(function (a, b) { return a.y < b.y ? a : b; });
    var left = hull.reduce(function (a, b) { return a.x < b.x ? a : b; });
    ctx.font = '9px "IBM Plex Mono", monospace';
    ctx.fillStyle = 'rgba(223,188,128,.82)';
    ctx.textAlign = 'left';
    ctx.fillText('TRUST BOUNDARY / ADMITTED DEVICES', left.x + 20, top.y - 12);
    ctx.fillStyle = 'rgba(120,208,243,.55)';
    ctx.textAlign = 'right';
    ctx.fillText('SUBSCRIPTIONS REMAIN AUTONOMOUS', hull.reduce(function (a, b) { return a.x > b.x ? a : b; }).x, top.y + 17);
    ctx.restore();
  }

  function drawNetwork(time) {
    ctx.clearRect(0, 0, W, H);
    var geom = stageGeometry();
    var pos = {};
    nodes.forEach(function (node) { pos[node.id] = nodePosition(node); });
    var active = {};
    activeIds().forEach(function (id) { active[id] = true; });
    var taskMode = page === 2;
    var trustMode = page === 4;
    var consoleMode = page === 3;
    var focusIds = { studio: true, laptop: true };

    if (!taskMode && consoleView === 'lanes' && consoleMode) {
      nodes.forEach(function (node) {
        if (node.id === 'studio') return;
        var p = pos[node.id];
        var reachable = active[node.id];
        var c = reachable ? 'rgba(120,208,243,.62)' : 'rgba(120,146,168,.28)';
        drawEdge(pos.studio, p, c, reachable ? 1.15 : .8, reachable ? [] : [2, 8]);
        if (reachable) drawEdge({ x: pos.studio.x + 3, y: pos.studio.y + 3 }, { x: p.x + 3, y: p.y + 3 }, 'rgba(223,188,128,.38)', .85, [5, 8]);
      });
    } else if (!taskMode) {
      edgePairs(activeIds()).forEach(function (pair) {
        var alpha = trustMode ? .16 : (page === 0 ? .14 : .46);
        drawEdge(pos[pair[0]], pos[pair[1]], 'rgba(120,208,243,' + alpha + ')', page === 0 ? .8 : 1, page === 0 ? [3, 8] : []);
      });
    }

    if (!taskMode && (page === 0 || page === 1) && !reduceMotion) {
      var since = time - domainPulseStart;
      if (page === 1 || since < 1300) {
        edgePairs(activeIds()).forEach(function (pair, idx) {
          var a = pos[pair[0]];
          var b = pos[pair[1]];
          var t = page === 1 ? ((time * .00006 + idx * .23) % 1) : clamp(since / 1000, 0, 1);
          var dx = b.x - a.x;
          var dy = b.y - a.y;
          var p = { x: a.x + dx * t, y: a.y + dy * t - Math.sin(t * Math.PI) * 8 };
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(120,208,243,.62)';
          ctx.fill();
        });
      }
    }

    if (taskMode) drawTaskPath(pos, time);
    if (trustMode) drawBoundary(pos, time);

    nodes.forEach(function (node) {
      var p = pos[node.id];
      var isActive = trustMode ? true : (taskMode ? !!focusIds[node.id] : !!active[node.id]);
      var focus = !taskMode || !!focusIds[node.id];
      var alpha = focus ? (isActive ? 1 : (page === 0 ? .45 : .3)) : .08;
      if (node.id === 'studio' && !taskMode) alpha = Math.max(alpha, .92);
      drawNode(node, p, isActive && focus, alpha, time, isActive);
    });

    if (hovered) drawHover(hovered, pos[hovered.id]);
  }

  function drawNode(node, p, active, alpha, time, hasMemory) {
    var depth = node.depth || .5;
    var radius = active ? 9.5 + depth * 3 : 6.5 + depth * 2.6;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (active) {
      var glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 45);
      glow.addColorStop(0, 'rgba(120,208,243,.24)');
      glow.addColorStop(1, 'rgba(120,208,243,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 45, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius + 5, 0, Math.PI * 2);
    ctx.strokeStyle = active ? 'rgba(120,208,243,.3)' : 'rgba(132,153,171,.2)';
    ctx.lineWidth = .7;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = active ? '#e6f5fc' : '#647487';
    ctx.shadowColor = active ? 'rgba(120,208,243,.8)' : 'transparent';
    ctx.shadowBlur = active ? 12 : 0;
    ctx.fill();
    ctx.shadowBlur = 0;
    if (active || (W > 780 && alpha > .2)) {
      ctx.font = '500 10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = active ? 'rgba(232,241,249,.9)' : 'rgba(132,153,171,.55)';
      ctx.fillText(node.label, p.x, p.y + radius + 21);
      ctx.font = '9px "IBM Plex Mono", monospace';
      ctx.fillStyle = active ? 'rgba(120,208,243,.7)' : 'rgba(132,153,171,.32)';
      ctx.fillText(language === 'zh' ? node.role : node.roleEn, p.x, p.y + radius + 34);
    }
    if (hasMemory) {
      var pulse = .55 + .25 * Math.sin(time * .0015);
      ctx.fillStyle = 'rgba(120,208,243,' + pulse + ')';
      ctx.beginPath();
      ctx.moveTo(p.x + 15, p.y - 15);
      ctx.lineTo(p.x + 19, p.y - 11);
      ctx.lineTo(p.x + 15, p.y - 7);
      ctx.lineTo(p.x + 11, p.y - 11);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  function drawHover(node, p) {
    var text = node.label.toUpperCase() + ' / ' + (language === 'zh' ? node.role : node.roleEn) + ' / ' + node.domains.length + ' DOMAINS';
    ctx.save();
    ctx.font = '9px "IBM Plex Mono", monospace';
    var tw = ctx.measureText(text).width;
    var x = Math.min(W - tw - 38, p.x + 25);
    var y = p.y - 36;
    ctx.fillStyle = 'rgba(3,7,12,.94)';
    ctx.strokeStyle = 'rgba(120,208,243,.25)';
    ctx.lineWidth = .7;
    ctx.fillRect(x, y, tw + 18, 24);
    ctx.strokeRect(x + .5, y + .5, tw + 17, 23);
    ctx.fillStyle = 'rgba(227,239,248,.9)';
    ctx.textAlign = 'left';
    ctx.fillText(text, x + 9, y + 15);
    ctx.restore();
  }

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    DPR = Math.min(2, window.devicePixelRatio || 1);
    netCanvas.width = Math.floor(W * DPR);
    netCanvas.height = Math.floor(H * DPR);
    netCanvas.style.width = W + 'px';
    netCanvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (!isDesktop()) {
      camera.zoom = cameraTarget(page).zoom;
      camera.tx = cameraTarget(page).tx;
      camera.ty = cameraTarget(page).ty;
    }
  }

  function loop(now) {
    var dt = Math.min(40, now - lastTime || 16);
    lastTime = now;
    updateCamera(now);
    if (task.state === 'moving' && now - task.start > task.duration) finishTask();

    var inertia = reduceMotion ? 1 : 1 - Math.exp(-dt / 420);
    bgSmooth.x += (bgTarget.x - bgSmooth.x) * inertia;
    bgSmooth.y += (bgTarget.y - bgSmooth.y) * inertia;

    bgCtx.fillStyle = '#03060b';
    bgCtx.fillRect(0, 0, W, H);
    if (bgNebula) {
      bgNebula.targetMouseX = bgSmooth.x;
      bgNebula.targetMouseY = bgSmooth.y;
      bgNebula.mouseX = bgSmooth.x;
      bgNebula.mouseY = bgSmooth.y;
      if (!reduceMotion) bgNebula.update(dt);
      bgNebula.render(bgCtx);
    }
    if (bgStars) {
      bgStars.mouseX = bgSmooth.x;
      bgStars.mouseY = bgSmooth.y;
      if (!reduceMotion) bgStars.update(dt);
      bgStars.render(bgCtx);
    }
    drawNetwork(now);
    requestAnimationFrame(loop);
  }

  function onScroll() {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(function () {
      scrollTick = false;
      if (isDesktop()) return;
      var mid = H * .44;
      var best = 0;
      var bestDist = Infinity;
      pages.forEach(function (section, i) {
        var rect = section.getBoundingClientRect();
        var d = Math.abs(rect.top + Math.min(rect.height, H) * .5 - mid);
        if (d < bestDist) { bestDist = d; best = i; }
      });
      setPage(best);
    });
  }

  function bind() {
    document.querySelectorAll('[data-page-link]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        event.preventDefault();
        setPage(Number(link.dataset.pageLink), true);
      });
    });
    domainButtons.forEach(function (button) {
      button.addEventListener('click', function () { setDomain(button.dataset.domain); });
    });
    langToggle.addEventListener('click', function () {
      setLanguage(language === 'zh' ? 'en' : 'zh');
    });
    consoleTabs.forEach(function (tab) {
      tab.addEventListener('click', function () { setConsoleView(tab.dataset.consoleView); });
    });
    taskButton.addEventListener('click', startTask);

    var wheelAccum = 0;
    var lastWheel = 0;
    var lastDir = 0;
    window.addEventListener('wheel', function (event) {
      if (!isDesktop()) return;
      event.preventDefault();
      var dir = event.deltaY > 0 ? 1 : -1;
      var now = performance.now();
      if (now - lastWheel < 1050) return;
      if (dir !== lastDir) { wheelAccum = 0; lastDir = dir; }
      wheelAccum += Math.abs(event.deltaY);
      if (wheelAccum < 35) return;
      wheelAccum = 0;
      lastWheel = now;
      if (dir > 0) goNext(); else goPrev();
    }, { passive: false });

    window.addEventListener('keydown', function (event) {
      if (!isDesktop()) return;
      var tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault(); goNext();
      } else if (event.key === 'ArrowUp' || event.key === 'PageUp') {
        event.preventDefault(); goPrev();
      } else if (event.key === 'Home') {
        event.preventDefault(); setPage(0);
      } else if (event.key === 'End') {
        event.preventDefault(); setPage(pages.length - 1);
      }
    });

    window.addEventListener('pointermove', function (event) {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      bgTarget.x = Math.max(0, Math.min(1, event.clientX / Math.max(1, W)));
      bgTarget.y = Math.max(0, Math.min(1, event.clientY / Math.max(1, H)));
      var found = null;
      nodes.forEach(function (node) {
        var p = nodePosition(node);
        if (Math.hypot(pointer.x - p.x, pointer.y - p.y) < 24) found = node;
      });
      hovered = found;
    }, { passive: true });

    window.addEventListener('resize', function () {
      resize();
      startCamera(page);
      onScroll();
    });
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) lastTime = performance.now();
    });

    window.addEventListener('hashchange', function () {
      var id = (location.hash || '').replace('#', '');
      var idx = pages.findIndex(function (p) { return p.id === id; });
      if (idx >= 0 && idx !== page) setPage(idx, true);
    });
  }

  function init() {
    var initialHash = (location.hash || '').replace('#', '');
    resize();
    bind();
    splitTitles();
    cacheStaticText();
    var savedLanguage = 'zh';
    try { savedLanguage = localStorage.getItem('mebular-site-language') || 'zh'; } catch (err) {}
    setLanguage(savedLanguage === 'en' ? 'en' : 'zh');
    if (window.Nebula) {
      bgNebula = new window.Nebula(bgCanvas, {
        baseParallax: .075, mouseInfluence: 1.0,
        viewLon: .5, viewTilt: .6, viewScale: .7,
        mistEnabled: !reduceMotion, mistAlpha: .08, mistParallax: .72,
        seed: Date.now()
      });
    }
    if (window.Starfield) {
      bgStars = new window.Starfield(bgCanvas, {
        mouseInfluence: 1.0, maxStars: 220, seed: Date.now() + 1
      });
    }
    camera.zoom = cameraTarget(0).zoom;
    camera.tx = cameraTarget(0).tx;
    camera.ty = cameraTarget(0).ty;
    setPage(0, true);
    if (initialHash) {
      var initialIndex = pages.findIndex(function (p) { return p.id === initialHash; });
      if (initialIndex > 0) setPage(initialIndex, true);
    }
    setDomain('product');
    setConsoleView('starmap');
    setTaskDom('idle');
    requestAnimationFrame(loop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
