(function () {
  // Inject banner CSS. Matches theme.css: a floating dark card with a lime
  // action. On phones it sits above the bottom bar instead of covering it.
  var style = document.createElement('style');
  style.textContent = [
    '#pwa-banner{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));',
    'width:min(480px,calc(100% - 24px));z-index:99999;',
    'background:rgba(23,23,27,.94);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);',
    'border:1px solid rgba(255,255,255,.11);border-radius:20px;',
    'padding:12px 12px 12px 14px;display:flex;align-items:center;gap:12px;',
    'box-shadow:0 16px 48px rgba(0,0,0,.6);',
    'transform:translate(-50%,calc(100% + 40px));opacity:0;',
    'transition:transform .35s ease,opacity .35s ease;',
    "font-family:'Geist',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;}",
    '#pwa-banner.show{transform:translate(-50%,0);opacity:1;}',
    '@media (max-width:760px){body:has(.bottom-nav) #pwa-banner{bottom:calc(92px + env(safe-area-inset-bottom));}}',
    '#pwa-banner img{width:42px;height:42px;border-radius:12px;flex-shrink:0;}',
    '#pwa-banner-text{flex:1;min-width:0;}',
    '#pwa-banner-title{font-size:14px;font-weight:600;color:#F4F4F5;line-height:1.25;}',
    '#pwa-banner-sub{font-size:12px;color:#A1A1AA;margin-top:3px;line-height:1.4;}',
    '#pwa-banner-sub strong{color:#D4D4D8;font-weight:600;}',
    '#pwa-install-btn{background:#C5F25A;color:#0A0A0C;border:none;font-family:inherit;',
    'padding:0 16px;height:40px;border-radius:12px;font-size:13.5px;font-weight:600;',
    'cursor:pointer;white-space:nowrap;flex-shrink:0;transition:background .15s;}',
    '#pwa-install-btn:hover{background:#D4F77E;}',
    '#pwa-dismiss-btn{background:none;border:none;color:#8B8B94;cursor:pointer;',
    'width:36px;height:40px;flex-shrink:0;font-size:22px;line-height:1;border-radius:10px;transition:color .15s,background .15s;}',
    '#pwa-dismiss-btn:hover{color:#F4F4F5;background:rgba(255,255,255,.06);}'
  ].join('');
  document.head.appendChild(style);

  // Inject banner HTML
  var banner = document.createElement('div');
  banner.id = 'pwa-banner';
  banner.setAttribute('role', 'complementary');
  banner.setAttribute('aria-label', 'Install app');

  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  var isInStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                       navigator.standalone;

  banner.innerHTML =
    '<img src="/icon-192.svg" alt="CSLB icon">' +
    '<div id="pwa-banner-text">' +
      '<div id="pwa-banner-title">Install CSLB Practice Portal</div>' +
      '<div id="pwa-banner-sub">' +
        (isIOS
          ? 'Tap <strong>Share</strong> then <strong>Add to Home Screen</strong>'
          : 'Add to your home screen for offline access') +
      '</div>' +
    '</div>' +
    (isIOS ? '' : '<button id="pwa-install-btn">Install</button>') +
    '<button id="pwa-dismiss-btn" aria-label="Dismiss">&times;</button>';

  document.body.appendChild(banner);

  function dismiss() {
    banner.classList.remove('show');
    try { localStorage.setItem('pwa-dismissed', Date.now()); } catch (e) {}
  }

  document.getElementById('pwa-dismiss-btn').addEventListener('click', dismiss);

  function showBanner() {
    if (isInStandalone) return;
    try {
      var ts = localStorage.getItem('pwa-dismissed');
      if (ts && Date.now() - parseInt(ts) < 7 * 24 * 60 * 60 * 1000) return;
    } catch (e) {}
    setTimeout(function () { banner.classList.add('show'); }, 1800);
  }

  // Android/Chrome — wait for browser prompt event
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    showBanner();
    var btn = document.getElementById('pwa-install-btn');
    if (btn) {
      btn.addEventListener('click', function () {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function () {
          deferredPrompt = null;
          banner.classList.remove('show');
        });
      });
    }
  });

  // iOS — show instructions banner directly
  if (isIOS && !isInStandalone) showBanner();

  // Register service worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js');
    });
  }
})();
