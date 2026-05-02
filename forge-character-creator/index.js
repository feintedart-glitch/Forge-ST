/**
 * FORGE Character Creator — SillyTavern Extension
 * Drop into: SillyTavern/public/scripts/extensions/third-party/forge-character-creator/
 *
 * Commit 1 of 3: Extension registration, settings, UI injection, event hooks
 */

import { extension_settings, getContext, saveSettingsDebounced } from '../../../extensions.js';

// ── Optional ST imports with graceful fallback ──────────────────────────────
let _saveCharacter = null;
let _createCharacter = null;
let _eventSource = null;
let _event_types = null;
let _getTokenCount = (text) => Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.35);

try {
    const script = await import('../../../../script.js');
    _saveCharacter  = script.saveCharacter  ?? null;
    _createCharacter = script.createCharacter ?? null;
    _eventSource    = script.eventSource    ?? null;
    _event_types    = script.event_types    ?? null;
} catch (e) {
    console.warn('[FORGE] Could not import script.js globals — ST write-back limited.', e);
}

try {
    const tok = await import('../../../../scripts/tokenizers.js');
    if (typeof tok.getTokenCount === 'function') _getTokenCount = tok.getTokenCount;
} catch (_) { /* use word-count fallback */ }

// ── World Info ──────────────────────────────────────────────────────────────
let _createWorldInfoEntry = null;
let _world_names = null;
try {
    const wi = await import('../../../../scripts/world-info.js');
    _createWorldInfoEntry = wi.createWorldInfoEntry ?? null;
    _world_names          = wi.world_names          ?? null;
} catch (_) { /* world info push disabled */ }

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════
const EXT_NAME    = 'forge-character-creator';
const EXT_VERSION = '1.0.0';

const DEFAULT_SETTINGS = {
    cardFormat:      'prose',   // 'wpp' | 'plist' | 'prose'
    explicitAnatomy: false,
    isFav:           false,
    lastCharId:      null,
};

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS INIT
// ═══════════════════════════════════════════════════════════════════════════
function initSettings() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = { ...DEFAULT_SETTINGS };
    } else {
        // Fill any missing keys added in future versions
        for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
            if (extension_settings[EXT_NAME][k] === undefined) {
                extension_settings[EXT_NAME][k] = v;
            }
        }
    }
    saveSettingsDebounced();
}

function getSetting(key) {
    return extension_settings[EXT_NAME]?.[key] ?? DEFAULT_SETTINGS[key];
}

function setSetting(key, value) {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = { ...DEFAULT_SETTINGS };
    extension_settings[EXT_NAME][key] = value;
    saveSettingsDebounced();
}

// ═══════════════════════════════════════════════════════════════════════════
// OVERLAY / PANEL CREATION
// ═══════════════════════════════════════════════════════════════════════════
let overlayEl = null;

async function createOverlay() {
    // Avoid double-injection
    if (document.getElementById('forge-overlay')) return;

    // Load HTML template
    let templateHTML = '';
    try {
        const res = await fetch(`/scripts/extensions/third-party/${EXT_NAME}/templates/creator.html`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        templateHTML = await res.text();
    } catch (e) {
        console.error('[FORGE] Failed to load creator.html template:', e);
        return;
    }

    // Build overlay wrapper
    overlayEl = document.createElement('div');
    overlayEl.id          = 'forge-overlay';
    overlayEl.className   = 'forge-overlay';
    overlayEl.innerHTML   = templateHTML;
    document.body.appendChild(overlayEl);

    // Close on backdrop click (outside the panel itself)
    overlayEl.addEventListener('click', (e) => {
        if (e.target === overlayEl) FORGE.close();
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlayEl.classList.contains('open')) FORGE.close();
    });

    // Close chip dropdowns when clicking elsewhere inside the panel
    overlayEl.addEventListener('click', (e) => {
        if (!e.target.closest('.forge-kw-add-wrap')) {
            overlayEl.querySelectorAll('.forge-kw-dropdown.open')
                     .forEach(d => d.classList.remove('open'));
        }
    });
}

// ── Open / Close ─────────────────────────────────────────────────────────
function openPanel() {
    if (!overlayEl) return;
    overlayEl.classList.add('open');
    document.body.style.overflow = 'hidden'; // prevent ST scroll-through
    refreshWorldTargetDropdown();
    refreshAvatarDisplay();
}

function closePanel() {
    if (!overlayEl) return;
    overlayEl.classList.remove('open');
    document.body.style.overflow = '';
}

// ═══════════════════════════════════════════════════════════════════════════
// BUTTON INJECTION INTO ST UI
// ═══════════════════════════════════════════════════════════════════════════
function injectForgeButton() {
    // Don't inject twice
    if (document.getElementById('forge-open-btn')) return;

    const btn = document.createElement('button');
    btn.id          = 'forge-open-btn';
    btn.textContent = '⚒ FORGE';
    btn.title       = 'Open FORGE Character Creator';
    btn.onclick     = () => FORGE.open();

    // Try several injection targets in priority order
    const targets = [
        '#rm_button_create',           // "Create Character" button area
        '#character_cross',            // character close/controls bar
        '#form_create_container',      // character editing form
        '#top-bar',                    // ST top bar
        '#right-nav-panel',            // right nav
        'body',                        // last resort
    ];

    for (const sel of targets) {
        const container = document.querySelector(sel);
        if (container) {
            // For form_create_container, prepend inside; for others append
            if (sel === '#form_create_container') {
                container.insertBefore(btn, container.firstChild);
            } else {
                container.appendChild(btn);
            }
            return;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// WORLD INFO TARGET DROPDOWN
// ═══════════════════════════════════════════════════════════════════════════
function refreshWorldTargetDropdown() {
    const sel = document.getElementById('forge-world-target');
    if (!sel) return;

    // Collect world names from ST
    let worlds = [];
    try {
        // _world_names may be an array or a reactive variable
        if (Array.isArray(_world_names)) {
            worlds = _world_names;
        } else if (typeof _world_names === 'function') {
            worlds = _world_names();
        } else {
            // Fallback: read from ST's select element
            const stSel = document.querySelector('#world_info_external_select, #world_info select');
            if (stSel) {
                worlds = Array.from(stSel.options)
                              .map(o => o.value)
                              .filter(v => v && v !== 'None');
            }
        }
    } catch (_) {}

    // Rebuild options
    sel.innerHTML = '<option value="">— select world —</option>';
    worlds.forEach(w => {
        const opt = document.createElement('option');
        opt.value       = w;
        opt.textContent = w;
        sel.appendChild(opt);
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// AVATAR DISPLAY
// ═══════════════════════════════════════════════════════════════════════════
function refreshAvatarDisplay() {
    const img    = document.getElementById('forge-char-avatar');
    const noAvtr = document.getElementById('forge-no-avatar');
    if (!img || !noAvtr) return;

    try {
        const ctx  = getContext();
        const char = ctx.characters?.[ctx.characterId];
        if (char?.avatar) {
            const avatarUrl = `/characters/${char.avatar}`;
            img.src            = avatarUrl;
            img.style.display  = 'block';
            noAvtr.style.display = 'none';
        } else {
            img.style.display    = 'none';
            noAvtr.style.display = '';
            noAvtr.textContent   = char ? 'No avatar set' : 'No character loaded';
        }
    } catch (_) {
        img.style.display    = 'none';
        noAvtr.style.display = '';
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ST EVENT HOOKS
// ═══════════════════════════════════════════════════════════════════════════
function hookSTEvents() {
    if (!_eventSource || !_event_types) return;

    // When a character is selected in ST, update the avatar preview
    _eventSource.on(_event_types.CHARACTER_SELECTED, () => {
        if (overlayEl?.classList.contains('open')) {
            refreshAvatarDisplay();
        }
    });

    // When the chat changes, keep avatar in sync
    _eventSource.on(_event_types.CHAT_CHANGED, () => {
        if (overlayEl?.classList.contains('open')) {
            refreshAvatarDisplay();
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// WRITE STATUS HELPER
// ═══════════════════════════════════════════════════════════════════════════
function showStatus(msg, isError = false) {
    const el = document.getElementById('forge-write-status');
    if (!el) return;
    el.textContent = msg;
    el.className   = 'forge-write-status visible' + (isError ? ' error' : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = 'forge-write-status'; }, 3500);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXTENSION INIT  (runs at bottom of file after FORGE namespace is built)
// ═══════════════════════════════════════════════════════════════════════════
async function extensionInit() {
    initSettings();
    await createOverlay();
    injectForgeButton();
    hookSTEvents();

    // Defer chip + widget init until after the overlay DOM is ready
    if (overlayEl) {
        initAllWidgets();
        // Restore persisted card-format preference
        const savedFormat = getSetting('cardFormat');
        const fmtBtn = overlayEl.querySelector(`.forge-format-btn[data-format="${savedFormat}"]`);
        if (fmtBtn) FORGE.setFormat(savedFormat, fmtBtn);
        // Restore explicit-anatomy toggle state
        if (getSetting('explicitAnatomy')) {
            const expToggle = document.getElementById('forge-explicit-toggle');
            if (expToggle && !expToggle.classList.contains('active')) {
                expToggle.classList.add('active');
                FORGE.explicitAnatomy = true;
            }
        }
    }

    console.log(`[FORGE] v${EXT_VERSION} — Character Creator extension loaded.`);
}

// Expose helpers needed by later commits and by inline HTML handlers
export {
    openPanel,
    closePanel,
    refreshWorldTargetDropdown,
    refreshAvatarDisplay,
    showStatus,
    getSetting,
    setSetting,
    _saveCharacter,
    _createCharacter,
    _createWorldInfoEntry,
    _getTokenCount,
    _eventSource,
    _event_types,
};

// ── jQuery entry point ──────────────────────────────────────────────────
// (The rest of FORGE — data, chip engine, output builders — is appended
//  in commits 2 and 3.  extensionInit() is called at the very end of
//  index.js once the full FORGE namespace is assembled.)
