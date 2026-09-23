/* ============================================================
   Mebular · 站点共享脚本
   - 星空背景动画（复用 nebula.js / stars.js）
   - 中英双语切换
   - 导航高亮
   - 等待名单表单（Buttondown 对接）
   ============================================================ */
(function () {
  'use strict';

  /* =========================================================
     1. 文案字典
     ========================================================= */
  var I18N = {
    zh: {
      'doc.pricing': '定价 · Mebular',
      'doc.waitlist': '等待名单 · Mebular',

      'nav.system': '系统',
      'nav.network': '网络',
      'nav.design': '设计',
      'nav.pricing': '定价',
      'nav.waitlist': '等待名单',
      'nav.github': 'GitHub',
      'lang.toggle': 'EN',
      'lang.aria': '切换语言',

      /* ---- 定价页 ---- */
      'pricing.tag': 'v1.0 · 定价预告',
      'pricing.title': '定价',
      'pricing.subtitle': '托管 Relay 订阅。分布式可验证的 agent 记忆网络，<br>数据主权始终在你手中。',
      'pricing.billing': '价格以美元计 · 按月订阅 · 可随时取消',

      'plan.free.name': 'Free',
      'plan.free.price': '$0',
      'plan.free.period': '永久免费',
      'plan.free.desc': '适合个人体验分布式记忆网络。',
      'plan.free.f1': '公共 relay 节点',
      'plan.free.f2': '最多 2 台设备',
      'plan.free.f3': '公平使用限额',
      'plan.free.f4': '基础记忆同步',
      'plan.free.cta': '加入等待名单',

      'plan.pro.badge': '推荐',
      'plan.pro.name': 'Pro',
      'plan.pro.price': '$8',
      'plan.pro.period': '/ 月',
      'plan.pro.desc': '为长期使用与多设备场景打造的专属实例。',
      'plan.pro.f1': '专属 relay 实例',
      'plan.pro.f2': '服务等级协议（SLA）',
      'plan.pro.f3': '更多设备（最多 10 台）',
      'plan.pro.f4': '优先同步与更低延迟',
      'plan.pro.f5': '可验证审计日志',
      'plan.pro.cta': '加入等待名单',

      'plan.team.name': 'Team',
      'plan.team.price': '$12',
      'plan.team.period': '/ 席 · 月',
      'plan.team.desc': '面向团队的多域记忆协作与合规审计。',
      'plan.team.f1': '多域管理',
      'plan.team.f2': '完整审计可见性',
      'plan.team.f3': '优先支持',
      'plan.team.f4': '席位与角色权限',
      'plan.team.f5': '合规导出与私有部署咨询',
      'plan.team.cta': '加入等待名单',

      'pricing.includes.title': '所有套餐均包含',
      'pricing.includes.body': '端到端加密 · 设备侧记忆存储 · 开源客户端 · 可验证同步',
      'faq.title': '常见问题',
      'faq.q1': '什么是托管 Relay？',
      'faq.a1': 'Relay 是记忆同步的中转节点。托管 Relay 由我们部署与运维，你无需自己搭建服务器，即可让多台设备保持记忆同步。',
      'faq.q2': 'Free 和 Pro 有什么区别？',
      'faq.a2': 'Free 使用公共 relay 并受公平使用限额约束，最多 2 台设备。Pro 提供专属 relay 实例、SLA 保障与更多设备，同步更稳定、延迟更低。',
      'faq.q3': '你们能看到我的记忆数据吗？',
      'faq.a3': '不能。记忆在设备侧加密，Relay 只负责转发与验证，不持有明文。审计日志可验证，但无法读取内容，数据主权始终属于你。',
      'faq.q4': '可以随时取消或更换套餐吗？',
      'faq.a4': '可以。订阅按月计费，可随时升级、降级或取消；取消后，当前计费周期结束前仍可正常使用。',
      'faq.q5': '企业合规与私有部署怎么支持？',
      'faq.a5': 'Team 套餐提供多域管理、完整审计可见性与优先支持。如需私有部署或定制合规方案，请在等待名单中选择「企业合规」与我们联系。',

      /* ---- 等待名单页 ---- */
      'waitlist.tag': 'v1.0 · 等待名单',
      'waitlist.title': '加入等待名单',
      'waitlist.subtitle': '留下邮箱，第一时间获取托管 Relay 的开放通知。',
      'form.email.label': '邮箱',
      'form.email.placeholder': 'you@example.com',
      'form.intent.label': '付费意向',
      'form.intent.placeholder': '请选择',
      'form.intent.relay': '托管 relay',
      'form.intent.enterprise': '企业合规',
      'form.intent.consulting': '咨询集成',
      'form.submit': '提交',
      'form.privacy': '我们仅使用你的邮箱发送产品更新，不会分享给第三方。',
      'form.err.email': '请输入有效的邮箱地址。',
      'form.err.intent': '请选择付费意向。',
      'form.err.network': '提交失败，请稍后重试。',
      'form.success.title': '已收到，谢谢！',
      'form.success.body': '我们会通过邮件与你联系。在此之前，欢迎先在 GitHub 上了解更多。',
      'form.success.back': '返回定价'
    },

    en: {
      'doc.pricing': 'Pricing · Mebular',
      'doc.waitlist': 'Waitlist · Mebular',

      'nav.system': 'System',
      'nav.network': 'Network',
      'nav.design': 'Design',
      'nav.pricing': 'Pricing',
      'nav.waitlist': 'Waitlist',
      'nav.github': 'GitHub',
      'lang.toggle': '中文',
      'lang.aria': 'Switch language',

      /* ---- Pricing ---- */
      'pricing.tag': 'v1.0 · Pricing preview',
      'pricing.title': 'Pricing',
      'pricing.subtitle': 'Hosted relay subscriptions. A distributed and verifiable agent memory network —<br>data sovereignty always stays with you.',
      'pricing.billing': 'Prices in USD · billed monthly · cancel anytime',

      'plan.free.name': 'Free',
      'plan.free.price': '$0',
      'plan.free.period': 'forever',
      'plan.free.desc': 'For individuals exploring the distributed memory network.',
      'plan.free.f1': 'Public relay node',
      'plan.free.f2': 'Up to 2 devices',
      'plan.free.f3': 'Fair-use limits',
      'plan.free.f4': 'Basic memory sync',
      'plan.free.cta': 'Join waitlist',

      'plan.pro.badge': 'Recommended',
      'plan.pro.name': 'Pro',
      'plan.pro.price': '$8',
      'plan.pro.period': '/ month',
      'plan.pro.desc': 'A dedicated instance for long-term, multi-device use.',
      'plan.pro.f1': 'Dedicated relay instance',
      'plan.pro.f2': 'Service-level agreement (SLA)',
      'plan.pro.f3': 'More devices (up to 10)',
      'plan.pro.f4': 'Priority sync, lower latency',
      'plan.pro.f5': 'Verifiable audit log',
      'plan.pro.cta': 'Join waitlist',

      'plan.team.name': 'Team',
      'plan.team.price': '$12',
      'plan.team.period': '/ seat · month',
      'plan.team.desc': 'Multi-domain memory collaboration and audit for teams.',
      'plan.team.f1': 'Multi-domain management',
      'plan.team.f2': 'Full audit visibility',
      'plan.team.f3': 'Priority support',
      'plan.team.f4': 'Seats and role permissions',
      'plan.team.f5': 'Compliance export & private deployment',
      'plan.team.cta': 'Join waitlist',

      'pricing.includes.title': 'Included in every plan',
      'pricing.includes.body': 'End-to-end encryption · device-side memory storage · open-source client · verifiable sync',
      'faq.title': 'FAQ',
      'faq.q1': 'What is a hosted relay?',
      'faq.a1': 'A relay is a transit node for memory sync. A hosted relay is deployed and operated by us, so you can keep multiple devices in sync without running your own server.',
      'faq.q2': 'What is the difference between Free and Pro?',
      'faq.a2': 'Free uses the public relay, is subject to fair-use limits, and supports up to 2 devices. Pro adds a dedicated relay instance, an SLA, and more devices with steadier, lower-latency sync.',
      'faq.q3': 'Can you see my memory data?',
      'faq.a3': 'No. Memories are encrypted on your devices; the relay only forwards and verifies and never holds plaintext. Audit logs are verifiable, but content stays unreadable. Data sovereignty stays with you.',
      'faq.q4': 'Can I cancel or change plans anytime?',
      'faq.a4': 'Yes. Subscriptions are billed monthly and you can upgrade, downgrade, or cancel anytime. After cancelling, your plan stays active until the end of the current billing period.',
      'faq.q5': 'How do you support enterprise compliance and private deployment?',
      'faq.a5': 'The Team plan offers multi-domain management, full audit visibility, and priority support. For private deployment or custom compliance, choose “Enterprise compliance” on the waitlist and reach out to us.',

      /* ---- Waitlist ---- */
      'waitlist.tag': 'v1.0 · Waitlist',
      'waitlist.title': 'Join the waitlist',
      'waitlist.subtitle': 'Leave your email and be the first to know when hosted relays open.',
      'form.email.label': 'Email',
      'form.email.placeholder': 'you@example.com',
      'form.intent.label': 'Purchase intent',
      'form.intent.placeholder': 'Select one',
      'form.intent.relay': 'Hosted relay',
      'form.intent.enterprise': 'Enterprise compliance',
      'form.intent.consulting': 'Consulting & integration',
      'form.submit': 'Submit',
      'form.privacy': 'We only use your email for product updates and never share it with third parties.',
      'form.err.email': 'Please enter a valid email address.',
      'form.err.intent': 'Please select your purchase intent.',
      'form.err.network': 'Submission failed, please try again later.',
      'form.success.title': 'Thank you!',
      'form.success.body': 'We will get in touch by email. In the meantime, feel free to learn more on GitHub.',
      'form.success.back': 'Back to pricing'
    }
  };

  var STORAGE_KEY = 'mebular-lang';

  function detectLang() {
    // 站点以中文为主：仅当用户之前手动切换过时才沿用其偏好
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'zh' || saved === 'en') return saved;
    } catch (e) {}
    return 'zh';
  }

  var lang = detectLang();

  function t(key) {
    var dict = I18N[lang] || I18N.zh;
    if (dict[key] != null) return dict[key];
    if (I18N.zh[key] != null) return I18N.zh[key];
    return key;
  }

  function applyLang(next) {
    lang = (next === 'en') ? 'en' : 'zh';
    document.documentElement.lang = (lang === 'zh') ? 'zh-CN' : 'en';

    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    }
    var htmlNodes = document.querySelectorAll('[data-i18n-html]');
    for (var j = 0; j < htmlNodes.length; j++) {
      htmlNodes[j].innerHTML = t(htmlNodes[j].getAttribute('data-i18n-html'));
    }
    var phNodes = document.querySelectorAll('[data-i18n-placeholder]');
    for (var k = 0; k < phNodes.length; k++) {
      phNodes[k].setAttribute('placeholder', t(phNodes[k].getAttribute('data-i18n-placeholder')));
    }
    var ariaNodes = document.querySelectorAll('[data-i18n-aria]');
    for (var m = 0; m < ariaNodes.length; m++) {
      ariaNodes[m].setAttribute('aria-label', t(ariaNodes[m].getAttribute('data-i18n-aria')));
    }

    var titleEl = document.body && document.body.getAttribute('data-title-i18n');
    if (titleEl) document.title = t(titleEl);

    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
  }

  function initI18n() {
    applyLang(lang);
    var toggles = document.querySelectorAll('[data-lang-toggle]');
    for (var i = 0; i < toggles.length; i++) {
      toggles[i].addEventListener('click', function () {
        applyLang(lang === 'zh' ? 'en' : 'zh');
      });
    }
  }

  /* =========================================================
     2. 导航高亮
     ========================================================= */
  function initNav() {
    var current = document.body.getAttribute('data-nav');
    if (!current) return;
    var links = document.querySelectorAll('nav a[data-nav]');
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute('data-nav') === current) {
        links[i].classList.add('is-active');
      }
    }
  }

  /* =========================================================
     3. 星空背景动画
     ========================================================= */
  function initBackground() {
    var canvas = document.getElementById('bg-canvas');
    if (!canvas || typeof window.Nebula !== 'function' || typeof window.Starfield !== 'function') return;

    var ctx = canvas.getContext('2d');
    var W = 0, H = 0;
    var nebula, stars, last = 0;

    function resize() {
      W = canvas.width = window.innerWidth;
      H = canvas.height = window.innerHeight;
    }
    resize();

    nebula = new window.Nebula(canvas, {
      baseParallax: 0.03, mouseInfluence: 1.0,
      viewLon: 0.5, viewTilt: 0.6, viewScale: 0.7,
      mistEnabled: true, mistAlpha: 0.08, mistParallax: 0.5,
      seed: Date.now()
    });

    stars = new window.Starfield(canvas, {
      mouseInfluence: 1.0, maxStars: 220, seed: Date.now() + 1
    });

    function loop(now) {
      var dt = now - last;
      last = now;
      if (dt > 100 || dt < 0) dt = 16;

      if (nebula) nebula.update(dt);
      if (stars) {
        stars.time = now;
        if (stars.update) stars.update(dt);
      }

      ctx.fillStyle = '#03050a';
      ctx.fillRect(0, 0, W, H);
      if (nebula) nebula.render(ctx);
      if (stars) stars.render(ctx);

      requestAnimationFrame(loop);
    }

    requestAnimationFrame(loop);
  }

  /* =========================================================
     4. 等待名单表单（Buttondown）
     ========================================================= */
  var PLACEHOLDER = '{{BUTTONDOWN_EMBED_URL}}';

  function initWaitlist() {
    var form = document.getElementById('waitlist-form');
    if (!form) return;

    var statusEl = document.getElementById('form-status');
    var successEl = document.getElementById('form-success');
    var emailEl = document.getElementById('email');
    var intentEl = document.getElementById('intent');

    function setError(msg) {
      if (!statusEl) return;
      statusEl.textContent = msg || '';
      statusEl.className = 'form-status' + (msg ? ' error' : '');
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      setError('');

      var email = emailEl ? emailEl.value.trim() : '';
      var intent = intentEl ? intentEl.value : '';

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setError(t('form.err.email'));
        if (emailEl) emailEl.focus();
        return;
      }
      if (!intent) {
        setError(t('form.err.intent'));
        if (intentEl) intentEl.focus();
        return;
      }

      var action = form.getAttribute('action') || '';
      var configured = action && action.indexOf(PLACEHOLDER) === -1;

      function done() {
        form.style.display = 'none';
        if (successEl) successEl.hidden = false;
      }

      if (!configured) {
        // Buttondown URL 尚未配置：仅做前端演示
        done();
        return;
      }

      var submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      fetch(action, {
        method: 'POST',
        body: new FormData(form),
        mode: 'no-cors'
      }).then(done).catch(function () {
        if (submitBtn) submitBtn.disabled = false;
        setError(t('form.err.network'));
      });
    });
  }

  /* =========================================================
     5. 初始化
     ========================================================= */
  function init() {
    initBackground();
    initI18n();
    initNav();
    initWaitlist();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.MEBULAR_SET_LANG = applyLang;
})();
