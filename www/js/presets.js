/**
 * HyperHDR Sidebar Presets  (v3)
 * ═══════════════════════════════════════════════════════════════════
 *
 * WHAT IS CAPTURED / RESTORED
 * ─────────────────────────────
 * Every setting type present in a HyperHDR backup file:
 *   automaticToneMapping · backgroundEffect · blackborderdetector
 *   color · device · effects · flatbufServer · foregroundEffect
 *   forwarder · general · jsonServer · ledConfig · leds · logger
 *   mqtt · network · protoServer · rawUdpServer · smoothing
 *   soundEffect · systemControl · systemGrabber · videoControl
 *   videoDetection · videoGrabber · webConfig
 *
 * SOURCES used when capturing:
 *   1. window.serverConfig   – live mirror of device config
 *   2. window.serverInfo     – extra info (instances, etc.)
 *   3. Active JSONEditor instances (editor_color, editor_smoothing, …)
 *   4. All plain HTML form controls
 *
 * IMPORT from backup file
 *   Drag-and-drop or click the 📂 button to load a
 *   "HyperHDR_export_format_v20" JSON backup and save it as a preset.
 *
 * APPLY
 *   All captured types are written back via requestWriteConfig().
 *   JSONEditors are updated via setValue().
 *   DOM fields are restored and their events fired.
 *
 * ═══════════════════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    var STORAGE_KEY = 'hyperhdr_presets_v3';

    /* ──────────────────────────────────────────────────────────────
       All setting types that live in a HyperHDR backup / serverConfig
    ────────────────────────────────────────────────────────────── */
    var ALL_TYPES = [
        // global (no hyperhdr_instance)
        'automaticToneMapping',
        'flatbufServer',
        'forwarder',
        'general',
        'jsonServer',
        'logger',
        'mqtt',
        'network',
        'protoServer',
        'soundEffect',
        'systemGrabber',
        'videoDetection',
        'videoGrabber',
        'webConfig',
        // per-instance
        'backgroundEffect',
        'blackborderdetector',
        'color',
        'device',
        'effects',
        'foregroundEffect',
        'instCapture',
        'ledConfig',
        'leds',
        'rawUdpServer',
        'smoothing',
        'systemControl',
        'videoControl'
    ];

    /* ──────────────────────────────────────────────────────────────
       JSONEditor variable names used by HyperHDR page scripts
    ────────────────────────────────────────────────────────────── */
    var KNOWN_EDITORS = [
        'editor_color',
        'editor_smoothing',
        'editor_blackborder',
        'editor_automatic_tone_mapping',
        'editor_leds',
        'editor_device',
        'editor_network',
        'editor_general',
        'editor_grabber',
        'editor_effects',
        'editor_remote',
        'editor_ledconfig',
        'editor_foreground',
        'editor_background',
        'editor_forwarder',
        'editor_flatbuf',
        'editor_proto',
        'editor_json',
        'editor_mqtt',
        'editor_webconfig',
        'editor_sound',
        'editor_logger',
        'editor_videocontrol',
        'editor_systemcontrol',
        'editor_systemgrabber',
        'editor_videograbber'
    ];

    /* ══════════════════════════════════════════════════════════════
       STORAGE
    ══════════════════════════════════════════════════════════════ */

    function loadPresets() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
        catch (e) { return {}; }
    }

    function savePresetsToStorage(map) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    }

    /* ══════════════════════════════════════════════════════════════
       CAPTURE  –  build a complete snapshot
    ══════════════════════════════════════════════════════════════ */

    function deepClone(obj) {
        try { return JSON.parse(JSON.stringify(obj)); }
        catch (e) { return obj; }
    }

    /** Extract all settings from window.serverConfig into the
     *  same flat { type → parsedConfig } shape we use internally. */
    function captureFromServerConfig() {
        if (!window.serverConfig) return {};
        var out = {};
        ALL_TYPES.forEach(function (type) {
            if (window.serverConfig[type] !== undefined) {
                out[type] = deepClone(window.serverConfig[type]);
            }
        });
        return out;
    }

    /** Collect active JSONEditor getValue() results keyed by
     *  the window variable name. */
    function captureEditors() {
        var out = {};
        KNOWN_EDITORS.forEach(function (name) {
            var ed = window[name];
            if (ed && typeof ed.getValue === 'function') {
                try { out[name] = ed.getValue(); } catch (e) { /**/ }
            }
        });
        return out;
    }

    /** Snapshot every plain HTML form control. */
    function captureDom() {
        var out = {};
        $('input[type="text"],input[type="number"],input[type="range"],input[type="color"],textarea,select').each(function () {
            var key = this.id || this.name;
            if (key) out[key] = $(this).val();
        });
        $('input[type="radio"]:checked').each(function () {
            if (this.name) out['__radio__' + this.name] = this.value;
        });
        $('input[type="checkbox"]').each(function () {
            var key = this.id || this.name;
            if (key) out['__chk__' + key] = this.checked;
        });
        return out;
    }

    function captureAll() {
        return {
            _version: 3,
            _ts: Date.now(),
            settings: captureFromServerConfig(),   // typed HyperHDR config
            editors:  captureEditors(),            // JSONEditor values
            dom:      captureDom()                 // raw form fields
        };
    }

    /* ══════════════════════════════════════════════════════════════
       IMPORT  –  parse a HyperHDR backup JSON file
    ══════════════════════════════════════════════════════════════ */

    /**
     * Convert a HyperHDR export (version HyperHDR_export_format_v20)
     * into our internal preset shape.
     *
     * Backup format:
     *  { version, instances, settings: [{ type, config (JSON string),
     *    hyperhdr_instance? }] }
     */
    function importFromBackup(backupObj) {
        if (!backupObj || !Array.isArray(backupObj.settings)) {
            throw new Error('Not a valid HyperHDR backup file.');
        }

        var settings = {};
        backupObj.settings.forEach(function (entry) {
            if (!entry.type) return;
            var parsed;
            try {
                parsed = (typeof entry.config === 'string')
                    ? JSON.parse(entry.config)
                    : entry.config;
            } catch (e) {
                parsed = entry.config;
            }
            // Store; per-instance types may appear multiple times –
            // keep instance 0 (or first occurrence).
            if (settings[entry.type] === undefined) {
                settings[entry.type] = parsed;
            }
        });

        return {
            _version: 3,
            _ts: Date.now(),
            _source: 'backup',
            _backupVersion: backupObj.version || '',
            settings: settings,
            editors:  {},
            dom:      {}
        };
    }

    /* ══════════════════════════════════════════════════════════════
       APPLY  –  restore a preset to the device
    ══════════════════════════════════════════════════════════════ */

    function applyAll(snap) {
        /* 1 ── Write all typed settings to server ─────────────── */
        if (snap.settings && Object.keys(snap.settings).length) {
            applySettings(snap.settings);
        }

        /* 2 ── Restore JSONEditors ────────────────────────────── */
        if (snap.editors && Object.keys(snap.editors).length) {
            applyEditors(snap.editors);
        }

        /* 3 ── Restore plain form fields ──────────────────────── */
        if (snap.dom && Object.keys(snap.dom).length) {
            applyDom(snap.dom);
        }
    }

    /**
     * Push settings to server via requestWriteConfig.
     * We also mirror into window.serverConfig so the live UI reflects
     * the restored values immediately.
     */
    function applySettings(settings) {
        if (typeof requestWriteConfig !== 'function') {
            console.warn('[Presets] requestWriteConfig not available.');
            return;
        }

        // Build one combined payload
        var payload = {};
        Object.keys(settings).forEach(function (type) {
            payload[type] = settings[type];

            // Mirror into live serverConfig
            if (window.serverConfig) {
                window.serverConfig[type] = deepClone(settings[type]);
            }
        });

        try {
            requestWriteConfig(payload);
        } catch (e) {
            console.error('[Presets] requestWriteConfig error:', e);
        }
    }

    function applyEditors(editorValues) {
        KNOWN_EDITORS.forEach(function (name) {
            var ed = window[name];
            if (ed && typeof ed.setValue === 'function' && editorValues[name] !== undefined) {
                try {
                    ed.setValue(editorValues[name]);
                    if (typeof ed.onChange === 'function') ed.onChange();
                } catch (e) {
                    console.warn('[Presets] setValue failed for', name, e);
                }
            }
        });
    }

    function applyDom(dom) {
        $('input[type="text"],input[type="number"],input[type="range"],input[type="color"],textarea,select').each(function () {
            var key = this.id || this.name;
            if (key && dom[key] !== undefined) {
                $(this).val(dom[key]).trigger('input').trigger('change');
            }
        });

        Object.keys(dom).forEach(function (k) {
            if (k.indexOf('__radio__') === 0) {
                var group = k.replace('__radio__', '');
                $('input[type="radio"][name="' + group + '"]').each(function () {
                    if (this.value === dom[k]) {
                        $(this).prop('checked', true).trigger('change');
                    }
                });
            } else if (k.indexOf('__chk__') === 0) {
                var id = k.replace('__chk__', '');
                var $el = $('#' + id);
                if (!$el.length) $el = $('input[type="checkbox"][name="' + id + '"]');
                if ($el.length) $el.prop('checked', dom[k]).trigger('change');
            }
        });
    }

    /* ══════════════════════════════════════════════════════════════
       SUMMARY  –  one-line human readable description of a preset
    ══════════════════════════════════════════════════════════════ */

    function buildSummary(snap) {
        var parts = [];
        var s = snap.settings || {};

        // Color / brightness
        if (s.color && s.color.channelAdjustment && s.color.channelAdjustment[0]) {
            var ch = s.color.channelAdjustment[0];
            if (ch.gamma !== undefined)
                parts.push('γ ' + ch.gamma);
            var r = ch.red   ? ch.red[0]   : null;
            var g = ch.green ? ch.green[1] : null;
            var b = ch.blue  ? ch.blue[2]  : null;
            if (r !== null && g !== null && b !== null)
                parts.push('RGB ' + r + '/' + g + '/' + b);
            if (ch.scaleOutput !== undefined)
                parts.push('Scale ' + (ch.scaleOutput * 100).toFixed(0) + '%');
            if (ch.powerLimit !== undefined && ch.powerLimit < 1)
                parts.push('Power ' + (ch.powerLimit * 100).toFixed(0) + '%');
        }

        // LED device
        if (s.device) {
            if (s.device.colorOrder)  parts.push(s.device.colorOrder.toUpperCase());
            if (s.device.host)        parts.push('@ ' + s.device.host);
            if (s.device.type)        parts.push(s.device.type);
        }

        // LED layout
        if (s.ledConfig && s.ledConfig.classic) {
            var lc = s.ledConfig.classic;
            var total = (lc.top || 0) + (lc.bottom || 0) + (lc.left || 0) + (lc.right || 0);
            if (total > 0) parts.push(total + ' LEDs');
        }

        // Smoothing
        if (s.smoothing) {
            if (s.smoothing.updateFrequency) parts.push(s.smoothing.updateFrequency + 'Hz');
            if (s.smoothing.type)            parts.push(s.smoothing.type);
        }

        // Grabber
        if (s.videoGrabber && s.videoGrabber.fps)
            parts.push('Grab ' + s.videoGrabber.fps + 'fps');
        if (s.systemGrabber && s.systemGrabber.fps)
            parts.push('SysGrab ' + s.systemGrabber.fps + 'fps');

        return parts.slice(0, 6).join(' · ') || 'Full configuration snapshot';
    }

    /* ══════════════════════════════════════════════════════════════
       UI HELPERS
    ══════════════════════════════════════════════════════════════ */

    function formatAge(ts) {
        if (!ts) return '';
        var m = Math.round((Date.now() - ts) / 60000);
        if (m < 1)  return 'just now';
        if (m < 60) return m + 'm ago';
        var h = Math.round(m / 60);
        if (h < 24) return h + 'h ago';
        return Math.round(h / 24) + 'd ago';
    }

    function countTypes(snap) {
        return snap.settings ? Object.keys(snap.settings).length : 0;
    }

    function showToast(header, body) {
        var $t = $('#toast_success_message');
        if (!$t.length) return;
        $('#toast_message_header_id').text(header);
        $('#toast_message_body_id').text(body);
        if (window.bootstrap && bootstrap.Toast) {
            bootstrap.Toast.getOrCreateInstance($t[0]).show();
        } else {
            $t.fadeIn(200).delay(2200).fadeOut(400);
        }
    }

    /* ══════════════════════════════════════════════════════════════
       RENDER PRESET LIST
    ══════════════════════════════════════════════════════════════ */

    function renderPresetList() {
        var presets = loadPresets();
        var $c = $('#presets_list_container');
        $c.empty();

        var names = Object.keys(presets).sort();
        if (!names.length) return;

        names.forEach(function (name) {
            var snap     = presets[name];
            var safeName = $('<s>').text(name).html();

            var $item = $('<div class="preset-item"></div>');

            var $info = $('<div class="preset-label" style="flex:1;min-width:0;cursor:pointer;" title="Click to apply">' + safeName + '</div>');
            $info.on('click', function () {
                if (!confirm('Apply preset "' + name + '"?\n\nThis will overwrite your current device configuration.')) return;
                applyAll(snap);
                showToast('Preset applied', '"' + name + '" restored & written to device.');
            });

            var $del = $('<button class="btn-del-preset" title="Delete">✕</button>');
            $del.on('click', function (e) {
                e.stopPropagation();
                if (!confirm('Delete preset "' + name + '"?')) return;
                var all = loadPresets();
                delete all[name];
                savePresetsToStorage(all);
                renderPresetList();
            });

            $item.append($info, $del);
            $c.append($item);
        });
    }

    /* ══════════════════════════════════════════════════════════════
       SIDEBAR TOGGLE
    ══════════════════════════════════════════════════════════════ */

    $(document).on('click', '#sidebar_presets_toggle', function (e) {
        e.preventDefault();
        $('#presets_submenu').toggleClass('open');
        if ($('#presets_submenu').hasClass('open')) renderPresetList();
    });

    /* ══════════════════════════════════════════════════════════════
       SAVE  –  capture current live state
    ══════════════════════════════════════════════════════════════ */

    $(document).on('click', '#btn_save_preset', function () {
        var name = $.trim($('#preset_name_input').val());
        if (!name) { $('#preset_name_input').focus(); return; }

        var all = loadPresets();
        all[name] = captureAll();
        savePresetsToStorage(all);
        $('#preset_name_input').val('');
        renderPresetList();
        showToast('Preset saved', '"' + name + '" — ' + Object.keys(all[name].settings).length + ' config types captured.');
    });

    $(document).on('keypress', '#preset_name_input', function (e) {
        if (e.which === 13) $('#btn_save_preset').trigger('click');
    });

    /* ══════════════════════════════════════════════════════════════
       IMPORT BACKUP FILE  –  📂 button
    ══════════════════════════════════════════════════════════════ */

    /** Hidden file input – reused across clicks */
    var $fileInput = $('<input type="file" accept=".json" style="display:none;" id="preset_file_input">').appendTo('body');

    $(document).on('click', '#btn_import_preset', function () {
        $fileInput.val('').trigger('click');
    });

    $fileInput.on('change', function () {
        var file = this.files && this.files[0];
        if (!file) return;

        var reader = new FileReader();
        reader.onload = function (e) {
            try {
                var obj = JSON.parse(e.target.result);
                var snap = importFromBackup(obj);

                // Suggest file name (strip timestamp suffix) as preset name
                var suggested = file.name.replace(/\.json$/i, '').replace(/_?\d{10,}$/, '').replace(/_/g, ' ').trim() || 'Imported backup';
                var name = $.trim($('#preset_name_input').val()) || suggested;

                // Confirm overwrite
                var all = loadPresets();
                if (all[name] && !confirm('A preset named "' + name + '" already exists. Overwrite?')) return;

                all[name] = snap;
                savePresetsToStorage(all);
                renderPresetList();
                showToast('Backup imported', '"' + name + '" — ' + Object.keys(snap.settings).length + ' setting types loaded.');
                $('#preset_name_input').val('');
            } catch (err) {
                alert('Import failed: ' + err.message);
            }
        };
        reader.readAsText(file);
    });

    /* ══════════════════════════════════════════════════════════════
       EXPORT PRESET  –  download as HyperHDR backup JSON
    ══════════════════════════════════════════════════════════════ */

    /**
     * Convert internal preset back to the HyperHDR export format so it
     * can be restored via the built-in Backup / Restore page too.
     */
    function exportAsBackup(snap, name) {
        var settingsArr = [];
        var perInstance = ['backgroundEffect','blackborderdetector','color','device',
                           'effects','foregroundEffect','instCapture','ledConfig','leds',
                           'rawUdpServer','smoothing','systemControl','videoControl'];

        Object.keys(snap.settings).forEach(function (type) {
            var entry = {
                type:   type,
                config: JSON.stringify(snap.settings[type])
            };
            if (perInstance.indexOf(type) !== -1) {
                entry.hyperhdr_instance = 0;
            }
            settingsArr.push(entry);
        });

        return {
            version:   'HyperHDR_export_format_v20',
            instances: [{ enabled: 1, friendly_name: 'First LED instance', instance: 0 }],
            settings:  settingsArr
        };
    }

    $(document).on('click', '#btn_export_preset', function () {
        var presets = loadPresets();
        var names = Object.keys(presets);
        if (!names.length) { alert('No presets to export.'); return; }

        // If exactly one preset exists export it; otherwise ask which
        var name;
        if (names.length === 1) {
            name = names[0];
        } else {
            name = prompt('Enter preset name to export:\n\n' + names.join('\n'));
            if (!name || !presets[name]) { alert('Preset not found.'); return; }
        }

        var backup  = exportAsBackup(presets[name], name);
        var blob    = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        var ts      = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 15);
        var fname   = 'hyperhdr_preset_' + name.replace(/[^a-z0-9]/gi, '_') + '_' + ts + '.json';

        // Use the page's download.min.js if available, else anchor trick
        if (typeof download === 'function') {
            download(blob, fname, 'application/json');
        } else {
            var url = URL.createObjectURL(blob);
            var a   = document.createElement('a');
            a.href  = url; a.download = fname;
            document.body.appendChild(a); a.click();
            setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
        }
    });

    /* ══════════════════════════════════════════════════════════════
       INJECT IMPORT / EXPORT BUTTONS into the sidebar panel
    ══════════════════════════════════════════════════════════════ */

    $(document).ready(function () {
        renderPresetList();
    });

}());