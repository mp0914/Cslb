(function () {
  // Inject banner CSS
  var style = document.createElement('style');
  style.textContent = [
    '#pwa-banner{position:fixed;bottom:0;left:0;right:0;z-index:99999;',
    'background:#1a1d2e;border-top:1px solid #2a2d3e;',
    'padding:14px 18px;display:flex;align-items:center;gap:14px;',
    'box-shadow:0 -4px 24px rgba(0,0,0,.55);',
    'transform:translateY(100%);transition:transform .35s ease;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
    '#pwa-banner.show{transform:translateY(0);}',
    '#pwa-banner img{width:44px;height:44px;border-radius:12px;flex-shrink:0;}',
    '#pwa-banner-text{flex:1;min-width:0;}',
    '#pwa-banner-title{font-size:14px;font-weight:700;color:#fff;line-height:1.2;}',
    '#pwa-banner-sub{font-size:11px;color:#6b7280;margin-top:3px;line-height:1.4;}',
    '#pwa-install-btn{background:#1e3a5f;color:#60a5fa;border:1px solid rgba(30,64,175,.35);',
    'padding:9px 16px;border-radius:9px;font-size:13px;font-weight:600;',
    'cursor:pointer;white-space:nowrap;flex-shrink:0;transition:background .15s;}',
    '#pwa-install-btn:hover{background:rgba(30,64,175,.35);}',
    '#pwa-dismiss-btn{background:none;border:none;color:#6b7280;cursor:pointer;',
    'padding:4px 6px;flex-shrink:0;font-size:20px;line-height:1;transition:color .15s;}',
    '#pwa-dismiss-btn:hover{color:#9ca3af;}'
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
          ? 'Tap <strong style="color:#9ca3af">Share</strong> then <strong style="color:#9ca3af">Add to Home Screen</strong>'
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
