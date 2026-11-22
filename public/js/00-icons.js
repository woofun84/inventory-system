/**
 * 统一图标库 —— 全项目只使用这一套线性 SVG 图标
 * 说明：
 *   - 不依赖外部字体或 CDN，离线可用；
 *   - appIcon(name, cls) 返回可直接插入 innerHTML 的 <svg> 字符串；
 *   - 所有图标继承 currentColor，跟随主题与文字色；
 *   - 本文件必须早于 01-core.js 加载。
 */
(function () {
  const ICONS = {
    box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>',
    inbound: '<path d="M12 3v11"/><path d="m8 10 4 4 4-4"/><path d="M4 17v3h16v-3"/>',
    outbound: '<path d="M12 14V3"/><path d="m8 7 4-4 4 4"/><path d="M4 17v3h16v-3"/>',
    cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h2.5l2.2 11h11.6l2-8H6"/>',
    returns: '<path d="M4 8h10a6 6 0 1 1 0 12H8"/><path d="m8 4-4 4 4 4"/>',
    clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 10h6M9 14h6M9 18h4"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
    tag: '<path d="M3 12.5 12.5 3H21v8.5L11.5 21z"/><circle cx="17" cy="7" r="1.2"/>',
    truck: '<path d="M2 6h11v10H2z"/><path d="M13 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>',
    audit: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4"/><path d="M9 12h6M9 16h6"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8 2 2-2 2 1.5 1.5-2.5 2.5-1.5-1.5-2 2"/>',
    logout: '<path d="M14 4h5v16h-5"/><path d="M4 12h11"/><path d="m11 8 4 4-4 4"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    edit: '<path d="M4 20h4l11-11-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 9v5M12 17.5h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    chart: '<path d="M3 20h18M6 20v-6M11 20V6M16 20v-9M20 20v-4"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14.5h2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    maximize: '<path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5"/>',
    restore: '<path d="M4 9h5V4M20 9h-5V4M20 15h-5v5M4 15h5v5"/>',
    check: '<path d="m5 12 4.5 4.5L19 7"/>',
    grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 19c1-3 3-4.5 6-4.5s5 1.5 6 4.5"/><path d="M16 6.5a3 3 0 0 1 0 5.5M17 14.5c2.5.5 4 2 4.5 4.5"/>',
  };

  window.appIcon = function (name, cls) {
    const body = Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : ICONS.box;
    const klass = cls ? 'icon ' + cls : 'icon';
    return '<svg class="' + klass + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  };
})();
