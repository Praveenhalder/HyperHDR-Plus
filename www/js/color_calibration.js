/**
 * color_calibration.js  –  HyperHDR Color Calibration Panel
 * ═══════════════════════════════════════════════════════════════════
 *
 * Each colour channel (red, green, blue, cyan, magenta, yellow, white,
 * black) has an [r,g,b] array in HyperHDR's channelAdjustment config.
 * This panel renders a native colour-picker + fine RGB inputs for every
 * channel, applies changes in real time via requestWriteConfig, and
 * saves on button click – exactly like the editor_color / btn_submit_color
 * pattern used by HyperHDR's own settings page.
 *
 * Two independent concerns:
 *  A) HyperHDR calibration  (state.cal)  → requestWriteConfig on every change
 *  B) Preview bg colour     (state.bg)   → #cal-bg-fill only, wheel / tiles
 */
(function () {
    'use strict';

    /* ══════════════════════════════════════════════════════════════
       UTILITIES  (hoisted so loadServerDefaults can use them)
    ══════════════════════════════════════════════════════════════ */
    function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

    function rgbToHex(rgb) {
        return '#' + rgb.map(function(v){
            return Math.max(0,Math.min(255,v)).toString(16).padStart(2,'0');
        }).join('');
    }

    function hexToRgb(hex) {
        var r = parseInt(hex.slice(1,3),16);
        var g = parseInt(hex.slice(3,5),16);
        var b = parseInt(hex.slice(5,7),16);
        return [r,g,b];
    }

    /* ── Channel definitions (order shown in panel) ─────────────── */
    var CHANNELS_PRIMARY = [
        { key: 'red',   label: 'Red',   icon: '🔴' },
        { key: 'green', label: 'Green', icon: '🟢' },
        { key: 'blue',  label: 'Blue',  icon: '🔵' }
    ];
    var CHANNELS_ADVANCED = [
        { key: 'cyan',    label: 'Cyan',    icon: '🩵' },
        { key: 'magenta', label: 'Magenta', icon: '🟣' },
        { key: 'yellow',  label: 'Yellow',  icon: '🟡' },
        { key: 'white',   label: 'White',   icon: '⚪' },
        { key: 'black',   label: 'Black',   icon: '⚫' }
    ];
    var CHANNELS = CHANNELS_PRIMARY.concat(CHANNELS_ADVANCED);

    /* ── Factory defaults (fallback only – used when server data unavailable) ── */
    var FACTORY_DEFAULTS = {
        cal: {
            red:     [255, 0,   0],
            green:   [0,   255, 0],
            blue:    [0,   0,   255],
            cyan:    [0,   255, 255],
            magenta: [255, 0,   255],
            yellow:  [255, 255, 0],
            white:   [255, 255, 255],
            black:   [0,   0,   0],
            gamma:              1.5,
            scaleOutput:        1.0,
            backlightThreshold: 0.0039,
            backlightColored:   true,
            classic_config:     true,
            saturationGain:     1.0,
            luminanceGain:      1.0,
            powerLimit:         1.0,
            temperatureSetting: 'disabled'
        },
        bg: { r: 255, g: 255, b: 255, brightness: 100 }
    };

    /**
     * Build the initial `state.cal` from live server data, mirroring the
     * same priority order used by remote.js → updateColorAdjustment():
     *   1. window.serverInfo.adjustment[0]          (live runtime values)
     *   2. window.serverConfig.color.channelAdjustment[0]  (persisted config)
     *   3. FACTORY_DEFAULTS.cal                     (hardcoded fallback)
     */
    function loadServerDefaults() {
        var src = null;

        if (window.serverInfo &&
            Array.isArray(window.serverInfo.adjustment) &&
            window.serverInfo.adjustment.length > 0) {
            src = window.serverInfo.adjustment[0];
        } else if (window.serverConfig &&
                   window.serverConfig.color &&
                   Array.isArray(window.serverConfig.color.channelAdjustment) &&
                   window.serverConfig.color.channelAdjustment.length > 0) {
            src = window.serverConfig.color.channelAdjustment[0];
        }

        if (!src) return deepClone(FACTORY_DEFAULTS);

        /* Map flat channelAdjustment object → state.cal shape */
        var cal = deepClone(FACTORY_DEFAULTS.cal);   /* start from factory so missing keys are safe */
        var channelKeys = ['red','green','blue','cyan','magenta','yellow','white','black'];
        channelKeys.forEach(function (k) {
            if (Array.isArray(src[k]) && src[k].length === 3) cal[k] = src[k].slice();
        });
        var scalarMap = {
            gamma:              'gamma',
            scaleOutput:        'scaleOutput',
            backlightThreshold: 'backlightThreshold',
            backlightColored:   'backlightColored',
            classic_config:     'classic_config',
            saturationGain:     'saturationGain',
            luminanceGain:      'luminanceGain',
            powerLimit:         'powerLimit',
            temperatureSetting: 'temperatureSetting'
        };
        Object.keys(scalarMap).forEach(function (k) {
            if (src[k] !== undefined && src[k] !== null) cal[scalarMap[k]] = src[k];
        });

        return { cal: cal, bg: deepClone(FACTORY_DEFAULTS.bg) };
    }

    var DEFAULTS    = null;   /* populated after deepClone is defined, inside init() */
    var state       = null;   /* same – assigned in init() after server data is read */
    var el          = {};
    var wheelCtx    = null;
    var wheelCanvas = null;
    var savedSinceOpen = false;   /* track whether Save was clicked after launch */

    /* ══════════════════════════════════════════════════════════════
       INIT
    ══════════════════════════════════════════════════════════════ */
    function domReady(fn) {
        if (document.readyState !== 'loading') fn();
        else document.addEventListener('DOMContentLoaded', fn);
    }
    domReady(init);

    function init() {
        /* ── Load live server values (or fall back to factory defaults) ── */
        DEFAULTS = loadServerDefaults();
        state    = deepClone(DEFAULTS);

        var staticIds = [
            'btn_launch_calibration',
            'cal-fullscreen','cal-bg-fill','cal-toast',
            'cal-panel','cal-wheel-panel','btn-toggle-panel',
            'btn_cal_save','btn_cal_reset','btn_cal_exit',
            /* advanced channels toggle */
            'btn-advanced-channels','ch-advanced-section',
            /* processing tab */
            'sl_gamma','val_gamma_out',
            'sl_bl','val_bl_out',
            /* advanced tab */
            'sl_sat','val_sat_out',
            'sl_lum','val_lum_out',
            'sl_power','val_power_out',
            'chk_backlight_colored',
            'chk_classic_config',
            /* wheel */
            'color-wheel-canvas','wheel-marker',
            'wheel-brightness-slider','wheel-brightness-val',
            'bg-swatch','bg-swatch-hex',
            /* subpage summary */
            'cal-channel-grid',
            'info-gamma','info-lum','info-bl','info-sat','info-power','info-blc'
        ];
        staticIds.forEach(function (id) { el[id] = document.getElementById(id); });

        if (!el['btn_launch_calibration']) return;

        buildChannelPickers();   /* DOM for each channel */
        buildSubpageGrid();      /* channel swatches on the landing page */
        bindScalarSliders();     /* gamma, brightness, etc. */
        bindCheckboxes();
        bindActions();
        bindWheelPanel();
        bindAdvancedChannelsToggle();

        document.querySelectorAll('.panel-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                var alreadyActive = tab.classList.contains('active');
                if (tab.dataset.tab === 'advanced' && alreadyActive) {
                    /* Clicking Advanced again closes it → restore classic_config from DEFAULTS.
                       If saved while Advanced was open, DEFAULTS.cal.classic_config is false → stays false.
                       If never saved, DEFAULTS still has the original snapshot → restores to true. */
                    switchTab('channels');
                    if (state) { state.cal.classic_config = DEFAULTS.cal.classic_config; if (el['chk_classic_config']) el['chk_classic_config'].checked = !!state.cal.classic_config; applyToHyperHDR(); }
                } else {
                    switchTab(tab.dataset.tab);
                }
            });
        });

        el['btn_launch_calibration'].addEventListener('click', launchCalibration);
        document.addEventListener('keydown', onKey);
        makeDraggable(document.getElementById('cal-combined'));
        // Keep individual panel drag handles working for backwards compat

        syncScalarControls();
        applyBg();
        updateSubpageSummary();
    }

    /* ══════════════════════════════════════════════════════════════
       BUILD CHANNEL PICKERS  (inside #channel-pickers in left panel)
    ══════════════════════════════════════════════════════════════ */
    function buildChannelPickers() {
        var container = document.getElementById('channel-pickers');
        var containerAdv = document.getElementById('channel-pickers-advanced');
        if (container) {
            container.innerHTML = '';
            CHANNELS_PRIMARY.forEach(function (ch) { appendChannelRow(ch, container); });
        }
        if (containerAdv) {
            containerAdv.innerHTML = '';
            CHANNELS_ADVANCED.forEach(function (ch) { appendChannelRow(ch, containerAdv); });
        }
    }

    /* ══════════════════════════════════════════════════════════════
       CUSTOM INLINE COLOUR PICKER  (replaces native <input type=color>)
       – gradient canvas (SV field) + hue bar + RGB number inputs
       – fires applyToHyperHDR() on every drag/input → fully real-time
    ══════════════════════════════════════════════════════════════ */

    /* Convert HSV (0-360, 0-1, 0-1) → RGB [0-255] */
    function hsvToRgb(h, s, v) {
        var r, g, b, i = Math.floor(h / 60), f = h / 60 - i,
            p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
        switch (i % 6) {
            case 0: r=v; g=t; b=p; break; case 1: r=q; g=v; b=p; break;
            case 2: r=p; g=v; b=t; break; case 3: r=p; g=q; b=v; break;
            case 4: r=t; g=p; b=v; break; default: r=v; g=p; b=q;
        }
        return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
    }

    /* Convert RGB [0-255] → HSV {h:0-360, s:0-1, v:0-1} */
    function rgbToHsv(r, g, b) {
        r/=255; g/=255; b/=255;
        var max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min, h, s=max?d/max:0, v=max;
        if (!d) { h=0; }
        else if (max===r) { h=((g-b)/d+6)%6; }
        else if (max===g) { h=(b-r)/d+2; }
        else              { h=(r-g)/d+4; }
        return { h: h*60, s: s, v: v };
    }

    /* Draw the SV gradient square for a given hue */
    function drawSVCanvas(canvas, hue) {
        var ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
        ctx.clearRect(0,0,W,H);
        /* base hue */
        ctx.fillStyle = 'hsl('+hue+',100%,50%)';
        ctx.fillRect(0,0,W,H);
        /* white left→right */
        var wg = ctx.createLinearGradient(0,0,W,0);
        wg.addColorStop(0,'rgba(255,255,255,1)'); wg.addColorStop(1,'rgba(255,255,255,0)');
        ctx.fillStyle = wg; ctx.fillRect(0,0,W,H);
        /* black top→bottom */
        var bg = ctx.createLinearGradient(0,0,0,H);
        bg.addColorStop(0,'rgba(0,0,0,0)'); bg.addColorStop(1,'rgba(0,0,0,1)');
        ctx.fillStyle = bg; ctx.fillRect(0,0,W,H);
    }

    /* Draw vertical hue bar */
    function drawHueBar(canvas) {
        var ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
        var g = ctx.createLinearGradient(0,0,0,H);
        [0,60,120,180,240,300,360].forEach(function(deg, i) {
            g.addColorStop(i/6, 'hsl('+deg+',100%,50%)');
        });
        ctx.fillStyle = g; ctx.fillRect(0,0,W,H);
    }

    /* One active popup tracker */
    var activePickerKey = null;

    function openInlinePicker(key) {
        /* close any existing popup */
        closeInlinePicker();
        activePickerKey = key;

        var rgb = state.cal[key];
        var hsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);

        /* ── build popup DOM ── */
        var popup = document.createElement('div');
        popup.className = 'ch-inline-picker';
        popup.id = 'ch-inline-popup-' + key;

        /* SV canvas */
        var svCanvas = document.createElement('canvas');
        svCanvas.className = 'ch-sv-canvas';
        svCanvas.width  = 200;
        svCanvas.height = 150;

        /* SV marker */
        var svMarker = document.createElement('div');
        svMarker.className = 'ch-sv-marker';

        var svWrap = document.createElement('div');
        svWrap.className = 'ch-sv-wrap';
        svWrap.appendChild(svCanvas);
        svWrap.appendChild(svMarker);

        /* Hue bar */
        var hueCanvas = document.createElement('canvas');
        hueCanvas.className = 'ch-hue-bar';
        hueCanvas.width  = 16;
        hueCanvas.height = 150;

        var hueMarker = document.createElement('div');
        hueMarker.className = 'ch-hue-marker';

        var hueWrap = document.createElement('div');
        hueWrap.className = 'ch-hue-wrap';
        hueWrap.appendChild(hueCanvas);
        hueWrap.appendChild(hueMarker);

        var canvasRow = document.createElement('div');
        canvasRow.className = 'ch-canvas-row';
        canvasRow.appendChild(svWrap);
        canvasRow.appendChild(hueWrap);

        /* RGB inputs row */
        var inputsRow = document.createElement('div');
        inputsRow.className = 'ch-picker-inputs-row';

        /* eyedropper spacer + preview swatch */
        var previewSwatch = document.createElement('div');
        previewSwatch.className = 'ch-picker-preview';
        previewSwatch.style.background = rgbToHex(rgb);

        var rInp = makePickerNumInput('R', rgb[0]);
        var gInp = makePickerNumInput('G', rgb[1]);
        var bInp = makePickerNumInput('B', rgb[2]);
        var spinBtn = document.createElement('div');
        spinBtn.className = 'ch-picker-spin';
        spinBtn.innerHTML = '&#8597;';

        inputsRow.appendChild(previewSwatch);
        inputsRow.appendChild(rInp.wrap);
        inputsRow.appendChild(gInp.wrap);
        inputsRow.appendChild(bInp.wrap);
        inputsRow.appendChild(spinBtn);

        popup.appendChild(canvasRow);
        popup.appendChild(inputsRow);

        /* ── position below the swatch ── */
        var swatchEl = document.getElementById('ch-swatch-' + key);
        var calPanel = document.getElementById('cal-panel');
        if (swatchEl && calPanel) {
            var sr = swatchEl.getBoundingClientRect();
            var pr = calPanel.getBoundingClientRect();
            popup.style.position = 'absolute';
            popup.style.top  = (sr.bottom - pr.top + calPanel.scrollTop + 4) + 'px';
            popup.style.left = (sr.left   - pr.left) + 'px';
            calPanel.style.position = 'relative';
            calPanel.appendChild(popup);
        } else {
            document.body.appendChild(popup);
        }

        /* ── draw initial state ── */
        drawSVCanvas(svCanvas, hsv.h);
        drawHueBar(hueCanvas);
        placeSVMarker(svMarker, svCanvas, hsv.s, hsv.v);
        placeHueMarker(hueMarker, hueCanvas, hsv.h);

        /* internal mutable HSV state for this picker */
        var H = hsv.h, S = hsv.s, V = hsv.v;

        function commit() {
            var newRgb = hsvToRgb(H, S, V);
            state.cal[key] = newRgb;
            previewSwatch.style.background = rgbToHex(newRgb);
            rInp.inp.value = newRgb[0];
            gInp.inp.value = newRgb[1];
            bInp.inp.value = newRgb[2];
            updateChannelUI(key);
            applyToHyperHDR();
        }

        /* ── SV canvas drag ── */
        function pickSV(e) {
            var rect = svCanvas.getBoundingClientRect();
            var cx = (e.clientX !== undefined ? e.clientX : e.touches[0].clientX);
            var cy = (e.clientY !== undefined ? e.clientY : e.touches[0].clientY);
            S = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
            V = Math.max(0, Math.min(1, 1 - (cy - rect.top) / rect.height));
            placeSVMarker(svMarker, svCanvas, S, V);
            commit();
        }
        var svDragging = false;
        svCanvas.addEventListener('mousedown',  function(e){ svDragging=true; pickSV(e); e.preventDefault(); });
        svCanvas.addEventListener('touchstart', function(e){ svDragging=true; pickSV(e); e.preventDefault(); }, {passive:false});
        document.addEventListener('mousemove',  function(e){ if(svDragging) pickSV(e); });
        document.addEventListener('touchmove',  function(e){ if(svDragging) pickSV(e); }, {passive:false});
        document.addEventListener('mouseup',    function(){ svDragging=false; });
        document.addEventListener('touchend',   function(){ svDragging=false; });

        /* ── Hue bar drag ── */
        function pickHue(e) {
            var rect = hueCanvas.getBoundingClientRect();
            var cy = (e.clientY !== undefined ? e.clientY : e.touches[0].clientY);
            H = Math.max(0, Math.min(359.99, ((cy - rect.top) / rect.height) * 360));
            drawSVCanvas(svCanvas, H);
            placeHueMarker(hueMarker, hueCanvas, H);
            commit();
        }
        var hueDragging = false;
        hueCanvas.addEventListener('mousedown',  function(e){ hueDragging=true; pickHue(e); e.preventDefault(); });
        hueCanvas.addEventListener('touchstart', function(e){ hueDragging=true; pickHue(e); e.preventDefault(); }, {passive:false});
        document.addEventListener('mousemove',   function(e){ if(hueDragging) pickHue(e); });
        document.addEventListener('touchmove',   function(e){ if(hueDragging) pickHue(e); }, {passive:false});
        document.addEventListener('mouseup',     function(){ hueDragging=false; });
        document.addEventListener('touchend',    function(){ hueDragging=false; });

        /* ── RGB number inputs ── */
        function onRgbInput() {
            var r = Math.max(0,Math.min(255, parseInt(rInp.inp.value)||0));
            var g = Math.max(0,Math.min(255, parseInt(gInp.inp.value)||0));
            var b = Math.max(0,Math.min(255, parseInt(bInp.inp.value)||0));
            var hsv2 = rgbToHsv(r,g,b);
            H=hsv2.h; S=hsv2.s; V=hsv2.v;
            drawSVCanvas(svCanvas, H);
            placeSVMarker(svMarker, svCanvas, S, V);
            placeHueMarker(hueMarker, hueCanvas, H);
            previewSwatch.style.background = rgbToHex([r,g,b]);
            state.cal[key] = [r,g,b];
            updateChannelUI(key);
            applyToHyperHDR();
        }
        rInp.inp.addEventListener('input', onRgbInput);
        gInp.inp.addEventListener('input', onRgbInput);
        bInp.inp.addEventListener('input', onRgbInput);

        /* ── close on outside click ── */
        setTimeout(function () {
            document.addEventListener('mousedown', function outsideClose(e) {
                if (!popup.contains(e.target) &&
                    e.target.id !== 'ch-swatch-' + key) {
                    closeInlinePicker();
                    document.removeEventListener('mousedown', outsideClose);
                }
            });
        }, 10);
    }

    function closeInlinePicker() {
        if (activePickerKey) {
            var old = document.getElementById('ch-inline-popup-' + activePickerKey);
            if (old && old.parentNode) old.parentNode.removeChild(old);
            activePickerKey = null;
        }
    }

    function placeSVMarker(marker, canvas, s, v) {
        var rect = canvas.getBoundingClientRect();
        var W = rect.width  || canvas.width;
        var H = rect.height || canvas.height;
        marker.style.left = (s * W - 7) + 'px';
        marker.style.top  = ((1 - v) * H - 7) + 'px';
    }

    function placeHueMarker(marker, canvas, h) {
        var H = canvas.getBoundingClientRect().height || canvas.height;
        marker.style.top = ((h / 360) * H - 5) + 'px';
    }

    function makePickerNumInput(label, val) {
        var wrap = document.createElement('div');
        wrap.className = 'ch-picker-num-wrap';
        var inp = document.createElement('input');
        inp.type = 'number'; inp.min = '0'; inp.max = '255';
        inp.value = val; inp.className = 'ch-picker-num';
        var lbl = document.createElement('div');
        lbl.className = 'ch-picker-num-label'; lbl.textContent = label;
        wrap.appendChild(inp); wrap.appendChild(lbl);
        return { wrap: wrap, inp: inp };
    }

    function appendChannelRow(ch, container) {
            var rgb  = state.cal[ch.key];
            var hex  = rgbToHex(rgb);

            /* outer row */
            var row = document.createElement('div');
            row.className = 'ch-picker-row';
            row.id = 'ch-row-' + ch.key;

            /* swatch — clicks open the inline picker */
            var swatchDiv = document.createElement('div');
            swatchDiv.className = 'ch-picker-swatch';
            swatchDiv.style.background = hex;
            swatchDiv.id = 'ch-swatch-' + ch.key;
            swatchDiv.style.cursor = 'pointer';
            swatchDiv.addEventListener('click', function (e) {
                e.stopPropagation();
                if (activePickerKey === ch.key) { closeInlinePicker(); return; }
                openInlinePicker(ch.key);
            });

            /* info block */
            var infoDiv = document.createElement('div');
            infoDiv.className = 'ch-picker-info';

            var nameDiv = document.createElement('div');
            nameDiv.className = 'ch-picker-name';
            nameDiv.textContent = ch.icon + ' ' + ch.label;

            var rgbDiv = document.createElement('div');
            rgbDiv.className = 'ch-picker-rgb';
            rgbDiv.id = 'ch-rgb-label-' + ch.key;
            rgbDiv.textContent = 'R:' + rgb[0] + ' G:' + rgb[1] + ' B:' + rgb[2];

            infoDiv.appendChild(nameDiv);
            infoDiv.appendChild(rgbDiv);

            /* fine-tune expand button */
            var expandBtn = document.createElement('button');
            expandBtn.className = 'ch-expand-btn';
            expandBtn.title = 'Fine-tune RGB values';
            expandBtn.textContent = '⋯';
            expandBtn.setAttribute('data-ch', ch.key);
            expandBtn.addEventListener('click', function () {
                var wrap = document.getElementById('ch-fine-' + ch.key);
                if (wrap) wrap.classList.toggle('open');
                this.textContent = (document.getElementById('ch-fine-' + ch.key).classList.contains('open')) ? '✕' : '⋯';
            });

            row.appendChild(swatchDiv);
            row.appendChild(infoDiv);
            row.appendChild(expandBtn);

            /* fine-tune wrap (hidden by default) */
            var fineWrap = document.createElement('div');
            fineWrap.className = 'ch-fine-wrap';
            fineWrap.id = 'ch-fine-' + ch.key;

            var fineGrid = document.createElement('div');
            fineGrid.className = 'ch-fine-tune';

            ['R','G','B'].forEach(function (component, idx) {
                var inp = document.createElement('input');
                inp.type  = 'number';
                inp.min   = '0';
                inp.max   = '255';
                inp.value = rgb[idx];
                inp.id    = 'ch-fine-' + ch.key + '-' + component;
                inp.addEventListener('input', function () {
                    var v = Math.max(0, Math.min(255, parseInt(this.value) || 0));
                    state.cal[ch.key][idx] = v;
                    updateChannelUI(ch.key);
                    applyToHyperHDR();   /* REALTIME */
                });
                fineGrid.appendChild(inp);
            });

            var labelsGrid = document.createElement('div');
            labelsGrid.className = 'ch-fine-labels';
            ['R','G','B'].forEach(function (l) {
                var s = document.createElement('span'); s.textContent = l;
                labelsGrid.appendChild(s);
            });

            fineWrap.appendChild(fineGrid);
            fineWrap.appendChild(labelsGrid);

            /* Assemble: row wraps both main row and fine-tune */
            var wrapper = document.createElement('div');
            wrapper.style.marginBottom = '0';
            wrapper.appendChild(row);
            wrapper.appendChild(fineWrap);
            container.appendChild(wrapper);
    }

    function bindAdvancedChannelsToggle() {
        /* Use querySelector so it always finds the live element */
        var btn     = document.getElementById('btn-advanced-channels');
        var section = document.getElementById('ch-advanced-section');
        if (!btn || !section) return;
        btn.addEventListener('click', function () {
            var isOpen = section.style.display === 'block';
            section.style.display = isOpen ? 'none' : 'block';
            btn.classList.toggle('open', !isOpen);
        });
    }

    /* Update all UI elements for one channel after state changes */
    function updateChannelUI(key) {
        var rgb = state.cal[key];
        var hex = rgbToHex(rgb);

        var swatch = document.getElementById('ch-swatch-' + key);
        if (swatch) swatch.style.background = hex;

        var label = document.getElementById('ch-rgb-label-' + key);
        if (label) label.textContent = 'R:' + rgb[0] + ' G:' + rgb[1] + ' B:' + rgb[2];

        ['R','G','B'].forEach(function (c, i) {
            var fi = document.getElementById('ch-fine-' + key + '-' + c);
            if (fi && parseInt(fi.value) !== rgb[i]) fi.value = rgb[i];
        });

        /* update subpage swatch too */
        var sub = document.getElementById('subpage-swatch-' + key);
        if (sub) sub.style.background = hex;
        var subVal = document.getElementById('subpage-val-' + key);
        if (subVal) subVal.textContent = 'R:' + rgb[0] + ' G:' + rgb[1] + ' B:' + rgb[2];
    }

    /* ══════════════════════════════════════════════════════════════
       SUBPAGE CHANNEL GRID
    ══════════════════════════════════════════════════════════════ */
    function buildSubpageGrid() {
        var grid = el['cal-channel-grid'];
        if (!grid) return;
        grid.innerHTML = '';
        CHANNELS.forEach(function (ch) {
            var rgb = state.cal[ch.key];
            var hex = rgbToHex(rgb);
            var card = document.createElement('div');
            card.className = 'cal-channel-card';
            card.innerHTML =
                '<div class="ch-label">' + ch.icon + ' ' + ch.label + '</div>' +
                '<div class="ch-swatch" id="subpage-swatch-' + ch.key + '" style="background:' + hex + ';"></div>' +
                '<div class="ch-values" id="subpage-val-' + ch.key + '">R:' + rgb[0] + ' G:' + rgb[1] + ' B:' + rgb[2] + '</div>';
            grid.appendChild(card);
        });
    }

    /* ══════════════════════════════════════════════════════════════
       SCALAR SLIDERS  (gamma, brightness, etc.)
    ══════════════════════════════════════════════════════════════ */
    function bindScalarSliders() {
        /* gamma: slider 1-40 → 0.1-4.0 */
        bindScalar('sl_gamma', 'val_gamma_out', 1, 40, function (raw) {
            state.cal.gamma = raw / 10;
            if (el['val_gamma_out']) el['val_gamma_out'].value = state.cal.gamma.toFixed(1);
        }, true);

        /* backlight: slider 0-100 → 0-0.3922 */
        bindScalar('sl_bl', 'val_bl_out', 0, 100, function (raw) {
            state.cal.backlightThreshold = parseFloat((raw / 100 * 0.3922).toFixed(4));
        });

        /* saturation: slider 0-40 → 0.0-4.0 */
        bindScalar('sl_sat', 'val_sat_out', 0, 40, function (raw) {
            state.cal.saturationGain = raw / 10;
            if (el['val_sat_out']) el['val_sat_out'].value = state.cal.saturationGain.toFixed(1);
        }, true);

        /* luminance: slider 0-200 → 0.0-2.0 */
        bindScalar('sl_lum', 'val_lum_out', 0, 200, function (raw) {
            state.cal.luminanceGain = raw / 100;
            if (el['val_lum_out']) el['val_lum_out'].value = state.cal.luminanceGain.toFixed(2);
        }, true);

        /* power: slider 0-100 → 0.0-1.0 */
        bindScalar('sl_power', 'val_power_out', 0, 100, function (raw) {
            state.cal.powerLimit = raw / 100;
            if (el['val_power_out']) el['val_power_out'].value = state.cal.powerLimit.toFixed(2);
        }, true);
    }

    function bindScalar(sliderId, boxId, min, max, onChange, scaled) {
        var slider = el[sliderId], box = el[boxId];
        if (!slider) return;

        slider.addEventListener('input', function () {
            var v = parseInt(this.value);
            if (!scaled && box) box.value = v;
            onChange(v);
            applyToHyperHDR();   /* REALTIME */
        });

        if (box) {
            box.addEventListener('change', function () {
                var v = parseFloat(this.value), raw;
                if      (sliderId === 'sl_gamma')  raw = Math.round(v * 10);
                else if (sliderId === 'sl_sat')    raw = Math.round(v * 10);
                else if (sliderId === 'sl_lum')    raw = Math.round(v * 100);
                else if (sliderId === 'sl_power')  raw = Math.round(v * 100);
                else raw = Math.round(v);
                raw = Math.max(min, Math.min(max, raw));
                slider.value = raw;
                onChange(raw);
                applyToHyperHDR();   /* REALTIME */
            });
        }
    }

    function bindCheckboxes() {
        if (el['chk_backlight_colored'])
            el['chk_backlight_colored'].addEventListener('change', function (e) {
                state.cal.backlightColored = e.target.checked;
                applyToHyperHDR();
            });
        /* classic_config is now managed automatically by switchTab():
           it is disabled while the Advanced tab is open and restored otherwise.
           The checkbox below also allows manual override while in the Advanced tab. */
        if (el['chk_classic_config'])
            el['chk_classic_config'].addEventListener('change', function (e) {
                state.cal.classic_config = e.target.checked;
                applyToHyperHDR();
            });
    }

    function bindActions() {
        if (el['btn_cal_save'])  el['btn_cal_save'].addEventListener('click',  saveSettings);
        if (el['btn_cal_reset']) el['btn_cal_reset'].addEventListener('click', resetToDefaults);
        if (el['btn_cal_exit'])  el['btn_cal_exit'].addEventListener('click',  exitFullscreen);
        if (el['btn-toggle-panel']) el['btn-toggle-panel'].addEventListener('click', togglePanels);
    }

    /* ══════════════════════════════════════════════════════════════
       BUILD HyperHDR color config
    ══════════════════════════════════════════════════════════════ */
    function buildColorConfig() {
        var c  = state.cal;
        return {
            channelAdjustment: [{
                backlightColored:   c.backlightColored,
                backlightThreshold: parseFloat(c.backlightThreshold.toFixed(4)),
                black:              c.black,
                blue:               c.blue,
                classic_config:     c.classic_config,
                cyan:               c.cyan,
                gamma:              parseFloat(c.gamma.toFixed(2)),
                green:              c.green,
                luminanceGain:      parseFloat(c.luminanceGain.toFixed(4)),
                magenta:            c.magenta,
                powerLimit:         parseFloat(c.powerLimit.toFixed(4)),
                red:                c.red,
                saturationGain:     parseFloat(c.saturationGain.toFixed(4)),
                scaleOutput:        parseFloat(c.scaleOutput.toFixed(4)),
                temperatureSetting: c.temperatureSetting,
                white:              c.white,
                yellow:             c.yellow
            }],
            imageToLedMappingType: 'advanced',
            sparse_processing:     false
        };
    }

    /* ══════════════════════════════════════════════════════════════
       APPLY  –  same pattern as editor_color / btn_submit_color
       Called in real time on every control change AND on Save
    ══════════════════════════════════════════════════════════════ */
    function applyToHyperHDR() {
        var cfg = buildColorConfig();

        /* requestWriteConfig({ color: … }) – exactly like btn_submit_color */
        if (typeof requestWriteConfig === 'function') {
            try { requestWriteConfig({ color: cfg }); }
            catch (e) { console.error('[ColorCal] requestWriteConfig error:', e); }
        } else {
            /* dev/preview fallback */
            console.log('[ColorCal] would call requestWriteConfig({ color: … })', cfg);
        }

        /* mirror into live serverConfig so the rest of the UI is current */
        if (window.serverConfig) window.serverConfig.color = deepClone(cfg);

        /* sync JSONEditor if it's open on the Image Processing page */
        var ed = window.editor_color;
        if (ed && typeof ed.setValue === 'function') {
            try { ed.setValue(cfg); if (typeof ed.onChange === 'function') ed.onChange(); }
            catch (e) {}
        }

        updateSubpageSummary();
    }

    function saveSettings() {
        savedSinceOpen = true;
        applyToHyperHDR();
        /* Update DEFAULTS so that exit-without-save after a re-open
           restores to the last saved state, not the original page-load state */
        DEFAULTS = deepClone(state);
        showToast('Saved & Applied 💾', '#48bb78');
    }

    function resetToDefaults() {
        /* Re-read server state in case it changed since page load */
        DEFAULTS = loadServerDefaults();
        state = deepClone(DEFAULTS);
        savedSinceOpen = true;   /* treat reset as intentional – exit won't re-reset */
        /* rebuild pickers with fresh values */
        buildChannelPickers();
        buildSubpageGrid();
        syncScalarControls();
        applyBg();
        syncWheelMarker();
        applyToHyperHDR();
        showToast('Reset to Defaults ↺', '#fc8181');
    }

    /* ══════════════════════════════════════════════════════════════
       SYNC SCALAR CONTROLS ← state
    ══════════════════════════════════════════════════════════════ */
    function syncScalarControls() {
        var c = state.cal;
        function set(id, v) { if (el[id]) el[id].value = v; }

        set('sl_gamma',      Math.round(c.gamma * 10));
        set('val_gamma_out', c.gamma.toFixed(1));

        var blPct = Math.round(c.backlightThreshold / 0.3922 * 100);
        set('sl_bl',    blPct); set('val_bl_out', blPct);

        set('sl_sat',      Math.round(c.saturationGain * 10));
        set('val_sat_out', c.saturationGain.toFixed(1));

        set('sl_lum',      Math.round(c.luminanceGain * 100));
        set('val_lum_out', c.luminanceGain.toFixed(2));

        set('sl_power',      Math.round(c.powerLimit * 100));
        set('val_power_out', c.powerLimit.toFixed(2));

        if (el['chk_backlight_colored']) el['chk_backlight_colored'].checked = !!c.backlightColored;
        if (el['chk_classic_config'])    el['chk_classic_config'].checked    = !!c.classic_config;

        if (el['wheel-brightness-slider']) el['wheel-brightness-slider'].value = state.bg.brightness;
        if (el['wheel-brightness-val'])    el['wheel-brightness-val'].textContent = state.bg.brightness + '%';
    }

    /* ══════════════════════════════════════════════════════════════
       SUBPAGE SUMMARY
    ══════════════════════════════════════════════════════════════ */
    function updateSubpageSummary() {
        var c = state.cal;
        if (el['info-gamma'])  el['info-gamma'].textContent  = c.gamma.toFixed(1);
        if (el['info-lum'])    el['info-lum'].textContent    = c.luminanceGain.toFixed(2);
        if (el['info-bl'])     el['info-bl'].textContent     = Math.round(c.backlightThreshold / 0.3922 * 100) + '%';
        if (el['info-sat'])    el['info-sat'].textContent    = c.saturationGain.toFixed(1);
        if (el['info-power'])  el['info-power'].textContent  = c.powerLimit.toFixed(2) + ' (' + Math.round(c.powerLimit * 100) + '%)';
        if (el['info-blc'])    el['info-blc'].textContent    = c.backlightColored ? '✔ On' : '✖ Off';

        CHANNELS.forEach(function (ch) {
            var rgb = c[ch.key];
            var sub = document.getElementById('subpage-swatch-' + ch.key);
            if (sub) sub.style.background = rgbToHex(rgb);
            var subVal = document.getElementById('subpage-val-' + ch.key);
            if (subVal) subVal.textContent = 'R:' + rgb[0] + ' G:' + rgb[1] + ' B:' + rgb[2];
        });
    }

    /* ══════════════════════════════════════════════════════════════
       FULLSCREEN
    ══════════════════════════════════════════════════════════════ */
    function launchCalibration() {
        savedSinceOpen = false;
        el['cal-fullscreen'].classList.add('active');
        applyBg();
        setTimeout(function () { initColorWheel(); syncWheelMarker(); }, 80);
        var d = document.documentElement;
        if      (d.requestFullscreen)       d.requestFullscreen().catch(function(){});
        else if (d.webkitRequestFullscreen) d.webkitRequestFullscreen();
        else if (d.mozRequestFullScreen)    d.mozRequestFullScreen();
    }

    function exitFullscreen() {
        closeInlinePicker();
        if (!savedSinceOpen) {
            /* Restore to the values that were active when the page loaded */
            state = deepClone(DEFAULTS);
            buildChannelPickers();
            buildSubpageGrid();
            syncScalarControls();
            applyBg();
            syncWheelMarker();
            applyToHyperHDR();
        }
        el['cal-fullscreen'].classList.remove('active');
        if      (document.exitFullscreen)       document.exitFullscreen().catch(function(){});
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        else if (document.mozCancelFullScreen)  document.mozCancelFullScreen();
    }

    function togglePanels() {
        var combined = document.getElementById('cal-combined');
        if (combined) combined.classList.toggle('collapsed');
    }

    /* ══════════════════════════════════════════════════════════════
       BACKGROUND (wheel / tiles only – does NOT affect HyperHDR)
    ══════════════════════════════════════════════════════════════ */
    function applyBg() {
        var b  = state.bg.brightness / 100;
        var r  = Math.round(state.bg.r * b);
        var g  = Math.round(state.bg.g * b);
        var bv = Math.round(state.bg.b * b);
        var hex = '#' + [r,g,bv].map(function(v){ return v.toString(16).padStart(2,'0'); }).join('');
        if (el['cal-bg-fill'])  el['cal-bg-fill'].style.backgroundColor = 'rgb('+r+','+g+','+bv+')';
        if (el['bg-swatch'])    el['bg-swatch'].style.background = 'rgb('+r+','+g+','+bv+')';
        if (el['bg-swatch-hex']) el['bg-swatch-hex'].textContent = hex.toUpperCase();
    }

    /* ══════════════════════════════════════════════════════════════
       WHEEL PANEL BINDING
    ══════════════════════════════════════════════════════════════ */
    function bindWheelPanel() {
        document.querySelectorAll('.quick-color-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                document.querySelectorAll('.quick-color-btn').forEach(function(b){ b.classList.remove('active'); });
                btn.classList.add('active');
                state.bg.r = parseInt(btn.dataset.r);
                state.bg.g = parseInt(btn.dataset.g);
                state.bg.b = parseInt(btn.dataset.b);
                applyBg();
                syncWheelMarker();
            });
        });

        if (el['wheel-brightness-slider']) {
            el['wheel-brightness-slider'].addEventListener('input', function () {
                state.bg.brightness = parseInt(this.value);
                if (el['wheel-brightness-val']) el['wheel-brightness-val'].textContent = state.bg.brightness + '%';
                applyBg();
            });
        }
    }

    /* ══════════════════════════════════════════════════════════════
       COLOUR WHEEL
    ══════════════════════════════════════════════════════════════ */
    function initColorWheel() {
        var canvas = el['color-wheel-canvas'];
        if (!canvas || (wheelCtx && wheelCanvas === canvas)) return;
        wheelCanvas = canvas;
        wheelCtx    = canvas.getContext('2d');
        var W = canvas.width, H = canvas.height;
        var cx = W/2, cy = H/2, r = Math.min(W,H)/2 - 2;

        /* Lightweight single-pass ImageData renderer */
        var imgData = wheelCtx.createImageData(W, H);
        var data = imgData.data;
        for (var py = 0; py < H; py++) {
            for (var px2 = 0; px2 < W; px2++) {
                var dx2 = px2 - cx, dy2 = py - cy;
                var dist2 = Math.sqrt(dx2*dx2 + dy2*dy2);
                if (dist2 > r) continue;
                var hue = (Math.atan2(dy2, dx2) * 180 / Math.PI + 360) % 360;
                var sat = dist2 / r;
                /* HSV-style: full saturation ring, white at center */
                var h6 = hue / 60, hi = Math.floor(h6), f = h6 - hi;
                var q = 1 - f, t2 = f;
                var rr, gg, bb;
                if      (hi === 0) { rr=1;   gg=t2;  bb=0;  }
                else if (hi === 1) { rr=q;   gg=1;   bb=0;  }
                else if (hi === 2) { rr=0;   gg=1;   bb=t2; }
                else if (hi === 3) { rr=0;   gg=q;   bb=1;  }
                else if (hi === 4) { rr=t2;  gg=0;   bb=1;  }
                else               { rr=1;   gg=0;   bb=q;  }
                /* blend towards white by (1-sat) */
                var idx = (py * W + px2) * 4;
                data[idx]   = Math.round((rr * sat + (1 - sat)) * 255);
                data[idx+1] = Math.round((gg * sat + (1 - sat)) * 255);
                data[idx+2] = Math.round((bb * sat + (1 - sat)) * 255);
                data[idx+3] = 255;
            }
        }
        wheelCtx.putImageData(imgData, 0, 0);
        /* clip to circle */
        wheelCtx.globalCompositeOperation = 'destination-in';
        wheelCtx.beginPath();
        wheelCtx.arc(cx, cy, r, 0, Math.PI * 2);
        wheelCtx.fill();
        wheelCtx.globalCompositeOperation = 'source-over';

        canvas.addEventListener('mousedown', wheelMouseDown);
        canvas.addEventListener('touchstart', wheelTouchStart, { passive: false });
    }

    var wheelDragging = false;
    function wheelMouseDown(e) {
        wheelDragging = true;
        pickWheel(e.offsetX, e.offsetY);
        var onMove = function(ev) {
            if (!wheelDragging) return;
            var rect = wheelCanvas.getBoundingClientRect();
            pickWheel(ev.clientX - rect.left, ev.clientY - rect.top);
        };
        var onUp = function() {
            wheelDragging = false;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }
    function wheelTouchStart(e) {
        e.preventDefault();
        var rect = wheelCanvas.getBoundingClientRect(), t = e.touches[0];
        pickWheel(t.clientX - rect.left, t.clientY - rect.top);
        var onMove = function(ev) {
            ev.preventDefault();
            var t2 = ev.touches[0];
            pickWheel(t2.clientX - rect.left, t2.clientY - rect.top);
        };
        var onEnd = function() {
            wheelCanvas.removeEventListener('touchmove', onMove);
            wheelCanvas.removeEventListener('touchend', onEnd);
        };
        wheelCanvas.addEventListener('touchmove', onMove, { passive: false });
        wheelCanvas.addEventListener('touchend', onEnd);
    }
    function pickWheel(x, y) {
        var W = wheelCanvas.width, H = wheelCanvas.height;
        var cx = W/2, cy = H/2, r = Math.min(W,H)/2-2;
        var dx = x-cx, dy = y-cy, dist = Math.sqrt(dx*dx+dy*dy);
        if (dist > r) { x = cx+dx/dist*r; y = cy+dy/dist*r; }
        var px = wheelCtx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
        state.bg.r = px[0]; state.bg.g = px[1]; state.bg.b = px[2];
        document.querySelectorAll('.quick-color-btn').forEach(function(b){ b.classList.remove('active'); });
        applyBg();
        moveWheelMarker(x, y);
    }
    function moveWheelMarker(x, y) {
        var m = el['wheel-marker'];
        if (!m) return;
        m.style.left = (x-7)+'px'; m.style.top = (y-7)+'px';
    }
    function syncWheelMarker() {
        if (!wheelCtx || !wheelCanvas) return;
        var W = wheelCanvas.width, H = wheelCanvas.height;
        var cx = W/2, cy = H/2, radius = Math.min(W,H)/2-2;
        var rn = state.bg.r/255, gn = state.bg.g/255, bn = state.bg.b/255;
        var max = Math.max(rn,gn,bn), min = Math.min(rn,gn,bn);
        var h=0, s=0, l=(max+min)/2;
        if (max !== min) {
            var d = max-min;
            s = l > 0.5 ? d/(2-max-min) : d/(max+min);
            if      (max===rn) h = (gn-bn)/d+(gn<bn?6:0);
            else if (max===gn) h = (bn-rn)/d+2;
            else               h = (rn-gn)/d+4;
            h /= 6;
        }
        moveWheelMarker(cx + s*radius*Math.cos(h*2*Math.PI), cy + s*radius*Math.sin(h*2*Math.PI));
    }

    /* ══════════════════════════════════════════════════════════════
       TABS
    ══════════════════════════════════════════════════════════════ */
    function switchTab(name) {
        document.querySelectorAll('.panel-tab').forEach(function(t){
            t.classList.toggle('active', t.dataset.tab === name);
        });
        document.querySelectorAll('.tab-content').forEach(function(tc){
            tc.classList.toggle('active', tc.id === 'tab-' + name);
        });
        /* Classic Config is disabled when the Advanced tab opens.
           It is only re-enabled when the user clicks Advanced again to close it. */
        if (state && name === 'advanced' && state.cal.classic_config) {
            state.cal.classic_config = false;
            if (el['chk_classic_config']) el['chk_classic_config'].checked = false;
            applyToHyperHDR();
        }
    }

    /* ══════════════════════════════════════════════════════════════
       KEYBOARD
    ══════════════════════════════════════════════════════════════ */
    function onKey(e) {
        if (!el['cal-fullscreen'] || !el['cal-fullscreen'].classList.contains('active')) return;
        if (e.key === 'Escape') exitFullscreen();
        if (e.key === 't' || e.key === 'T') togglePanels();
    }

    /* ══════════════════════════════════════════════════════════════
       DRAGGABLE
    ══════════════════════════════════════════════════════════════ */
    function makeDraggable(panel) {
        if (!panel) return;
        var handle = panel.querySelector('.panel-drag-hint') || panel.querySelector('.wheel-title') || panel;
        var ix, iy, dragging = false;
        handle.style.cursor = 'grab';
        handle.addEventListener('mousedown', function(e) {
            dragging = true;
            var r = panel.getBoundingClientRect();
            ix = e.clientX - r.left; iy = e.clientY - r.top;
            panel.style.position = 'absolute'; panel.style.margin = '0'; panel.style.transform = 'none';
            handle.style.cursor = 'grabbing'; e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!dragging) return;
            panel.style.left = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ix)) + 'px';
            panel.style.top  = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - iy)) + 'px';
        });
        document.addEventListener('mouseup', function() { dragging = false; handle.style.cursor = 'grab'; });
    }

    /* ══════════════════════════════════════════════════════════════
       TOAST
    ══════════════════════════════════════════════════════════════ */
    function showToast(msg, color) {
        var t = el['cal-toast'];
        if (!t) return;
        t.textContent = msg; t.style.background = color || 'rgba(72,187,120,.9)';
        t.classList.add('show');
        setTimeout(function(){ t.classList.remove('show'); }, 2400);
    }

    /* ══════════════════════════════════════════════════════════════
       PUBLIC API
    ══════════════════════════════════════════════════════════════ */
    window.ColorCalibration = {
        getColorConfig: buildColorConfig,
        getState:       function(){ return deepClone(state); },
        apply:          applyToHyperHDR,
        save:           saveSettings,
        reset:          resetToDefaults
    };

}());
