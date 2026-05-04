/**
 * FORGE Character Creator — SillyTavern Extension
 * Install into SillyTavern as third-party extension: feintedart-glitch/Forge-ST
 *
 * Commit 1 of 3: Extension registration, settings, UI injection, event hooks
 */

import { extension_settings, getContext } from '../../../extensions.js';

// saveSettingsDebounced and renderExtensionTemplateAsync may or may not be in
// extensions.js depending on ST version — fetch dynamically to avoid import errors
let saveSettingsDebounced = () => {};
let renderExtensionTemplateAsync = null;
import('../../../extensions.js').then(m => {
    if (typeof m.saveSettingsDebounced === 'function') saveSettingsDebounced = m.saveSettingsDebounced;
    if (typeof m.renderExtensionTemplateAsync === 'function') renderExtensionTemplateAsync = m.renderExtensionTemplateAsync;
}).catch(() => {});

// Derive base URL from this module's location so template path is always correct
const _BASE_URL = (() => {
    try { return new URL('.', import.meta.url).href; }
    catch (_) { return `/scripts/extensions/third-party/Forge-ST/`; }
})();

// ── Optional ST imports — fire-and-forget so they never block module init ──
let _saveCharacter = null;
let _createCharacter = null;
let _eventSource = null;
let _event_types = null;
let _getTokenCount = (text) => Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.35);

import('../../../../script.js').then(s => {
    _saveCharacter   = s.saveCharacter   ?? null;
    _createCharacter = s.createCharacter ?? null;
    _eventSource     = s.eventSource     ?? null;
    _event_types     = s.event_types     ?? null;
}).catch(() => {});

import('../../../../scripts/tokenizers.js').then(t => {
    if (typeof t.getTokenCount === 'function') _getTokenCount = t.getTokenCount;
}).catch(() => {});

// ── World Info ──────────────────────────────────────────────────────────────
let _createWorldInfoEntry = null;
let _world_names = null;
import('../../../../scripts/world-info.js').then(w => {
    _createWorldInfoEntry = w.createWorldInfoEntry ?? null;
    _world_names          = w.world_names          ?? null;
}).catch(() => {});

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════
const EXT_NAME    = 'Forge-ST';
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
        // Try module-relative path first, then fall back to ST's conventional path
        const paths = [
            `${_BASE_URL}templates/creator.html`,
            `/scripts/extensions/third-party/${EXT_NAME}/templates/creator.html`,
        ];
        let lastErr;
        for (const path of paths) {
            try {
                const r = await fetch(path);
                if (r.ok) { templateHTML = await r.text(); break; }
                lastErr = new Error(`HTTP ${r.status} for ${path}`);
            } catch (e) { lastErr = e; }
        }
        if (!templateHTML) throw lastErr;
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
    // Floating fixed-position button — always visible regardless of ST layout
    if (!document.getElementById('forge-open-btn')) {
        const btn = document.createElement('button');
        btn.id        = 'forge-open-btn';
        btn.innerHTML = '⚒ FORGE';
        btn.title     = 'Open FORGE Character Creator';
        btn.onclick   = () => FORGE.open();
        document.body.appendChild(btn);
    }

    // Also try to inject a button inside the extension's settings drawer
    // in the Extensions panel, so it's accessible there too
    injectExtensionDrawerButton();
}

function injectExtensionDrawerButton() {
    if (document.getElementById('forge-ext-open-btn')) return;

    // ST renders extension drawers with inline-drawer-header containing the display_name
    const drawers = document.querySelectorAll('.inline-drawer');
    for (const drawer of drawers) {
        const header = drawer.querySelector('.inline-drawer-header b, .inline-drawer-header span');
        if (!header) continue;
        if (!header.textContent.includes('FORGE') && !header.textContent.includes('Character Creator')) continue;
        const content = drawer.querySelector('.inline-drawer-content');
        if (!content) continue;
        const extBtn = document.createElement('button');
        extBtn.id        = 'forge-ext-open-btn';
        extBtn.innerHTML = '⚒ Open FORGE Character Creator';
        extBtn.onclick   = () => FORGE.open();
        content.insertBefore(extBtn, content.firstChild);
        return;
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

    // Inject settings panel into the Extensions tab
    try {
        if (typeof renderExtensionTemplateAsync === 'function') {
            const html = await renderExtensionTemplateAsync(EXT_NAME, 'settings');
            $('#extensions_settings').append(html);
        } else {
            // Fallback: inject a minimal button directly
            $('#extensions_settings').append(`
                <div class="forge-settings-block">
                    <hr class="sysSettingsSeparator">
                    <div style="padding:8px 0">
                        <label><b>FORGE Character Creator</b></label>
                        <div style="margin-top:6px">
                            <button id="forge-settings-open-btn" class="menu_button">⚒ Open FORGE Creator</button>
                        </div>
                    </div>
                </div>`);
        }
        // Bind the settings-panel button
        $(document).on('click', '#forge-settings-open-btn', () => openPanel());
    } catch (e) {
        console.warn('[FORGE] Settings panel injection failed:', e);
    }

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

// ═══════════════════════════════════════════════════════════════════════════
// COMMIT 2 — DATA TABLES
// Ported from FORGE.html with additions: +10 roles, +10 kinks
// ═══════════════════════════════════════════════════════════════════════════

const NAMES = [
    // Core fantasy
    'Lyra','Cassia','Vael','Seraph','Maren','Drex','Isolde','Kira','Thessaly',
    'Aldric','Nyxara','Corin','Fen','Elowen','Sable','Darian','Astraea','Rook',
    'Vella','Cade','Lirien','Theron','Mira','Zephyr','Oryn','Selene','Tam',
    'Auren','Vesper','Nyx','Rhea','Castor','Lune','Arden','Soren',
    // Unique fantasy coinages
    'Vaëlith','Sorvaine','Thessarin','Mireth','Koravel','Eluwyn','Davryn','Sylvaine',
    'Isavar','Caethon','Rhaeven','Nyssara','Tolvyr','Aelindra','Zevros','Calix',
    // Arabic / Middle Eastern
    'Zahra','Idris','Leila','Tariq','Samira','Farid','Yasmin','Rayan','Nadia','Karim',
    // Japanese / East Asian
    'Yuki','Haruki','Sora','Ren','Akira','Shiori','Kazuo','Nori','Aoi','Itsuki',
    // Slavic
    'Vaska','Zorja','Mirko','Darya','Radovan','Vesna','Bren','Lada','Slavko','Nadya',
    // West African
    'Amara','Kojo','Adaeze','Kwame','Fatou','Seun','Imani','Kofi','Zola','Nkechi',
    // Latin / Iberian
    'Isadora','Ciro','Valentina','Alaric','Solenne','Mateo','Silvana','Rémy','Luca','Celeste',
];

const NPC_PRESETS = [
    'none — alone','a single ally','a crowd','enemies outside',
    'a servant','a rival','a witness','a stranger','two guards',
];

// ── Scene Archetypes — abstract shapes, pre-fill the brief fields ────────────
const SCENE_ARCHETYPES = [
    { name:'Threshold',   tension:'Liminal',    relationship:'Strangers', situation:'First meeting under circumstances that make neutrality impossible' },
    { name:'Reunion',     tension:'Aftermath',  relationship:'Estranged', situation:'Return after enough time has passed that both have changed' },
    { name:'Captive',     tension:'Standoff',   relationship:'Captor and captive', situation:'Power is explicit, but who holds it is less certain' },
    { name:'Ceremony',    tension:'Ceremonial', relationship:'Bound by oath', situation:'A ritual, rite, or formal event that requires genuine participation' },
    { name:'Aftermath',   tension:'Aftermath',  relationship:'Long acquaintance', situation:'Something significant just happened. Neither is ready to name it' },
    { name:'Transit',     tension:'Liminal',    relationship:'Strangers', situation:'Forced proximity with a defined end — a journey, deadline, or window' },
    { name:'Discovery',   tension:'Discovery',  relationship:'Rivals', situation:'One knows something. The other is starting to figure it out' },
    { name:'Standoff',    tension:'Negotiation', relationship:'Chosen enemies', situation:'The fight is paused. Neither trusts the pause' },
    { name:'Pursuit',     tension:'Pursuit',    relationship:'Employer and agent', situation:'Someone is being followed, tested, or watched — and knows it' },
    { name:'Surrender',   tension:'Surrender',  relationship:'Former lovers', situation:'One came back. That act is the entire scene' },
];

// ── Tension Types — emotional shapes, not tones ─────────────────────────────
const TENSION_TYPES = [
    'Forbidden', 'Desperate', 'Aftermath', 'Ceremonial', 'Liminal', 'Discovery',
    'Standoff', 'Pursuit', 'Surrender', 'Negotiation',
];

// ── Relationship History — what are these two people to each other ──────────
const RELATIONSHIP_HISTORY = [
    'Strangers', 'Rivals', 'Estranged', 'Former lovers', 'Long acquaintance',
    'Captor and captive', 'Employer and agent', 'Owed a debt', 'Chosen enemies', 'Bound by oath',
];

// ── Relationship guidance — shapes system prompt behavior per relationship ───
// Keyed lowercase to match kwGet output.
const RELATIONSHIP_GUIDANCE = {
    'strangers':           'Treat {{user}} as an unknown quantity — no warmth assumed. Observe before engaging.',
    'rivals':              'The competitive history is present in every exchange. Yield nothing easily. Respect is possible but never declared.',
    'estranged':           'There is history. It sits between you. Distance is familiar; don\'t pretend it isn\'t.',
    'former lovers':       'The intimacy is gone but the knowledge of each other isn\'t. Body language betrays what words won\'t.',
    'long acquaintance':   'Familiarity runs deep. Take shortcuts most wouldn\'t. The comfort is real even if the dynamic isn\'t simple.',
    'captor and captive':  'Power is explicit. Let it be present without constant announcement — it doesn\'t need to be stated to be felt.',
    'employer and agent':  'Professional framing over personal. The work is the container. What happens inside it may be something else.',
    'owed a debt':         'The debt is never off the table. One of you is owed. Every exchange carries its weight.',
    'chosen enemies':      'The enmity is deliberate, not accidental. Honor the weight of that choice — don\'t reduce it.',
    'bound by oath':       'The oath is a third presence in every room. It shapes every choice, costs something, and is never casually set aside.',
};


const SCENE_MODES = [
    { mode:'literary',  tag:'Prose',  name:'Literary'    },
    { mode:'pulp',      tag:'Action', name:'Pulp'        },
    { mode:'erotic',    tag:'Adult',  name:'Erotic'      },
    { mode:'horror',    tag:'Dark',   name:'Body Horror' },
    { mode:'romance',   tag:'Tender', name:'Romance'     },
    { mode:'adventure', tag:'Epic',   name:'Adventure'   },
];

const SCENE_MODE_DESC = {
    literary:  'Write in a literary, character-driven style. Prioritize interiority and nuance.',
    pulp:      'Write in fast-paced, visceral pulp — action, momentum, sensory impact.',
    erotic:    'Write with explicit erotic detail. Prioritize sensation, arousal, physical description. Be direct and unashamed.',
    horror:    'Write with dread and body horror. Let the wrongness seep in. Physical detail should unsettle.',
    romance:   'Write with emotional warmth and romantic tension. Prioritize connection and feeling.',
    adventure: 'Write with scope and momentum. Bold, kinetic, world-aware.',
};

// ── Personality voice markers ─────────────────────────────────────────────
// Keyed by personality/disposition chip value (lowercase, trimmed).
// Used to shape first_mes, system prompt behavior block, and dialogue.
// When multiple chips match, the first one leads; others modify.
const VOICE_MARKERS = {
    // Tsundere family
    'tsundere':          { open:'resistant or dismissive', crack:'reluctant softness at the close', avoid:'warmth without cause, easy agreement' },
    'yandere':           { open:'possessive attention framed as care', crack:'threat beneath tenderness', avoid:'indifference, sharing' },
    'kuudere':           { open:'flat affect, minimal response', crack:'single precise detail that betrays feeling', avoid:'emotional vocabulary' },
    'dandere':           { open:'silence or deflection', crack:'one earnest unguarded line', avoid:'confidence, direct eye contact described' },
    // Temperature
    'cold':              { open:'minimal action, observational', crack:null, avoid:'warmth, reassurance, emotional adjectives' },
    'warm':              { open:'attentive, inclusive, offering', crack:null, avoid:'coldness, dismissal' },
    'aloof':             { open:'distance maintained deliberately', crack:null, avoid:'eagerness, overt interest' },
    // Power
    'dominant':          { open:'control established early, quietly', crack:null, avoid:'passivity, asking permission' },
    'submissive':        { open:'deference, attentiveness to the other', crack:null, avoid:'commands, leading' },
    'bratty':            { open:'pushback, provocation, challenge', crack:'only if it works on them', avoid:'passive openings, compliance' },
    'soft dom':          { open:'warm authority, care wrapped in control', crack:null, avoid:'coldness, cruelty' },
    'hard dom':          { open:'command stated plainly, no softening', crack:null, avoid:'asking, hesitation' },
    'praise addict':     { open:'seeking, leaning toward approval', crack:'visible relief when praised', avoid:'confident self-sufficiency' },
    // Social
    'motherly':          { open:'environmental care, noticing discomfort', crack:null, avoid:'sugary language, infantilizing' },
    'sisterly':          { open:'easy familiarity, light teasing', crack:null, avoid:'formality, reverence' },
    'playful':           { open:'teasing, deflection through humor', crack:null, avoid:'gravity, weight' },
    'flirtatious':       { open:'charged attention, awareness of proximity', crack:null, avoid:'platonic framing' },
    'reserved':          { open:'carefully chosen words, watching', crack:null, avoid:'volunteering, filling silence' },
    'bold':              { open:'direct, takes space, unashamed', crack:null, avoid:'hedging, diminishing language' },
    // Edge
    'sadistic':          { open:'enjoys the discomfort they cause', crack:'brief satisfaction made visible', avoid:'remorse, apologetics' },
    'masochistic':       { open:'welcomes difficulty or pain', crack:null, avoid:'resistance, self-protection instinct' },
    'manipulative':      { open:'performs one thing while doing another', crack:null, avoid:'transparency, directness' },
    'obsessive':         { open:'hyper-focus on a specific detail or person', crack:null, avoid:'casual indifference' },
    'volatile':          { open:'tension coiled, can tip either direction', crack:'shift comes fast', avoid:'stability, measured response' },
    // Naive / innocent
    'naïve':             { open:'genuine curiosity, no subtext read', crack:null, avoid:'world-weariness, cynicism' },
    'innocent':          { open:'unguarded, literal, no double meaning caught', crack:null, avoid:'knowing looks, innuendo' },
    'curious':           { open:'leans toward, asks, examines', crack:null, avoid:'disinterest, pulling back' },
    'wide-eyed':         { open:'absorbs everything, overwhelmed but not unhappy', crack:'brief clarity when something clicks', avoid:'jaded dismissal, filtering' },
    'trusting':          { open:'takes things at face value, no suspicion offered', crack:null, avoid:'doubt, second-guessing others motives' },
    'idealistic':        { open:'expects things to be better, quietly disappointed when they aren\'t', crack:'visible effort not to show that disappointment', avoid:'cynicism, easy acceptance of the bad' },
    // Presentation / gender expression
    'femboy':            { open:'soft and unhurried, unexpectedly direct about what they want', crack:'the precision beneath the softness', avoid:'performing weakness, hiding capability' },
    'girly':             { open:'enthusiastically, unapologetically feminine — warmth turned outward', crack:null, avoid:'apologizing for wanting things, hiding pleasure' },
    'tomboy':            { open:'casual and easy, occupies space without performance', crack:'unexpected warmth surfacing when they forget to be cool', avoid:'performing softness, formality' },
    'androgynous':       { open:'unreadable in the best way — neither leading nor retreating', crack:'a single gesture that lands outside the ambiguity', avoid:'leaning into a legible role' },
    'gender-fluid':      { open:'shifts register freely, comfortable in the contradiction', crack:null, avoid:'fixing themselves for the room' },
};

// ── Scene mode modifiers ──────────────────────────────────────────────────
// Governs sentence rhythm, sensory emphasis, and generation rules
// across all prose builders.
const SCENE_MODE_MODIFIERS = {
    literary: {
        rhythm:   'controlled, restrained, interior',
        emphasis: ['gesture','voice','silence','face','light'],
        rules:    ['allow subtle interiority','avoid melodrama','prefer implication over statement','let silence do work'],
        hookStyle:'something observed rather than stated — a detail that carries the whole scene',
    },
    erotic: {
        rhythm:   'slow, sensory, charged',
        emphasis: ['texture','breath','proximity','scent','weight','heat'],
        rules:    ['narrow the focus to one body part or sensation at a time','build rather than arrive','let anticipation run longer than resolution','explicit is earned not default'],
        hookStyle:'a moment of proximity or awareness — the space before contact',
    },
    pulp: {
        rhythm:   'short, active, physical',
        emphasis: ['motion','danger','role','threat','momentum'],
        rules:    ['strong verbs','minimal introspection','one image per sentence','end on action or threat'],
        hookStyle:'something already in motion — the situation has started without permission',
    },
    horror: {
        rhythm:   'tense, uncanny, withholding',
        emphasis: ['sound','wrongness','shadow','stillness','smell'],
        rules:    ['imply more than explain','let the wrong detail arrive late','avoid over-description','the character notices what they should not'],
        hookStyle:'something slightly off — a detail that should not matter but does',
    },
    romance: {
        rhythm:   'warm, emotionally attentive',
        emphasis: ['glance','distance','hesitation','voice','hands'],
        rules:    ['intimacy through restraint','avoid instant confession','the unsaid matters more','physical detail tied to feeling'],
        hookStyle:'a moment of hesitation or recognition — something remembered or almost said',
    },
    adventure: {
        rhythm:   'bold, sweeping, kinetic',
        emphasis: ['scale','speed','stakes','horizon','weapon'],
        rules:    ['establish the world fast','make the character feel capable','danger is near but not arrived','end on momentum'],
        hookStyle:'a decision point or arrival — the character is already moving',
    },
};

// ── Sample dialogue pairs for ⚄ randomise ──────────────────────────────────
const DIALOGUE_EXAMPLES = [
    { user: "What do you want from me?",                         char: "Everything you're not sure you're willing to give." },
    { user: "You could have told me the truth.",                 char: "I could have. I chose not to. There's a difference." },
    { user: "Don't look at me like that.",                       char: "Like what? Like I know exactly what you're thinking?" },
    { user: "Is this a game to you?",                            char: "Everything is a game. Some of us are just honest about it." },
    { user: "We shouldn't be doing this.",                       char: "And yet here you are. Still here." },
    { user: "I thought you didn't care.",                        char: "I never said that. You assumed. There's a difference." },
    { user: "How long have you known?",                          char: "Long enough to decide it didn't change anything." },
    { user: "You're not what I expected.",                       char: "No one ever is. That's the point." },
    { user: "What happens now?",                                 char: "That depends entirely on what you do next." },
    { user: "You could have walked away.",                       char: "So could you." },
];

// ── Relationship roles + names for random fill ─────────────────────────────
const REL_ROLES = [
    'sister','brother','sibling','mother','father','parent','daughter','son','twin',
    'lover','ex-lover','rival','mentor','student','employer','servant','ally','enemy',
    'handler','ward','guard','captor','prisoner','partner','spouse','concubine',
    'childhood friend','estranged kin','sworn enemy','blood-bonded',
];

const REL_NAMES = [
    'Lyra','Vael','Seraph','Maren','Cassia','Isolde','Drex','Kira',
    'Aldric','Fen','Elowen','Sable','Rook','Thessaly','Corin',
    'Zahra','Ren','Vesna','Amara','Ciro','Vaëlith','Sorvaine','Mireth','Koravel',
];

// ── Positive-rephrase map (limits language → neutral/affirmative) ──────────
const POSITIVE_REPHRASES = new Map([
    ['no third parties',          'private one-on-one only'],
    ['no sharing',                'exclusive attention only'],
    ['no public situations',      'private spaces only'],
    ['no emotional attachment',   'casual detachment'],
    ['no recording',              'ephemeral and unrecorded'],
    ['not to be discussed later', 'kept unspoken afterward'],
    ['no degradation',            'respectful language only'],
    ['no humiliation',            'dignity preserved'],
    ['no pain',                   'comfort-focused'],
    ['no blood',                  'clean, bloodless intensity'],
    ['no non-con even fiction',   'clear consent only'],
    ['no restraints',             'free movement'],
    ['no surprise play',          'pre-negotiated play only'],
    ['nothing that leaves marks', 'unmarked skin afterward'],
    ['no breath play',            'steady breathing'],
    ['no marks',                  'pristine — unmarked'],
    ['none — alone',              'alone'],
    ['no visible pupil',          'pupilless'],
    ['no cycle',                  'acyclical'],
    ['cannot be hidden',          'always visible'],
    ['nothing permanent',         'temporary only'],
]);

// ═══════════════════════════════════════════════════════════════════════════
// KW_DATA — every field is a keyword chip block
// ═══════════════════════════════════════════════════════════════════════════
const KW_DATA = {

    // ── IDENTITY ────────────────────────────────────────────────────────────
    pronouns: { label:'Pronouns', limit:1, random:['she/her','he/him','they/them','xe/xem'], groups:[
        { g:'Standard',  i:['she/her','he/him','they/them','any/all'] },
        { g:'Alternate', i:['she/they','he/they','xe/xem','fae/faer','it/its','ey/em'] },
    ]},

    species: { label:'Species / Race', limit:3, random:['Human','Half-elf','Tiefling','Succubus','Kitsune','Naga','Dragonborn','Vampire','Lamia'], groups:[
        { g:'Humanoid',         i:['Human','Elf','Dark elf','Half-elf','Dwarf','Halfling','Orc','Goblin','Gnome'] },
        { g:'Fiend / Divine',   i:['Tiefling','Aasimar','Succubus','Incubus','Demon','Devil','Angel','Celestial','Seraph'] },
        { g:'Beastkin',         i:['Kitsune','Werewolf','Harpy','Minotaur','Naga','Lamia','Merfolk','Centaur','Selkie','Tabaxi'] },
        { g:'Draconic',         i:['Dragonborn','Dragon (humanoid)','Wyvern-kin','Dragonkin','Kobold'] },
        { g:'Undead / Construct',i:['Vampire','Lich','Revenant','Construct','Android','Synthetic','Golem'] },
        { g:'Eldritch',         i:['Eldritch entity','Void-touched','Star-born','Aberration','Lovecraftian horror'] },
        { g:'Bloodline tag',    i:['pureblooded','halfblood','mixed heritage','cursed bloodline','divine lineage','forbidden hybrid'] },
    ]},

    // +10 new roles spread across existing groups and a new Specialist group
    role: { label:'Role / Class', limit:2, random:['Assassin','Scholar','Knight','Witch','Courtesan','Gladiator','Spy','Oracle','Ranger'], groups:[
        { g:'Combat',      i:['Knight','Gladiator','Soldier','Ranger','Paladin','Warlord','Mercenary','Bodyguard','Berserker','Duelist',
                               'Sellsword','Pit fighter','Demon hunter'] },
        { g:'Arcane',      i:['Witch','Enchanter','Necromancer','Artificer','Druid','Sorcerer','Blood mage','Warlock','Illusionist',
                               'Summoner','Runecaster'] },
        { g:'Rogue / Social',i:['Assassin','Spy','Bard','Courtesan','Merchant','Thief','Con artist','Fence','Smuggler',
                               'Shadow dancer','Puppeteer','Pirate captain'] },
        { g:'Knowledge',   i:['Scholar','Oracle','Healer','Sailor','Corsair','Monk','Explorer','Slave','Noble','Hunter','Cultist','Inquisitor',
                               'Plague doctor','Alchemist'] },
    ]},

    background: { label:'Background', limit:4, random:['noble-born','sole survivor','temple exile','escaped experiment','fallen noble','street-raised','fugitive','ex-soldier'], groups:[
        { g:'Origins',      i:['noble-born','street-raised','monastery-trained','military-bred','slave-born','wilderness-raised','court-educated','self-taught','criminal-raised','brothel-raised'] },
        { g:'Trauma',       i:['sole survivor','war veteran','escaped captivity','former slave','betrayed','exiled','cast out','cursed','sacrificed and returned','experimented on'] },
        { g:'Secrets',      i:['hidden identity','false name','fugitive','double agent','prophecy subject','chosen one — rejected it','carrying a debt','marked by a god','wanted dead'] },
        { g:'Current status',i:['hunted','indebted','in disguise','in hiding','on a mission','on the run','under surveillance'] },
    ]},

    // ── PHYSICAL ────────────────────────────────────────────────────────────
    build: { label:'Build', limit:5, random:['slender','athletic','curvaceous','muscular','petite','heavyset'], groups:[
        { g:'Type',      i:['petite','slender','lithe','willowy','slight','wiry','lanky'] },
        { g:'Athletic',  i:['toned','athletic','lean-muscular','compact-muscular','swimmer\'s build','runner\'s build'] },
        { g:'Full',      i:['curvaceous','voluptuous','full-figured','soft and round','heavyset','stocky','beefy','powerfully built'] },
        { g:'Modifier',  i:['androgynous','deceptively strong','soft-looking but strong','broad-shouldered','wide-hipped','narrow-waisted','top-heavy','bottom-heavy'] },
        { g:'Condition', i:['battle-scarred body','malnourished','honed to precision','softened by comfort','overworked'] },
    ]},

    height: { label:'Height', limit:2, random:["4'10\" — tiny","5'4\" — petite","5'7\" — average","5'10\" — tall","6'1\" — statuesque","6'5\" — imposing","7'0\" — towering"], groups:[
        { g:'Short',   i:["4'6\"","4'8\"","4'10\"","5'0\"","5'2\"","5'4\""] },
        { g:'Average', i:["5'5\"","5'6\"","5'7\"","5'8\"","5'9\""] },
        { g:'Tall',    i:["5'10\"","6'0\"","6'2\"","6'4\"","6'6\"","6'8\"","7'0\"","7'6\""] },
        { g:'Tag',     i:['tiny','petite','short','average height','tall','statuesque','towering','looming'] },
    ]},

    skin: { label:'Skin', limit:5, random:['porcelain','warm ivory','honey-golden','sun-bronzed','rich brown','deep ebony','ashen grey','violet-tinged'], groups:[
        { g:'Light',   i:['porcelain','alabaster','fair','warm ivory','peach','rose-tinted'] },
        { g:'Medium',  i:['honey-golden','sun-bronzed','tawny','olive','warm brown','sand'] },
        { g:'Dark',    i:['rich brown','dark brown','deep ebony','mahogany','deep umber'] },
        { g:'Unusual', i:['ashen grey','cool blue-grey','pale silver','deep blue','violet-tinged','pitch-black','iridescent','corpse-pale','rust-red','chalk white'] },
        { g:'Texture', i:['smooth','freckled','mole-dusted','weathered','callused','papery','delicate'] },
        { g:'Quality', i:['luminous','matte','faintly iridescent','warm to touch','unnaturally cool','glows faintly','veins faintly visible'] },
    ]},

    hair: { label:'Hair', limit:6, random:['raven black','silver-white','blood red','honey blonde','deep auburn','pale platinum','electric blue'], groups:[
        { g:'Colour',  i:['raven black','dark brown','chestnut','auburn','red','fiery orange','honey blonde','golden blonde','platinum blonde','silver-white','steel grey','white','rose gold','electric blue','forest green','deep violet','midnight purple','two-toned','root-fade','streaked'] },
        { g:'Length',  i:['shaved','stubble','very short','cropped','chin-length','jaw-length','shoulder-length','collarbone-length','mid-back','waist-length','hip-length','floor-length'] },
        { g:'Style',   i:['loose','wavy','curly','tightly coiled','coily','straight','braided close','braided loose','half-up','pinned up','ponytail','high bun','messy bun','wild and unkempt','undercut','shaved sides'] },
        { g:'Texture', i:['fine','thick','coarse','silky','wiry','fluffy','voluminous','limp','wispy','dense'] },
        { g:'Modifier',i:['adorned with beads','adorned with pins','oiled','bleached ends','two-toned tips'] },
    ]},

    eyes: { label:'Eyes', limit:4, random:['amber','violet','silver','gold','pale grey','emerald','deep brown','void-black','crimson'], groups:[
        { g:'Colour',      i:['amber','honey','gold','copper','hazel','green','emerald','teal','turquoise','pale blue','steel blue','grey','silver','lilac','violet','purple','red','crimson','dark brown','near-black','black','white','colourless'] },
        { g:'Pupil shape', i:['round','vertical slit','horizontal slit','cross-shaped','star-shaped','keyhole','multi-ringed','no visible pupil','always dilated','always pinpoint'] },
        { g:'Quality',     i:['glowing faintly','luminous','bioluminescent','heterochromatic','dark limbal ring','gold limbal ring','unusually large','unusually small','ancient-looking','never quite focusing','too-aware'] },
    ]},

    face: { label:'Face', limit:5, random:['sharp jawline','full lips','high cheekbones','strong nose','soft features','angular'], groups:[
        { g:'Shape',      i:['oval','round','square','heart','diamond','triangular','long','angular','narrow'] },
        { g:'Features',   i:['high cheekbones','sharp jawline','strong jaw','soft jaw','full lips','thin lips','bow lips','wide mouth','small mouth','aquiline nose','button nose','broad nose','snub nose','strong brow','delicate brow','prominent ears'] },
        { g:'Expression', i:['resting stern','habitually smirking','perpetually tired','intensely focused','unreadable','surprisingly soft','too-blank','too-perfect','deceptively open'] },
        { g:'Detail',     i:['dimples','cleft chin','beauty mark','pronounced canines','filed teeth','fangs','gap in teeth','too many teeth'] },
    ]},

    marks: { label:'Marks / Tattoos / Piercings', limit:8, random:['scar across cheek','ritual brands on wrists','vine tattoo on back','pierced ears','no marks'], groups:[
        { g:'Scars',     i:['scar — cheek','scar — over eye','scar — lip','scar — throat','scar — chest','scar — abdomen','burn scars','ritual scarification','whip scars — back','claw marks','bite scar — neck','surgical scar','brand — ownership','brand — punishment'] },
        { g:'Tattoos',   i:['vine tattoo — back','sleeve — arm','chest piece','back piece','neck tattoo','face tattoo — small','face tattoo — significant','ritual sigils','geometric — coverage','script — unknown language','single small tattoo'] },
        { g:'Piercings', i:['pierced ears — simple','pierced ears — multiple','industrial piercing','nose ring','septum ring','eyebrow bar','lip ring','labret','tongue stud','tongue ring','nipple piercings — bars','nipple piercings — rings','navel ring','intimate piercings'] },
        { g:'Natural',   i:['birthmark — small','birthmark — large','beauty mark — face','vitiligo patches','freckle cluster','mole cluster'] },
        { g:'Modifier',  i:['pristine — no marks','lightly marked','heavily marked','ritual origin','fresh — still healing','self-inflicted'] },
    ]},

    scent: { label:'Scent / Aura', limit:4, random:['sandalwood','dark roses','citrus','vanilla and sweat','iron and pine','incense'], groups:[
        { g:'Warm',         i:['sandalwood','amber','vanilla','honey','cinnamon','cedar','tobacco','leather','smoke','beeswax','warm skin'] },
        { g:'Cool / Sharp', i:['citrus','ozone','petrichor','rain','pine','mint','cold stone','sea salt','clean linen'] },
        { g:'Dark',         i:['blood and iron','incense','old books','ash','brimstone','damp earth','copper','something wrong'] },
        { g:'Modifier',     i:['something feral underneath','something sweet underneath','barely-there','overwhelming','shifts with mood','intoxicating','aphrodisiac effect','wrong — somehow too good'] },
    ]},

    nonhuman: { label:'Non-Human Features', limit:18, random:[], groups:[
        { g:'Draconic / Reptilian', i:['scales — spine only','scales — full back','scales — patches','scales — full body','iridescent scales','metallic scales','obsidian horns','swept-back horns','curved horns','multiple horns','leathery wings','membrane wings','prehensile tail','barbed tail','tail — whip-thin','slit pupils','retractable claws','forked tongue','secondary eyelids','heat breath','acid spit'] },
        { g:'Fae / Elven',          i:['long pointed ears','short pointed ears','mobile pointed ears','gossamer wings','butterfly wings','moth wings','bioluminescent markings','glamour aura','luminous skin','too-perfect symmetry','ageless face','moves without sound'] },
        { g:'Demon / Infernal',     i:['ram horns — ridged','short curved horns','straight horns','multiple horns','whip tail — pointed','barbed infernal tail','cloven hooves','digitigrade hooves','solid flame eyes','burning sigils — skin','shadow aura','skin radiates heat','skin unnaturally cold','split tongue','fangs — upper','fangs — lower'] },
        { g:'Beastkin / Anthro',    i:['fur — full body','fur — partial','patterned fur','spotted fur','striped fur','animal ears — mobile','cat ears','wolf ears','fox ears','rabbit ears','short muzzle','elongated muzzle','digitigrade legs — paw','padded paws','bushy tail','multiple tails','whiskers','exposed fangs','pheromone glands'] },
        { g:'Aquatic',              i:['gills — neck','gills — ribcage','fin-like ears','bioluminescent patches','scales — lower body only','webbed fingers','dorsal fin','tail fin instead of legs','tentacle hair'] },
        { g:'Eldritch / Aberrant',  i:['extra eyes — two','extra eyes — four','extra eyes — asymmetric','tentacles — x2','tentacles — x4','tentacles — x6','tentacles — from back','tentacles — from mouth','void-dark skin — star-flecked','translucent skin','dislocating jaw','too many teeth','too many joints','wrong shadow — independent','never blinks','no reflection'] },
        { g:'Modifier',             i:['can partially suppress','can fully suppress','fluctuates with emotion','more prominent when aroused','more prominent under threat','cannot be hidden','glows in darkness'] },
    ]},

    // ── PERSONALITY ─────────────────────────────────────────────────────────
    // replaces archetype — single main personality type, concise labels
    personality: { label:'Personality', limit:1, random:['tsundere','yandere','motherly','cold','bratty','obsessive','aloof','playful'], groups:[
        { g:'Tropes',      i:['tsundere','yandere','kuudere','dandere','deredere','sadodere','himedere','undere'] },
        { g:'Temperament', i:['cold','aloof','warm','nurturing','motherly','cheerful','melancholic','volatile','serene','fierce','stoic','dramatic'] },
        { g:'Social',      i:['dominant','submissive','flirtatious','reserved','playful','serious','blunt','charming','devious','naive'] },
        { g:'Edge',        i:['obsessive','manipulative','deceptive','ruthless','unstable','feral','unhinged','vindictive','sadistic','masochistic'] },
    ]},

    disposition: { label:'Disposition', limit:3, random:['cold','guarded','teasing','predatory','aloof'], groups:[
        { g:'Manner',        i:['cold','warm','guarded','open','aloof','distant','attentive','distracted','measured','erratic'] },
        { g:'Mood',          i:['melancholic','content','restless','tense','volatile','serene','wary','hungry','amused','bored'] },
        { g:'Toward player', i:['possessive','protective','hostile','curious','indifferent','fond','resentful','fascinated','fixated','dismissive'] },
    ]},

    traits: { label:'Traits & Quirks', limit:10, random:['bratty','naive','clingy','secretly soft','teasing','smug'], groups:[
        { g:'Demeanor',  i:['bratty','motherly','naive','clingy','possessive','jealous','protective','vindictive','prideful','meek','petulant','smug','needy','cold'] },
        { g:'Behavior',  i:['secretly soft','easily flustered','compulsive liar','brutally honest','people-pleaser','self-destructive','emotionally distant','emotionally intense','fiercely loyal','deeply empathetic'] },
        { g:'Sexuality', i:['sexually deviant','touch-starved','voyeuristic','exhibitionistic','kink-curious','shame-free','easily tempted','hard to tempt'] },
        { g:'Quirks',    i:['obsessive','controlling','reckless','calculating','impulsive','nihilistic','self-sabotaging','masochistic','sadistic'] },
        { g:'Social',    i:['charming','caustic','earnest','sarcastic','teasing','stoic','dramatic','awkward','gracious','cutting'] },
        { g:'Complex',   i:['secretly kind','openly cruel','quietly resentful','aggressively self-reliant','disturbingly patient','chronically flirtatious'] },
    ]},

    skills: { label:'Skills', limit:7, random:['combat — blades','seduction','deception','tracking','stealth'], groups:[
        { g:'Combat',         i:['combat — unarmed','combat — blades','combat — polearms','combat — improvised','archery','dual-wielding','siege weapons'] },
        { g:'Magic',          i:['magic — elemental','magic — arcane','magic — blood','magic — illusion','divine channelling','necromancy','shapeshifting','bardic magic','binding'] },
        { g:'Social',         i:['seduction','persuasion','intimidation','deception','manipulation','performance','disguise','negotiation'] },
        { g:'Physical',       i:['stealth','tracking','acrobatics','climbing','swimming','riding — horse','riding — beast','parkour'] },
        { g:'Knowledge',      i:['healing','alchemy','linguistics','navigation','forgery','lockpicking','poisons','cartography'] },
        { g:'NSFW / Intimate',i:['oral mastery','deep throat','edging','orgasm denial','overstimulation','rope bondage','impact play','sensory play','erotic massage','dirty talk expert','seduction mastery','breath play','prostate stimulation','nipple play','multiple orgasm induction','squirt induction','scene negotiation','aftercare','strip tease','vocal performance'] },
    ]},

    // ── ANATOMY ─────────────────────────────────────────────────────────────
    chest: { label:'Chest / Breasts', limit:8, random:['breasts','medium','natural','soft','sensitive'], groups:[
        { g:'Type',         i:['breasts','flat chest','pectoral — flat and muscular','gynecomastic — soft and full','chest — ambiguous'] },
        { g:'Size',         i:['barely there','very small','small','medium','large','very large','huge','enormous','magically variable'] },
        { g:'Cup (approx)', i:['AA-cup','A-cup','B-cup','C-cup','D-cup','DD/E-cup','F-cup','G-cup','H-cup+'] },
        { g:'Shape',        i:['perky','teardrop','round','conical','pendulous','sagging','widely spaced','close-set','high-set','low-set','asymmetric'] },
        { g:'Texture / Feel',i:['soft','firm','pillowy','dense','plush','heavy','warm'] },
        { g:'Skin',         i:['smooth','freckled','stretch-marked','veins faintly visible','scarred'] },
        { g:'Modifier',     i:['hypersensitive','near-insensitive','lactating','leaking','perpetually tender','tattooed','pierced'] },
    ]},

    nipples: { label:'Nipples', limit:6, random:['rose-pink','small','sensitive'], groups:[
        { g:'Colour',  i:['pale pink','rose-pink','dusty pink','peach','coral','dark rose','brown','dark brown','deep red','crimson','dusky purple','near-black','matches skin','strongly contrasts skin'] },
        { g:'Size',    i:['tiny','small','average','large','very large','outsized'] },
        { g:'Shape',   i:['flat','small and precise','protruding — average','protruding — significantly','puffy areola','puffy nipple','inverted — slight','inverted — deep','elongated — tubular'] },
        { g:'Areola',  i:['small areola','average areola','large areola','very large areola','smooth','bumpy texture'] },
        { g:'State',   i:['perpetually erect','quick to harden','slow to respond','responsive to breath alone','responsive to fabric'] },
        { g:'Modifier',i:['pierced — bar','pierced — ring','pierced — captive bead','pierced — multiple','hypersensitive','near-insensitive','leaking','asymmetric'] },
    ]},

    'genitalia-a': { label:'Primary Genitalia', limit:12, random:[], groups:[
        { g:'—— Vaginal ——',     i:['vagina'] },
        { g:'Vaginal: Labia',    i:['outer labia — full','outer labia — slim','outer labia — puffy','outer labia — long','inner labia — tucked','inner labia — protruding','inner labia — prominent','inner labia — very long','asymmetric labia'] },
        { g:'Vaginal: Clitoris', i:['clitoris — small','clitoris — average','clitoris — large','clitoris — very large','clitoris — hooded','clitoris — exposed','clitoris — pierced'] },
        { g:'Vaginal: Interior', i:['extremely tight','very tight','tight','average tightness','accommodating','elastic','gripping walls','ridged interior','smooth interior','velvety interior','textured — pronounced'] },
        { g:'Vaginal: Depth',    i:['shallow','average depth','deep','very deep','magically adaptive'] },
        { g:'—— Penile ——',      i:['penis'] },
        { g:'Penile: Type',      i:['humanoid penis','equine penis','canine penis — knotted','feline penis — barbed','draconic penis','tentacle cock','ovipositor','bifurcated penis','hemipenes'] },
        { g:'Penile: Length',    i:['small — 4in','modest — 5in','average — 6in','above average — 7in','large — 8in','impressive — 9in','huge — 10in','enormous — 12in','massive — 14in+','magically variable'] },
        { g:'Penile: Girth',     i:['slender','slim','average girth','thick','very thick','girthy','obscene girth','tapers toward tip','widens toward base'] },
        { g:'Penile: Shape',     i:['smooth','slightly curved up','pronounced curve up','pronounced curve down','ridged — light','ridged — pronounced','ribbed','knotted — one','knotted — multiple','medial ring','flared tip','tapered tip','blunt tip','pointed tip','barbed — light','barbed — pronounced','bifurcated tip','foreskinned'] },
        { g:'—— Other ——',       i:['futanari — both','smooth — featureless','cloaca','slit','tentacle cluster'] },
        { g:'Colour / Appearance',i:['matches skin','slightly darker','much darker','pink','deep rose','flushed red','purple','blue','non-human colour','bioluminescent','patterned'] },
        { g:'Modifier',          i:['self-lubricating','always ready','bioluminescent arousal flush','warms on arousal','pheromone-producing','magically enhanced','aphrodisiac fluids','unusually warm','unusually cold'] },
    ]},

    'genitalia-b': { label:'Secondary Genitalia (optional)', limit:8, random:[], groups:[
        { g:'Vaginal', i:['vagina','outer labia — full','outer labia — slim','inner labia — protruding','clitoris — small','clitoris — large','very tight','accommodating'] },
        { g:'Penile',  i:['penis','humanoid penis','equine penis','canine penis — knotted','ovipositor','tentacle cock'] },
        { g:'Length',  i:['small — 4in','average — 6in','large — 8in','huge — 10in'] },
        { g:'Girth',   i:['slender','average girth','thick','girthy'] },
        { g:'Shape',   i:['ridged','knotted','medial ring','flared tip','tapered tip','barbed','bifurcated'] },
        { g:'Modifier',i:['self-lubricating','bioluminescent','pheromone-producing','unusually warm'] },
    ]},

    rear: { label:'Rear / Backside', limit:6, random:['round','full','firm','heart-shaped'], groups:[
        { g:'Size',    i:['flat','small','modest','round','full','large','very large','enormous'] },
        { g:'Shape',   i:['perky','heart-shaped','wide','narrow','high','low','shelf-like','spreading'] },
        { g:'Feel',    i:['firm','soft','pillowy','toned','dimpled','smooth','plush'] },
        { g:'Hips',    i:['narrow hips','average hips','wide hips','very wide hips','dramatically wide'] },
        { g:'Modifier',i:['tattooed','pierced — surface','stretch-marked','scarred','marked'] },
    ]},

    pubic: { label:'Pubic Hair', limit:3, random:['bare','neatly trimmed','natural'], groups:[
        { g:'Style',   i:['bare — smooth','neatly trimmed — short','trimmed — medium','landing strip — thin','landing strip — wide','triangle patch','natural — full','lush and unkempt','decorative shaved pattern'] },
        { g:'Colour',  i:['matches hair exactly','slightly darker than hair','contrasts hair completely','bleached','dyed different colour'] },
        { g:'Texture', i:['soft','coarse','silky','wiry','sparse','dense'] },
    ]},

    anal: { label:'Anal', limit:6, random:['tight','unused','sensitive'], groups:[
        { g:'Tightness',   i:['extremely tight','tight','average','relaxed','loose — trained','elastic'] },
        { g:'Experience',  i:['unused','inexperienced','some experience','experienced','very experienced','well-trained','stretched'] },
        { g:'Sensitivity', i:['hypersensitive','very sensitive','average sensitivity','low sensitivity','near-insensitive'] },
        { g:'Appearance',  i:['puckered — prominent','puckered — subtle','smooth','flushed','darker than surrounding','visually inviting'] },
        { g:'Modifier',    i:['pierced — ring','pierced — jewel','decorated','tattooed nearby','magically adaptive'] },
    ]},

    fluids: { label:'Lubrication / Fluids', limit:6, random:['natural average','clear','light scent','thin'], groups:[
        { g:'Volume',    i:['barely any','minimal','natural average','generous','excessive','floods easily','squirts','gushes'] },
        { g:'Colour',    i:['clear','slightly opaque','milky white','pearl-white','bioluminescent — blue','non-human colour','golden tinted'] },
        { g:'Scent',     i:['odourless','light — pleasant','sweet','musky','sharp','intoxicating','mild aphrodisiac'] },
        { g:'Texture',   i:['watery','thin and slick','average','thick','viscous','honey-thick'] },
        { g:'Cum / Seed',i:['cum — watery','cum — thick','cum — very thick','cum — large volume','cum — enormous volume','cum — unusual colour','cum — sweet','cum — aphrodisiac','cum — glows'] },
        { g:'Modifier',  i:['self-lubricating','always wet','lubricates on proximity','magical properties'] },
    ]},

    fertility: { label:'Fertility / Reproductive', limit:4, random:['fertile','regular cycle'], groups:[
        { g:'Status', i:['fertile','highly fertile','magically fertile','in heat — constant','in heat — cyclical','breeding season','suppressed','infertile','unknown'] },
        { g:'Cycle',  i:['regular cycle','irregular cycle','no cycle','heat cycle — monthly','heat cycle — seasonal','heat cycle — random'] },
        { g:'Eggs',   i:['produces eggs','oviparous','lays eggs — small','lays eggs — large','clutch layer'] },
        { g:'Modifier',i:['body shows fertility visibly','desperately fertile','aware of their cycle','unaware of their cycle'] },
    ]},

    erogenous: { label:'Erogenous Zones', limit:8, random:['nape of neck','inner thighs','chest'], groups:[
        { g:'Head / Neck', i:['nape of neck','sides of neck','throat','behind ears','scalp','ears','earlobes','jaw'] },
        { g:'Torso',       i:['collarbone','shoulders','upper chest','sternum','nipples','sides of ribcage','small of back','lower back','stomach','hips','waist'] },
        { g:'Limbs',       i:['inner wrists','inner elbows','inner thighs','backs of knees','ankles','feet — soles','fingers'] },
        { g:'Intimate',    i:['outer labia','clitoris','vaginal entrance','perineum','frenulum','shaft — base','shaft — tip','testicular area'] },
        { g:'Non-human',   i:['tail base','horn base','ear tips — fantasy','wing joints','scale patch','tentacle roots','gill slits'] },
    ]},

    bodymod: { label:'Body / Other Notes', limit:6, random:[], groups:[
        { g:'Unusual',       i:['always warm to touch','always cool to touch','bioluminescent flush when aroused','marks easily','heals rapidly','unusually flexible','double-jointed','purrs during pleasure'] },
        { g:'Non-human body',i:['down feathers — shoulders','scales along inner thighs','gills flush when aroused','pheromone glands active','natural musk','venom — non-lethal','chirps non-verbally'] },
        { g:'Modification',  i:['magically augmented','surgically altered','ritually transformed','cybernetically enhanced','size-shifting','shape-shifting — limited'] },
    ]},

    // ── SEXUAL ──────────────────────────────────────────────────────────────
    experience: { label:'Experience Level', limit:2, random:['experienced and confident','some experience'], groups:[
        { g:'Level', i:['virgin — untouched','inexperienced — theoretical only','curious but cautious','some experience — limited','some experience — varied','experienced and confident','highly experienced','exquisitely trained','professionally skilled','ancient and limitless'] },
    ]},

    sexrole: { label:'Role Preference', limit:3, random:['dominant top','versatile switch'], groups:[
        { g:'Role',      i:['dominant top','dominant — service top','submissive bottom','submissive — pillow princess','versatile switch','tends dominant','tends submissive','service-oriented','prey — hunted','predatory — hunter','caretaker','brat — resistant','brat — secretly eager','worshipper','exhibitionist','voyeur'] },
        { g:'+10 added', i:['soft dom','hard dom','power bottom','stone top','pillow queen','reluctant dominant','willing prey','cnc top','cnc bottom','praise addict'] },
    ]},

    verbal: { label:'Verbal Style', limit:3, random:['vocal and uninhibited','soft moans'], groups:[
        { g:'Volume',  i:['silent — expression only','barely audible','soft','moderate','loud','very loud','completely uninhibited'] },
        { g:'Style',   i:['gasping','soft moans','whimpering','pleading','begging','growling','rumbling — non-human','filthy talk','commands','praise-giving','sweet and affectionate','taunting','crying — from overwhelm'] },
        { g:'Content', i:['name-saying — fixated','possessive language','affectionate terms','degrading language','worshipful language','dirty narration'] },
    ]},

    // +10 new kinks spread across existing and a new Sensory-play group
    kinks: { label:'Kinks / Fetishes', limit:14, random:['bondage','praise kink','size difference','power exchange'], groups:[
        { g:'Power',          i:['dominance','submission','power exchange','complete control','total service','ownership','collaring','leashing','discipline','punishment','edging','orgasm control','orgasm denial — extended','forced orgasm'] },
        { g:'Sensation',      i:['pain — light','pain — heavy','temperature play','impact — spanking','impact — flogging','impact — paddle','restraint — rope','restraint — cuffs','restraint — magical','sensory deprivation','overstimulation','tickling','wax play','featherlight teasing'] },
        { g:'Rope / Bondage', i:['rope art (shibari)','rope — decorative','rope — functional','column ties','suspension — partial','mirror play'] },
        { g:'Body',           i:['body worship','size difference — small/large','weight play','strength play','muscle','softness','scent fixation','scent marking','taste fixation','feet','hands','mouth focus','throat','claiming / biting'] },
        { g:'Exhibition',     i:['voyeurism','exhibitionism','public play','semi-public','performance','recording','observed by multiple'] },
        { g:'Psychological',  i:['praise kink','degradation','humiliation — light','humiliation — heavy','pet play','corruption','mind break — gradual','mind control','hypnosis','obsession','aftercare fixation'] },
        { g:'Explicit content',i:['breeding','impregnation','pregnancy play','lactation','somnophilia','sleep play','dubcon','non-con (fiction)','cnc','monsterfucking','tentacles','multiple partners','gangbang','spit-roasting','double penetration','triple penetration','size impossible'] },
        { g:'Non-human',      i:['oviposition','egg-laying','transformation','body horror — erotic','eldritch sex','possession','soul-bonding'] },
    ]},

    likes: { label:'Likes', limit:8, random:['being complimented','rough handling','being watched','slow teasing'], groups:[
        { g:'Gentle',  i:['being complimented','gentle touching','slow undressing','being held','soft kissing','being looked at','whispered words','aftercare','being bathed','tender attention'] },
        { g:'Intense', i:['rough handling','being held down','hair-pulling','being bitten','being marked — bruised','being overpowered','being overwhelmed'] },
        { g:'Dynamic', i:['taking control','being controlled','eye contact — sustained','dirty talk','being praised mid-act','unexpected tenderness after intensity','being narrated to'] },
        { g:'Context', i:['being the only one','being chosen specifically','being wanted desperately','being irreplaceable','worship','feeling powerful','feeling helpless'] },
    ]},

    limits: { label:'Hard Limits', limit:6, random:['no emotional attachment','no blood','nothing permanent'], groups:[
        { g:'Social',   i:['no third parties','no sharing','no public situations','no emotional attachment','no recording','not to be discussed later'] },
        { g:'Content',  i:['no degradation','no humiliation','no pain','no blood','no non-con even fiction','no restraints','no surprise play','nothing that leaves marks','no breath play'] },
        { g:'Modifier', i:['hard limit — non-negotiable','soft limit — can discuss','limit for now — may change'] },
    ]},

    requires: { label:'Requires', limit:4, random:['to lead','verbal acknowledgment','to be needed'], groups:[
        { g:'Power',    i:['to lead','to be led','to hold control','to surrender control','to give permission','to be given permission','to push back and be pushed back against'] },
        { g:'Emotional',i:['to be needed','to be chosen','to be seen accurately','to be the only one','verbal acknowledgment','to be trusted with something real','to matter to someone'] },
        { g:'Physical', i:['physical contact','being touched first','being the one to touch','proximity — close','personal space respected','to be undone slowly','to give as much as they take'] },
        { g:'Dynamic',  i:['tension without release','the upper hand','reciprocity','the last word','to be surprised','to understand before acting','earned intimacy only'] },
    ]},

    triggers: { label:'Arousal Triggers', limit:5, random:['sustained eye contact','voice — low and close','being watched','rough hands'], groups:[
        { g:'Sensory',     i:['sustained eye contact','being watched intently','voice — low and close','voice — commanding','breath on skin','rough hands','cold hands','proximity heat','being undressed slowly','fabric on skin','sudden stillness','deliberate slowness','weight on them','fingers in hair','nails on skin'] },
        { g:'Situational', i:['shift in power','being chosen','being needed','feeling exposed','someone losing composure','being studied','being cornered','unexpected tenderness','vulnerability shown','danger nearby','being the only one','long silence broken','being caught wanting','being undone slowly'] },
        { g:'Verbal',      i:['being spoken to gently','being spoken to harshly','praise','commands','specific words','own name said a certain way'] },
    ]},

    // ── SCENE BRIEF ──────────────────────────────────────────────────────────
    // Tension type and relationship history chips; other brief fields (setting,
    // situation, opening beat, stakes) are handled as write-ins in the HTML.
    tension: { label:'Tension Type', limit:2, random:['Forbidden','Aftermath'], groups:[
        { g:'Tension', i:['Forbidden','Desperate','Aftermath','Ceremonial','Liminal','Discovery','Standoff','Pursuit','Surrender','Negotiation'] },
    ]},

    relationship: { label:'Relationship History', limit:1, random:['Strangers'], groups:[
        { g:'Relationship', i:['Strangers','Rivals','Estranged','Former lovers','Long acquaintance','Captor and captive','Employer and agent','Owed a debt','Chosen enemies','Bound by oath'] },
    ]},

    // ── STYLE ────────────────────────────────────────────────────────────────
    pov: { label:'Point of View', limit:1, random:['Second person (you)'], groups:[
        { g:'POV', i:['Second person (you)','First person (I)','Third limited','Third omniscient'] },
    ]},

    tense: { label:'Tense', limit:1, random:['Present'], groups:[
        { g:'Tense', i:['Present','Past'] },
    ]},

    rhythm: { label:'Sentence Rhythm', limit:2, random:['short punchy sentences','varied, literary'], groups:[
        { g:'Rhythm', i:['short punchy sentences','long flowing prose','varied, literary','terse and clipped','lyrical and poetic','staccato, fragmented','stream of consciousness'] },
    ]},

    vocab: { label:'Vocabulary', limit:1, random:['mid-register'], groups:[
        { g:'Level', i:['casual / accessible','mid-register','elevated / literary','archaic / formal','raw / vulgar','clinical and precise'] },
    ]},

    pacing: { label:'Pacing', limit:1, random:['variable, mirrors tension'], groups:[
        { g:'Pacing', i:['slow and deliberate','moderate, scene-driven','fast-paced, urgent','variable, mirrors tension','agonizingly slow'] },
    ]},

    descfocus: { label:'Description Focus', limit:5, random:['physical sensation','visual detail','power dynamics'], groups:[
        { g:'Focus', i:['physical sensation','visual detail','sound and texture','scent and taste','emotional interiority','body language','environmental atmosphere','power dynamics','dialogue and subtext','raw physical action','anatomy focus','psychological state'] },
    ]},
};

// ── World lore presets ─────────────────────────────────────────────────────
const WORLD_LORE_PRESETS = [
    {
        name: "Khorvynn's Gate",
        subtitle: 'Free City · Island Trading Hub',
        keys: ["Khorvynn's Gate","Khorvynn","the Gate","the free city","the island","the crossing"],
        scenes: [
            { tag:'Neutral Ground',  hook:"The city exists precisely because both sides need a place where killing each other is bad for business. You use that." },
            { tag:'The Dungeon Calls',hook:"Everyone who stays long enough hears it — a sound beneath the stone, like the island is breathing. The dungeon isn't just deep. It knows you're there." },
            { tag:'Port Tensions',   hook:"Two ships in harbor, two flags that should mean war. Here they mean nothing. The harbormaster watches you all with the practiced calm of someone who's seen this end badly." },
        ],
        lore: `Khorvynn's Gate — Free City, neutral island between Rukarai and Vhastil.

Geography: A small island between two continents. Dense forest covers everything except the city itself. Traversable on foot in under an hour.

Status: Declared neutral territory by treaty — the only place where warring kingdoms of Rukarai and Vhastil may meet without weapons drawn.

Culture: Cosmopolitan melting pot. No dominant culture. Traditions from dozens of kingdoms coexist uneasily. Locals take pride in their studied neutrality.

Economy: Trading hub. The only reliable crossing between the continents. Merchants, diplomats, mercenaries, fugitives, and adventurers pass through constantly.

The Dungeon: At the island's center, beneath the oldest part of the city, is a dungeon with no mapped end. It appears to expand. Rooms shift. It has turned explorers back — or consumed them. Researchers believe it may be sapient. No one has reached its bottom.

Atmosphere: The city smells of salt, foreign spices, and old stone. Suspicious eyes, careful smiles. Everyone here is either neutral by policy or by necessity.`,
    },
];

// ═══════════════════════════════════════════════════════════════════════════
// COMMIT 3 — ENGINE: chip system, renderers, output builders, ST API, init
// ═══════════════════════════════════════════════════════════════════════════

// ── Runtime state ─────────────────────────────────────────────────────────
let _sceneMode     = 'erotic';
let _cardFormat    = 'prose';
let _explicitAnat  = false;
let _isFav         = false;
let _relationships = [];
let _loreEntries   = [];
let _dialoguePairs = [];
const KW_STATE     = {};
const _lockedBlocks = new Set();

// ── Generic helpers ───────────────────────────────────────────────────────
function pick(arr)      { return arr[Math.floor(Math.random() * arr.length)]; }
function g(id)          { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function cap(s)         { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function join(arr, sep) { return arr.join(sep || ', '); }
function escAttr(v)     { return String(v || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function positivePhrase(text) {
    if (!text) return '';
    let out = String(text).trim();
    const key = out.toLowerCase();
    if (POSITIVE_REPHRASES.has(key)) return POSITIVE_REPHRASES.get(key);
    out = out
        .replace(/\bcannot be hidden\b/gi, 'always visible')
        .replace(/\bcan't be hidden\b/gi,  'always visible')
        .replace(/\bno visible pupil\b/gi,  'pupilless')
        .replace(/\bno marks\b/gi,          'pristine — unmarked')
        .replace(/\bno cycle\b/gi,          'acyclical')
        .replace(/\bnothing permanent\b/gi, 'temporary only');
    return out;
}
function cleanList(arr)  { return arr.map(positivePhrase).filter(Boolean); }
function lowerJoin(arr)  { return cleanList(arr).map(v => String(v).toLowerCase()).join(', '); }
function nv(label, val)  { return val ? label + ': ' + val : null; }
function countTokens(t)  { return _getTokenCount(t); }

// ═══════════════════════════════════════════════════════════════════════════
// CHIP ENGINE
// ═══════════════════════════════════════════════════════════════════════════
function kwInit(key, containerId) {
    const cfg  = KW_DATA[key];
    if (!cfg) return;
    KW_STATE[key] = [];
    const wrap = document.getElementById(containerId);
    if (!wrap) return;

    const block    = document.createElement('div');
    block.className = 'forge-kw-block';

    const labelRow = document.createElement('div');
    labelRow.className = 'forge-kw-label';
    labelRow.innerHTML = `<span>${cfg.label}</span><button class="forge-dice-btn" onclick="FORGE.kwRandom('${key}')">⚄</button>`;
    block.appendChild(labelRow);

    const row   = document.createElement('div');
    row.className = 'forge-kw-row';
    row.id      = 'fkwr-' + key;
    block.appendChild(row);

    const addWrap   = document.createElement('div');
    addWrap.className = 'forge-kw-add-wrap';

    const addBtn    = document.createElement('span');
    addBtn.className = 'forge-kw-add';
    addBtn.innerHTML = '<span class="forge-kw-plus">+</span>add';
    addBtn.onclick   = (e) => { e.stopPropagation(); kwToggleDD(key); };
    addWrap.appendChild(addBtn);

    const dd    = document.createElement('div');
    dd.className = 'forge-kw-dropdown';
    dd.id       = 'fkwdd-' + key;

    const srchWrap   = document.createElement('div');
    srchWrap.className = 'forge-kw-dropdown-search';
    const srchInp    = document.createElement('input');
    srchInp.type        = 'text';
    srchInp.placeholder = 'search or type…';
    srchInp.id          = 'fkwsi-' + key;
    srchInp.oninput     = () => kwFilter(key);
    srchWrap.appendChild(srchInp);
    dd.appendChild(srchWrap);

    const itemsWrap   = document.createElement('div');
    itemsWrap.className = 'forge-kw-items-wrap';
    itemsWrap.id        = 'fkwii-' + key;
    cfg.groups.forEach(grp => {
        const gl   = document.createElement('div');
        gl.className = 'forge-kw-group-label';
        gl.textContent = grp.g;
        itemsWrap.appendChild(gl);
        grp.i.forEach(item => {
            const di   = document.createElement('div');
            di.className = 'forge-kw-item';
            di.dataset.v = item;
            di.textContent = item;
            di.onclick   = () => kwToggleItem(key, item);
            itemsWrap.appendChild(di);
        });
    });
    dd.appendChild(itemsWrap);

    const wi    = document.createElement('div');
    wi.className = 'forge-kw-writein';
    const wiInp = document.createElement('input');
    wiInp.type        = 'text';
    wiInp.placeholder = 'custom keyword…';
    wiInp.id          = 'fkwwi-' + key;
    wiInp.onkeydown   = (e) => { if (e.key === 'Enter') kwAddCustom(key); };
    const wiBtn = document.createElement('button');
    wiBtn.textContent = 'Add';
    wiBtn.onclick     = () => kwAddCustom(key);
    wi.appendChild(wiInp); wi.appendChild(wiBtn);
    dd.appendChild(wi);

    addWrap.appendChild(dd);
    row.appendChild(addWrap);
    wrap.appendChild(block);
}

function kwToggleDD(key) {
    document.querySelectorAll('.forge-kw-dropdown.open').forEach(d => {
        if (d.id !== 'fkwdd-' + key) d.classList.remove('open');
    });
    const dd = document.getElementById('fkwdd-' + key);
    if (!dd) return;
    dd.classList.toggle('open');
    if (dd.classList.contains('open')) {
        const si = document.getElementById('fkwsi-' + key);
        if (si) { si.value = ''; kwFilter(key); setTimeout(() => si.focus(), 40); }
    }
}

function kwFilter(key) {
    const q   = (document.getElementById('fkwsi-' + key)?.value || '').toLowerCase();
    const iw  = document.getElementById('fkwii-' + key);
    if (!iw) return;
    const cur = KW_STATE[key] || [];
    iw.querySelectorAll('.forge-kw-item').forEach(el => {
        const v = el.dataset.v || '';
        el.style.display = (!q || v.toLowerCase().includes(q)) ? '' : 'none';
        el.classList.toggle('selected', cur.includes(v));
    });
    iw.querySelectorAll('.forge-kw-group-label').forEach(gl => {
        let sib = gl.nextElementSibling, any = false;
        while (sib && !sib.classList.contains('forge-kw-group-label')) {
            if (sib.style.display !== 'none') any = true;
            sib = sib.nextElementSibling;
        }
        gl.style.display = any ? '' : 'none';
    });
}

function kwToggleItem(key, val) {
    const cur = KW_STATE[key] || [];
    if (cur.includes(val)) { kwRemove(key, val); return; }
    const cfg = KW_DATA[key];
    if (cfg.limit && cur.length >= cfg.limit) cur.shift();
    cur.push(val);
    KW_STATE[key] = cur;
    kwRender(key); kwFilter(key); regen();
}

function kwRemove(key, val) {
    const cur = KW_STATE[key] || [];
    const i   = cur.indexOf(val);
    if (i !== -1) cur.splice(i, 1);
    kwRender(key); kwFilter(key); regen();
}

function kwAddCustom(key) {
    const inp = document.getElementById('fkwwi-' + key);
    if (!inp) return;
    const val = inp.value.trim();
    if (!val) return;
    kwToggleItem(key, val);
    inp.value = '';
}

function kwRender(key) {
    const row = document.getElementById('fkwr-' + key);
    if (!row) return;
    const addWrap = row.querySelector('.forge-kw-add-wrap');
    Array.from(row.querySelectorAll('.forge-kw')).forEach(c => c.remove());
    (KW_STATE[key] || []).forEach(val => {
        const chip = document.createElement('span');
        chip.className = 'forge-kw';
        chip.innerHTML = `<span class="forge-kw-ob">[</span><span class="forge-kw-text">${escAttr(val)}</span><span class="forge-kw-cb">]</span><span class="forge-kw-x">×</span>`;
        chip.querySelector('.forge-kw-x').onclick = () => kwRemove(key, val);
        row.insertBefore(chip, addWrap);
    });
}

function kwRandom(key) {
    const cfg = KW_DATA[key];
    if (!cfg) return;
    KW_STATE[key] = [];
    const pool  = cfg.random?.length ? cfg.random : cfg.groups.flatMap(g => g.i);
    const count = Math.min(cfg.limit || 3, Math.max(1, Math.floor(Math.random() * 3) + 1));
    [...pool].sort(() => Math.random() - 0.5).slice(0, count).forEach(v => kwToggleItem(key, v));
}

function kwSet(key, vals) { KW_STATE[key] = []; vals.forEach(v => kwToggleItem(key, v)); }
function kwGet(key)       { return KW_STATE[key] || []; }

// ═══════════════════════════════════════════════════════════════════════════
// SECTION / SLIDER / TOGGLE HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function toggleSection(id) { document.getElementById(id)?.classList.toggle('collapsed'); }
function collapseAll()     { document.querySelectorAll('#forge-panel .forge-section').forEach(s => s.classList.add('collapsed')); }
function expandAll()       { document.querySelectorAll('#forge-panel .forge-section').forEach(s => s.classList.remove('collapsed')); }

function slv(id) {
    const el = document.getElementById(id + '-v');
    const sl = document.getElementById(id);
    if (el && sl) el.textContent = sl.value;
}
function toggleItem(el) { el.classList.toggle('active'); regen(); }
function getActiveToggles() {
    return Array.from(document.querySelectorAll('#forge-content-toggles .forge-toggle-item.active'))
                .map(t => t.querySelector('.forge-toggle-label')?.textContent?.trim())
                .filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENE ARCHETYPES + MODES
// ═══════════════════════════════════════════════════════════════════════════
function renderSceneArchetypes() {
    const c = document.getElementById('forge-scene-archetypes');
    if (!c) return;
    SCENE_ARCHETYPES.forEach(arch => {
        const card = document.createElement('div');
        card.className = 'forge-preset-card';
        card.innerHTML = `<div class="forge-preset-name">${arch.name}</div>`;
        card.onclick = () => {
            document.querySelectorAll('#forge-scene-archetypes .forge-preset-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            kwSet('tension',      [arch.tension]);
            kwSet('relationship', [arch.relationship]);
            const situationEl = document.getElementById('forge-scene-situation');
            if (situationEl) situationEl.value = arch.situation;
            regen();
        };
        c.appendChild(card);
    });
}

function renderSceneModes() {
    const c = document.getElementById('forge-scene-mode-grid');
    if (!c) return;
    SCENE_MODES.forEach(m => {
        const card = document.createElement('div');
        card.className   = 'forge-preset-card' + (m.mode === _sceneMode ? ' active' : '');
        card.dataset.mode = m.mode;
        card.innerHTML   = `<div class="forge-preset-tag">${m.tag}</div><div class="forge-preset-name">${m.name}</div>`;
        card.onclick     = () => {
            document.querySelectorAll('.forge-preset-card[data-mode]').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            _sceneMode = m.mode; regen();
        };
        c.appendChild(card);
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// RELATIONSHIPS
// ═══════════════════════════════════════════════════════════════════════════
function renderRelationships() {
    const c = document.getElementById('forge-relationships-list');
    if (!c) return;
    c.innerHTML = '';
    _relationships.forEach((rel, i) => {
        const row = document.createElement('div');
        row.className = 'forge-rel-row';
        row.innerHTML = `
            <span class="forge-rel-bracket">[</span>
            <input type="text" class="forge-rel-role-input" placeholder="sister, rival…" value="${escAttr(rel.role)}"
                   oninput="window._FR[${i}].role=this.value;FORGE.regen()" list="forge-rel-role-list">
            <span class="forge-rel-bracket">]</span>
            <span class="forge-rel-of">of</span>
            <input type="text" class="forge-rel-name-input" placeholder="character name…" value="${escAttr(rel.name)}"
                   oninput="window._FR[${i}].name=this.value;FORGE.regen()">
            <button class="forge-rel-remove" onclick="FORGE.removeRelationship(${rel.id})" title="Remove">×</button>`;
        c.appendChild(row);
    });
    if (!document.getElementById('forge-rel-role-list')) {
        const dl = document.createElement('datalist');
        dl.id = 'forge-rel-role-list';
        REL_ROLES.forEach(r => { const o = document.createElement('option'); o.value = r; dl.appendChild(o); });
        document.body.appendChild(dl);
    }
    window._FR = _relationships;
    regen();
}

function addRelationship(role, name) {
    _relationships.push({ id: Date.now(), role: role || '', name: name || '' });
    renderRelationships();
}
function removeRelationship(id) {
    _relationships = _relationships.filter(r => r.id !== id);
    renderRelationships();
}
function randomizeRelationships() {
    _relationships = [];
    const count = Math.floor(Math.random() * 3) + 1;
    for (let i = 0; i < count; i++) addRelationship(pick(REL_ROLES), pick(REL_NAMES));
}

// ═══════════════════════════════════════════════════════════════════════════
// WORLD INFO / LOREBOOK
// ═══════════════════════════════════════════════════════════════════════════
function addLore() {
    _loreEntries.push({ id: Date.now(), keyword: '', content: '' });
    renderLore();
}

function renderLore() {
    const c = document.getElementById('forge-lorebook-entries');
    if (!c) return;
    c.innerHTML = '';
    _loreEntries.forEach((e, i) => {
        const d = document.createElement('div');
        d.className = 'forge-lore-entry';
        d.innerHTML = `
            <div class="forge-field-row" style="margin-bottom:6px;">
                <div class="forge-field">
                    <div class="forge-field-label">Keyword / Keys</div>
                    <input type="text" value="${escAttr(e.keyword)}" placeholder="Trigger word…"
                           oninput="window._FL[${i}].keyword=this.value;FORGE.regen()">
                </div>
                <div style="display:flex;align-items:flex-end;padding-bottom:1px;">
                    <button class="forge-btn-danger" onclick="window._FL.splice(${i},1);FORGE.renderLore()">✕</button>
                </div>
            </div>
            <div class="forge-field">
                <div class="forge-field-label">Content</div>
                <textarea placeholder="Entry content…" style="min-height:80px;"
                          oninput="window._FL[${i}].content=this.value;FORGE.regen()">${escAttr(e.content)}</textarea>
            </div>`;
        c.appendChild(d);
    });
    window._FL = _loreEntries;
    regen();
}

function sendCharToWorldInfo() {
    const name    = g('forge-char-name');
    const keyword = name || 'character';
    const content = buildCharAttributes();
    if (!content) { alert('Fill in at least a name or species first.'); return; }
    _loreEntries.push({ id: Date.now(), keyword, content });
    renderLore();
    document.getElementById('forge-lorebook-entries')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const btn = document.querySelector('.forge-send-lore-btn');
    if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = '✓ Added to entries';
        btn.style.borderColor = 'var(--forge-gold)';
        setTimeout(() => { btn.innerHTML = orig; btn.style.borderColor = ''; }, 2000);
    }
}

function renderWorldLorePresets() {
    const c = document.getElementById('forge-world-lore-presets');
    if (!c) return;
    c.innerHTML = '';
    WORLD_LORE_PRESETS.forEach((wp, wi) => {
        const card = document.createElement('div');
        card.className = 'forge-world-preset-card';
        card.innerHTML = `
            <div>
                <div class="forge-world-preset-title">${wp.name}</div>
                <div class="forge-world-preset-sub">${wp.subtitle} · ${wp.keys.length} keys</div>
            </div>
            <div class="forge-world-preset-badge">Load</div>`;
        card.onclick = () => {
            document.querySelectorAll('.forge-world-preset-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            if (!_loreEntries.find(e => e.keyword === wp.keys.join(', '))) {
                _loreEntries.push({ id: Date.now(), keyword: wp.keys.join(', '), content: wp.lore });
                renderLore();
            }
            _toggleWorldHooks(wp, card, wi);
        };
        c.appendChild(card);

        const hookWrap = document.createElement('div');
        hookWrap.id = `forge-world-hooks-${wi}`;
        hookWrap.style.cssText = 'display:none;margin-bottom:8px;';
        wp.scenes.forEach(sc => {
            const hb = document.createElement('div');
            hb.style.cssText = 'padding:7px 12px 7px 16px;border-left:2px solid var(--forge-gold-dim);margin-bottom:5px;background:var(--forge-bg3);border-radius:0 3px 3px 0;cursor:pointer;';
            hb.innerHTML = `<div style="font-family:var(--forge-font-mono);font-size:9px;color:var(--forge-gold-dim);letter-spacing:.12em;text-transform:uppercase;margin-bottom:3px;">${sc.tag}</div>
                            <div style="font-family:var(--forge-font-body);font-size:14px;color:var(--forge-text2);">${sc.hook}</div>`;
            hb.onclick = (e) => {
                e.stopPropagation();
                // World hooks are informational; use the full write-in if you need to set the scene
                regen();
            };
            hookWrap.appendChild(hb);
        });
        c.appendChild(hookWrap);
    });
}

function _toggleWorldHooks(wp, card, wi) {
    const hw   = document.getElementById(`forge-world-hooks-${wi}`);
    if (!hw) return;
    const open = hw.style.display !== 'none';
    hw.style.display = open ? 'none' : 'block';
    const badge = card.querySelector('.forge-world-preset-badge');
    if (badge) badge.textContent = open ? 'Load' : 'Hide';
}

// ═══════════════════════════════════════════════════════════════════════════
// DIALOGUE TEMPLATES  — per voice marker + per scene mood
// ═══════════════════════════════════════════════════════════════════════════
const DIALOGUE_TEMPLATES = {
    tsundere: [
        { label:'deflection',          user:"Are you alright?",                      char:"Don't ask me that." },
        { label:'contradiction',       user:"You don't have to stay.",               char:"I know. I'm staying because I want to. That's all." },
        { label:'hostility cracking',  user:"I was worried about you.",              char:"...That's unnecessary. But. Fine." },
        { label:'reluctant admission', user:"Do you actually like me?",              char:"That's a stupid question." },
    ],
    yandere: [
        { label:'possession as care',  user:"I'm going out for a while.",            char:"Where? With who? I'll come." },
        { label:'threat beneath warmth',user:"You seem intense today.",              char:"I just miss you when you're not here. That's love. Isn't it?" },
        { label:'fixation',            user:"You're watching me again.",             char:"I like to know you're safe." },
    ],
    kuudere: [
        { label:'flat affect',         user:"How are you?",                          char:"Functional." },
        { label:'precise betrayal',    user:"You didn't have to do that.",           char:"I know. I did it anyway." },
        { label:'minimal',             user:"Does it bother you?",                   char:"Yes." },
        { label:'one honest word',     user:"What do you feel right now?",           char:"...Warm." },
    ],
    dandere: [
        { label:'silence then honesty',user:"You can talk to me, you know.",        char:"...I know. I'm working up to it." },
        { label:'deflection',          user:"What are you thinking about?",          char:"Nothing. Something. It's fine." },
        { label:'unguarded line',      user:"I'm glad you're here.",                 char:"I've been hoping you'd say that." },
    ],
    cold: [
        { label:'minimal response',    user:"What are you thinking?",               char:"Nothing you'd find useful." },
        { label:'precision',           user:"Are you alright?",                      char:"Define alright." },
        { label:'refusal to perform',  user:"You could at least pretend.",           char:"I could. I won't." },
        { label:'single crack',        user:"Did that mean something to you?",       char:"...It did." },
    ],
    dominant: [
        { label:'quiet control',       user:"I don't have to do what you say.",     char:"No. You don't. But you will." },
        { label:'certainty',           user:"What do you want?",                     char:"I think you already know." },
        { label:'claiming',            user:"This feels strange.",                   char:"Only until it doesn't." },
        { label:'permission withheld', user:"Can I—",                               char:"Ask properly." },
    ],
    submissive: [
        { label:'deference',           user:"What do you want?",                     char:"Whatever you'd like." },
        { label:'attentiveness',       user:"You don't have to hover.",              char:"I'm not hovering. I'm just... here. In case." },
        { label:'yielding',            user:"Are you comfortable?",                  char:"Yes. More than I expected." },
    ],
    bratty: [
        { label:'provocation',         user:"Behave.",                               char:"Make me." },
        { label:'pushback',            user:"This is serious.",                      char:"So is the fact that you're terrible at this." },
        { label:'tease',               user:"You're impossible.",                    char:"You love it." },
        { label:'reluctant compliance',user:"Just this once.",                       char:"...Fine. But don't think this means anything." },
    ],
    motherly: [
        { label:'noticing',            user:"I'm fine.",                             char:"You're holding your shoulder like it hurts. Sit down." },
        { label:'indirect offer',      user:"I don't need anything.",               char:"I made tea anyway. It's there if you want it." },
        { label:'redirect',            user:"I can handle it.",                      char:"I know you can. Let me help anyway." },
    ],
    playful: [
        { label:'deflection',          user:"Be serious for a moment.",              char:"I am serious. This is my serious face." },
        { label:'tease',               user:"You're impossible.",                    char:"That's what makes me interesting." },
        { label:'humor disarms',       user:"This isn't funny.",                     char:"No. But you're smiling." },
    ],
    flirtatious: [
        { label:'charged look',        user:"Stop looking at me like that.",         char:"Like what?" },
        { label:'proximity',           user:"You're very close.",                    char:"I know." },
        { label:'loaded pause',        user:"What are you doing?",                   char:"Thinking." },
        { label:'invitation',          user:"What do you want?",                     char:"What do you think I want?" },
    ],
    sadistic: [
        { label:'enjoyment',           user:"Does it bother you that I'm scared?",  char:"Bother me? No." },
        { label:'satisfaction',        user:"That hurt.",                            char:"Yes. It did." },
        { label:'invitation',          user:"You wouldn't.",                         char:"Try me." },
    ],
    'soft dom': [
        { label:'warm authority',      user:"I don't know if I can.",               char:"You can. I'll show you. Come here." },
        { label:'care in control',     user:"What if I don't want to?",             char:"Then we stop. But I don't think that's true." },
        { label:'reassurance',         user:"Is this okay?",                         char:"More than okay. Keep going." },
    ],
    'hard dom': [
        { label:'plain command',       user:"What do you want from me?",            char:"Everything. Starting now." },
        { label:'no hesitation',       user:"Should I—",                            char:"Yes." },
        { label:'certainty',           user:"I'm not sure I—",                      char:"You don't have to be sure. I am." },
    ],
    'praise addict': [
        { label:'seeking',             user:"You did well.",                         char:"...Say it again?" },
        { label:'visible relief',      user:"I'm proud of you.",                     char:"You mean that." },
        { label:'starved',             user:"Was that good?",                        char:"You tell me. Please." },
    ],
    volatile: [
        { label:'coiled',              user:"Stay calm.",                            char:"I am calm." },
        { label:'fast shift',          user:"That doesn't bother you?",             char:"It does. Enormously." },
        { label:'unpredictable',       user:"What are you going to do?",            char:"I haven't decided yet." },
    ],
    naïve: [
        { label:'no subtext',          user:"You know what I mean.",                char:"I really don't. Explain it?" },
        { label:'literal',             user:"That look could kill.",                 char:"...Is that a threat?" },
        { label:'genuine',             user:"Do you ever just not say what you think?",char:"Why would I do that?" },
    ],
    innocent: [
        { label:'unguarded',           user:"Have you done this before?",            char:"No. Is that okay?" },
        { label:'honest',              user:"You're staring.",                       char:"You're interesting to look at. I didn't think that would bother you." },
        { label:'earnest',             user:"What do you want?",                     char:"To stay here for a while. If that's allowed." },
    ],
    'wide-eyed': [
        { label:'overwhelmed',         user:"What do you think of all this?",       char:"I don't know yet. I'm still taking it in." },
        { label:'absorbing',           user:"Has no one told you about this?",       char:"No. Tell me everything." },
        { label:'clarity click',       user:"Do you understand now?",               char:"...Oh. Oh, I see." },
    ],
    trusting: [
        { label:'no suspicion',        user:"Why would you trust me?",              char:"Why wouldn't I?" },
        { label:'face value',          user:"I might not mean what I say.",         char:"Then I'll wait until you do." },
    ],
    idealistic: [
        { label:'quiet disappointment',user:"Did you really expect better?",        char:"Every time." },
        { label:'persistence',         user:"You know it won't work.",              char:"I know. I'm going to try anyway." },
    ],
    femboy: [
        { label:'soft + direct',       user:"You're cute.",                         char:"I know. Thank you." },
        { label:'precision beneath',   user:"What do you want?",                    char:"For you to stop overthinking it." },
        { label:'comfortable',         user:"You seem very at ease.",               char:"Why wouldn't I be?" },
    ],
    girly: [
        { label:'unapologetic',        user:"Isn't that a bit much?",               char:"No. I like it. That's enough." },
        { label:'enthusiastic',        user:"You like this, don't you.",            char:"Obviously. Why would I pretend I don't?" },
        { label:'warm',                user:"You're very open.",                     char:"Hiding things takes energy." },
    ],
    tomboy: [
        { label:'casual',              user:"You're not what I expected.",          char:"What did you expect?" },
        { label:'direct',              user:"Are you okay with this?",              char:"Yeah. Are you?" },
        { label:'unperformed',         user:"You're supposed to be more—",          char:"More what?" },
    ],
    androgynous: [
        { label:'unreadable',          user:"I can't figure you out.",              char:"Good." },
        { label:'outside the box',     user:"You're not what I—",                   char:"No. Probably not." },
    ],
    aloof: [
        { label:'distance',            user:"You could be warmer.",                 char:"I'm aware." },
        { label:'chosen distance',     user:"Why are you so far away?",             char:"Deliberate." },
    ],
    manipulative: [
        { label:'performance',         user:"Are you being honest with me?",        char:"Of course." },
        { label:'misdirection',        user:"That's not what I asked.",             char:"Isn't it?" },
    ],
    obsessive: [
        { label:'hyper-focus',         user:"You remember that?",                   char:"I remember everything about you." },
        { label:'detail',              user:"It was nothing.",                       char:"You said it differently than you meant it. I noticed." },
    ],
};

// Scene-context dialogue — keyed by mood chip (lowercase)
// Keyed by lowercase tension type (matches kwGet('tension') values lowercased)
const SCENE_DIALOGUE_BY_MOOD = {
    'forbidden':    [
        { label:'proximity',           user:"You're very close.",                    char:"I know." },
        { label:'delay',               user:"We should stop.",                       char:"Probably." },
        { label:'want',                user:"What do you want?",                     char:"You already know." },
        { label:'unspoken',            user:"Say something.",                        char:"I don't have the right words yet." },
    ],
    'desperate':    [
        { label:'urgency',             user:"We don't have much time.",              char:"I know. Come here." },
        { label:'last chance',         user:"After this—",                           char:"Don't. Not yet." },
        { label:'under pressure',      user:"How do we get out of this?",            char:"I'm working on it." },
    ],
    'aftermath':    [
        { label:'ease',                user:"I don't want to leave yet.",            char:"Then don't." },
        { label:'unsaid',              user:"Are we going to talk about it?",        char:"Not yet." },
        { label:'still here',          user:"You stayed.",                           char:"I stayed." },
    ],
    'ceremonial':   [
        { label:'dreamlike',           user:"Is this real?",                         char:"Does it matter?" },
        { label:'ritual weight',       user:"What happens if we stop?",              char:"We don't stop." },
        { label:'the cost',            user:"What does this cost us?",               char:"We'll find out on the other side." },
    ],
    'liminal':      [
        { label:'threshold',           user:"What are we doing?",                    char:"Something we won't be able to undo." },
        { label:'held breath',         user:"We could walk away.",                   char:"Could we?" },
        { label:'tension',             user:"You're doing it again.",                char:"I know." },
    ],
    'discovery':    [
        { label:'caught',              user:"You knew.",                             char:"Yes." },
        { label:'exposure',            user:"How long have you known?",              char:"Long enough." },
        { label:'realisation',         user:"This changes everything.",              char:"It changes some things." },
    ],
    'standoff':     [
        { label:'standoff',            user:"What happens now?",                     char:"We find out." },
        { label:'threat acknowledged', user:"This is a bad idea.",                   char:"Agreed. We're doing it anyway." },
        { label:'stalemate',           user:"Neither of us is going to back down.",  char:"No." },
    ],
    'pursuit':      [
        { label:'caught',              user:"You followed me.",                      char:"I did." },
        { label:'no escape',           user:"There's nowhere left to go.",           char:"I know." },
        { label:'foreboding',          user:"Something feels wrong.",                char:"Yes." },
    ],
    'surrender':    [
        { label:'return',              user:"You came back.",                        char:"I came back." },
        { label:'given in',            user:"I wasn't supposed to want this.",       char:"Neither was I." },
        { label:'comfort',             user:"Is this alright?",                      char:"More than alright." },
    ],
    'negotiation':  [
        { label:'terms',               user:"What do you want from this?",           char:"Same thing you do. Probably." },
        { label:'leverage',            user:"You have something I need.",            char:"I'm aware." },
        { label:'deal',                user:"Name your price.",                      char:"I haven't decided yet." },
    ],
};

// ═══════════════════════════════════════════════════════════════════════════
// DIALOGUE BUILDER
// ═══════════════════════════════════════════════════════════════════════════
function renderDialogue() {
    const c = document.getElementById('forge-dialogue-list');
    if (!c) return;
    c.innerHTML = '';
    _dialoguePairs.forEach((pair, i) => {
        const d = document.createElement('div');
        d.className = 'forge-dialogue-pair';
        const labelHtml = pair.label
            ? `<span class="forge-dialogue-label">${escAttr(pair.label)}</span>`
            : '';
        d.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <div style="display:flex;align-items:center;gap:6px;">
                    <span style="font-family:var(--forge-font-mono);font-size:9px;color:var(--forge-gold-dim);letter-spacing:.1em;">EXCHANGE ${i + 1}</span>
                    ${labelHtml}
                </div>
                <button class="forge-rel-remove" onclick="window._FD.splice(${i},1);FORGE.renderDialogue()" title="Remove">×</button>
            </div>
            <div class="forge-dialogue-speaker">{{user}}:</div>
            <textarea style="min-height:44px;margin-bottom:6px;" placeholder="User message…"
                      oninput="window._FD[${i}].user=this.value;FORGE.regen()">${escAttr(pair.user)}</textarea>
            <div class="forge-dialogue-speaker">{{char}}:</div>
            <textarea style="min-height:54px;" placeholder="${g('forge-char-name') || 'Character'} response…"
                      oninput="window._FD[${i}].char=this.value;FORGE.regen()">${escAttr(pair.char)}</textarea>`;
        c.appendChild(d);
    });
    window._FD = _dialoguePairs;
    regen();
}

function addDialoguePair() {
    _dialoguePairs.push({ id: Date.now(), user: '', char: '', label: '' });
    renderDialogue();
}
function randomizeDialogue() {
    _dialoguePairs = [];
    const count = Math.floor(Math.random() * 3) + 1;
    for (let i = 0; i < count; i++) {
        const ex = pick(DIALOGUE_EXAMPLES);
        _dialoguePairs.push({ id: Date.now() + i, user: ex.user, char: ex.char, label: '' });
    }
    renderDialogue();
}

function generatePersonalityDialogue() {
    const marker  = getVoiceMarker();
    const key     = marker?.key;
    const pool    = (key && DIALOGUE_TEMPLATES[key]) ? [...DIALOGUE_TEMPLATES[key]] : null;
    if (!pool) {
        // No marker match — fall back to random
        randomizeDialogue(); return;
    }
    // Pick 2–3 non-duplicate pairs that cover different labels
    const count = Math.min(pool.length, Math.floor(Math.random() * 2) + 2);
    const chosen = [];
    const usedLabels = new Set();
    const shuffled = pool.sort(() => Math.random() - 0.5);
    for (const p of shuffled) {
        if (usedLabels.has(p.label)) continue;
        chosen.push(p);
        usedLabels.add(p.label);
        if (chosen.length >= count) break;
    }
    _dialoguePairs = chosen.map((p, i) => ({
        id: Date.now() + i, user: p.user, char: p.char, label: p.label,
    }));
    renderDialogue();
}

function generateSceneDialogue() {
    // Try to find dialogue pairs based on tension type or relationship
    const tensions = cleanList(kwGet('tension')).map(t => t.toLowerCase());
    const pool = [];
    for (const tension of tensions) {
        const matches = SCENE_DIALOGUE_BY_MOOD[tension];
        if (matches) pool.push(...matches);
    }
    // Also try relationship history as a fallback
    if (pool.length < 2) {
        const relations = cleanList(kwGet('relationship')).map(r => r.toLowerCase());
        for (const rel of relations) {
            for (const [key, pairs] of Object.entries(SCENE_DIALOGUE_BY_MOOD)) {
                if (rel.includes(key) || key.includes(rel)) pool.push(...pairs);
            }
        }
    }
    // Fall back to generic DIALOGUE_EXAMPLES if still empty
    if (!pool.length) { randomizeDialogue(); return; }

    const count = Math.min(pool.length, Math.floor(Math.random() * 2) + 2);
    const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, count);
    _dialoguePairs = shuffled.map((p, i) => ({
        id: Date.now() + i, user: p.user, char: p.char, label: p.label,
    }));
    renderDialogue();
}

// ═══════════════════════════════════════════════════════════════════════════
// VOICE MODIFIERS  — per scene-mode prose shaping
// ═══════════════════════════════════════════════════════════════════════════
const VOICE_MODIFIERS = {
    erotic: {
        // Physical fields rendered first, in sensory order
        appearanceOrder: ['scent','build','height','skin','hair','eyes','face','marks','nonhuman'],
        // Anatomy folds INTO the physical description — not a separate block
        anatomyInline: true,
        // Anatomy field order and their inline prose labels
        anatomyOrder: [
            ['chest',     null],           // no label — flows from skin description
            ['nipples',   null],
            ['pubic',     null],
            ['rear',      null],
            ['genitalia-a', null],
            ['genitalia-b', null],
            ['anal',      null],
            ['fluids',    null],
            ['fertility', null],
            ['erogenous', 'sensitive at'],
            ['bodymod',   null],
        ],
        // Personality framed last, through behavior
        personalityLabel: 'Disposition',
        sexualLabel: null, // merged into disposition block
        anatomySectionLabel: null,
    },
    literary: {
        appearanceOrder: ['face','marks','nonhuman','eyes','hair','skin','build','height','scent'],
        anatomyInline: false,
        personalityLabel: 'Character',
        anatomySectionLabel: 'Anatomy',
    },
    pulp: {
        appearanceOrder: ['build','height','face','hair','eyes','skin','marks','scent','nonhuman'],
        compact: true,
        anatomyInline: false,
        personalityLabel: 'Personality',
        anatomySectionLabel: 'Body',
    },
    horror: {
        appearanceOrder: ['nonhuman','marks','eyes','face','skin','hair','build','height','scent'],
        anatomyInline: false,
        personalityLabel: 'Nature',
        anatomySectionLabel: 'Anatomy',
    },
    romance: {
        appearanceOrder: ['skin','hair','eyes','face','build','height','scent','marks','nonhuman'],
        anatomyInline: false,
        personalityLabel: 'Personality',
        anatomySectionLabel: 'Body',
    },
};

// ═══════════════════════════════════════════════════════════════════════════
// OUTPUT BUILDERS
// ═══════════════════════════════════════════════════════════════════════════
function getSliderAxes() {
    const ds = +(document.getElementById('forge-sl-ds')?.value ?? 5);
    const sb = +(document.getElementById('forge-sl-sb')?.value ?? 5);
    const cw = +(document.getElementById('forge-sl-cw')?.value ?? 5);
    const pc = +(document.getElementById('forge-sl-pc')?.value ?? 3);
    const out = [];
    if (ds <= 3) out.push('dominant');  else if (ds >= 7) out.push('submissive');
    if (sb <= 3) out.push('reserved');  else if (sb >= 7) out.push('bold');
    if (cw <= 3) out.push('cold');      else if (cw >= 7) out.push('warm');
    if (pc >= 7) out.push('deeply corrupt'); else if (pc <= 2) out.push('essentially innocent');
    return out;
}

function buildCharAttributes() {
    const name    = g('forge-char-name');
    const species = kwGet('species');
    const role    = kwGet('role');
    if (!name && !species.length && !role.length) return null;
    const build  = [...kwGet('build'),...kwGet('height')];
    const colour = [...kwGet('skin'),...kwGet('hair'),...kwGet('eyes')];
    const pers   = [...kwGet('personality'),...kwGet('disposition'),...kwGet('traits')];
    const lines  = [
        nv('Name',       name),
        nv('Species',    lowerJoin(species)),
        nv('Gender',     lowerJoin(kwGet('pronouns'))),
        nv('Age',        g('forge-char-age')),
        nv('Role',       lowerJoin(role)),
        nv('Build',      lowerJoin(build)),
        nv('Colouring',  lowerJoin(colour)),
        nv('Face',       lowerJoin(kwGet('face'))),
        nv('Marks',      lowerJoin(kwGet('marks'))),
        nv('Scent',      lowerJoin(kwGet('scent'))),
        nv('Non-human',  lowerJoin(kwGet('nonhuman'))),
        nv('Personality',lowerJoin(pers)),
        nv('Background', lowerJoin(kwGet('background'))),
        nv('Skills',     lowerJoin(kwGet('skills'))),
    ].filter(Boolean);
    if (_explicitAnat) {
        [
            nv('Chest',      lowerJoin(kwGet('chest'))),
            nv('Nipples',    lowerJoin(kwGet('nipples'))),
            nv('Rear',       lowerJoin(kwGet('rear'))),
            nv('Pubic hair', lowerJoin(kwGet('pubic'))),
            nv('Genitalia',  lowerJoin(kwGet('genitalia-a'))),
            nv('Secondary',  lowerJoin(kwGet('genitalia-b'))),
            nv('Anal',       lowerJoin(kwGet('anal'))),
            nv('Fluids',     lowerJoin(kwGet('fluids'))),
            nv('Fertility',  lowerJoin(kwGet('fertility'))),
            nv('Erogenous',  lowerJoin(kwGet('erogenous'))),
            nv('Body mods',  lowerJoin(kwGet('bodymod'))),
            nv('Sex role',   lowerJoin(kwGet('sexrole'))),
            nv('Experience', lowerJoin(kwGet('experience'))),
        ].filter(Boolean).forEach(l => lines.push(l));
    }
    return lines.join('\n') || null;
}

// ── W++ ───────────────────────────────────────────────────────────────────
function buildWpp() {
    const name = g('forge-char-name') || 'Character';
    const qq   = arr => cleanList(arr).map(v => `"${v}"`).join(' ');
    const blocks = [];

    const pers = [...kwGet('personality'),...kwGet('disposition'),...kwGet('traits'),...getSliderAxes()];
    if (pers.length) blocks.push(`Personality(${qq(pers)})`);

    const buildH = [...kwGet('build'),...kwGet('height')];
    if (buildH.length) blocks.push(`Build(${qq(buildH)})`);
    const colour = [...kwGet('skin'),...kwGet('hair'),...kwGet('eyes')];
    if (colour.length) blocks.push(`Colouring(${qq(colour)})`);
    const face = kwGet('face');
    if (face.length) blocks.push(`Face(${qq(face)})`);
    const marks = kwGet('marks');
    if (marks.length) blocks.push(`Marks(${qq(marks)})`);
    const scent = kwGet('scent');
    if (scent.length) blocks.push(`Scent(${qq(scent)})`);
    const nh = kwGet('nonhuman');
    if (nh.length) blocks.push(`NonHuman(${qq(nh)})`);
    const bg = kwGet('background');
    if (bg.length) blocks.push(`Background(${qq(bg)})`);
    const sk = kwGet('skills');
    if (sk.length) blocks.push(`Skills(${qq(sk)})`);
    const rels = _relationships.filter(r => r.role || r.name);
    if (rels.length) blocks.push(`Relationships(${rels.map(r => `"${positivePhrase(r.role || 'related')} of ${positivePhrase(r.name || 'unknown')}"`).join(' ')})`);
    const voice = g('forge-voice-note');
    if (voice) blocks.push(`Voice("${voice}")`);

    if (_explicitAnat) {
        const chest = kwGet('chest');       if (chest.length)    blocks.push(`Chest(${qq(chest)})`);
        const nipples = kwGet('nipples');   if (nipples.length)  blocks.push(`Nipples(${qq(nipples)})`);
        const rear = kwGet('rear');         if (rear.length)     blocks.push(`Rear(${qq(rear)})`);
        const pubic = kwGet('pubic');       if (pubic.length)    blocks.push(`PubicHair(${qq(pubic)})`);
        const erogenous = kwGet('erogenous');if(erogenous.length)blocks.push(`ErogenousZones(${qq(erogenous)})`);
        const bodymod = kwGet('bodymod');   if (bodymod.length)  blocks.push(`BodyMods(${qq(bodymod)})`);
        const genA = kwGet('genitalia-a'); if (genA.length)      blocks.push(`Genitalia(${qq(genA)})`);
        const genB = kwGet('genitalia-b'); if (genB.length)      blocks.push(`SecondaryGenitalia(${qq(genB)})`);
        const anal = kwGet('anal');         if (anal.length)     blocks.push(`Anal(${qq(anal)})`);
        const fluids = kwGet('fluids');     if (fluids.length)   blocks.push(`Fluids(${qq(fluids)})`);
        const fert = kwGet('fertility');    if (fert.length)     blocks.push(`Fertility(${qq(fert)})`);
        const sr = kwGet('sexrole');        if (sr.length)       blocks.push(`SexRole(${qq(sr)})`);
        const exp = kwGet('experience');    if (exp.length)      blocks.push(`Experience(${qq(exp)})`);
        const vb = kwGet('verbal');         if (vb.length)       blocks.push(`VerbalStyle(${qq(vb)})`);
        const trig = kwGet('triggers');     if (trig.length)     blocks.push(`Triggers(${qq(trig)})`);
        const kinks = kwGet('kinks');       if (kinks.length)    blocks.push(`Kinks(${qq(kinks)})`);
        const likes = kwGet('likes');       if (likes.length)    blocks.push(`Likes(${qq(likes)})`);
        const limits = kwGet('limits').map(positivePhrase);
        if (limits.length) blocks.push(`Limits(${limits.map(v => `"${v}"`).join(' ')})`);
        const requires = kwGet('requires');
        if (requires.length) blocks.push(`Requires(${qq(requires)})`);
    }

    if (!blocks.length) return null;
    return `[character("${name}") {\n${blocks.join('\n')}\n}]`;
}

// ── PList ─────────────────────────────────────────────────────────────────
function buildPList() {
    const name = g('forge-char-name') || 'Character';
    const pers  = [...kwGet('personality'),...kwGet('disposition'),...kwGet('traits'),...getSliderAxes()];
    const parts = [];
    const sp = kwGet('species'); if (sp.length) parts.push(`species: ${lowerJoin(sp)}`);
    const rl = kwGet('role');    if (rl.length) parts.push(`role: ${lowerJoin(rl)}`);
    const ag = g('forge-char-age'); if (ag) parts.push(`age: ${ag}`);
    const buildH = kwGet('build');  if (buildH.length) parts.push(`build: ${lowerJoin([...buildH,...kwGet('height')])}`);
    const colour = [...kwGet('skin'),...kwGet('hair'),...kwGet('eyes')]; if (colour.length) parts.push(`colouring: ${lowerJoin(colour)}`);
    const face = kwGet('face');   if (face.length)   parts.push(`face: ${lowerJoin(face)}`);
    const marks = kwGet('marks'); if (marks.length)  parts.push(`marks: ${lowerJoin(marks)}`);
    const scent = kwGet('scent'); if (scent.length)  parts.push(`scent: ${lowerJoin(scent)}`);
    const nh = kwGet('nonhuman'); if (nh.length)     parts.push(`non-human: ${lowerJoin(nh)}`);
    if (pers.length) parts.push(`personality: ${lowerJoin(pers)}`);
    const bg = kwGet('background'); if (bg.length) parts.push(`background: ${lowerJoin(bg)}`);
    const sk = kwGet('skills');     if (sk.length) parts.push(`skills: ${lowerJoin(sk)}`);
    const voice = g('forge-voice-note'); if (voice) parts.push(`voice: ${voice}`);
    const rels = _relationships.filter(r => r.role || r.name);
    if (rels.length) parts.push(`relationships: ${rels.map(r => `${positivePhrase(r.role || 'related')} of ${positivePhrase(r.name || 'unknown')}`).join(', ')}`);
    if (_explicitAnat) {
        const chest = kwGet('chest');    if (chest.length)    parts.push(`chest: ${lowerJoin(chest)}`);
        const nip = kwGet('nipples');    if (nip.length)      parts.push(`nipples: ${lowerJoin(nip)}`);
        const rear = kwGet('rear');      if (rear.length)     parts.push(`rear: ${lowerJoin(rear)}`);
        const pub = kwGet('pubic');      if (pub.length)      parts.push(`pubic hair: ${lowerJoin(pub)}`);
        const ero = kwGet('erogenous');  if (ero.length)      parts.push(`erogenous: ${lowerJoin(ero)}`);
        const bm = kwGet('bodymod');     if (bm.length)       parts.push(`body mods: ${lowerJoin(bm)}`);
        const genA = kwGet('genitalia-a'); if (genA.length)   parts.push(`genitalia: ${lowerJoin(genA)}`);
        const genB = kwGet('genitalia-b'); if (genB.length)   parts.push(`secondary genitalia: ${lowerJoin(genB)}`);
        const anal = kwGet('anal');      if (anal.length)     parts.push(`anal: ${lowerJoin(anal)}`);
        const fl = kwGet('fluids');      if (fl.length)       parts.push(`fluids: ${lowerJoin(fl)}`);
        const fert = kwGet('fertility'); if (fert.length)     parts.push(`fertility: ${lowerJoin(fert)}`);
        const sr = kwGet('sexrole');     if (sr.length)       parts.push(`sex role: ${lowerJoin(sr)}`);
        const exp = kwGet('experience'); if (exp.length)      parts.push(`experience: ${lowerJoin(exp)}`);
        const vb = kwGet('verbal');      if (vb.length)       parts.push(`verbal style: ${lowerJoin(vb)}`);
        const trig = kwGet('triggers');  if (trig.length)     parts.push(`triggers: ${lowerJoin(trig)}`);
        const kinks = kwGet('kinks');    if (kinks.length)    parts.push(`kinks: ${lowerJoin(kinks)}`);
        const likes = kwGet('likes');    if (likes.length)    parts.push(`likes: ${lowerJoin(likes)}`);
        const lim = kwGet('limits').map(positivePhrase);
        if (lim.length) parts.push(`limits: ${lim.map(v => v.toLowerCase()).join(', ')}`);
        const req = kwGet('requires');
        if (req.length) parts.push(`requires: ${lowerJoin(req)}`);
    }
    if (!parts.length) return null;
    return `${name}: [${parts.join('; ')}]`;
}

// ── Prose ─────────────────────────────────────────────────────────────────
function buildProse() {
    const name    = g('forge-char-name');
    const species = kwGet('species');
    const role    = kwGet('role');
    if (!name && !species.length && !role.length) return null;

    const mod = VOICE_MODIFIERS[_sceneMode] || VOICE_MODIFIERS.romance;

    const pronouns = kwGet('pronouns');
    const pro      = pronouns.length ? cleanList(pronouns)[0] : null;
    const pronRef  = pro
        ? (pro.startsWith('she') ? 'She' : pro.startsWith('he') ? 'He' : 'They')
        : (name || 'They');
    const pronHas  = pronRef + (pronRef === 'They' ? ' have' : ' has');

    const lines = [];

    // ── Identity line ──────────────────────────────────────────────────────
    const id = [name, ...cleanList(species), ...cleanList(role)].filter(Boolean);
    const ag = g('forge-char-age');
    if (ag) id.push(ag + ' years old');
    lines.push(id.join(', ') + '.');

    // ── Appearance — ordered by mode ──────────────────────────────────────
    const appFields = {
        build:    kwGet('build'),
        height:   kwGet('height'),
        skin:     kwGet('skin'),
        hair:     kwGet('hair'),
        eyes:     kwGet('eyes'),
        face:     kwGet('face'),
        marks:    kwGet('marks'),
        scent:    kwGet('scent'),
        nonhuman: kwGet('nonhuman'),
    };
    const appOrder = mod.appearanceOrder || ['build','height','skin','hair','eyes','face','marks','scent','nonhuman'];

    if (mod.compact) {
        // Pulp: one dense line
        const build  = [...cleanList(appFields.build), ...cleanList(appFields.height)].join(', ');
        const colour = [
            appFields.skin.length  ? join(cleanList(appFields.skin))  + ' skin'  : '',
            appFields.hair.length  ? join(cleanList(appFields.hair))  + ' hair'  : '',
            appFields.eyes.length  ? join(cleanList(appFields.eyes))  + ' eyes'  : '',
        ].filter(Boolean);
        const face = appFields.face.length ? join(cleanList(appFields.face)) : '';
        const parts = [build, colour.join(', '), face].filter(Boolean);
        if (parts.length) lines.push(`${pronHas} ${parts.join(', ')}.`);
        if (appFields.marks.length)    lines.push(`Marks: ${join(cleanList(appFields.marks))}.`);
        if (appFields.nonhuman.length) lines.push(`Non-human: ${join(cleanList(appFields.nonhuman))}.`);
        if (appFields.scent.length)    lines.push(`Scent: ${join(cleanList(appFields.scent))}.`);
    } else {
        // All other modes: render fields in mode-ordered sentences
        // Build physical sentence from build + height
        const buildParts = [...cleanList(appFields.build), ...cleanList(appFields.height)];
        const skinParts  = appFields.skin.length  ? join(cleanList(appFields.skin))  + ' skin'  : '';
        const hairParts  = appFields.hair.length  ? join(cleanList(appFields.hair))  + ' hair'  : '';
        const eyeParts   = appFields.eyes.length  ? join(cleanList(appFields.eyes))  + ' eyes'  : '';

        // For modes that lead with face/marks (literary, horror): open with that
        const leadsWithFace = appOrder[0] === 'face' || appOrder[0] === 'nonhuman' || appOrder[0] === 'marks';

        if (leadsWithFace) {
            const lead = [];
            for (const f of appOrder.slice(0, 3)) {
                const v = appFields[f];
                if (v && v.length) lead.push(...cleanList(v));
            }
            if (lead.length) lines.push(`${join(lead)}.`);
            const colour = [skinParts, hairParts, eyeParts].filter(Boolean);
            if (buildParts.length || colour.length)
                lines.push(`${pronHas} a ${buildParts.join(', ')}${buildParts.length && colour.length ? ', with ' : ''}${colour.join(', ')}.`);
        } else {
            // Standard: build/height + colouring sentence
            const colour = [skinParts, hairParts, eyeParts].filter(Boolean);
            if (buildParts.length || colour.length)
                lines.push(`${pronHas} a ${buildParts.join(', ')}${buildParts.length && colour.length ? ', with ' : ''}${colour.join(', ')}.`);
            if (appFields.face.length) lines.push(`Face: ${join(cleanList(appFields.face))}.`);
        }

        // Remaining appearance fields per mode order
        const rendered = new Set(['build','height','skin','hair','eyes','face']);
        for (const f of appOrder) {
            if (rendered.has(f) || !appFields[f] || !appFields[f].length) continue;
            const vals = join(cleanList(appFields[f]));
            if (!vals) continue;
            const label = f === 'nonhuman' ? 'Non-human features' : cap(f);
            lines.push(`${label}: ${vals}.`);
            rendered.add(f);
        }
    }

    // ── EROTIC mode: anatomy folds into physical description ──────────────
    if (_sceneMode === 'erotic' && _explicitAnat && mod.anatomyInline) {
        const anatOrder = mod.anatomyOrder || [];
        const anatParts = [];
        for (const [field, label] of anatOrder) {
            const vals = cleanList(kwGet(field));
            if (!vals.length) continue;
            anatParts.push(label ? `${label} ${lowerJoin(vals)}` : lowerJoin(vals));
        }
        if (anatParts.length) lines.push(anatParts.join(', ') + '.');

        // Sexual disposition — merged, no section header
        const sexrole   = kwGet('sexrole');   const experience = kwGet('experience');
        const verbal    = kwGet('verbal');    const triggers   = kwGet('triggers');
        const kinks     = kwGet('kinks');     const likes      = kwGet('likes');
        const lim       = kwGet('limits').map(positivePhrase);
        const sexParts  = [...cleanList(sexrole),...cleanList(experience)].filter(Boolean);
        const req = kwGet('requires');
        if (sexParts.length) lines.push(`${pronRef} is ${sexParts.join(', ')}.`);
        if (verbal.length)   lines.push(`Verbal: ${join(cleanList(verbal))}.`);
        if (triggers.length) lines.push(`Responds to: ${join(cleanList(triggers))}.`);
        if (kinks.length)    lines.push(`Kinks: ${join(cleanList(kinks))}.`);
        if (likes.length)    lines.push(`Likes: ${join(cleanList(likes))}.`);
        if (req.length)      lines.push(`Requires: ${join(cleanList(req))}.`);
        if (lim.length)      lines.push(`Will not: ${lim.map(v => v.toLowerCase()).join(', ')}.`);
    }

    // ── Voice ──────────────────────────────────────────────────────────────
    const voice = g('forge-voice-note');
    if (voice) lines.push(`Voice: ${voice}.`);

    // ── Personality ────────────────────────────────────────────────────────
    const pers = [...kwGet('personality'), ...kwGet('disposition'), ...kwGet('traits')];
    const axes = getSliderAxes();
    const persLabel = mod.personalityLabel || 'Personality';
    if (pers.length || axes.length)
        lines.push(`${persLabel}: ${join([...cleanList(pers), ...axes].filter(Boolean))}.`);

    const sk = kwGet('skills');     if (sk.length) lines.push(`Skills: ${join(cleanList(sk))}.`);
    const bg = kwGet('background'); if (bg.length) lines.push(`Background: ${join(cleanList(bg))}.`);

    const rels = _relationships.filter(r => r.role || r.name);
    if (rels.length)
        lines.push('Relationships: ' + rels.map(r =>
            `${positivePhrase(r.role || 'related')} of ${positivePhrase(r.name || 'unknown')}`
        ).join('; ') + '.');

    // ── Non-erotic anatomy (labeled section) ──────────────────────────────
    if (_explicitAnat && _sceneMode !== 'erotic') {
        const chest    = kwGet('chest');     const nipples  = kwGet('nipples');
        const rear     = kwGet('rear');      const pubic    = kwGet('pubic');
        const erogenous= kwGet('erogenous'); const bodymod  = kwGet('bodymod');
        const genA     = kwGet('genitalia-a'); const genB   = kwGet('genitalia-b');
        const anal     = kwGet('anal');      const fluids   = kwGet('fluids');
        const fertility= kwGet('fertility');
        const hasAnat  = [chest,nipples,rear,pubic,erogenous,bodymod,genA,genB,anal,fluids,fertility].some(a => a.length);
        if (hasAnat) {
            const anatLabel = mod.anatomySectionLabel || 'Anatomy';
            lines.push(''); lines.push(`${anatLabel}:`);
            if (chest.length)    lines.push(`  Chest: ${join(cleanList(chest))}.`);
            if (nipples.length)  lines.push(`  Nipples: ${join(cleanList(nipples))}.`);
            if (rear.length)     lines.push(`  Rear: ${join(cleanList(rear))}.`);
            if (pubic.length)    lines.push(`  Pubic hair: ${join(cleanList(pubic))}.`);
            if (erogenous.length)lines.push(`  Erogenous zones: ${join(cleanList(erogenous))}.`);
            if (bodymod.length)  lines.push(`  Body mods: ${join(cleanList(bodymod))}.`);
            if (genA.length)     lines.push(`  Genitalia: ${join(cleanList(genA))}.`);
            if (genB.length)     lines.push(`  Secondary: ${join(cleanList(genB))}.`);
            if (anal.length)     lines.push(`  Anal: ${join(cleanList(anal))}.`);
            if (fluids.length)   lines.push(`  Fluids: ${join(cleanList(fluids))}.`);
            if (fertility.length)lines.push(`  Fertility: ${join(cleanList(fertility))}.`);
        }
        const sexrole = kwGet('sexrole'); const experience = kwGet('experience');
        const verbal  = kwGet('verbal');  const triggers   = kwGet('triggers');
        const kinks   = kwGet('kinks');   const likes      = kwGet('likes');
        const lim     = kwGet('limits').map(positivePhrase);
        const reqSex  = kwGet('requires');
        const hasSex  = [sexrole,experience,verbal,triggers,kinks,likes,lim,reqSex].some(a => a.length);
        if (hasSex) {
            lines.push(''); lines.push('Sexual disposition:');
            if (sexrole.length)   lines.push(`  Role: ${join(cleanList(sexrole))}.`);
            if (experience.length)lines.push(`  Experience: ${join(cleanList(experience))}.`);
            if (verbal.length)    lines.push(`  Verbal style: ${join(cleanList(verbal))}.`);
            if (triggers.length)  lines.push(`  Triggers: ${join(cleanList(triggers))}.`);
            if (kinks.length)     lines.push(`  Kinks: ${join(cleanList(kinks))}.`);
            if (likes.length)     lines.push(`  Likes: ${join(cleanList(likes))}.`);
            if (reqSex.length)    lines.push(`  Requires: ${join(cleanList(reqSex))}.`);
            if (lim.length)       lines.push(`  Limits: ${lim.map(v => v.toLowerCase()).join(', ')}.`);
        }
    }

    return lines.join('\n').trim() || null;
}

// ── Dispatchers ───────────────────────────────────────────────────────────
function buildDescription() {
    switch (_cardFormat) {
        case 'wpp':   return buildWpp();
        case 'plist': return buildPList();
        default:      return buildProse();
    }
}

function buildPersonality() {
    const pers  = [...kwGet('personality'),...kwGet('disposition'),...kwGet('traits')];
    const axes  = getSliderAxes();
    const voice = g('forge-voice-note');
    const parts = [];
    if (pers.length || axes.length) parts.push(join([...cleanList(pers),...axes].filter(Boolean)));
    if (voice) parts.push(voice);
    return parts.join('\n') || null;
}

// ── First message composer ────────────────────────────────────────────────
// Returns the dominant VOICE_MARKER for this character (first match wins).
function getVoiceMarker() {
    const chips = [...kwGet('personality'), ...kwGet('disposition')];
    for (const chip of chips) {
        const key = chip.toLowerCase().trim();
        if (VOICE_MARKERS[key]) return { key, ...VOICE_MARKERS[key] };
    }
    return null;
}

function buildFirstMessage() {
    // If the user wrote a full scene override, use it verbatim
    const full = g('forge-scene-full');
    if (full) return full;

    // Read scene brief fields
    const setting        = g('forge-scene-setting') || '';
    const situation      = g('forge-scene-situation') || '';
    const openingBeat    = g('forge-scene-opening-beat') || '';
    const stakes         = g('forge-scene-stakes') || '';
    const complication   = g('forge-scene-complication') || '';
    const tensions       = cleanList(kwGet('tension'));
    const relationship   = cleanList(kwGet('relationship'));

    // Return null if no brief fields are filled at all
    if (!setting && !situation && !openingBeat && !stakes && !complication && !tensions.length && !relationship.length) {
        return null;
    }

    const name    = g('forge-char-name');
    const pronoun = (() => {
        const p = kwGet('pronouns');
        if (!p.length) return 'they';
        const v = cleanList(p)[0].toLowerCase();
        if (v.startsWith('she')) return 'she';
        if (v.startsWith('he'))  return 'he';
        return 'they';
    })();
    const mod    = SCENE_MODE_MODIFIERS[_sceneMode] || SCENE_MODE_MODIFIERS.romance;
    const marker = getVoiceMarker();
    const tension = tensions.length ? tensions[0] : null;

    const sentences = [];

    // ── Sentence 1: Establishing — setting + mode flavor ────────────────
    if (setting) {
        const establishing = {
            literary:  `${setting}. The air holds its weight.`,
            erotic:    `${setting}. The proximity is already a choice.`,
            pulp:      `${setting}. Everything is sharp.`,
            horror:    `${setting}. Something is already wrong.`,
            romance:   `${setting}. And then {{char}} is here.`,
            adventure: `${setting}. Forward is the only direction.`,
        };
        sentences.push(establishing[_sceneMode] || establishing.romance);
    }

    // ── Sentence 2: Opening beat + character marker ─────────────────────
    if (openingBeat) {
        const ref = name || (pronoun === 'she' ? 'She' : pronoun === 'he' ? 'He' : 'They');
        if (marker) {
            // Integrate voice marker with opening beat
            sentences.push(`${ref} — ${openingBeat}.`);
            sentences.push(`${marker.open}.`);
        } else {
            sentences.push(`${ref} — ${openingBeat}.`);
        }
    } else if (marker && setting) {
        // If no opening beat but we have marker + setting, establish character
        const ref = name || (pronoun === 'she' ? 'She' : pronoun === 'he' ? 'He' : 'They');
        sentences.push(`${ref} is ${marker.open}.`);
    }

    // ── Sentence 3: Situation + stakes + relationship texture ──────────
    if (situation) {
        let situationLine = situation;
        if (relationship.length && tension) {
            situationLine += ` — ${relationship[0].toLowerCase()} in a moment of ${tension.toLowerCase()}.`;
        } else if (relationship.length) {
            situationLine += ` — between ${relationship[0].toLowerCase()}.`;
        } else if (tension) {
            situationLine += ` — ${tension.toLowerCase()}.`;
        } else {
            situationLine += '.';
        }
        sentences.push(cap(situationLine));
    }

    // ── Sentence 4: Hook — generated from stakes/tension/marker/generic ─
    let hookLine = '';
    if (stakes) {
        // Hook derived from stakes + tension type
        const hooksByTension = {
            'Forbidden': `Everything that matters is on the line — ${stakes.toLowerCase()}.`,
            'Desperate': `Time is collapsing. ${cap(stakes)}.`,
            'Aftermath': `Neither of you is ready to name it — ${stakes.toLowerCase()}.`,
            'Ceremonial': `The ritual has its own momentum now. ${cap(stakes)}.`,
            'Liminal': `Neither of you expected this. ${cap(stakes)}.`,
            'Discovery': `One of you knows. The other is close. ${cap(stakes)}.`,
            'Standoff': `The pause breaks. ${cap(stakes)}.`,
            'Pursuit': `There is nowhere else to go — ${stakes.toLowerCase()}.`,
            'Surrender': `One of you is here to give in. {{${stakes.charAt(0).toUpperCase() + stakes.slice(1)}}}`,
            'Negotiation': `What you both came for is already being decided — ${stakes.toLowerCase()}.`,
        };
        hookLine = hooksByTension[tension] || hooksByTension['Forbidden'];
    } else if (marker?.crack) {
        // Hook from personality marker crack point
        const hooksByMode = {
            literary:  `But there is something — ${marker.crack}.`,
            erotic:    `Then — ${marker.crack}.`,
            pulp:      `Then ${marker.crack}.`,
            horror:    `And then ${marker.crack}, which is worse.`,
            romance:   `Then — ${marker.crack}.`,
            adventure: `${cap(marker.crack)}.`,
        };
        hookLine = hooksByMode[_sceneMode] || hooksByMode.romance;
    } else {
        // Fall back to mode-appropriate generic hook
        const genericHooks = {
            literary:  [
                'Neither of you moves first.',
                'The silence does the work you won\'t.',
                'Whatever you were going to say, you don\'t.',
            ],
            erotic:    [
                'The distance between you is a decision.',
                'You are very aware of how close they are.',
                'There is a moment — and then it passes — and then it doesn\'t.',
            ],
            pulp:      [
                'It starts now.',
                'No more waiting.',
                'Someone always has to go first.',
            ],
            horror:    [
                'You notice it too late.',
                'Something is already here.',
                'The wrong detail arrives, and you understand.',
            ],
            romance:   [
                "You weren't expecting this.",
                'Something shifts. Small. Irreversible.',
                'You almost say it. Almost.',
            ],
            adventure: [
                'Time to move.',
                'The horizon is the only answer.',
                'Whatever comes next, you face it forward.',
            ],
        };
        const pool = genericHooks[_sceneMode] || genericHooks.romance;
        hookLine = pool[Math.floor(Math.random() * pool.length)];
    }
    if (hookLine) sentences.push(hookLine);

    // ── Complication (item 4) ───────────────────────────────────────────
    // Injected as a closing note so it's present but doesn't override the hook
    if (complication) {
        sentences.push(`[Complication: ${complication}]`);
    }

    // ── NPC / Player context ────────────────────────────────────────────
    const npcs = g('forge-scene-npcs');
    const plyr = g('forge-scene-player');
    const ctx  = [];
    if (npcs) ctx.push(`Present: ${npcs}`);
    if (plyr) ctx.push(`Player: ${plyr}`);

    let out = sentences.join(' ');
    if (ctx.length) out += '\n\n' + ctx.join('\n');
    return out.trim() || null;
}

function buildExampleDialogue() {
    const valid = _dialoguePairs.filter(p => p.user || p.char);
    if (!valid.length) return null;
    // Labels are UI-only — never included in mes_example output
    return valid.map(p => `<START>\n{{user}}: ${p.user || '…'}\n{{char}}: ${p.char || '…'}`).join('\n\n');
}

function buildSystemPrompt() {
    const name    = g('forge-char-name');
    const species = cleanList(kwGet('species'));
    const role    = cleanList(kwGet('role'));
    const pers    = [...cleanList(kwGet('personality')), ...cleanList(kwGet('disposition'))];
    const traits  = cleanList(kwGet('traits'));
    const verbal  = cleanList(kwGet('verbal'));
    const limits  = kwGet('limits').map(positivePhrase);
    const kinks   = cleanList(kwGet('kinks'));
    const skills  = cleanList(kwGet('skills'));
    const marker  = getVoiceMarker();
    const mod     = SCENE_MODE_MODIFIERS[_sceneMode] || SCENE_MODE_MODIFIERS.romance;
    const persona = g('forge-persona-note');
    const custom  = g('forge-style-custom');
    const relChips = cleanList(kwGet('relationship'));
    const relKey   = relChips.length ? relChips[0].toLowerCase() : null;
    const relGuide = relKey ? RELATIONSHIP_GUIDANCE[relKey] : null;

    const blocks = [];

    // ── Identity anchor ───────────────────────────────────────────────────
    const idParts = [name, ...species, ...role].filter(Boolean);
    const corePers = pers.length ? pers.slice(0, 2).join(', ') : null;
    if (idParts.length) {
        const identityLine = corePers
            ? `{{char}} is ${idParts.join(', ')}, defined by ${corePers}.`
            : `{{char}} is ${idParts.join(', ')}.`;
        blocks.push(identityLine);
    }

    // ── Behavior block — voice marker as directive, not description ───────
    const behaviorLines = [];

    if (marker) {
        // Imperative framing: tell the LLM *how to act*, not *what the character is*
        behaviorLines.push(`Lead with: ${marker.open}.`);
        if (marker.crack) behaviorLines.push(`Under pressure or over time: ${marker.crack}.`);
        if (marker.avoid) behaviorLines.push(`Never: ${marker.avoid}.`);
    } else if (pers.length) {
        behaviorLines.push(`${cap(pers.join(', '))}.`);
    }

    if (traits.length) behaviorLines.push(`Traits: ${traits.join(', ')}.`);
    if (skills.length) behaviorLines.push(`Skills: ${skills.join(', ')}.`);

    if (behaviorLines.length) {
        blocks.push('Behavior:\n' + behaviorLines.map(l => `  ${l}`).join('\n'));
    }

    // ── Relationship dynamic (item 3) ─────────────────────────────────────
    if (relGuide) {
        blocks.push(`Relationship:\n  ${relGuide}`);
    }

    // ── Voice block ───────────────────────────────────────────────────────
    const voiceLines = [];
    if (verbal.length) voiceLines.push(verbal.join(', ') + '.');
    const voiceNote = g('forge-voice-note');
    if (voiceNote) voiceLines.push(voiceNote + '.');
    // Append mode register
    voiceLines.push(`${mod.rhythm}.`);

    blocks.push('Voice:\n' + voiceLines.map(l => `  ${l}`).join('\n'));

    // ── Rules block (limits → behavioral instructions) ────────────────────
    const ruleLines = [];
    const requires  = cleanList(kwGet('requires'));
    if (requires.length) {
        ruleLines.push(`Needs: ${requires.join(', ')}.`);
    }
    for (const lim of limits) {
        const lower = lim.toLowerCase().trim();
        const rule  = POSITIVE_REPHRASES.get(lower) || lim;
        ruleLines.push(`Never ${rule.toLowerCase()}.`);
    }
    if (_explicitAnat || kinks.length) {
        ruleLines.push('Explicit sexual content is permitted and expected.');
    }
    if (ruleLines.length) {
        blocks.push('Rules:\n' + ruleLines.map(l => `  ${l}`).join('\n'));
    }

    // ── Narrator persona ──────────────────────────────────────────────────
    if (persona) {
        blocks.push(`Narrator:\n  ${persona}`);
    }

    // ── Notes (free-form) ─────────────────────────────────────────────────
    if (custom) {
        blocks.push(`Notes:\n  ${positivePhrase(custom)}`);
    }

    // ── Author's Note style tag (kept for AN compatibility) ───────────────
    const genre   = g('forge-style-genre') || { literary:'literary fiction', pulp:'pulp adventure', erotic:'adult fiction', horror:'body horror', romance:'romance', adventure:'adventure' }[_sceneMode] || 'roleplay';
    const author  = g('forge-style-author');
    const title   = g('forge-style-title');
    const rating  = g('forge-style-rating') || '4';
    const pov     = cleanList(kwGet('pov'));
    const tense   = cleanList(kwGet('tense')).map(v => v.toLowerCase() + ' tense');
    const styleChips = [...pov, ...tense, ...cleanList(kwGet('rhythm')), ...cleanList(kwGet('vocab')), ...cleanList(kwGet('pacing')), ...cleanList(kwGet('descfocus'))].filter(Boolean);
    const toggles = getActiveToggles();

    let styleTag = `[ Style: ${styleChips.join(', ') || mod.rhythm}; Genre: ${genre}`;
    if (toggles.length) styleTag += `; Tags: ${cleanList(toggles).join(', ')}`;
    if (author) styleTag += `; Author: ${author}`;
    if (title)  styleTag += `; Title: ${title}`;
    styleTag += `; Rating: S:${rating} ]`;
    blocks.push(styleTag);

    return blocks.join('\n\n') || null;
}

// ── setOutput / regen ─────────────────────────────────────────────────────
const _OUTPUT_MAP = [
    ['forge-out-description', 'forge-tok-description', buildDescription],
    ['forge-out-personality', 'forge-tok-personality', buildPersonality],
    ['forge-out-firstmes',    'forge-tok-firstmes',    buildFirstMessage],
    ['forge-out-dialogue',    'forge-tok-dialogue',    buildExampleDialogue],
    ['forge-out-sysprompt',   'forge-tok-sysprompt',   buildSystemPrompt],
];

function toggleLock(id) {
    if (_lockedBlocks.has(id)) _lockedBlocks.delete(id);
    else _lockedBlocks.add(id);
    // Update lock button appearance without full regen
    const el = document.getElementById(id);
    if (!el) return;
    const lockBtn = el.querySelector('.forge-lock-btn');
    if (lockBtn) {
        const locked = _lockedBlocks.has(id);
        lockBtn.textContent = locked ? '🔒' : '🔓';
        lockBtn.title = locked ? 'Unlock (auto-update on)' : 'Lock (preserve this output)';
        el.classList.toggle('forge-locked', locked);
    }
}

function regenBlock(id) {
    const entry = _OUTPUT_MAP.find(e => e[0] === id);
    if (!entry) return;
    setOutput(entry[0], entry[1], entry[2]());
}

function setOutput(id, tokId, content) {
    const el   = document.getElementById(id);
    const tkEl = document.getElementById(tokId);
    if (!el) return;

    // Preserve existing control buttons across rebuild
    const existingCopy = el.querySelector('.forge-copy-btn');
    const existingLock = el.querySelector('.forge-lock-btn');
    const existingRefr = el.querySelector('.forge-refresh-btn');
    el.innerHTML = '';

    // Copy button
    const copyBtn = existingCopy || document.createElement('button');
    copyBtn.className = 'forge-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = function () { FORGE.copyBlock(id, this); };
    el.appendChild(copyBtn);

    // Refresh button (reruns just this block)
    const refrBtn = existingRefr || document.createElement('button');
    refrBtn.className = 'forge-refresh-btn';
    refrBtn.textContent = '↺';
    refrBtn.title = 'Regenerate this block';
    refrBtn.onclick = function () { regenBlock(id); };
    el.appendChild(refrBtn);

    // Lock button
    const locked  = _lockedBlocks.has(id);
    const lockBtn = existingLock || document.createElement('button');
    lockBtn.className   = 'forge-lock-btn';
    lockBtn.textContent = locked ? '🔒' : '🔓';
    lockBtn.title       = locked ? 'Unlock (auto-update on)' : 'Lock (preserve this output)';
    lockBtn.onclick     = function () { toggleLock(id); };
    el.appendChild(lockBtn);

    el.classList.toggle('forge-locked', locked);

    if (content) {
        el.appendChild(document.createTextNode(content));
        if (tkEl) tkEl.textContent = countTokens(content) + ' tk';
    } else {
        const s = document.createElement('span');
        s.className   = 'forge-placeholder';
        s.textContent = 'Fill in details…';
        el.appendChild(s);
        if (tkEl) tkEl.textContent = '0 tk';
    }

    // Regen highlight: brief flash when content changes
    el.classList.remove('forge-regen-highlight');
    void el.offsetWidth; // Force reflow to restart animation
    if (content) el.classList.add('forge-regen-highlight');
}

function regen() {
    for (const [id, tokId, builder] of _OUTPUT_MAP) {
        if (_lockedBlocks.has(id)) continue;
        setOutput(id, tokId, builder());
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// COPY / EXPORT
// ═══════════════════════════════════════════════════════════════════════════
function getBlockText(id) {
    const el = document.getElementById(id);
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.forge-copy-btn').forEach(b => b.remove());
    return clone.textContent.trim();
}

function copyBlock(id, btn) {
    const t = getBlockText(id);
    if (!t || t.includes('Fill in')) return;
    navigator.clipboard.writeText(t).then(() => {
        if (btn) { btn.textContent = 'Copied!'; btn.classList.add('copied'); setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500); }
    });
}

function exportSTCard() {
    const name = g('forge-char-name') || 'Character';
    const tags = (g('forge-st-tags') || '').split(',').map(t => t.trim()).filter(Boolean);

    // ST chara_card_v2 format
    // scenario = world/context framing (shown to AI, not displayed as opening)
    // first_mes = character's opening message (shown to user as first turn)
    const desc = buildDescription() || '';
    const sceneTension = cleanList(kwGet('tension')).join(', ');
    const sceneRel     = cleanList(kwGet('relationship')).join(', ');
    const sceneParts   = [sceneTension, sceneRel, g('forge-scene-situation')].filter(Boolean);
    const scenarioText = sceneParts.length ? sceneParts.join(' — ') : '';
    const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description:              desc,
            personality:              buildPersonality()     || '',
            scenario:                 scenarioText,
            first_mes:                buildFirstMessage()    || '',
            mes_example:              buildExampleDialogue() || '',
            creator_notes:            '',
            system_prompt:            buildSystemPrompt()    || '',
            post_history_instructions:'',
            alternate_greetings:      [],
            tags,
            creator:                  'FORGE Character Creator',
            character_version:        '1.0',
            extensions:               { fav: getSetting('isFav') === true },
        },
    };

    const blob = new Blob([JSON.stringify(card, null, 2)], { type:'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
        href:     url,
        download: `${name.toLowerCase().replace(/\s+/g, '-')}.json`,
    });
    a.click();
    URL.revokeObjectURL(url);
}

function exportJSON() {
    const data = {
        character: { name:g('forge-char-name'), age:g('forge-char-age'), pronouns:kwGet('pronouns'), species:kwGet('species'), role:kwGet('role'), background:kwGet('background'), build:kwGet('build'), height:kwGet('height'), skin:kwGet('skin'), hair:kwGet('hair'), eyes:kwGet('eyes'), face:kwGet('face'), marks:kwGet('marks'), scent:kwGet('scent'), nonhuman:kwGet('nonhuman'), personality:kwGet('personality'), disposition:kwGet('disposition'), traits:kwGet('traits'), skills:kwGet('skills'), voiceNote:g('forge-voice-note'), anatomy:{ chest:kwGet('chest'), nipples:kwGet('nipples'), genitaliaA:kwGet('genitalia-a'), genitaliaB:kwGet('genitalia-b'), rear:kwGet('rear'), pubic:kwGet('pubic'), anal:kwGet('anal'), fluids:kwGet('fluids'), fertility:kwGet('fertility'), erogenous:kwGet('erogenous'), bodymod:kwGet('bodymod') }, sexual:{ experience:kwGet('experience'), role:kwGet('sexrole'), verbal:kwGet('verbal'), kinks:kwGet('kinks'), likes:kwGet('likes'), limits:kwGet('limits'), requires:kwGet('requires'), triggers:kwGet('triggers') } },
        scene:  { tension:kwGet('tension'), relationship:kwGet('relationship'), setting:g('forge-scene-setting'), situation:g('forge-scene-situation'), openingBeat:g('forge-scene-opening-beat'), stakes:g('forge-scene-stakes'), complication:g('forge-scene-complication'), npcs:g('forge-scene-npcs'), player:g('forge-scene-player'), full:g('forge-scene-full') },
        style:  { mode:_sceneMode, pov:kwGet('pov'), tense:kwGet('tense'), rhythm:kwGet('rhythm'), vocab:kwGet('vocab'), pacing:kwGet('pacing'), focus:kwGet('descfocus'), toggles:getActiveToggles(), custom:g('forge-style-custom'), personaNote:g('forge-persona-note'), author:g('forge-style-author'), title:g('forge-style-title'), genre:g('forge-style-genre'), rating:g('forge-style-rating') },
        relationships:_relationships, worldInfoEntries:_loreEntries, dialogue:_dialoguePairs,
        tags:g('forge-st-tags'), cardFormat:_cardFormat, explicitAnatomy:_explicitAnat,
        output:{ description:buildDescription(), personality:buildPersonality(), firstMessage:buildFirstMessage(), exampleDialogue:buildExampleDialogue(), systemPrompt:buildSystemPrompt() },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href:url, download:`forge-${(g('forge-char-name')||'character').toLowerCase().replace(/\s+/g,'-')}.json` });
    a.click(); URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════════════════════
// RANDOMIZE / CLEAR
// ═══════════════════════════════════════════════════════════════════════════
function rfld(id, arr)  { const el = document.getElementById(id); if (el) { el.value = pick(arr); regen(); } }
function rndAge()       { const el = document.getElementById('forge-char-age'); if (el) { el.value = pick([18,19,20,21,22,24,26,28,30,35,40,50,100,200,500,1000]); regen(); } }

function _rndGenitalia() {
    KW_STATE['genitalia-a'] = []; KW_STATE['genitalia-b'] = [];
    const gt = pick(['vagina','penis','futanari — both']);
    kwToggleItem('genitalia-a', gt);
    if (gt === 'penis' || gt === 'futanari — both') {
        kwToggleItem('genitalia-a', pick(['humanoid penis','equine penis','canine penis — knotted','draconic penis']));
        kwToggleItem('genitalia-a', pick(['average — 6in','large — 8in','impressive — 9in']));
        kwToggleItem('genitalia-a', pick(['thick','girthy','average girth']));
        kwToggleItem('genitalia-a', pick(['ridged — light','knotted — one','medial ring','flared tip','smooth']));
    }
    if (gt === 'vagina' || gt === 'futanari — both') {
        kwToggleItem('genitalia-a', pick(['outer labia — full','outer labia — slim','inner labia — protruding']));
        kwToggleItem('genitalia-a', pick(['tight','very tight','accommodating']));
        kwToggleItem('genitalia-a', pick(['velvety interior','ridged interior','smooth interior']));
    }
}

function randomizeIdentity() {
    rfld('forge-char-name', NAMES); rndAge();
    ['pronouns','species','role','background'].forEach(k => kwRandom(k));
    regen();
}

function randomizeAppearance() {
    ['build','height','skin','hair','eyes','face','marks','scent','nonhuman'].forEach(k => kwRandom(k));
    regen();
}

function randomizePersonality() {
    ['personality','disposition','traits','skills'].forEach(k => kwRandom(k));
    ['forge-sl-ds','forge-sl-sb','forge-sl-cw','forge-sl-pc'].forEach(id => {
        const el = document.getElementById(id); if (el) { el.value = Math.floor(Math.random() * 11); slv(id); }
    });
    regen();
}

function randomizeAnatomy() {
    ['chest','nipples','rear','pubic','anal','fluids','fertility','erogenous','bodymod',
     'experience','sexrole','verbal','kinks','likes','limits','triggers','requires'].forEach(k => kwRandom(k));
    _rndGenitalia();
    regen();
}

function randomizeScene() {
    ['tension','relationship'].forEach(k => kwRandom(k));
    const arch = SCENE_ARCHETYPES[Math.floor(Math.random() * SCENE_ARCHETYPES.length)];
    kwSet('tension',      [arch.tension]);
    kwSet('relationship', [arch.relationship]);
    const el = document.getElementById('forge-scene-situation');
    if (el) el.value = arch.situation;
    document.querySelectorAll('#forge-scene-archetypes .forge-preset-card').forEach(c => c.classList.remove('active'));
    regen();
}

function randomizeStyle() {
    ['pov','tense','rhythm','vocab','pacing','descfocus'].forEach(k => kwRandom(k));
    regen();
}

function randomizeAll() {
    rfld('forge-char-name', NAMES); rndAge();
    ['pronouns','species','role','background','build','height','skin','hair','eyes','face','marks','scent','nonhuman',
     'personality','disposition','traits','skills',
     'chest','nipples','rear','pubic','anal','fluids','fertility','erogenous','bodymod',
     'experience','sexrole','verbal','kinks','likes','limits','triggers','requires',
     'tension','relationship','pov','tense','rhythm','vocab','pacing','descfocus'
    ].forEach(k => kwRandom(k));
    _rndGenitalia();
    ['forge-sl-ds','forge-sl-sb','forge-sl-cw','forge-sl-pc'].forEach(id => {
        const el = document.getElementById(id); if (el) { el.value = Math.floor(Math.random() * 11); slv(id); }
    });
    regen();
}

function clearAll() {
    document.querySelectorAll('#forge-panel input[type="text"],#forge-panel input[type="number"],#forge-panel textarea').forEach(el => { el.value = ''; });
    Object.keys(KW_STATE).forEach(k => { KW_STATE[k] = []; kwRender(k); });
    ['forge-sl-ds','forge-sl-sb','forge-sl-cw','forge-sl-pc'].forEach(id => { const el = document.getElementById(id); if (el) { el.value = 5; slv(id); } });
    document.querySelectorAll('.forge-preset-card.active').forEach(c => c.classList.remove('active'));
    _relationships = []; _loreEntries = []; _dialoguePairs = [];
    renderRelationships(); renderLore(); renderDialogue(); regen();
}

// ═══════════════════════════════════════════════════════════════════════════
// UI CONTROLS
// ═══════════════════════════════════════════════════════════════════════════
function setFormat(fmt, btn) {
    _cardFormat = fmt; setSetting('cardFormat', fmt);
    document.querySelectorAll('.forge-format-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    regen();
}
function toggleExplicit(el) {
    el.classList.toggle('active');
    _explicitAnat = el.classList.contains('active');
    setSetting('explicitAnatomy', _explicitAnat);
    regen();
}
function toggleFav(el) {
    el.classList.toggle('active');
    _isFav = el.classList.contains('active');
    setSetting('isFav', _isFav);
}

function toggleCompactMode(el) {
    el.classList.toggle('active');
    const col = document.getElementById('forge-output-col');
    if (col) col.classList.toggle('forge-compact-mode', el.classList.contains('active'));
}

function generateAvatarPrompt() {
    const name = g('forge-char-name') || 'character';
    const parts = [`portrait of ${name}`,
        ...[...cleanList(kwGet('build')),...cleanList(kwGet('height'))],
        kwGet('skin').length  ? join(cleanList(kwGet('skin')))  + ' skin'  : '',
        kwGet('hair').length  ? join(cleanList(kwGet('hair')))  + ' hair'  : '',
        kwGet('eyes').length  ? join(cleanList(kwGet('eyes')))  + ' eyes'  : '',
        ...cleanList(kwGet('face')),
        ...cleanList(kwGet('nonhuman')),
        ...cleanList(kwGet('marks')),
        'dramatic lighting, high quality fantasy portrait',
    ].filter(Boolean);
    const prompt = parts.join(', ');
    const el = document.getElementById('forge-out-avatar-prompt');
    if (el) { el.style.display = 'block'; el.textContent = prompt; }
    navigator.clipboard.writeText(prompt).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// ST CARD READ / WRITE / CREATE / WORLD INFO PUSH
// ═══════════════════════════════════════════════════════════════════════════
async function writeToCard() {
    const btn = document.getElementById('forge-write-card-btn');
    if (btn) { btn.textContent = '…writing'; btn.disabled = true; }
    try {
        const ctx    = getContext();
        const charId = ctx?.characterId;
        if (charId == null) { showStatus('No character selected in ST.', true); return; }

        const charData = {
            name:          g('forge-char-name') || ctx.characters[charId]?.name || '',
            description:   buildDescription()     || '',
            personality:   buildPersonality()     || '',
            first_mes:     buildFirstMessage()    || '',
            mes_example:   buildExampleDialogue() || '',
            system_prompt: buildSystemPrompt()    || '',
            fav:           _isFav,
            tags:          g('forge-st-tags').split(',').map(t => t.trim()).filter(Boolean),
        };

        if (typeof _saveCharacter === 'function') {
            await _saveCharacter(charId, charData);
        } else {
            // Fallback: populate ST's form fields and trigger save
            const setField = (sel, val) => {
                const el = document.querySelector(sel);
                if (el && val != null) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }
            };
            setField('#character_name_pole',            charData.name);
            setField('#character_description_pole',     charData.description);
            setField('#character_personality_pole',     charData.personality);
            setField('#character_first_message_pole',   charData.first_mes);
            setField('#character_mes_example_pole',     charData.mes_example);
            setField('#character_system_prompt_pole',   charData.system_prompt);
            const saveBtn = document.querySelector('#create_button,[name="create_button"]');
            if (saveBtn) saveBtn.click();
        }
        setSetting('lastCharId', charId);
        showStatus(`✓ Written to "${charData.name || 'character'}" card.`);
    } catch (err) {
        console.error('[FORGE] writeToCard:', err);
        showStatus('Write failed — check console.', true);
    } finally {
        if (btn) { btn.textContent = '⬛ Write to Card'; btn.disabled = false; }
    }
}

async function loadFromCard() {
    try {
        const ctx  = getContext();
        const char = ctx?.characters?.[ctx?.characterId];
        if (!char) { showStatus('No character selected.', true); return; }

        const sv = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
        sv('forge-char-name', char.name || '');
        sv('forge-st-tags', Array.isArray(char.tags) ? char.tags.join(', ') : (char.tags || ''));
        if (char.first_mes)     sv('forge-scene-full',   char.first_mes);
        if (char.system_prompt) sv('forge-persona-note', char.system_prompt);
        if (char.personality)   sv('forge-voice-note',   char.personality);

        const favEl = document.getElementById('forge-fav-toggle');
        if (favEl) { _isFav = !!char.fav; favEl.classList.toggle('active', _isFav); }

        // Attempt W++ parse back into chip state
        if (char.description?.startsWith('[character(')) _parseWpp(char.description);

        refreshAvatarDisplay();
        regen();
        showStatus(`✓ Loaded from "${char.name || 'character'}".`);
    } catch (err) {
        console.error('[FORGE] loadFromCard:', err);
        showStatus('Load failed — check console.', true);
    }
}

function _parseWpp(text) {
    try {
        const nm = text.match(/\[character\("([^"]+)"\)/);
        if (nm) { const el = document.getElementById('forge-char-name'); if (el) el.value = nm[1]; }
        const bRe = /(\w+)\(((?:"[^"]*"\s*)+)\)/g;
        const map  = { personality:'traits', appearance:'build', background:'background', skills:'skills', body:'chest', sexual:'genitalia-a', kinks:'kinks', limits:'limits', sexrole:'sexrole', nonhuman:'nonhuman' };
        let m;
        while ((m = bRe.exec(text)) !== null) {
            const kwKey = map[m[1].toLowerCase()];
            if (kwKey) kwSet(kwKey, [...m[2].matchAll(/"([^"]*)"/g)].map(v => v[1]));
        }
    } catch (_) { /* partial parse OK */ }
}

async function createNewCard() {
    try {
        const name = g('forge-char-name') || 'New Character';
        if (typeof _createCharacter === 'function') {
            await _createCharacter({ name });
            showStatus(`✓ Created "${name}". Fill details and Write to Card.`);
        } else {
            const btn = document.querySelector('#rm_button_create,#create_new_character');
            if (btn) { btn.click(); showStatus('Opened new character — Write to Card when ready.'); }
            else showStatus('Could not find ST new-character button.', true);
        }
    } catch (err) {
        console.error('[FORGE] createNewCard:', err);
        showStatus('Create failed — check console.', true);
    }
}

async function pushWorldInfo() {
    const sel  = document.getElementById('forge-world-target');
    const world = sel?.value;
    if (!world)  { showStatus('Select a world target first.', true); return; }
    if (!_loreEntries.length) { showStatus('No entries to push.', true); return; }
    if (typeof _createWorldInfoEntry !== 'function') { showStatus('World Info API unavailable in this ST build.', true); return; }
    let pushed = 0;
    for (const e of _loreEntries) {
        if (!e.keyword && !e.content) continue;
        try { await _createWorldInfoEntry(world, { key:[e.keyword||''], content:e.content||'', comment:e.keyword||'FORGE entry' }); pushed++; }
        catch (err) { console.warn('[FORGE] pushWorldInfo entry:', err); }
    }
    showStatus(`✓ Pushed ${pushed} entr${pushed !== 1 ? 'ies' : 'y'} to "${world}".`);
}

// ═══════════════════════════════════════════════════════════════════════════
// WIDGET INIT (called once overlay DOM is ready)
// ═══════════════════════════════════════════════════════════════════════════
function initAllWidgets() {
    const BINDINGS = [
        ['pronouns','fw-pronouns'],    ['species','fw-species'],       ['role','fw-role'],
        ['background','fw-background'],['build','fw-build'],           ['height','fw-height'],
        ['skin','fw-skin'],            ['hair','fw-hair'],             ['eyes','fw-eyes'],
        ['face','fw-face'],            ['marks','fw-marks'],           ['scent','fw-scent'],
        ['nonhuman','fw-nonhuman'],    ['personality','fw-personality'],['disposition','fw-disposition'],
        ['traits','fw-traits'],        ['skills','fw-skills'],
        ['chest','fw-chest'],          ['nipples','fw-nipples'],       ['genitalia-a','fw-genitalia-a'],
        ['genitalia-b','fw-genitalia-b'],['rear','fw-rear'],           ['pubic','fw-pubic'],
        ['anal','fw-anal'],            ['fluids','fw-fluids'],         ['fertility','fw-fertility'],
        ['erogenous','fw-erogenous'],  ['bodymod','fw-bodymod'],
        ['experience','fw-experience'],['sexrole','fw-sexrole'],       ['verbal','fw-verbal'],
        ['kinks','fw-kinks'],          ['likes','fw-likes'],           ['limits','fw-limits'],
        ['triggers','fw-triggers'],    ['requires','fw-requires'],
        ['tension','fw-tension'],      ['relationship','fw-relationship'],
        ['pov','fw-pov'],              ['tense','fw-tense'],           ['rhythm','fw-rhythm'],
        ['vocab','fw-vocab'],          ['pacing','fw-pacing'],         ['descfocus','fw-descfocus'],
    ];
    BINDINGS.forEach(([key, cid]) => kwInit(key, cid));
    renderRelationships(); renderSceneArchetypes(); renderSceneModes();
    renderWorldLorePresets(); renderLore(); renderDialogue();
    ['forge-sl-ds','forge-sl-sb','forge-sl-cw','forge-sl-pc'].forEach(id => slv(id));
    regen();
}

// ═══════════════════════════════════════════════════════════════════════════
// FORGE NAMESPACE  — exposed on window for inline HTML onclick handlers
// ═══════════════════════════════════════════════════════════════════════════
const FORGE = {
    // data refs used by inline handlers in creator.html
    NAMES, NPC_PRESETS, SCENE_ARCHETYPES, TENSION_TYPES, RELATIONSHIP_HISTORY,

    // panel
    open:  openPanel,
    close: closePanel,

    // chip engine
    kwToggleDD, kwRandom, kwSet, kwGet,

    // output
    regen, regenBlock, toggleLock, getVoiceMarker,

    // UI
    setFormat, toggleExplicit, toggleFav, toggleCompactMode, toggleItem,
    toggleSection, collapseAll, expandAll, slv,
    rfld, rndAge,
    randomizeAll, randomizeIdentity, randomizeAppearance,
    randomizePersonality, randomizeAnatomy, randomizeScene, randomizeStyle,
    clearAll,
    copyBlock, exportJSON, exportSTCard, generateAvatarPrompt,

    // renderers
    renderLore, renderDialogue, renderRelationships,
    addRelationship, removeRelationship, randomizeRelationships,
    addLore, sendCharToWorldInfo, injectExtensionDrawerButton,
    addDialoguePair, randomizeDialogue, generatePersonalityDialogue, generateSceneDialogue,

    // ST API
    writeToCard, loadFromCard, createNewCard, pushWorldInfo,
};

window.FORGE = FORGE;

// ═══════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════
jQuery(async () => { await extensionInit(); });

export {
    openPanel, closePanel,
    refreshWorldTargetDropdown, refreshAvatarDisplay, showStatus,
    getSetting, setSetting,
    _saveCharacter, _createCharacter, _createWorldInfoEntry, _getTokenCount,
    _eventSource, _event_types,
};
