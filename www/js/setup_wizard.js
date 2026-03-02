/**
 * HyperHDR Setup Wizard  –  setup_wizard.js
 * ═══════════════════════════════════════════════════════════════════
 *
 * Flow:
 *   Pane 0  – Welcome: "Start LED Setup" | "Upload Backup"
 *   Pane B  – Backup upload + apply (then exit wizard)
 *   Pane 1  – Capture device (screen or USB + live preview)
 *   Pane 2  – LED controller selection + options
 *   Pane 2W – WLED IP connect (only if wled selected)
 *   Pane 3  – LED layout (corner-to-corner canvas preview + strobe tests)
 *   Pane 4  – Review & save
 *
 * First-run guard: localStorage key 'hyperhdr_wizard_done'
 * ═══════════════════════════════════════════════════════════════════
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'hyperhdr_wizard_done';

    var wiz = {
        darkMode:        true,
        currentPane:     '0',       // '0','backup','1','2','2w','3','4'
        flow:            [],
        grabType:        'screen',   // 'screen' | 'usb'
        sysDevice:       'auto',
        sysFps:          24,
        vidDevice:       'auto',
        vidMode:         'auto',
        vidFps:          0,
        ctrlType:        null,
        ctrlOptions:     {},
        wledIp:          '',
        wledConnected:   false,
        leds:            { top:25, bottom:25, left:14, right:14, position:0, gpos:0, glength:0, reverse:false },
        previewActive:   false,
        ledStreamActive: false,
        showLedNums:     false,
        strobeTimer:     null,
        ledmapUploaded:  false,
        ledmapDirty:     false,
    };


    var WIZ_COOKIE = 'hyperhdr_wiz';

    function wizSave() {
        var data = {
            grabType:  wiz.grabType,
            sysDevice: wiz.sysDevice,
            sysFps:    wiz.sysFps,
            vidDevice: wiz.vidDevice,
            vidMode:   wiz.vidMode,
            vidFps:    wiz.vidFps,
            ctrlType:  wiz.ctrlType,
            wledIp:    wiz.wledIp,
            leds:      wiz.leds
        };
        var expires = new Date(Date.now() + 30*24*60*60*1000).toUTCString(); // 30 days
        document.cookie = WIZ_COOKIE + '=' + encodeURIComponent(JSON.stringify(data)) + '; expires=' + expires + '; path=/; SameSite=Lax';
    }

    function wizLoad() {
        var match = document.cookie.match(new RegExp('(?:^|; )' + WIZ_COOKIE + '=([^;]*)'));
        if (!match) return;
        try {
            var data = JSON.parse(decodeURIComponent(match[1]));
            if (data.grabType)  wiz.grabType  = data.grabType;
            if (data.sysDevice) wiz.sysDevice = data.sysDevice;
            if (data.sysFps)    wiz.sysFps    = data.sysFps;
            if (data.vidDevice) wiz.vidDevice = data.vidDevice;
            if (data.vidMode)   wiz.vidMode   = data.vidMode;
            if (data.vidFps !== undefined) wiz.vidFps = data.vidFps;
            if (data.ctrlType)  wiz.ctrlType  = data.ctrlType;
            if (data.wledIp)    wiz.wledIp    = data.wledIp;
            if (data.leds)      wiz.leds      = Object.assign(wiz.leds, data.leds);
        } catch(e) { console.warn('[Wizard] cookie load failed:', e); }
    }

    function wizRestoreDOM() {
        // Grab type tab
        document.querySelectorAll('.wiz-grab-tab').forEach(function(tab) {
            tab.classList.toggle('active', tab.dataset.grab === wiz.grabType);
        });
        var isUsb = wiz.grabType === 'usb';
        var screenEl = document.getElementById('wiz-grab-screen');
        var usbEl    = document.getElementById('wiz-grab-usb');
        if (screenEl) screenEl.style.display = isUsb ? 'none' : '';
        if (usbEl)    usbEl.style.display    = isUsb ? ''     : 'none';

        // Screen fields
        var sysDev = document.getElementById('wiz-sys-device');
        var sysFps = document.getElementById('wiz-sys-fps');
        if (sysDev && wiz.sysDevice) sysDev.value = wiz.sysDevice;
        if (sysFps && wiz.sysFps)    sysFps.value = wiz.sysFps;

        // USB fields
        var vidDev  = document.getElementById('wiz-vid-device');
        var vidMode = document.getElementById('wiz-vid-mode');
        var vidFps  = document.getElementById('wiz-vid-fps');
        if (vidDev  && wiz.vidDevice) vidDev.value  = wiz.vidDevice;
        if (vidMode && wiz.vidMode)   vidMode.value  = wiz.vidMode;
        if (vidFps  && wiz.vidFps !== undefined) vidFps.value = wiz.vidFps;

        // WLED IP
        var wledIpEl = document.getElementById('wiz-wled-ip');
        if (wledIpEl && wiz.wledIp) wledIpEl.value = wiz.wledIp;

        // LED counts
        var fields = { top:'wiz-led-top', bottom:'wiz-led-bottom', left:'wiz-led-left', right:'wiz-led-right',
                       position:'wiz-led-position', gpos:'wiz-led-gpos', glength:'wiz-led-glength' };
        Object.keys(fields).forEach(function(k) {
            var el = document.getElementById(fields[k]);
            if (el && wiz.leds[k] !== undefined) el.value = wiz.leds[k];
        });
        var revEl = document.getElementById('wiz-led-reverse');
        if (revEl) revEl.checked = !!wiz.leds.reverse;

        updateLedTotal();
    }

    var ledCanvas, imageCanvas, ledCtx, imgCtx;
    var twoDPaths = [];
    var computedLeds = [];

    var STEP_LABELS = ['Welcome', 'Capture', 'Controller', 'Layout', 'Review'];
    var PANE_TO_STEP = { '0':0, 'backup':0, '1':1, '2':2, '2o':2, '2w':2, '3':3, '4':4 };

    function shouldRun() {
        return localStorage.getItem(STORAGE_KEY) !== 'done';
    }

    function markDone() {
        localStorage.setItem(STORAGE_KEY, 'done');
    }

    function init() {
        if (!shouldRun()) return;

        if (!document.getElementById('wiz-styles')) {
            var link = document.createElement('link');
            link.id   = 'wiz-styles';
            link.rel  = 'stylesheet';
            link.href = 'css/setup_wizard.css';
            document.head.appendChild(link);
        }
        if (!document.getElementById('wiz-editor-styles')) {
            var s = document.createElement('style');
            s.id = 'wiz-editor-styles';
            s.textContent = '#wiz-ctrl-editor-container select { color: var(--wiz-text, #e2e8f0) !important; background: var(--wiz-input-bg, #1e2433) !important; } #wiz-ctrl-editor-container select option { color: #1a202c !important; background: #fff !important; }';
            document.head.appendChild(s);
        }

        fetch('content/setup_wizard.html')
            .then(function(r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.text();
            })
            .then(function(html) {
                var tmp = document.createElement('div');
                tmp.innerHTML = html;
                var overlay = tmp.querySelector('#setup-wizard-overlay');
                if (overlay) document.body.appendChild(overlay);
                var fs = tmp.querySelector('#wiz-strobe-fs');
                if (fs) document.body.appendChild(fs);
                afterInject();
            })
            .catch(function(err) {
                console.warn('[Wizard] fetch failed (' + err.message + '), falling back to inline HTML');
                injectInline();
                afterInject();
            });
    }

    function injectInline() {
        if (document.getElementById('setup-wizard-overlay')) return;
        var div = document.createElement('div');
        div.innerHTML = getWizardHTML();
        var overlay = div.querySelector('#setup-wizard-overlay');
        if (overlay) document.body.appendChild(overlay);
        var fs = div.querySelector('#wiz-strobe-fs');
        if (fs) document.body.appendChild(fs);
    }

    function getWizardHTML() {
        return [
        '<div id="setup-wizard-overlay" class="wiz-dark">','<div class="wiz-bg-mesh"></div>',

        '<div class="wiz-topbar">','<div class="wiz-logo">','<img src="/img/hyperhdr/hyperhdrwhitelogo.png" alt="HyperHDR" id="wiz-logo-img" />','<span class="wiz-logo-text">Setup Wizard</span>','</div>','<div class="wiz-topbar-right">','<span class="wiz-mode-icon">🌙</span>','<div class="wiz-mode-toggle" id="wiz-mode-toggle" title="Toggle light / dark"></div>','<span class="wiz-mode-icon">☀️</span>','</div>','</div>',

        '<div class="wiz-progress-wrap" id="wiz-progress"></div>',

        '<div class="wiz-body">',

          '<div class="wiz-pane active" id="wiz-pane-0">','<div class="wiz-pane-scroll" style="justify-content:center;">','<div style="text-align:center;margin-bottom:36px;">','<div class="wiz-complete-icon" style="background:rgba(79,156,249,.12);border-color:var(--wiz-accent);">⚡</div>','<div class="wiz-pane-title">Welcome to HyperHDR</div>','<div class="wiz-pane-sub">Let\'s get your ambient lighting set up in a few easy steps.</div>','</div>','<div class="wiz-choices">','<div class="wiz-choice-card" id="wiz-choice-setup">','<div class="wiz-choice-icon">🔧</div>','<div class="wiz-choice-title">Start LED Setup</div>','<div class="wiz-choice-desc">Configure your LED controller, capture device, and LED layout from scratch.</div>','</div>','<div class="wiz-choice-card" id="wiz-choice-backup">','<div class="wiz-choice-icon">📦</div>','<div class="wiz-choice-title">Upload Backup</div>','<div class="wiz-choice-desc">Restore a HyperHDR backup JSON file from a previous installation.</div>','</div>','</div>','</div>','</div>',

          '<div class="wiz-pane" id="wiz-pane-backup">','<div class="wiz-pane-title">Restore from Backup</div>','<div class="wiz-pane-sub">Drop your HyperHDR_export_format_v20 JSON file below.</div>','<div class="wiz-section" style="max-width:520px;">','<div class="wiz-upload-zone" id="wiz-upload-zone">','<div class="wiz-upload-icon">📂</div>','<div class="wiz-upload-title">Drop backup JSON here</div>','<div class="wiz-upload-sub">or click to browse</div>','<input type="file" id="wiz-backup-file" accept=".json" style="display:none;" />','</div>','<div id="wiz-backup-status" style="margin-top:12px;display:none;"></div>','</div>','</div>',

          '<div class="wiz-pane" id="wiz-pane-1">','<div class="wiz-pane-title">Capture Device</div>','<div class="wiz-pane-sub">Choose how HyperHDR reads your screen\'s video signal.</div>','<div style="display:flex;gap:14px;width:100%;max-width:860px;align-items:stretch;flex-wrap:wrap;">',

              '<div class="wiz-section" style="flex:1;min-width:240px;max-width:360px;">','<div class="wiz-section-title">Source</div>','<div class="wiz-grab-tabs" id="wiz-grab-tabs" style="margin-bottom:16px;">','<button class="wiz-grab-tab active" data-grab="screen">🖥️ Screen</button>','<button class="wiz-grab-tab" data-grab="usb">📷 USB</button>','</div>',

                '<div id="wiz-grab-screen">','<div class="wiz-input-group"><label>Capture Backend</label>','<select class="wiz-input" id="wiz-sys-device"><option value="auto">Auto-detect</option></select>','</div>','<div class="wiz-input-group"><label>Capture FPS</label>','<select class="wiz-input" id="wiz-sys-fps">','<option value="10">10 fps</option>','<option value="15">15 fps</option>','<option value="24" selected>24 fps</option>','<option value="30">30 fps</option>','<option value="60">60 fps</option>','</select>','</div>','</div>',

                '<div id="wiz-grab-usb" style="display:none;">','<div class="wiz-input-group"><label>Video Device</label>','<select class="wiz-input" id="wiz-vid-device"><option value="auto">Auto-detect</option></select>','</div>','<div class="wiz-input-group"><label>Resolution</label>','<select class="wiz-input" id="wiz-vid-mode"><option value="auto">Auto</option></select>','</div>','<div class="wiz-input-group"><label>FPS</label>','<select class="wiz-input" id="wiz-vid-fps"><option value="0">Auto</option></select>','</div>','</div>','</div>',

              '<div class="wiz-section" style="flex:2;min-width:260px;display:flex;flex-direction:column;">','<div class="wiz-section-title">Live Preview</div>','<div class="wiz-preview-frame" id="wiz-preview-frame-1" style="flex:1;min-height:180px;">','<canvas id="wiz-preview-canvas-1" style="width:100%;height:100%;display:block;"></canvas>','<div class="wiz-preview-badge" id="wiz-preview-badge-1">No signal</div>','</div>','<div style="margin-top:10px;display:flex;justify-content:flex-end;">','<button class="wiz-btn wiz-btn-secondary" id="wiz-preview-toggle" style="font-size:.76rem;padding:7px 16px;">▶ Start Preview</button>','</div>','</div>',

            '</div>','</div>',

          '<div class="wiz-pane" id="wiz-pane-2">','<div class="wiz-pane-title">LED Controller</div>','<div class="wiz-pane-sub">Select the type of LED controller connected to your system.</div>','<div class="wiz-pane-scroll" style="max-width:760px;width:100%;overflow-y:auto;max-height:calc(100vh - 220px);">','<div class="wiz-section" style="max-width:760px;width:100%;">','<div class="wiz-section-title">Controller Type</div>','<div id="wiz-ctrl-grid">',

                  '<div class="wiz-ctrl-group-label" style="font-size:.65rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--wiz-text3,rgba(255,255,255,.45));margin:18px 0 7px;padding-left:2px;">RPi SPI</div>','<div class="wiz-controller-grid">','<div class="wiz-ctrl-chip" data-type="apa102" data-group="SPI">apa102</div>','<div class="wiz-ctrl-chip" data-type="apa104" data-group="SPI">apa104</div>','<div class="wiz-ctrl-chip" data-type="hd108" data-group="SPI">hd108</div>','<div class="wiz-ctrl-chip" data-type="hyperspi" data-group="SPI">hyperspi</div>','<div class="wiz-ctrl-chip" data-type="lpd6803" data-group="SPI">lpd6803</div>','<div class="wiz-ctrl-chip" data-type="lpd8806" data-group="SPI">lpd8806</div>','<div class="wiz-ctrl-chip" data-type="p9813" data-group="SPI">p9813</div>','<div class="wiz-ctrl-chip" data-type="sk6812spi" data-group="SPI">sk6812spi</div>','<div class="wiz-ctrl-chip" data-type="sk6822spi" data-group="SPI">sk6822spi</div>','<div class="wiz-ctrl-chip" data-type="sk9822" data-group="SPI">sk9822</div>','<div class="wiz-ctrl-chip" data-type="ws2801" data-group="SPI">ws2801</div>','<div class="wiz-ctrl-chip" data-type="ws2812spi" data-group="SPI">ws2812spi</div>','</div>','<div class="wiz-ctrl-group-label" style="font-size:.65rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--wiz-text3,rgba(255,255,255,.45));margin:18px 0 7px;padding-left:2px;">Network</div>','<div class="wiz-controller-grid">','<div class="wiz-ctrl-chip" data-type="atmoorb" data-group="network">atmoorb</div>','<div class="wiz-ctrl-chip" data-type="cololight" data-group="network">cololight</div>','<div class="wiz-ctrl-chip" data-type="fadecandy" data-group="network">fadecandy</div>','<div class="wiz-ctrl-chip" data-type="home_assistant" data-group="network">home_assistant</div>','<div class="wiz-ctrl-chip" data-type="lifx" data-group="network">lifx</div>','<div class="wiz-ctrl-chip" data-type="nanoleaf" data-group="network">nanoleaf</div>','<div class="wiz-ctrl-chip" data-type="philipshue" data-group="network">philipshue</div>','<div class="wiz-ctrl-chip" data-type="tpm2net" data-group="network">tpm2net</div>','<div class="wiz-ctrl-chip" data-type="udpartnet" data-group="network">udpartnet</div>','<div class="wiz-ctrl-chip" data-type="udpe131" data-group="network">udpe131</div>','<div class="wiz-ctrl-chip" data-type="udph801" data-group="network">udph801</div>','<div class="wiz-ctrl-chip" data-type="udpraw" data-group="network">udpraw</div>','<div class="wiz-ctrl-chip" data-type="wled" data-group="network">wled</div>','<div class="wiz-ctrl-chip" data-type="yeelight" data-group="network">yeelight</div>','<div class="wiz-ctrl-chip" data-type="zigbee2mqtt" data-group="network">zigbee2mqtt</div>','</div>','<div class="wiz-ctrl-group-label" style="font-size:.65rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--wiz-text3,rgba(255,255,255,.45));margin:18px 0 7px;padding-left:2px;">USB / Serial</div>','<div class="wiz-controller-grid">','<div class="wiz-ctrl-chip" data-type="adalight" data-group="serial">adalight</div>','<div class="wiz-ctrl-chip" data-type="atmo" data-group="serial">atmo</div>','<div class="wiz-ctrl-chip" data-type="dmx" data-group="serial">dmx</div>','<div class="wiz-ctrl-chip" data-type="karate" data-group="serial">karate</div>','<div class="wiz-ctrl-chip" data-type="sedu" data-group="serial">sedu</div>','<div class="wiz-ctrl-chip" data-type="skydimo" data-group="serial">skydimo</div>','<div class="wiz-ctrl-chip" data-type="tpm2" data-group="serial">tpm2</div>','</div>','<div class="wiz-ctrl-group-label" style="font-size:.65rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--wiz-text3,rgba(255,255,255,.45));margin:18px 0 7px;padding-left:2px;">Debug</div>','<div class="wiz-controller-grid">','<div class="wiz-ctrl-chip" data-type="file" data-group="debug">file</div>','</div>','</div>','</div>','</div>','</div>',

          '<div class="wiz-pane" id="wiz-pane-2o">','<div class="wiz-pane-title" id="wiz-2o-title">Controller Options</div>','<div class="wiz-pane-sub" id="wiz-2o-sub">Configure your LED controller settings.</div>','<div class="wiz-pane-scroll" style="max-width:700px;width:100%;">','<div class="wiz-section" style="max-width:700px;width:100%;">',

                '<div id="wiz-ctrl-hint" style="margin-bottom:12px;display:none;"></div>',

                '<div id="wiz-ctrl-editor-container"></div>',

                '<div id="wiz-ctrl-discovery-wrap" style="margin-top:8px;display:none;">','<label style="font-size:.73rem;font-weight:600;color:var(--wiz-text2);display:block;margin-bottom:5px;" id="wiz-disc-label">Discovered devices</label>','<select class="wiz-input" id="wiz-ctrl-discovery-sel"><option value="">Select a device…</option></select>','</div>','</div>','</div>','</div>',

          '<div class="wiz-pane" id="wiz-pane-2w">','<div class="wiz-pane-title">Connect WLED Device</div>','<div class="wiz-pane-sub">Enter the IP address of your WLED device, or scan to find it automatically.</div>','<div class="wiz-section" style="max-width:500px;width:100%;">',

              '<div class="wiz-section-title">WLED IP Address</div>','<div class="wiz-connect-row" style="margin-bottom:12px;">','<input class="wiz-input" type="text" id="wiz-wled-ip" placeholder="e.g. 192.168.1.100" style="flex:1;font-family:var(--wiz-mono);" />','<button class="wiz-btn wiz-btn-secondary" id="wiz-wled-scan" style="white-space:nowrap;flex-shrink:0;">🔍 Scan</button>','<button class="wiz-btn wiz-btn-primary" id="wiz-wled-connect" style="flex-shrink:0;">Connect</button>','</div>',

              '<div id="wiz-wled-scan-results" style="display:none;margin-bottom:14px;">','<div style="font-size:.65rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--wiz-text3);margin-bottom:8px;">Found on network</div>','<div id="wiz-wled-devices" style="display:flex;flex-wrap:wrap;gap:6px;"></div>','</div>',

              '<div id="wiz-wled-status" class="wiz-status-badge idle" style="width:100%;box-sizing:border-box;">','<div class="wiz-status-dot"></div>','<span id="wiz-wled-status-text">Not connected</span>','</div>',

              '<div id="wiz-wled-strobe-bar" style="display:none;margin-top:10px;padding:10px 14px;border-radius:9px;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.25);display:none;align-items:center;gap:10px;">','<span style="font-size:1.1rem;">⚡</span>','<div style="flex:1;">','<div style="font-size:.78rem;font-weight:600;color:var(--wiz-yellow);">Strobing LEDs…</div>','<div id="wiz-strobe-progress-wrap" style="height:3px;background:rgba(251,191,36,.2);border-radius:2px;margin-top:5px;overflow:hidden;">','<div id="wiz-strobe-progress-bar" style="height:100%;width:0%;background:var(--wiz-yellow);border-radius:2px;transition:width 2s linear;"></div>','</div>','</div>','</div>',

              '<div class="wiz-divider"></div>',

              '<div class="wiz-input-group">','<label>Number of LEDs on WLED device</label>','<input class="wiz-input" type="number" id="wiz-wled-leds" value="60" min="1" max="1000" style="width:120px;font-family:var(--wiz-mono);" />','</div>','</div>','</div>',

          '<div class="wiz-pane" id="wiz-pane-3">','<div class="wiz-pane-title">LED Layout</div>','<div class="wiz-pane-sub">Set how many LEDs are on each side of your screen, then test each side.</div>','<div class="wiz-layout3-wrap">',

              '<div class="wiz-layout3-controls wiz-section">','<div class="wiz-section-title">LED Counts</div>','<div class="wiz-led-layout">','<div class="wiz-led-top wiz-led-input-stack">','<label>Top</label>','<input class="wiz-input wiz-led-count" type="number" id="wiz-led-top" value="25" min="0" />','<button class="wiz-strobe-btn" data-side="top">⚡ Test</button>','</div>','<div class="wiz-led-left wiz-led-input-stack">','<label>Left</label>','<input class="wiz-input wiz-led-count" type="number" id="wiz-led-left" value="14" min="0" />','<button class="wiz-strobe-btn" data-side="left">⚡ Test</button>','</div>','<div class="wiz-led-mid"></div>','<div class="wiz-led-right wiz-led-input-stack">','<label>Right</label>','<input class="wiz-input wiz-led-count" type="number" id="wiz-led-right" value="14" min="0" />','<button class="wiz-strobe-btn" data-side="right">⚡ Test</button>','</div>','<div class="wiz-led-bot wiz-led-input-stack">','<label>Bottom</label>','<input class="wiz-input wiz-led-count" type="number" id="wiz-led-bottom" value="25" min="0" />','<button class="wiz-strobe-btn" data-side="bottom">⚡ Test</button>','</div>','</div>','<div class="wiz-divider"></div>','<div class="wiz-section-title">Advanced Options</div>','<div class="wiz-gap-group">','<div class="wiz-gap-row"><label>Start position</label><input class="wiz-input" type="number" id="wiz-led-position" value="0" min="0" style="width:72px;" /></div>','<div class="wiz-gap-row"><label>Gap position</label><input class="wiz-input" type="number" id="wiz-led-gpos" value="0" min="0" style="width:72px;" /></div>','<div class="wiz-gap-row"><label>Gap length</label><input class="wiz-input" type="number" id="wiz-led-glength" value="0" min="0" style="width:72px;" /></div>','<div class="wiz-gap-row"><label>Reverse</label><input type="checkbox" id="wiz-led-reverse" style="width:18px;height:18px;accent-color:var(--wiz-accent);cursor:pointer;" /></div>','</div>','<div class="wiz-divider"></div>','<div style="display:flex;align-items:center;justify-content:space-between;font-size:.75rem;color:var(--wiz-text2);">','<span>Total: <b style="color:var(--wiz-accent);" id="wiz-led-total">78</b> LEDs</span>','<span style="font-size:.65rem;color:var(--wiz-text3);font-style:italic;">Updates live</span>','</div>','</div>',

              '<div class="wiz-layout3-preview">','<div class="wiz-preview-frame wiz-layout3-frame" id="wiz-preview-frame-3">','<div id="wiz-leds-preview-wrap" style="position:relative;width:100%;height:100%;">','<canvas id="wiz-image-canvas" style="position:absolute;left:0;top:0;width:100%;height:100%;z-index:1;"></canvas>','<canvas id="wiz-leds-canvas"  style="position:absolute;left:0;top:0;width:100%;height:100%;z-index:2;"></canvas>','</div>','<div class="wiz-preview-badge" id="wiz-layout-badge">Preview</div>','</div>','<div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:8px;align-items:center;">','<span id="wiz-layout-wled-badge" style="display:none;font-size:.68rem;font-family:var(--wiz-mono);padding:4px 10px;border-radius:7px;border:1px solid;margin-right:auto;"></span>','<button class="wiz-btn wiz-btn-secondary" id="wiz-toggle-led-nums" style="font-size:.72rem;padding:6px 12px;">🔢 Numbers</button>','<button class="wiz-btn wiz-btn-secondary" id="wiz-strobe-all-btn" style="font-size:.72rem;padding:6px 12px;">⚡ Test All</button>','<button class="wiz-btn wiz-btn-secondary" id="wiz-strobe-fs-btn" style="font-size:.72rem;padding:6px 12px;">⛶ Fullscreen</button>','<button class="wiz-btn wiz-btn-secondary" onclick="wizPreviewLedMap()" style="font-size:.72rem;padding:6px 12px;">💾 Download ledmap.json</button>','</div>','</div>',

            '</div>','</div>',

          '<div class="wiz-pane" id="wiz-pane-4">','<div class="wiz-pane-title">Review &amp; Save</div>','<div class="wiz-pane-sub">Your configuration is ready. Review and save to apply.</div>','<div class="wiz-pane-scroll" style="max-width:680px;width:100%;">','<div class="wiz-summary-grid" id="wiz-summary-grid">','<div class="wiz-summary-card"><div class="label">Capture Source</div><div class="value accent" id="sum-capture">—</div></div>','<div class="wiz-summary-card"><div class="label">LED Controller</div><div class="value accent" id="sum-ctrl">—</div></div>','<div class="wiz-summary-card"><div class="label">Total LEDs</div><div class="value green" id="sum-leds">—</div></div>','<div class="wiz-summary-card"><div class="label">Layout</div><div class="value" id="sum-layout">—</div></div>','<div class="wiz-summary-card"><div class="label">WLED IP</div><div class="value" id="sum-wled">N/A</div></div>','<div class="wiz-summary-card"><div class="label">Status</div><div class="value green" id="sum-status">Ready</div></div>','</div>','<div style="margin-top:20px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">','<button class="wiz-btn wiz-btn-success" id="wiz-save-btn">💾 Save &amp; Launch HyperHDR</button>','<button class="wiz-btn wiz-btn-ghost" id="wiz-back-from-final">← Back</button>','</div>','</div>','</div>',

        '</div>',

        '<div class="wiz-footer">','<div class="wiz-footer-left">','<button class="wiz-btn wiz-btn-secondary" id="wiz-back-btn" style="display:none;">← Back</button>','</div>','<div class="wiz-footer-center"></div>','<div class="wiz-footer-right">','<button class="wiz-btn wiz-btn-ghost" id="wiz-skip-btn">Skip setup</button>','<button class="wiz-btn wiz-btn-primary" id="wiz-next-btn" style="display:none;">Next →</button>','</div>','</div>',

        '</div>',

        '<div id="wiz-strobe-fs">','<div id="wiz-strobe-fs-inner">','<div style="font-size:1.2rem;font-weight:600;margin-bottom:8px;" id="wiz-strobe-fs-label">Testing all LEDs…</div>','<div style="font-size:.8rem;opacity:.5;">The LEDs should flash white/colour around your screen.</div>','<button onclick="window.wizCloseStrobeFS()">✕ Close Fullscreen</button>','</div>',
        '</div>'
        ].join('');
    }

    function afterInject() {
        var overlay = document.getElementById('setup-wizard-overlay');
        if (!overlay) return;

        wizLoad(); // restore wiz state from cookie before binding anything
        // Seed ctrlOptions.host from restored wledIp so editor and save both see it
        if (wiz.wledIp && !wiz.ctrlOptions.host) {
            wiz.ctrlOptions.host = wiz.wledIp;
        }

        buildProgressBar();
        bindModeToggle();
        bindWelcome();
        bindBackup();
        bindCapture();
        bindController();
        bindWled();
        bindLayout();
        bindReview();
        bindNavButtons();
        registerImageStreamHandler();

        var savedMode = localStorage.getItem('hyperhdr_theme');
        if (savedMode === 'light') {
            wiz.darkMode = false;
            applyMode();
        }

        waitForServer(function(){
            populateCaptureDevices();
            populateControllerList();
            wizRestoreDOM(); // restore DOM values after device lists are populated
        });
    }

    function waitForServer(cb) {
        if (window.serverInfo && window.serverInfo.ledDevices) {
            cb();
            return;
        }
        var attempts = 0;
        var t = setInterval(function(){
            attempts++;
            if ((window.serverInfo && window.serverInfo.ledDevices) || attempts > 30) {
                clearInterval(t);
                cb();
            }
        }, 300);
    }

    function buildProgressBar() {
        var wrap = document.getElementById('wiz-progress');
        if (!wrap) return;
        var html = '';
        for (var i = 0; i < STEP_LABELS.length; i++) {
            if (i > 0) html += '<div class="wiz-step-line" id="wiz-line-' + i + '"></div>';
            html += '<div class="wiz-step-dot"><div class="wiz-step-node" id="wiz-node-' + i + '">' +
                    '<span class="wiz-step-num">' + (i + 1) + '</span>' +
                    '<span class="wiz-step-label">' + STEP_LABELS[i] + '</span>' +
                    '</div></div>';
        }
        wrap.innerHTML = html;
    }

    function updateProgress(paneId) {
        var activeStep = PANE_TO_STEP[paneId] || 0;
        for (var i = 0; i < STEP_LABELS.length; i++) {
            var node = document.getElementById('wiz-node-' + i);
            if (!node) continue;
            node.classList.remove('active', 'done');
            if (i < activeStep) node.classList.add('done');
            else if (i === activeStep) node.classList.add('active');

            if (i > 0) {
                var line = document.getElementById('wiz-line-' + i);
                if (line) {
                    line.classList.remove('done', 'active');
                    if (i <= activeStep) line.classList.add(i < activeStep ? 'done' : 'active');
                }
            }
        }
    }

    function bindModeToggle() {
        var toggle = document.getElementById('wiz-mode-toggle');
        if (toggle) toggle.addEventListener('click', function(){
            wiz.darkMode = !wiz.darkMode;
            applyMode();
            localStorage.setItem('hyperhdr_theme', wiz.darkMode ? 'dark' : 'light');
        });
    }

    function applyMode() {
        var overlay = document.getElementById('setup-wizard-overlay');
        if (!overlay) return;
        overlay.classList.toggle('wiz-dark',  wiz.darkMode);
        overlay.classList.toggle('wiz-light', !wiz.darkMode);
        document.body.classList.toggle('dark-mode', wiz.darkMode);
        var logoImg = document.getElementById('wiz-logo-img');
        if (logoImg) {
            logoImg.style.filter = wiz.darkMode ? '' : 'invert(1)';
        }
    }

    function showPane(id) {
        document.querySelectorAll('.wiz-pane').forEach(function(p){
            p.classList.remove('active');
        });
        var target = document.getElementById('wiz-pane-' + id);
        if (target) target.classList.add('active');

        wiz.currentPane = id;
        updateProgress(id);
        updateNavButtons(id);

        if (id === '1') {
            setTimeout(silentEnableCapture, 500);
        }
        if (id === '3') {
            setTimeout(initLayoutCanvas, 100);
            var wledInp = document.getElementById('wiz-wled-ip');
            if (wledInp && wledInp.value.trim() && !wiz.wledIp) {
                wiz.wledIp = wledInp.value.trim();
            }
            updateLayoutWledBadge();
            updateTestButtonsVisibility();
        }
        if (id === '4') {
            populateSummary();
        }
    }

    function updateNavButtons(paneId) {
        var backBtn = document.getElementById('wiz-back-btn');
        var nextBtn = document.getElementById('wiz-next-btn');
        var skipBtn = document.getElementById('wiz-skip-btn');

        var showBack = (paneId !== '0' && paneId !== 'backup');
        if (backBtn) backBtn.style.display = showBack ? '' : 'none';

        var showNext = ['1','2','2o','2w','3'].indexOf(paneId) !== -1;
        if (nextBtn) nextBtn.style.display = showNext ? '' : 'none';

        if (skipBtn) {
            skipBtn.textContent = (paneId === '4') ? 'Skip' : 'Skip setup';
        }
    }

    // Mirrors grabber.js exactly:
    //   Step 1 — save grabber device settings:  requestWriteConfig({ systemGrabber:{...} })
    //   Step 2 — save enable checkbox:          requestWriteConfig({ systemControl:{...} })
    // Two separate calls, same as clicking Save on each panel in grabber.js.
    function silentEnableCapture() {
        if (typeof requestWriteConfig !== 'function') return;
        var activeTab = document.querySelector('.wiz-grab-tab.active');
        var grabType  = (activeTab && activeTab.dataset.grab) ? activeTab.dataset.grab : 'screen';
        wiz.grabType  = grabType;
        try {
            if (grabType === 'usb') {
                var vidDev  = document.getElementById('wiz-vid-device');
                var vidMode = document.getElementById('wiz-vid-mode');
                var vidFps  = document.getElementById('wiz-vid-fps');
                // Step 1: save videoGrabber device settings (mirrors btn_submit_videoGrabber)
                var grabPayload = { videoGrabber: wizGetConfig('videoGrabber') };
                grabPayload.videoGrabber.device    = vidDev  ? vidDev.value           : 'auto';
                grabPayload.videoGrabber.videoMode = vidMode ? vidMode.value          : 'auto';
                grabPayload.videoGrabber.fps       = vidFps  ? parseInt(vidFps.value) : 0;
                requestWriteConfig(grabPayload);
                if (window.serverConfig) window.serverConfig.videoGrabber = grabPayload.videoGrabber;
                // Step 2: save videoControl enable (mirrors btn_submit_videoControl)
                setTimeout(function() {
                    var ctrlPayload = { videoControl: wizGetConfig('videoControl') };
                    ctrlPayload.videoControl.videoInstanceEnable = true;
                    requestWriteConfig(ctrlPayload);
                    if (window.serverConfig) window.serverConfig.videoControl = ctrlPayload.videoControl;
                    // Also disable screen capture
                    setTimeout(function() {
                        var sysCtrl = { systemControl: wizGetConfig('systemControl') };
                        sysCtrl.systemControl.systemInstanceEnable = false;
                        requestWriteConfig(sysCtrl);
                        if (window.serverConfig) window.serverConfig.systemControl = sysCtrl.systemControl;
                    }, 200);
                }, 200);
            } else {
                var sysDev = document.getElementById('wiz-sys-device');
                var sysFps = document.getElementById('wiz-sys-fps');
                // Step 1: save systemGrabber device settings (mirrors btn_submit_systemGrabber)
                var grabPayload = { systemGrabber: wizGetConfig('systemGrabber') };
                grabPayload.systemGrabber.device = sysDev ? sysDev.value           : 'auto';
                grabPayload.systemGrabber.fps    = sysFps ? parseInt(sysFps.value) : 24;
                requestWriteConfig(grabPayload);
                if (window.serverConfig) window.serverConfig.systemGrabber = grabPayload.systemGrabber;
                // Step 2: save systemControl enable (mirrors btn_submit_systemControl)
                setTimeout(function() {
                    var ctrlPayload = { systemControl: wizGetConfig('systemControl') };
                    ctrlPayload.systemControl.systemInstanceEnable = true;
                    requestWriteConfig(ctrlPayload);
                    if (window.serverConfig) window.serverConfig.systemControl = ctrlPayload.systemControl;
                    // Also disable USB capture
                    setTimeout(function() {
                        var vidCtrl = { videoControl: wizGetConfig('videoControl') };
                        vidCtrl.videoControl.videoInstanceEnable = false;
                        requestWriteConfig(vidCtrl);
                        if (window.serverConfig) window.serverConfig.videoControl = vidCtrl.videoControl;
                    }, 200);
                }, 200);
            }
        } catch(e) { console.warn('[Wizard] silentEnableCapture error:', e); }
    }

    function wizGetConfig(type) {
        if (window.serverConfig && window.serverConfig[type] !== undefined) {
            return JSON.parse(JSON.stringify(window.serverConfig[type]));
        }
        if (window.schema && window.schema[type]) {
            var out = {};
            var props = window.schema[type].properties || {};
            Object.keys(props).forEach(function(k) {
                if (props[k]['default'] !== undefined) out[k] = props[k]['default'];
            });
            return out;
        }
        return {};
    }

    function bindWelcome() {
        var cardSetup  = document.getElementById('wiz-choice-setup');
        var cardBackup = document.getElementById('wiz-choice-backup');
        if (cardSetup)  cardSetup.addEventListener('click',  function(){
            // Enable HyperHDR instance first — required before capture can start
            if (typeof requestSetComponentState === 'function') {
                try { requestSetComponentState('ALL', true); } catch(e) {}
            }
            showPane('1');
        });
        if (cardBackup) cardBackup.addEventListener('click', function(){ showPane('backup'); });
    }

    function bindBackup() {
        var zone   = document.getElementById('wiz-upload-zone');
        var fileIn = document.getElementById('wiz-backup-file');
        var status = document.getElementById('wiz-backup-status');

        if (!zone) return;

        zone.addEventListener('click', function(){ if (fileIn) fileIn.click(); });

        zone.addEventListener('dragover', function(e){ e.preventDefault(); zone.classList.add('drag-over'); });
        zone.addEventListener('dragleave', function(){ zone.classList.remove('drag-over'); });
        zone.addEventListener('drop', function(e){
            e.preventDefault();
            zone.classList.remove('drag-over');
            var file = e.dataTransfer.files[0];
            if (file) processBackupFile(file);
        });

        if (fileIn) fileIn.addEventListener('change', function(){
            if (this.files[0]) processBackupFile(this.files[0]);
        });
    }

    function processBackupFile(file) {
        var status = document.getElementById('wiz-backup-status');
        var zone   = document.getElementById('wiz-upload-zone');
        var reader = new FileReader();
        reader.onload = function(e) {
            try {
                var obj = JSON.parse(e.target.result);
                if (!obj || !Array.isArray(obj.settings)) throw new Error('Not a valid HyperHDR backup file.');

                var payload = {};
                obj.settings.forEach(function(entry){
                    if (!entry.type) return;
                    var parsed;
                    try { parsed = (typeof entry.config === 'string') ? JSON.parse(entry.config) : entry.config; }
                    catch(ex){ parsed = entry.config; }
                    if (payload[entry.type] === undefined) payload[entry.type] = parsed;
                });

                if (status) {
                    status.style.display = '';
                    status.innerHTML = '<div class="wiz-status-badge ok"><div class="wiz-status-dot"></div>' +
                        '<span>Backup loaded! Applying ' + Object.keys(payload).length + ' config types…</span></div>';
                }

                if (typeof requestWriteConfig === 'function') {
                    try { requestWriteConfig(payload); } catch(ex){ console.warn('[Wizard] requestWriteConfig failed:', ex); }
                }
                if (window.serverConfig) {
                    Object.keys(payload).forEach(function(k){ window.serverConfig[k] = payload[k]; });
                }

                setTimeout(function(){ exitWizard(true); }, 1200);
            } catch (err) {
                if (status) {
                    status.style.display = '';
                    status.innerHTML = '<div class="wiz-status-badge fail"><div class="wiz-status-dot"></div><span>Error: ' + err.message + '</span></div>';
                }
            }
        };
        reader.readAsText(file);
    }

    function bindCapture() {
        document.querySelectorAll('.wiz-grab-tab').forEach(function(tab){
            tab.addEventListener('click', function(){
                document.querySelectorAll('.wiz-grab-tab').forEach(function(t){ t.classList.remove('active'); });
                tab.classList.add('active');
                wiz.grabType = tab.dataset.grab;
                document.getElementById('wiz-grab-screen').style.display = (wiz.grabType === 'screen') ? '' : 'none';
                document.getElementById('wiz-grab-usb').style.display    = (wiz.grabType === 'usb')    ? '' : 'none';
                wizSave();
                silentEnableCapture();
            });
        });

        var prevBtn = document.getElementById('wiz-preview-toggle');
        if (prevBtn) prevBtn.addEventListener('click', function(){
            if (wiz.previewActive) {
                wiz.previewActive = false;
                prevBtn.innerHTML = '▶ Start Preview';
                prevBtn.className = 'wiz-btn wiz-btn-secondary';
                stopImagePreview();
            } else {
                wiz.previewActive = true;
                prevBtn.innerHTML = '⏹ Stop Preview';
                prevBtn.className = 'wiz-btn wiz-btn-danger';
                startImagePreview();
            }
        });

        var sysDev = document.getElementById('wiz-sys-device');
        if (sysDev) sysDev.addEventListener('change', function(){ wiz.sysDevice = this.value; wizSave(); });
        var sysFpsEl = document.getElementById('wiz-sys-fps');
        if (sysFpsEl) sysFpsEl.addEventListener('change', function(){ wiz.sysFps = parseInt(this.value)||24; wizSave(); });

        var vidDevSel = document.getElementById('wiz-vid-device');
        if (vidDevSel) vidDevSel.addEventListener('change', function(){
            wiz.vidDevice = this.value;
            populateVideoModes(this.value);
            wizSave();
        });

        // Silently enable screen capture when entering pane 1 (see navigateForward)
    }

    function populateCaptureDevices() {
        var sysSel = document.getElementById('wiz-sys-device');
        if (sysSel && window.serverInfo && window.serverInfo.systemGrabbers) {
            sysSel.innerHTML = '<option value="auto">Auto-detect</option>';
            var modes = window.serverInfo.systemGrabbers.modes || [];
            modes.forEach(function(m){
                var opt = document.createElement('option');
                opt.value = m; opt.textContent = m;
                sysSel.appendChild(opt);
            });
            if (window.serverConfig && window.serverConfig.systemGrabber && window.serverConfig.systemGrabber.device) {
                sysSel.value = window.serverConfig.systemGrabber.device;
            }
        }

        var vidSel = document.getElementById('wiz-vid-device');
        if (vidSel && window.serverInfo && window.serverInfo.grabbers && window.serverInfo.grabbers.video_devices) {
            vidSel.innerHTML = '<option value="auto">Auto-detect</option>';
            window.serverInfo.grabbers.video_devices.forEach(function(dev){
                var opt = document.createElement('option');
                opt.value = dev.device; opt.textContent = dev.device;
                vidSel.appendChild(opt);
            });
        }
    }

    function populateVideoModes(device) {
        var modeSel = document.getElementById('wiz-vid-mode');
        var fpsSel  = document.getElementById('wiz-vid-fps');
        if (!modeSel || !fpsSel) return;
        modeSel.innerHTML = '<option value="auto">Auto</option>';
        fpsSel.innerHTML  = '<option value="0">Auto</option>';

        if (!window.serverInfo || !window.serverInfo.grabbers) return;
        var devInfo = (window.serverInfo.grabbers.video_devices || []).find(function(d){ return d.device === device; });
        if (!devInfo) return;

        var seenModes = [], seenFps = [];
        (devInfo.videoModeList || []).forEach(function(m){
            var modeStr = m.width + 'x' + m.height;
            if (seenModes.indexOf(modeStr) === -1) {
                seenModes.push(modeStr);
                var opt = document.createElement('option'); opt.value = modeStr; opt.textContent = modeStr;
                modeSel.appendChild(opt);
            }
            if (seenFps.indexOf(m.fps) === -1) {
                seenFps.push(m.fps);
                var opt2 = document.createElement('option'); opt2.value = m.fps; opt2.textContent = m.fps + ' fps';
                fpsSel.appendChild(opt2);
            }
        });
    }

    function setBadge(id, text, color) {
        var badge = document.getElementById(id);
        if (!badge) return;
        badge.textContent = text;
        badge.style.color = color || 'rgba(255,255,255,0.7)';
        if (color === 'var(--wiz-green)') {
            badge.style.background  = 'rgba(52,211,153,0.18)';
            badge.style.borderColor = 'rgba(52,211,153,0.35)';
        } else {
            badge.style.background  = 'rgba(0,0,0,0.7)';
            badge.style.borderColor = 'rgba(255,255,255,0.15)';
        }
    }

    function wizResetCanvas() {
        var canvas = document.getElementById('wiz-preview-canvas-1');
        if (!canvas) return;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        var sourceImg = document.getElementById('left_top_hyperhdr_logo');
        if (sourceImg && sourceImg.naturalWidth > 0) {
            var x = Math.max(canvas.width / 2 - 100, 0);
            var y = Math.max(canvas.height / 2 - 30, 0);
            ctx.drawImage(sourceImg, x, y, 200, 64);
            ctx.font = '13px monospace';
            ctx.textAlign = 'center';
            ctx.fillStyle = 'rgba(255,255,255,0.45)';
            ctx.fillText(wiz.previewActive ? 'No signal' : 'Preview paused', x + 100, y + 82);
        }
    }

    function startImagePreview() {
        var canvas = document.getElementById('wiz-preview-canvas-1');
        if (!canvas) return;
        var frame = document.getElementById('wiz-preview-frame-1');
        if (frame) {
            canvas.width  = frame.offsetWidth  || frame.clientWidth  || 480;
            canvas.height = frame.offsetHeight || frame.clientHeight || 220;
        }
        if (!canvas.width  || canvas.width  < 10) canvas.width  = 480;
        if (!canvas.height || canvas.height < 10) canvas.height = 220;
        wiz.previewLastFrame = Date.now();
        window.modalOpened = true;
        wizResetCanvas();
        if (typeof requestLedImageStart === 'function') requestLedImageStart();
        setBadge('wiz-preview-badge-1', '⏳ Starting…', '');
        wizFeedWatcher();
    }

    function stopImagePreview() {
        wiz.previewActive  = false;
        window.modalOpened = false;  // let live_preview.js resume normal control
        if (typeof requestLedImageStop === 'function') requestLedImageStop();
        wizResetCanvas();
        setBadge('wiz-preview-badge-1', 'No signal', '');
    }

    // Mirror live_preview.js feedWatcher() exactly
    function wizFeedWatcher() {
        setTimeout(function() {
            if (!wiz.previewActive) return;
            var delta = Date.now() - wiz.previewLastFrame;
            if (delta > 2000 && delta < 7000) {
                wizResetCanvas();
                setBadge('wiz-preview-badge-1', '⚠ No signal', 'var(--wiz-yellow)');
            }
            wizFeedWatcher();
        }, 2000);
    }

    // Hook into the SAME cmd-image-stream-frame event live_preview.js uses.
    // We use a namespaced handler (.wizard) so we don't interfere with live_preview.js.
    // live_preview.js checks modalOpened — we set it true when preview is active
    // so live_preview.js won't call requestLedImageStop() on our frames.
    function registerImageStreamHandler() {
        if (!window.hyperhdr) {
            setTimeout(registerImageStreamHandler, 300);
            return;
        }
        $(window.hyperhdr).off('cmd-image-stream-frame.wizard')
            .on('cmd-image-stream-frame.wizard', function(event) {
                if (wiz.currentPane !== '1' || !wiz.previewActive) return;

                var canvas = document.getElementById('wiz-preview-canvas-1');
                if (!canvas) return;
                var frame = document.getElementById('wiz-preview-frame-1');
                if (frame) {
                    var fw = frame.offsetWidth  || frame.clientWidth;
                    var fh = frame.offsetHeight || frame.clientHeight;
                    if (fw > 10 && (canvas.width !== fw || canvas.height !== fh)) {
                        canvas.width  = fw;
                        canvas.height = fh;
                    }
                }

                wiz.previewLastFrame = Date.now();

                // Identical to live_preview.js cmd-image-stream-frame handler
                var imageData  = event.response;
                var image      = new Image();
                var urlCreator = window.URL || window.webkitURL;
                image.onload   = function() {
                    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
                    setBadge('wiz-preview-badge-1', '● Live', 'var(--wiz-green)');
                };
                image.src = urlCreator.createObjectURL(imageData);
            });
    }

    var _ctrlGridBound = false;

    function bindController() {
        var container = document.getElementById('wiz-ctrl-grid');
        if (!container || _ctrlGridBound) return;
        _ctrlGridBound = true;
        container.addEventListener('click', function(e){
            var chip = e.target.closest('.wiz-ctrl-chip');
            if (!chip) return;
            container.querySelectorAll('.wiz-ctrl-chip').forEach(function(c){ c.classList.remove('selected'); });
            chip.classList.add('selected');
            wiz.ctrlType  = chip.dataset.type;
            wiz.ctrlGroup = chip.dataset.group || '';
            wizSave();
        });
    }

    function populateControllerList() {
        var container = document.getElementById('wiz-ctrl-grid');
        if (!container) return;
        bindController();
        restoreCtrlSelection(container);
    }

    function restoreCtrlSelection(container) {
        var type = wiz.ctrlType;
        if (!type && window.serverConfig && window.serverConfig.device && window.serverConfig.device.type) {
            type = window.serverConfig.device.type;
            if (type === 'philipshueentertainment') type = 'philipshue';
        }
        if (type) {
            var cur = container.querySelector('[data-type="' + type + '"]');
            if (cur) {
                cur.classList.add('selected');
                wiz.ctrlType  = type;
                wiz.ctrlGroup = cur.dataset.group || '';
            }
        }
    }

    var wiz_conf_editor = null;

    function buildControllerOptionsPane(type) {
        var container = document.getElementById('wiz-ctrl-editor-container');
        var hintEl    = document.getElementById('wiz-ctrl-hint');
        var discWrap  = document.getElementById('wiz-ctrl-discovery-wrap');
        var title     = document.getElementById('wiz-2o-title');
        var sub       = document.getElementById('wiz-2o-sub');

        if (!container) return;
        container.innerHTML = '';
        if (hintEl)   { hintEl.style.display = 'none'; hintEl.innerHTML = ''; }
        if (discWrap) discWrap.style.display = 'none';
        if (title)    title.textContent = type + ' Options';
        if (sub)      sub.textContent   = 'Configure the settings for your ' + type + ' controller.';

        if (wiz_conf_editor) {
            try { wiz_conf_editor.destroy(); } catch(e){}
            wiz_conf_editor = null;
        }

        if (window.serverSchema &&
            window.serverSchema.properties &&
            window.serverSchema.properties.device &&
            window.serverSchema.properties.alldevices &&
            window.serverSchema.properties.alldevices[type]) {

            var generalOptions  = window.serverSchema.properties.device;
            var specificOptions = window.serverSchema.properties.alldevices[type];

            var group = wiz.ctrlGroup || '';
            var isSpiPlatform = window.sysInfo &&
                (window.sysInfo.system.productType === 'windows' ||
                 window.sysInfo.system.productType === 'macos');
            if (isSpiPlatform && group === 'SPI') {
                if (specificOptions.properties && specificOptions.properties.output) {
                    delete specificOptions.properties.output.default;
                }
            }

            if (typeof createJsonEditor === 'function') {
                wiz_conf_editor = createJsonEditor('wiz-ctrl-editor-container', {
                    generalOptions:  generalOptions,
                    specificOptions: specificOptions,
                });

                var isCurrentDevice = (window.serverConfig && window.serverConfig.device &&
                                       window.serverConfig.device.type === type);

                var values_general = {};
                for (var key in window.serverConfig.device) {
                    if (key !== 'type' && key in generalOptions.properties)
                        values_general[key] = window.serverConfig.device[key];
                }
                wiz_conf_editor.getEditor('root.generalOptions').setValue(values_general);

                if (isCurrentDevice) {
                    var specificVals = wiz_conf_editor.getEditor('root.specificOptions').getValue();
                    var values_specific = {};
                    for (var k in specificVals) {
                        values_specific[k] = (k in window.serverConfig.device)
                            ? window.serverConfig.device[k]
                            : specificVals[k];
                    }
                    wiz_conf_editor.getEditor('root.specificOptions').setValue(values_specific);
                } else {
                    wiz_conf_editor.getEditor('root.generalOptions.refreshTime').setValue(0);
                }

                var needsDisc = (group === 'SPI' || group === 'serial');
                if (needsDisc && typeof requestLedDeviceDiscovery === 'function') {
                    // Inject discovery dropdown inline next to the output/SPI path input,
                    // same pattern as light_source.js #deviceListInstances
                    var _discSel = $('<select id="wiz-ctrl-disc-sel" />')
                        .addClass('wiz-input')
                        .css({ width: '40%', 'margin-left': '6px', 'flex-shrink': '0',
                               'font-size': '.8rem', cursor: 'pointer' });

                    var _discPortLabel = (group === 'SPI') ? 'SPI device' : 'serial port';
                    _discSel.append($('<option>', { value: '', text: '\u23f3 Scanning\u2026' }));

                    // Append select synchronously beside the output input (createJsonEditor is sync)
                    var _outInput = $("input[name='root[specificOptions][output]']", '#wiz-ctrl-editor-container');
                    if (_outInput.length) {
                        _outInput[0].style.width = '55%';
                        _outInput[0].parentElement.style.display = 'flex';
                        _outInput[0].parentElement.style.alignItems = 'center';
                        _outInput[0].parentElement.appendChild(_discSel[0]);
                    }

                    // Populate asynchronously
                    requestLedDeviceDiscovery(type).then(function(result) {
                        _discSel.empty();
                        var devs = (result && result.info && result.info.devices) ? result.info.devices : [];
                        _discSel.append($('<option>', { value: '', text: devs.length
                            ? 'Select ' + _discPortLabel + '\u2026'
                            : 'No ' + _discPortLabel + ' found' }));
                        devs.forEach(function(dev) {
                            _discSel.append($('<option>', { value: dev.value, text: dev.name || dev.value }));
                        });
                        _discSel.append($('<option>', { value: '__rescan__', text: '\ud83d\udd04 Rescan\u2026' }));
                    }).catch(function() {
                        _discSel.empty()
                            .append($('<option>', { value: '', text: 'Discovery failed' }))
                            .append($('<option>', { value: '__rescan__', text: '\ud83d\udd04 Rescan\u2026' }));
                    });

                    _discSel.on('change', function() {
                        var val = $(this).val();
                        if (val === '__rescan__') {
                            _discSel.empty().append($('<option>', { value: '', text: '\u23f3 Scanning\u2026' }));
                            requestLedDeviceDiscovery(type).then(function(result) {
                                _discSel.empty();
                                var devs = (result && result.info && result.info.devices) ? result.info.devices : [];
                                _discSel.append($('<option>', { value: '', text: devs.length
                                    ? 'Select ' + _discPortLabel + '\u2026'
                                    : 'No ' + _discPortLabel + ' found' }));
                                devs.forEach(function(dev) {
                                    _discSel.append($('<option>', { value: dev.value, text: dev.name || dev.value }));
                                });
                                _discSel.append($('<option>', { value: '__rescan__', text: '\ud83d\udd04 Rescan\u2026' }));
                            });
                            return;
                        }
                        if (!val || !wiz_conf_editor) return;
                        try { wiz_conf_editor.getEditor('root.specificOptions.output').setValue(val); } catch(e) {}
                    });
                }

                if (hintEl && (type === 'ws2812spi' || type === 'ws281x' || type === 'sk6812spi')) {
                    hintEl.style.display = '';
                    hintEl.innerHTML = '<div style="padding:10px 14px;border-radius:8px;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);font-size:.78rem;color:var(--wiz-yellow);">⚠ This device requires the ws281x/SPI kernel driver to be installed and configured on your system.</div>';
                }

            } else {
                container.innerHTML = '<div style="color:var(--wiz-text2);font-size:.8rem;padding:8px 0;">Controller editor not available. Options will use defaults.</div>';
                buildFallbackFields(container, type);
            }

        } else {
            buildFallbackFields(container, type);
        }
    }

    function buildFallbackFields(container, type) {
        var defs = {
            'adalight':  [
                {key:'output',     label:'Serial Port',    type:'text',   placeholder:'/dev/ttyUSB0', default:'/dev/ttyUSB0'},
                {key:'rate',       label:'Baud Rate',      type:'number', default:115200},
                {key:'colorOrder', label:'Color Order',    type:'select', options:['RGB','GRB','BGR'], default:'RGB'},
            ],
            'ws281x':    [
                {key:'gpio',       label:'GPIO Pin',       type:'number', default:18},
                {key:'colorOrder', label:'Color Order',    type:'select', options:['RGB','GRB','BGR'], default:'RGB'},
            ],
            'sk6812spi': [
                {key:'output',     label:'SPI Device',     type:'text',   placeholder:'/dev/spidev0.0', default:'/dev/spidev0.0'},
                {key:'colorOrder', label:'Color Order',    type:'select', options:['RGBW','GRBW','BGRW'], default:'RGBW'},
            ],
            'ws2812spi': [
                {key:'output',     label:'SPI Device',     type:'text',   placeholder:'/dev/spidev0.0', default:'/dev/spidev0.0'},
                {key:'colorOrder', label:'Color Order',    type:'select', options:['RGB','GRB','BGR'], default:'GRB'},
            ],
            'tpm2net':   [
                {key:'host',       label:'Target IP',      type:'text',   placeholder:'192.168.1.x', default:''},
                {key:'colorOrder', label:'Color Order',    type:'select', options:['RGB','GRB'], default:'RGB'},
            ],
            'adalight-apa102': [
                {key:'output',     label:'Serial Port',    type:'text',   placeholder:'/dev/ttyUSB0', default:'/dev/ttyUSB0'},
                {key:'colorOrder', label:'Color Order',    type:'select', options:['RGB','GRB','BGR'], default:'RGB'},
            ],
            'dmx':       [
                {key:'output',     label:'DMX Device',     type:'text',   placeholder:'/dev/ttyUSB0', default:''},
                {key:'universe',   label:'Universe',       type:'number', default:1},
            ],
            'karate':    [
                {key:'output',     label:'Serial Port',    type:'text',   placeholder:'/dev/ttyUSB0', default:'/dev/ttyUSB0'},
            ],
            'sedu':      [
                {key:'output',     label:'Serial Port',    type:'text',   placeholder:'/dev/ttyUSB0', default:'/dev/ttyUSB0'},
            ],
            'tpm2':      [
                {key:'output',     label:'Serial Port',    type:'text',   placeholder:'/dev/ttyUSB0', default:'/dev/ttyUSB0'},
            ],
            'philipshue':[
                {key:'output',     label:'Bridge IP',      type:'text',   placeholder:'192.168.1.x', default:''},
                {key:'username',   label:'API Username',   type:'text',   placeholder:'', default:''},
            ],
            'yeelight':  [
                {key:'host',       label:'Device IP',      type:'text',   placeholder:'192.168.1.x', default:''},
            ],
            'file':      [
                {key:'output',     label:'File path',      type:'text',   placeholder:'/tmp/leds.txt', default:'/tmp/leds.txt'},
            ],
        };

        var fields = defs[type];
        if (!fields || !fields.length) {
            container.innerHTML += '<div style="font-size:.78rem;color:var(--wiz-text2);">No additional configuration needed for <b>' + type + '</b>. Click Next to continue.</div>';
            return;
        }

        fields.forEach(function(f){
            var grp = document.createElement('div');
            grp.className = 'wiz-input-group';
            var lbl = document.createElement('label');
            lbl.textContent = f.label;
            grp.appendChild(lbl);

            var val = (wiz.ctrlOptions && wiz.ctrlOptions[f.key] !== undefined)
                ? wiz.ctrlOptions[f.key] : f.default;

            if (f.type === 'select') {
                var sel = document.createElement('select');
                sel.className = 'wiz-input';
                f.options.forEach(function(o){
                    var opt = document.createElement('option');
                    opt.value = o; opt.textContent = o;
                    if (o === val) opt.selected = true;
                    sel.appendChild(opt);
                });
                sel.addEventListener('change', function(){ wiz.ctrlOptions[f.key] = this.value; });
                wiz.ctrlOptions[f.key] = val;
                grp.appendChild(sel);
            } else {
                var inp = document.createElement('input');
                inp.className = 'wiz-input';
                inp.type = f.type || 'text';
                inp.placeholder = f.placeholder || '';
                inp.value = val !== undefined ? val : '';
                inp.addEventListener('input', function(){ wiz.ctrlOptions[f.key] = this.value; });
                wiz.ctrlOptions[f.key] = inp.value;
                grp.appendChild(inp);
            }
            container.appendChild(grp);
        });
    }

    function collectCtrlOptions() {
        if (!wiz_conf_editor) return;
        try {
            var genVal  = wiz_conf_editor.getEditor('root.generalOptions').getValue();
            var specVal = wiz_conf_editor.getEditor('root.specificOptions').getValue();
            wiz.ctrlOptions = Object.assign({}, genVal, specVal);
        } catch(e) {
            console.warn('[Wizard] collectCtrlOptions error:', e);
        }
    }

    function bindWled() {
        var connectBtn = document.getElementById('wiz-wled-connect');
        var scanBtn    = document.getElementById('wiz-wled-scan');
        var ipInput    = document.getElementById('wiz-wled-ip');

        if (connectBtn) connectBtn.addEventListener('click', function(){
            var ip = ipInput ? ipInput.value.trim() : '';
            if (!ip) {
                if (ipInput) {
                    ipInput.style.borderColor = 'var(--wiz-red)';
                    ipInput.focus();
                    setTimeout(function(){ ipInput.style.borderColor = ''; }, 1500);
                }
                return;
            }
            attemptWledConnect(ip, connectBtn);
        });

        if (scanBtn) scanBtn.addEventListener('click', function(){
            triggerWledScan(scanBtn);
        });

        if (ipInput && wiz.ctrlOptions.host) ipInput.value = wiz.ctrlOptions.host;
    }

    function setWledStatus(state, text) {
        var badge = document.getElementById('wiz-wled-status');
        var txt   = document.getElementById('wiz-wled-status-text');
        if (!badge) return;
        badge.classList.remove('idle', 'testing', 'ok', 'fail');
        badge.classList.add(state);
        if (txt) txt.textContent = text;
    }

    function setConnectBtn(btn, state) {
        if (!btn) return;
        btn.disabled = (state === 'connecting');
        if (state === 'connecting') {
            btn.innerHTML = '<span class="wiz-spinner" style="display:inline-block;"></span> Connecting…';
            btn.style.background = '';
            btn.className = 'wiz-btn wiz-btn-secondary';
        } else if (state === 'ok') {
            btn.innerHTML = '✓ Connected';
            btn.className = 'wiz-btn wiz-btn-success';
            btn.disabled = false;
        } else if (state === 'fail') {
            btn.innerHTML = '✗ Failed — Retry';
            btn.className = 'wiz-btn wiz-btn-danger';
            btn.disabled = false;
        } else {
            btn.innerHTML = 'Connect';
            btn.className = 'wiz-btn wiz-btn-primary';
            btn.disabled = false;
        }
    }

    function attemptWledConnect(ip, btn) {
        setConnectBtn(btn, 'connecting');
        setWledStatus('testing', 'Connecting to ' + ip + '…');
        wiz.wledConnected = false;

        if (typeof requestSetComponentState === 'function') {
            try { requestSetComponentState('ALL', false); } catch(e){}
        }

        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timeoutId  = controller ? setTimeout(function(){ controller.abort(); }, 4000) : null;
        var fetchOpts  = controller ? { signal: controller.signal } : {};

        fetch('http://' + ip + '/json/info', fetchOpts)
            .then(function(r){
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function(data){
                if (timeoutId) clearTimeout(timeoutId);

                var name    = (data && data.name)    ? data.name    : 'WLED Device';
                var version = (data && data.ver)     ? ' v' + data.ver : '';
                var leds    = (data && data.leds && data.leds.count) ? data.leds.count : null;

                wiz.wledConnected = true;
                wiz.wledIp = ip;
                wizSave();
                wiz.ctrlOptions.host = ip;
                if (leds) {
                    wiz.ctrlOptions.leds = leds;
                    var ledsInp = document.getElementById('wiz-wled-leds');
                    if (ledsInp) ledsInp.value = leds;
                }

                var ipInCtrl = document.getElementById('wiz-ctrl-wled-host');
                if (ipInCtrl) ipInCtrl.value = ip;

                setConnectBtn(btn, 'ok');
                setWledStatus('ok', '✓ ' + name + version + (leds ? '  —  ' + leds + ' LEDs' : ''));

                var badge = document.getElementById('wiz-wled-status');
                if (badge) {
                    badge.style.transform = 'scale(1.04)';
                    setTimeout(function(){ badge.style.transform = ''; }, 300);
                }

                triggerWledStrobe(ip);
            })
            .catch(function(err){
                if (timeoutId) clearTimeout(timeoutId);
                var reason = (err && err.name === 'AbortError') ? 'Timed out' : 'No response';
                setConnectBtn(btn, 'fail');
                setWledStatus('fail', '✗ ' + reason + ' — check IP and network');
                wiz.wledConnected = false;

                var ipInput = document.getElementById('wiz-wled-ip');
                if (ipInput) {
                    ipInput.style.borderColor = 'var(--wiz-red)';
                    ipInput.style.animation = 'wiz-shake .4s ease';
                    setTimeout(function(){
                        ipInput.style.borderColor = '';
                        ipInput.style.animation   = '';
                    }, 500);
                }
            });
    }

    function triggerWledScan(scanBtn) {
        var scanResults  = document.getElementById('wiz-wled-scan-results');
        var devContainer = document.getElementById('wiz-wled-devices');

        if (scanBtn) {
            scanBtn.disabled = true;
            scanBtn.innerHTML = '<span class="wiz-spinner" style="display:inline-block;vertical-align:middle;margin-right:4px;"></span> Scanning…';
        }

        if (scanResults) scanResults.style.display = '';
        if (devContainer) devContainer.innerHTML = '<div style="font-size:.75rem;color:var(--wiz-text2);padding:4px 0;">Looking for WLED devices on your network…</div>';
        setWledStatus('testing', 'Scanning network…');

        function resetScanBtn() {
            if (scanBtn) {
                scanBtn.disabled = false;
                scanBtn.innerHTML = '🔍 Scan';
            }
        }

        function buildDeviceChip(dev) {
            var chip = document.createElement('button');
            chip.className = 'wiz-ctrl-chip';
            chip.style.cssText = 'cursor:pointer;display:flex;align-items:center;gap:6px;padding:8px 12px;';

            var dot = document.createElement('span');
            dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:var(--wiz-green);flex-shrink:0;';

            var label = document.createElement('span');
            label.textContent = (dev.name && dev.name !== dev.value) ? dev.name + '  ' + dev.value : dev.value;

            chip.appendChild(dot);
            chip.appendChild(label);

            chip.addEventListener('click', function(){
                devContainer.querySelectorAll('.wiz-ctrl-chip').forEach(function(c){ c.classList.remove('selected'); });
                chip.classList.add('selected');

                var ipIn = document.getElementById('wiz-wled-ip');
                if (ipIn) ipIn.value = dev.value;
                wiz.wledIp = dev.value;

                var connectBtn = document.getElementById('wiz-wled-connect');
                attemptWledConnect(dev.value, connectBtn);
            });

            return chip;
        }

        if (typeof requestLedDeviceDiscovery === 'function') {
            requestLedDeviceDiscovery('wled')
                .then(function(result){
                    resetScanBtn();
                    if (devContainer) devContainer.innerHTML = '';

                    var devices = (result && result.info && result.info.devices) ? result.info.devices : [];
                    if (devices.length) {
                        devices.forEach(function(dev){
                            devContainer.appendChild(buildDeviceChip(dev));
                        });
                        setWledStatus('idle', devices.length + ' device' + (devices.length > 1 ? 's' : '') + ' found — click to connect');
                    } else {
                        devContainer.innerHTML = '<div style="font-size:.75rem;color:var(--wiz-text2);">No WLED devices found. Enter IP manually.</div>';
                        setWledStatus('idle', 'No devices found');
                    }
                })
                .catch(function(){
                    resetScanBtn();
                    if (devContainer) devContainer.innerHTML = '<div style="font-size:.75rem;color:var(--wiz-red);">Scan failed. Enter IP manually.</div>';
                    setWledStatus('idle', 'Scan failed');
                });
        } else {
            resetScanBtn();
            if (devContainer) devContainer.innerHTML = '<div style="font-size:.75rem;color:var(--wiz-text2);">Auto-scan not available. Enter the WLED IP address manually.</div>';
            setWledStatus('idle', 'Enter IP manually');
        }
    }

    function triggerWledStrobe(ip) {
        var headers = { 'Content-Type': 'application/json' };

        var blinkPayload = JSON.stringify({ on: true, bri: 255, transition: 0, seg: [{ col: [[255, 255, 255]], fx: 1, sx: 220 }] });
        var offPayload   = JSON.stringify({ on: false, transition: 0 });

        function post(payload) {
            return fetch('http://' + ip + '/json/state', { method: 'POST', headers: headers, body: payload }).catch(function(){});
        }

        post(blinkPayload);
        setTimeout(function(){ post(offPayload); }, 2000);

        var bar     = document.getElementById('wiz-wled-strobe-bar');
        var prog    = document.getElementById('wiz-strobe-progress-bar');
        var statusBadge = document.getElementById('wiz-wled-status');

        if (bar) {
            bar.style.display = 'flex';
            if (prog) {
                prog.style.width = '0%';
                void prog.offsetWidth;
                prog.style.width = '100%';
            }
        }

        setTimeout(function(){
            if (bar) bar.style.display = 'none';
            if (prog) { prog.style.width = '0%'; }

            var txt = document.getElementById('wiz-wled-status-text');
            setWledStatus('ok', txt ? txt.textContent : '✓ Connected');
        }, 2200);
    }

    var _layoutDebTimer    = null;
    var _ledmapUploadTimer = null;

    function scheduleLiveLayoutUpdate() {
        clearTimeout(_layoutDebTimer);
        _layoutDebTimer = setTimeout(function(){
            buildLedLayout();
            renderLedCanvas();
            scheduleWledLedmapRebuild();
        }, 150);
    }

    function scheduleWledLedmapRebuild() {
        if (!getWledIp()) return;
        // Just mark dirty — reboot happens only when user clicks a test button
        wiz.ledmapDirty    = true;
        wiz.ledmapUploaded = false;
    }

    function uploadLedmapToWled(cb) {
        var ip     = getWledIp();
        var mapObj = generateLedMap();
        if (!ip || !mapObj) { if (cb) cb(false); return; }

        var blob = new Blob([JSON.stringify(mapObj)], { type: 'application/json' });
        var fd   = new FormData();
        fd.append('data', blob, 'ledmap.json');

        fetch('http://' + ip + '/edit', { method: 'POST', body: fd })
            .then(function(r) {
                console.log('[WLED] ledmap.json upload status:', r.status);
                return wledPost({ rb: true }).catch(function(){});
            })
            .then(function() { if (cb) cb(true); })
            .catch(function(e) {
                console.warn('[WLED] ledmap upload error:', e);
                if (cb) cb(false);
            });
    }

    function deleteLedmapFromWled(cb) {
        var ip = getWledIp();
        if (!ip) { if (cb) cb(false); return; }
        var blank = new Blob(['{"map":[]}'], { type: 'application/json' });
        var fd    = new FormData();
        fd.append('data', blank, 'ledmap.json');
        fetch('http://' + ip + '/edit', { method: 'POST', body: fd })
            .then(function(r) {
                console.log('[WLED] ledmap.json cleared, status:', r.status);
                return wledPost({ rb: true }).catch(function(){});
            })
            .then(function() { if (cb) cb(true); })
            .catch(function(e) {
                console.warn('[WLED] ledmap clear error:', e);
                if (cb) cb(false);
            });
    }

    function bindLayout() {
        ['wiz-led-top','wiz-led-bottom','wiz-led-left','wiz-led-right'].forEach(function(id){
            var el = document.getElementById(id);
            if (el) el.addEventListener('input', function(){
                wiz.leds[id.replace('wiz-led-','')] = parseInt(this.value) || 0;
                updateLedTotal();
                scheduleLiveLayoutUpdate();
                wizSave();
            });
        });

        var posEl = document.getElementById('wiz-led-position');
        var gposEl = document.getElementById('wiz-led-gpos');
        var glenEl = document.getElementById('wiz-led-glength');
        var revEl  = document.getElementById('wiz-led-reverse');
        if (posEl)  posEl.addEventListener('input',  function(){ wiz.leds.position = parseInt(this.value)||0; scheduleLiveLayoutUpdate(); wizSave(); });
        if (gposEl) gposEl.addEventListener('input', function(){ wiz.leds.gpos     = parseInt(this.value)||0; scheduleLiveLayoutUpdate(); wizSave(); });
        if (glenEl) glenEl.addEventListener('input', function(){ wiz.leds.glength  = parseInt(this.value)||0; scheduleLiveLayoutUpdate(); wizSave(); });
        if (revEl)  revEl.addEventListener('change', function(){ wiz.leds.reverse  = this.checked; scheduleLiveLayoutUpdate(); wizSave(); });

        var upd = document.getElementById('wiz-layout-update');
        if (upd) upd.addEventListener('click', function(){ buildLedLayout(); renderLedCanvas(); });

        var numBtn = document.getElementById('wiz-toggle-led-nums');
        if (numBtn) numBtn.addEventListener('click', function(){
            wiz.showLedNums = !wiz.showLedNums;
            this.classList.toggle('active', wiz.showLedNums);
            renderLedCanvas();
        });

        var allBtn = document.getElementById('wiz-strobe-all-btn');
        if (allBtn) allBtn.addEventListener('click', function(){
            runTestWithLedmapGuard(allBtn, function(){ strobeAllLeds(2000); }, 'all');
        });

        var fsBtn = document.getElementById('wiz-strobe-fs-btn');
        if (fsBtn) fsBtn.addEventListener('click', function(){ openStrobeFS('all'); });

        document.querySelectorAll('.wiz-strobe-btn').forEach(function(btn){
            btn.addEventListener('click', function(){
                var side = this.dataset.side;
                var clickedBtn = this;
                runTestWithLedmapGuard(clickedBtn, function(){ strobeSide(side, 2000); }, side);
            });
        });

        if (window.hyperhdr) {
            $(window.hyperhdr).on('cmd-image-stream-frame', function(event){
                if (wiz.currentPane !== '3') return;
                if (!imgCtx) return;
                var img = new Image();
                img.onload = function(){ imgCtx.drawImage(img, 0, 0, imageCanvas.width, imageCanvas.height); };
                var urlCreator = window.URL || window.webkitURL;
                img.src = urlCreator.createObjectURL(event.response);
            });
            $(window.hyperhdr).on('cmd-ledcolors-ledstream-update', function(event){
                if (wiz.currentPane !== '3') return;
                renderLedCanvas(event.response.result.leds);
            });
        }
    }

    function initLayoutCanvas() {
        var frame = document.getElementById('wiz-preview-frame-3');
        imageCanvas = document.getElementById('wiz-image-canvas');
        ledCanvas   = document.getElementById('wiz-leds-canvas');
        if (!imageCanvas || !ledCanvas || !frame) return;

        var w = frame.clientWidth  || 560;
        var h = frame.clientHeight || 315;

        imageCanvas.width  = ledCanvas.width  = w;
        imageCanvas.height = ledCanvas.height = h;

        ledCtx = ledCanvas.getContext('2d');
        imgCtx = imageCanvas.getContext('2d');

        imgCtx.fillStyle = '#000';
        imgCtx.fillRect(0, 0, w, h);

        ledCtx.strokeStyle = 'rgba(80,80,80,0.5)';

        buildLedLayout();
        renderLedCanvas();
    }

    function buildLedLayout() {
        var l = wiz.leds;
        var params = {
            ledstop:    l.top    || 0,
            ledsbottom: l.bottom || 0,
            ledsleft:   l.left   || 0,
            ledsright:  l.right  || 0,
            ledsglength: l.glength || 0,
            ledsgpos:    l.gpos    || 0,
            position:    l.position || 0,
            groupX: 0, groupY: 0, reverse: l.reverse || false,
            ledsVDepth: 0.05, ledsHDepth: 0.08,
            edgeVGap: 0, overlap: 0,
            ptblh:0, ptblv:1, ptbrh:1, ptbrv:1,
            pttlh:0, pttlv:0, pttrh:1, pttrv:0
        };

        if (typeof createClassicLedLayout === 'function') {
            computedLeds = createClassicLedLayout(params);
        } else {
            computedLeds = buildFallbackLayout(params);
        }

        updateLedTotal();
        var badge = document.getElementById('wiz-layout-badge');
        if (badge) badge.textContent = computedLeds.length + ' LEDs';

        rebuildPaths();
    }

    function buildFallbackLayout(p) {
        var arr = [];
        var total = p.ledstop + p.ledsright + p.ledsbottom + p.ledsleft;
        if (total === 0) return arr;

        function addLeds(count, hminFn, hmaxFn, vminFn, vmaxFn, sideGroup) {
            for (var i = 0; i < count; i++) {
                arr.push({
                    hmin:round4(hminFn(i,count)), hmax:round4(hmaxFn(i,count)),
                    vmin:round4(vminFn(i,count)), vmax:round4(vmaxFn(i,count)),
                    group:0, side: sideGroup
                });
            }
        }
        function round4(v){ return Math.round(v*10000)/10000; }
        var dH = p.ledsHDepth, dV = p.ledsVDepth;
        if (p.ledstop>0)    addLeds(p.ledstop,    function(i,n){return i/n;},      function(i,n){return (i+1)/n;}, function(){return 0;},    function(){return dH;},  'top');
        if (p.ledsright>0)  addLeds(p.ledsright,  function(){return 1-dV;},        function(){return 1;},          function(i,n){return i/n;}, function(i,n){return (i+1)/n;}, 'right');
        if (p.ledsbottom>0) addLeds(p.ledsbottom, function(i,n){return 1-(i+1)/n;},function(i,n){return 1-i/n;},  function(){return 1-dH;}, function(){return 1;},   'bottom');
        if (p.ledsleft>0)   addLeds(p.ledsleft,   function(){return 0;},            function(){return dV;},         function(i,n){return 1-(i+1)/n;}, function(i,n){return 1-i/n;}, 'left');

        var pos = ((p.position || 0) % total + total) % total;
        if (pos > 0) arr = arr.slice(pos).concat(arr.slice(0, pos));

        if (p.reverse) arr.reverse();

        if (p.ledsglength > 0 && p.ledsgpos >= 0) {
            var gStart = ((p.ledsgpos % total) + total) % total;
            var toRemove = [];
            for (var g = 0; g < p.ledsglength; g++) {
                toRemove.push((gStart + g) % total);
            }
            toRemove.sort(function(a,b){return b-a;});
            toRemove.forEach(function(idx){ arr.splice(idx, 1); });
        }

        return arr;
    }

    function rebuildPaths() {
        if (!ledCanvas) return;
        var W = ledCanvas.width, H = ledCanvas.height;
        twoDPaths = [];
        computedLeds.forEach(function(led){
            var x = led.hmin * W, y = led.vmin * H;
            var w = (led.hmax - led.hmin) * W, h = (led.vmax - led.vmin) * H;
            twoDPaths.push(buildRoundRect(x, y, w, h, 4));
        });
    }

    function buildRoundRect(x, y, w, h, r) {
        var path = new Path2D();
        path.moveTo(x+r, y);
        path.lineTo(x+w-r, y); path.quadraticCurveTo(x+w, y, x+w, y+r);
        path.lineTo(x+w, y+h-r); path.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
        path.lineTo(x+r, y+h); path.quadraticCurveTo(x, y+h, x, y+h-r);
        path.lineTo(x, y+r); path.quadraticCurveTo(x, y, x+r, y);
        return path;
    }

    function renderLedCanvas(colors) {
        if (!ledCtx || !computedLeds.length) return;
        ledCtx.clearRect(0, 0, ledCanvas.width, ledCanvas.height);
        var W = ledCanvas.width, H = ledCanvas.height;
        var total = computedLeds.length;

        computedLeds.forEach(function(led, idx){
            var fill;
            if (colors && colors.length/3 >= total) {
                fill = 'rgba(' + colors[idx*3] + ',' + colors[idx*3+1] + ',' + colors[idx*3+2] + ',0.8)';
            } else {
                if (idx === 0)      fill = 'rgba(0,0,0,0.95)';
                else if (idx === 1) fill = 'rgba(90,90,90,0.95)';
                else                fill = 'hsla(' + (idx*360/total) + ',100%,55%,0.75)';
            }
            ledCtx.fillStyle = fill;
            if (twoDPaths[idx]) {
                ledCtx.fill(twoDPaths[idx]);
                ledCtx.stroke(twoDPaths[idx]);
            }

            if (wiz.showLedNums) {
                var displayNum = idx;
                ledCtx.fillStyle = 'rgba(0,0,0,0.7)';
                var cx = (led.hmin + (led.hmax - led.hmin) / 2) * W;
                var cy = (led.vmin + (led.vmax - led.vmin) / 2) * H;
                var labelW = String(displayNum).length * 5 + 4;
                ledCtx.fillRect(cx - labelW/2, cy - 7, labelW, 11);
                ledCtx.fillStyle = '#fff';
                ledCtx.font = 'bold 9px monospace';
                ledCtx.textAlign = 'center';
                ledCtx.fillText(displayNum, cx, cy + 3);
            }
        });

        drawSideLabels(W, H);
    }

    function drawSideLabels(W, H) {
        if (!ledCtx) return;
        var labels = [
            { text: 'TOP',    x: W/2, y: 14,   align: 'center' },
            { text: 'BOTTOM', x: W/2, y: H-6,  align: 'center' },
            { text: 'LEFT',   x: 4,   y: H/2,  align: 'left',  rotate: -Math.PI/2, rx: 14, ry: H/2 },
            { text: 'RIGHT',  x: W-4, y: H/2,  align: 'right', rotate: Math.PI/2,  rx: W-14, ry: H/2 }
        ];
        ledCtx.save();
        ledCtx.font = 'bold 10px monospace';

        ledCtx.fillStyle = 'rgba(255,255,255,0.35)';
        ledCtx.textAlign = 'center';
        ledCtx.fillText('TOP', W/2, 13);

        ledCtx.fillText('BOTTOM', W/2, H - 5);

        ledCtx.save();
        ledCtx.translate(13, H/2);
        ledCtx.rotate(-Math.PI/2);
        ledCtx.textAlign = 'center';
        ledCtx.fillText('LEFT', 0, 0);
        ledCtx.restore();

        ledCtx.save();
        ledCtx.translate(W - 13, H/2);
        ledCtx.rotate(Math.PI/2);
        ledCtx.textAlign = 'center';
        ledCtx.fillText('RIGHT', 0, 0);
        ledCtx.restore();

        ledCtx.restore();
    }

    function updateLedTotal() {
        var t = (wiz.leds.top||0)+(wiz.leds.bottom||0)+(wiz.leds.left||0)+(wiz.leds.right||0);
        var el = document.getElementById('wiz-led-total');
        if (el) el.textContent = t;
    }

    function updateLayoutWledBadge() {
        var badge = document.getElementById('wiz-layout-wled-badge');
        if (!badge) return;
        var ip = getWledIp();
        if (ip) {
            badge.style.display = '';
            badge.textContent = '⚡ WLED: ' + ip;
            badge.style.color = 'var(--wiz-green)';
            badge.style.borderColor = 'rgba(52,211,153,.3)';
            badge.style.background = 'rgba(52,211,153,.1)';
        } else {
            badge.style.display = 'none';
        }
        updateTestButtonsVisibility();
    }

    function updateTestButtonsVisibility() {
       var isWled   = (wiz.ctrlType === 'wled');
       var display  = isWled ? '' : 'none';

      document.querySelectorAll('.wiz-strobe-btn').forEach(function(btn){
        btn.style.display = display;
      });
      ['wiz-strobe-all-btn', 'wiz-strobe-fs-btn'].forEach(function(id){
        var el = document.getElementById(id);
        if (el) el.style.display = display;
      });
    }

    function getWledIp() {
        if (wiz.wledIp) return wiz.wledIp;
        var inp = document.getElementById('wiz-wled-ip');
        return inp ? inp.value.trim() : '';
    }

    function wledPost(payload) {
        var ip = getWledIp();
        if (!ip) return Promise.resolve(null);
        console.log('[WLED →]', JSON.stringify(payload));
        return fetch('http://' + ip + '/json/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function(r) { return r.json(); })
          .then(function(r) { console.log('[WLED ←]', JSON.stringify(r)); return r; })
          .catch(function(e) { console.warn('[WLED err]', e); return null; });
    }

    function buildIArray(indices, total) {
        var sorted = indices.slice().sort(function(a, b) { return a - b; });

        var ranges = [];
        if (sorted.length) {
            var rs = sorted[0], re = sorted[0] + 1;
            for (var k = 1; k < sorted.length; k++) {
                if (sorted[k] === re) { re++; }
                else { ranges.push([rs, re]); rs = sorted[k]; re = sorted[k] + 1; }
            }
            ranges.push([rs, re]);
        }

        var iArr = [0, total, '000000'];
        ranges.forEach(function(r) {
            iArr.push(r[0], r[1], 'FFFFFF');
        });

        return iArr;
    }

    function getIndicesForSide(side) {
        var l   = wiz.leds;
        var T   = l.top    || 0;
        var R   = l.right  || 0;
        var B   = l.bottom || 0;
        var L   = l.left   || 0;
        var tot = T + R + B + L;
        if (!tot) return [];

        var pStart, pEnd;
        switch (side) {
            case 'top':    pStart = 0;       pEnd = T;       break;
            case 'right':  pStart = T;       pEnd = T+R;     break;
            case 'bottom': pStart = T+R;     pEnd = T+R+B;   break;
            case 'left':   pStart = T+R+B;   pEnd = tot;     break;
            default: return [];
        }

        var rev = l.reverse || false;
        var pos = ((l.position || 0) % tot + tot) % tot;

        var indices = [];
        for (var p = pStart; p < pEnd; p++) {
            indices.push(p);
        }

        console.log('[Side ' + side + '] phys ' + pStart + '..' + (pEnd-1) + ' → indices:', indices.join(','));
        return indices;
    }

    function strobeSide(side, duration) {
        if (!computedLeds.length) return;

        var total   = (wiz.leds.top||0)+(wiz.leds.right||0)+(wiz.leds.bottom||0)+(wiz.leds.left||0);
        var indices = getIndicesForSide(side);
        var ip      = getWledIp();
        var step    = Math.max(200, Math.floor(duration / 6));

        if (!indices.length) return;

        if (ip) {
            wledPost({ on: true, bri: 255, transition: 0 }).then(function() {
                var iOn  = buildIArray(indices, total);
                var iOff = [0, total, '000000'];

                var n = 0;
                (function flash() {
                    if (n >= 6) {
                        wledPost({ on: false });
                        return;
                    }
                    wledPost({ seg: { i: (n % 2 === 0) ? iOn : iOff } });
                    n++;
                    setTimeout(flash, step);
                })();
            });
        } else if (typeof requestLedDeviceIdentification === 'function') {
            requestLedDeviceIdentification('test', {});
        }

        if (ledCtx) {
            var canvasIdx = getCanvasIndicesForSide(side);
            _strobeCanvasSide(canvasIdx, duration);
        }
    }

    function strobeAllLeds(duration) {
        if (!computedLeds.length) return;

        var ip    = getWledIp();
        var total = (wiz.leds.top||0)+(wiz.leds.right||0)+(wiz.leds.bottom||0)+(wiz.leds.left||0);
        var step  = Math.max(200, Math.floor(duration / 6));

        if (ip) {
            wledPost({ on: true, bri: 255, transition: 0 }).then(function() {
                var n = 0;
                (function flash() {
                    if (n >= 6) { wledPost({ on: false }); return; }
                    var col = (n % 2 === 0) ? [[255,255,255]] : [[0,0,0]];
                    wledPost({ seg: { col: col, fx: 0 } });
                    n++;
                    setTimeout(flash, step);
                })();
            });
        } else if (typeof requestLedDeviceIdentification === 'function') {
            requestLedDeviceIdentification('test', {});
        }

        if (ledCtx) _strobeCanvasAll(duration);
    }

    function getCanvasIndicesForSide(side) {
        var indices = [];
        computedLeds.forEach(function(led, i) {
            if (led.side === side) indices.push(i);
        });
        if (indices.length) return indices;

        var l   = wiz.leds;
        var T   = l.top||0, R=l.right||0, B=l.bottom||0, L=l.left||0;
        var tot = T+R+B+L;
        if (!tot) return [];
        var pos = ((l.position||0) % tot + tot) % tot;
        var pStart, pEnd;
        switch(side) {
            case 'top':    pStart=0;     pEnd=T;     break;
            case 'right':  pStart=T;     pEnd=T+R;   break;
            case 'bottom': pStart=T+R;   pEnd=T+R+B; break;
            case 'left':   pStart=T+R+B; pEnd=tot;   break;
            default: return [];
        }
        for (var p = pStart; p < pEnd; p++) {
            indices.push((p - pos + tot) % tot);
        }
        return indices;
    }

    function _strobeCanvasAll(duration) {
        var n = 0, max = 6;
        var t = setInterval(function(){
            if (!ledCtx) { clearInterval(t); return; }
            if (n % 2 === 0) {
                ledCtx.clearRect(0, 0, ledCanvas.width, ledCanvas.height);
                ledCtx.fillStyle = 'rgba(255,255,255,0.92)';
                twoDPaths.forEach(function(p){ ledCtx.fill(p); });
            } else {
                renderLedCanvas();
            }
            if (++n >= max) { clearInterval(t); renderLedCanvas(); }
        }, duration / max);
    }

    function _strobeCanvasSide(canvasIndices, duration) {
        var n = 0, max = 6;
        var t = setInterval(function(){
            renderLedCanvas();
            if (n % 2 === 0) {
                ledCtx.fillStyle = 'rgba(255,255,255,0.95)';
                canvasIndices.forEach(function(i){
                    if (twoDPaths[i]) ledCtx.fill(twoDPaths[i]);
                });
            }
            if (++n >= max) { clearInterval(t); renderLedCanvas(); }
        }, duration / max);
    }

    function generateLedMap() {
        var l   = wiz.leds;
        var T   = l.top     || 0;
        var R   = l.right   || 0;
        var B   = l.bottom  || 0;
        var L   = l.left    || 0;
        var tot = T + R + B + L;
        if (!tot) return null;

        var pos     = ((l.position || 0) % tot + tot) % tot;
        var gpos    = ((l.gpos    || 0) % tot + tot) % tot;
        var glength = l.glength || 0;
        var rev     = l.reverse  || false;

        var gapSet = {};
        for (var g = 0; g < glength; g++) {
            gapSet[(gpos + g) % tot] = true;
        }

        var map = new Array(tot);
        for (var p = 0; p < tot; p++) {
            if (gapSet[p]) {
                map[p] = -1;
            } else {
                var logical = (p - pos + tot) % tot;
                if (rev) logical = tot - 1 - logical;
                map[p] = logical;
            }
        }

        return { map: map };
    }

    function runTestWithLedmapGuard(btn, testFn, side) {
        var needsReboot = !getWledIp() ? false : (!wiz.ledmapUploaded || wiz.ledmapDirty);

        // No WLED or ledmap already current — run test directly
        if (!needsReboot) {
            testFn();
            return;
        }

        var origText     = btn ? btn.textContent : '';
        var origDisabled = btn ? btn.disabled    : false;

        if (btn) { btn.disabled = true; btn.textContent = '⏳ Uploading map…'; }
        document.querySelectorAll('.wiz-strobe-btn, #wiz-strobe-all-btn, #wiz-strobe-fs-btn').forEach(function(b){
            b.disabled = true;
        });

        if (typeof requestSetComponentState === 'function') {
            try { requestSetComponentState('ALL', false); } catch(e){}
        }

        if (!generateLedMap()) {
            // No valid ledmap — skip reboot, run test directly
            _restoreTestButtons();
            if (btn) { btn.disabled = origDisabled; btn.textContent = origText; }
            wiz.ledmapUploaded = true;
            wiz.ledmapDirty    = false;
            testFn();
            return;
        }

        uploadLedmapToWled(function(ok) {
            if (ok) {
                wiz.ledmapUploaded = true;
                wiz.ledmapDirty    = false;
                // Show "Preparing test…" on the clicked button while WLED reboots
                if (btn) btn.textContent = '⏳ Preparing test…';
                // Start canvas strobe immediately so user sees feedback during the 5s wait
                if (ledCtx) {
                    if (side && side !== 'all') {
                        var waitIndices = getCanvasIndicesForSide(side);
                        if (waitIndices.length) _strobeCanvasSide(waitIndices, 5000);
                        else _strobeCanvasAll(5000);
                    } else {
                        _strobeCanvasAll(5000);
                    }
                }
                // 5 second wait after reboot — WLED flash starts once device is ready
                setTimeout(function() {
                    _restoreTestButtons();
                    if (btn) { btn.disabled = false; btn.textContent = origText; }
                    testFn();  // ← WLED flash starts HERE after WLED is ready
                }, 5000);
            } else {
                // Upload failed — still run test, don't block user
                _restoreTestButtons();
                if (btn) { btn.disabled = false; btn.textContent = origText; }
                testFn();
            }
        });
    }

    function _restoreTestButtons() {
        document.querySelectorAll('.wiz-strobe-btn, #wiz-strobe-all-btn, #wiz-strobe-fs-btn').forEach(function(b){
            b.disabled = false;
        });
    }

    window.wizUploadLedMap = function() {
        var ip = getWledIp();
        if (!ip) { alert('No WLED IP set. Connect to WLED first.'); return; }
        if (!generateLedMap()) { alert('No LED layout configured.'); return; }

        var btn = document.getElementById('wiz-upload-ledmap-btn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Uploading…'; }

        uploadLedmapToWled(function(ok) {
            if (btn) {
                btn.disabled = false;
                btn.textContent = ok ? '✓ Uploaded! Rebooting…' : '✗ Upload failed';
                if (ok) setTimeout(function(){ btn.textContent = '📁 Upload ledmap.json'; }, 3500);
            }
            if (ok) wiz.ledmapUploaded = true;
        });
    };

    window.wizPreviewLedMap = function() {
        var mapObj = generateLedMap();
        if (!mapObj) { alert('No layout configured.'); return; }
        var json = JSON.stringify(mapObj, null, 2);
        var a = document.createElement('a');
        a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
        a.download = 'ledmap.json';
        a.click();
    };

    function getSideRanges(l) {
        var top = l.top||0, right = l.right||0, bottom = l.bottom||0, left = l.left||0;
        return {
            top:    [0,             top],
            right:  [top,           top+right],
            bottom: [top+right,     top+right+bottom],
            left:   [top+right+bottom, top+right+bottom+left]
        };
    }

    window.wizCloseStrobeFS = function() {
        var fs = document.getElementById('wiz-strobe-fs');
        if (fs) fs.classList.remove('show');
        if (typeof requestLedColorsStop === 'function') requestLedColorsStop();
    };

    function openStrobeFS(side) {
        var fs  = document.getElementById('wiz-strobe-fs');
        var lbl = document.getElementById('wiz-strobe-fs-label');
        var inner = document.getElementById('wiz-strobe-fs-inner');
        if (!fs || !inner) return;

        if (lbl) lbl.textContent = side === 'all' ? 'Testing all LEDs…' : 'Testing ' + side + ' LEDs…';
        fs.classList.add('show');

        if (typeof requestLedColorsStart === 'function') requestLedColorsStart();

        strobeAllLeds(3000);
    }

    function populateSummary() {
        var _grabTab = document.querySelector('.wiz-grab-tab.active');
        if (_grabTab && _grabTab.dataset && _grabTab.dataset.grab) wiz.grabType = _grabTab.dataset.grab;
        var _s = document.getElementById('wiz-sys-device'); if (_s && _s.value) wiz.sysDevice = _s.value;
        var _f = document.getElementById('wiz-sys-fps');    if (_f && _f.value) wiz.sysFps    = parseInt(_f.value) || 24;
        var _v = document.getElementById('wiz-vid-device'); if (_v && _v.value) wiz.vidDevice = _v.value;
        var l = wiz.leds;
        var total = (l.top||0)+(l.bottom||0)+(l.left||0)+(l.right||0);
        setText('sum-capture',  wiz.grabType === 'screen' ? ('Screen (' + (wiz.sysDevice || 'auto') + ')') : ('USB: ' + (wiz.vidDevice || 'auto')));
        setText('sum-ctrl',     wiz.ctrlType || 'Not set');
        setText('sum-leds',     total + ' LEDs');
        setText('sum-layout',   'T:' + l.top + ' B:' + l.bottom + ' L:' + l.left + ' R:' + l.right);
        setText('sum-wled',     wiz.wledIp ? (wiz.wledIp + (wiz.wledConnected ? ' ✓' : ' ✗')) : 'N/A');
        setText('sum-status',   'Ready to save');
    }

    function setText(id, val) {
        var el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    function bindReview() {
        var saveBtn = document.getElementById('wiz-save-btn');
        var backBtn = document.getElementById('wiz-back-from-final');
        if (saveBtn) saveBtn.addEventListener('click', saveAndExit);
        if (backBtn) backBtn.addEventListener('click', function(){ navigateBack(); });
    }

    function saveAndExit() {
        collectCtrlOptions();

        var saveBtn = document.getElementById('wiz-save-btn');
        if (saveBtn) { saveBtn.textContent = '⏳ Saving…'; saveBtn.disabled = true; }

        function _doSave() {
            var payload = {};

            if (wiz.ctrlType) {
                if (wiz_conf_editor) {
                    try {
                        var genVal  = wiz_conf_editor.getEditor('root.generalOptions').getValue();
                        var specVal = wiz_conf_editor.getEditor('root.specificOptions').getValue();
                        payload.device = Object.assign({ type: wiz.ctrlType }, genVal, specVal);
                    } catch(e) {
                        payload.device = Object.assign({ type: wiz.ctrlType }, wiz.ctrlOptions);
                    }
                } else {
                    payload.device = Object.assign({ type: wiz.ctrlType }, wiz.ctrlOptions);
                }
                ['leds','rate','gpio','universe','port'].forEach(function(k){
                    if (payload.device[k] !== undefined && !isNaN(payload.device[k]))
                        payload.device[k] = Number(payload.device[k]);
                });
                // Ensure WLED IP is always in the device payload
                if (wiz.ctrlType === 'wled' && wiz.wledIp && !payload.device.host) {
                    payload.device.host = wiz.wledIp;
                }
            }

            var l = wiz.leds;
            if (computedLeds.length) {
                payload.leds = computedLeds;
            }
            payload.ledConfig = {
                classic: {
                    top: l.top||0, bottom: l.bottom||0,
                    left: l.left||0, right: l.right||0,
                    ledsglength: l.glength||0, ledsgpos: l.gpos||0,
                    position: l.position||0, reverse: l.reverse||false
                }
            };

            var _grabTab = document.querySelector('.wiz-grab-tab.active');
            if (_grabTab && _grabTab.dataset && _grabTab.dataset.grab) wiz.grabType = _grabTab.dataset.grab;
            var _sysDev  = document.getElementById('wiz-sys-device');
            var _sysFps  = document.getElementById('wiz-sys-fps');
            var _vidDev  = document.getElementById('wiz-vid-device');
            var _vidMode = document.getElementById('wiz-vid-mode');
            var _vidFps  = document.getElementById('wiz-vid-fps');
            if (_sysDev  && _sysDev.value)  wiz.sysDevice = _sysDev.value;
            if (_sysFps  && _sysFps.value)  wiz.sysFps    = parseInt(_sysFps.value) || 24;
            if (_vidDev  && _vidDev.value)  wiz.vidDevice = _vidDev.value;
            if (_vidMode && _vidMode.value) wiz.vidMode   = _vidMode.value;
            if (_vidFps  && _vidFps.value !== undefined && _vidFps.value !== '') {
                wiz.vidFps = parseInt(_vidFps.value) || 0;
            }

            var sc = window.serverConfig || {};

            if (wiz.grabType === 'screen') {
                payload.systemGrabber = wizGetConfig('systemGrabber');
                payload.systemGrabber.device = wiz.sysDevice || 'auto';
                payload.systemGrabber.fps    = wiz.sysFps    || 24;
                payload.systemControl = wizGetConfig('systemControl');
                payload.systemControl.systemInstanceEnable = true;
                payload.videoControl  = wizGetConfig('videoControl');
                payload.videoControl.videoInstanceEnable  = false;
            } else {
                payload.videoGrabber = wizGetConfig('videoGrabber');
                payload.videoGrabber.device    = wiz.vidDevice || 'auto';
                payload.videoGrabber.videoMode = wiz.vidMode   || 'auto';
                payload.videoGrabber.fps       = wiz.vidFps    || 0;
                payload.videoControl  = wizGetConfig('videoControl');
                payload.videoControl.videoInstanceEnable  = true;
                payload.systemControl = wizGetConfig('systemControl');
                payload.systemControl.systemInstanceEnable = false;
            }

            // Enable HyperHDR instance first — saving while disabled throws an error
            if (typeof requestSetComponentState === 'function') {
                try { requestSetComponentState('ALL', true); } catch(e) {}
            }

            setTimeout(function() {
                if (typeof requestWriteConfig === 'function') {
                    try { requestWriteConfig(payload); } catch(e){ console.warn('[Wizard] save error:', e); }
                }
                if (window.serverConfig) {
                    Object.keys(payload).forEach(function(k){ window.serverConfig[k] = payload[k]; });
                }
                setTimeout(function(){ exitWizard(true); }, 800);
            }, 600);
        }

        if (getWledIp()) {
            if (saveBtn) saveBtn.textContent = '⏳ Removing ledmap…';
            deleteLedmapFromWled(function() {
                if (saveBtn) saveBtn.textContent = '⏳ Finishing…';
                setTimeout(_doSave, 2000);
            });
        } else {
            _doSave();
        }
    }

    function bindNavButtons() {
        var nextBtn = document.getElementById('wiz-next-btn');
        var backBtn = document.getElementById('wiz-back-btn');
        var skipBtn = document.getElementById('wiz-skip-btn');

        if (nextBtn) nextBtn.addEventListener('click', navigateForward);
        if (backBtn) backBtn.addEventListener('click', navigateBack);
        if (skipBtn) skipBtn.addEventListener('click', function(){ exitWizard(false); });
    }

    function navigateForward() {
        stopPreviewIfActive();
        var p = wiz.currentPane;
        if (p === '1') {
            var _activeTab = document.querySelector('.wiz-grab-tab.active');
            if (_activeTab && _activeTab.dataset && _activeTab.dataset.grab) {
                wiz.grabType = _activeTab.dataset.grab;
            }
            var sysDev  = document.getElementById('wiz-sys-device');
            var sysFps  = document.getElementById('wiz-sys-fps');
            var vidDev  = document.getElementById('wiz-vid-device');
            var vidMode = document.getElementById('wiz-vid-mode');
            var vidFps  = document.getElementById('wiz-vid-fps');
            wiz.sysDevice = sysDev  ? sysDev.value          : 'auto';
            wiz.sysFps    = sysFps  ? parseInt(sysFps.value) : 24;
            wiz.vidDevice = vidDev  ? vidDev.value           : 'auto';
            wiz.vidMode   = vidMode ? vidMode.value          : 'auto';
            wiz.vidFps    = vidFps  ? parseInt(vidFps.value) : 0;
            showPane('2');

        } else if (p === '2') {
            if (!wiz.ctrlType) { highlightRequired(document.getElementById('wiz-ctrl-grid')); return; }
            buildControllerOptionsPane(wiz.ctrlType);
            if (wiz.ctrlType === 'wled') {
                var ipIn = document.getElementById('wiz-wled-ip');
                if (ipIn && wiz.ctrlOptions.host) ipIn.value = wiz.ctrlOptions.host;
                showPane('2w');
            } else {
                showPane('2o');
            }

        } else if (p === '2o') {
            collectCtrlOptions();
            showPane('3');

        } else if (p === '2w') {
            showPane('3');

        } else if (p === '3') {
            buildLedLayout();
            showPane('4');
        }
    }

    function navigateBack() {
        stopPreviewIfActive();
        var p = wiz.currentPane;
        if      (p === 'backup') showPane('0');
        else if (p === '1')      showPane('0');
        else if (p === '2')      showPane('1');
        else if (p === '2o')     showPane('2');
        else if (p === '2w')     showPane('2');
        else if (p === '3')      {
            if (wiz.ctrlType === 'wled') showPane('2w');
            else showPane('2o');
        }
        else if (p === '4')      showPane('3');
    }

    function stopPreviewIfActive() {
        if (wiz.previewActive) {
            wiz.previewActive = false;
            stopImagePreview();
            var btn = document.getElementById('wiz-preview-toggle');
            if (btn) {
                btn.innerHTML = '▶ Start Preview';
                btn.className = 'wiz-btn wiz-btn-secondary';
            }
        }
    }

    function highlightRequired(el) {
        if (!el) return;
        el.style.outline = '2px solid var(--wiz-accent)';
        setTimeout(function(){ el.style.outline = ''; }, 1500);
    }

    function exitWizard(saved) {
        markDone();
        stopPreviewIfActive();
        if (typeof requestLedColorsStop  === 'function') requestLedColorsStop();
        if (typeof requestLedImageStop   === 'function') requestLedImageStop();
        if (window.hyperhdr) {
            $(window.hyperhdr).off('cmd-image-stream-frame.wizard');
        }

        var overlay = document.getElementById('setup-wizard-overlay');
        if (overlay) {
            overlay.classList.add('wiz-fade-out');
            setTimeout(function(){
                overlay.parentNode && overlay.parentNode.removeChild(overlay);
                var fs = document.getElementById('wiz-strobe-fs');
                if (fs && fs.parentNode) fs.parentNode.removeChild(fs);
                var wzCss = document.querySelector('link[href*="setup_wizard.css"]');
                if (wzCss && wzCss.parentNode) wzCss.parentNode.removeChild(wzCss);
            }, 420);
        }

        if (typeof removeOverlay === 'function') removeOverlay();
    }

    window.wizStep = function(id, delta) {
        var el = document.getElementById(id);
        if (!el) return;
        var val = parseInt(el.value, 10) || 0;
        var min = el.hasAttribute('min') ? parseInt(el.getAttribute('min'), 10) : -Infinity;
        el.value = Math.max(min, val + delta);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 200);
    }

}());
