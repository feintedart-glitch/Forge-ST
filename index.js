/**
 * FORGE Character Creator — SillyTavern Extension
 * Install into SillyTavern as third-party extension: feintedart-glitch/Forge-ST
 *
 * Commit 1 of 3: Extension registration, settings, UI injection, event hooks
 */

import { extension_settings, getContext, saveSettingsDebounced } from '../../../extensions.js';

// Derive base URL from this module's location so template path is always correct
const _BASE_URL = (() => {
    try { return new URL('.', import.meta.url).href; }
    catch (_) { return `/scripts/extensions/third-party/Forge-ST/`; }
})();

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

// ═══════════════════════════════════════════════════════════════════════════
// COMMIT 2 — DATA TABLES
// Ported from FORGE.html with additions: +10 roles, +10 kinks
// ═══════════════════════════════════════════════════════════════════════════

const NAMES = [
    'Lyra','Cassia','Vael','Seraph','Maren','Drex','Isolde','Kira','Thessaly',
    'Aldric','Nyxara','Corin','Fen','Elowen','Sable','Darian','Astraea','Rook',
    'Vella','Cade','Lirien','Theron','Mira','Zephyr','Oryn','Selene','Tam',
    'Auren','Vesper','Nyx','Rhea','Castor','Lune','Arden','Soren',
];

const NPC_PRESETS = [
    'none — alone','a single ally','a crowd','enemies outside',
    'a servant','a rival','a witness','a stranger','two guards',
];

const HOOKS = [
    "The door clicks shut. Neither of you moves.",
    "You'd been warned about this one.",
    "It starts the way these things always start — badly.",
    "They look at you like they've been waiting.",
    "The blood on your hands isn't entirely theirs.",
    "You weren't supposed to find this room.",
    "This was always going to happen.",
    "Three heartbeats of silence before something breaks.",
    "The word no dies somewhere between thought and voice.",
    "They don't ask if you're sure. Neither do you.",
    "Something in the way they said your name.",
    "You told yourself this would only happen once.",
];

const SCENE_PRESETS_DATA = [
    { genre:'Fantasy',     name:'Dark Court',    location:'throne room',                        atmosphere:'midnight, torchlight',                         situation:'summons that cannot be refused',                    mood:'tense, dangerous',       hook:"The throne is occupied. You were not invited to sit." },
    { genre:'Sci-Fi',      name:'Last Ship',     location:'deep space vessel',                  atmosphere:'emergency red lighting',                       situation:'two survivors, limited time',                       mood:'desperate, urgent',      hook:"The airlock seals. You run the math. You don't tell them the math." },
    { genre:'Contemporary',name:'Late Night',    location:'empty bar after close',              atmosphere:'3am, city quiet',                              situation:'a deal, or what looks like one',                    mood:'erotically charged',     hook:'The last glass is poured. Neither of you leaves.' },
    { genre:'Horror',      name:'The House',     location:'old house, rooms that shift',        atmosphere:'storm, power out',                             situation:'trapped inside',                                    mood:'dark, foreboding',       hook:"The lights go out at the moment you realize the door won't open." },
    { genre:'Romance',     name:'Reunion',       location:'hotel room',                         atmosphere:'evening, golden lamplight, rain',               situation:'reunion years in the making',                       mood:'warmly intimate',        hook:"You'd rehearsed this. None of it comes out right." },
    { genre:'Dungeon',     name:'The Cell',      location:'dungeon, stone and chain',           atmosphere:'indeterminate, timeless',                      situation:'prisoner and keeper',                               mood:'charged, dangerous',     hook:"The key turns. They didn't expect you to look at them like that." },
    { genre:'Fantasy',     name:'Sacred Rite',   location:'forest clearing, standing stones',   atmosphere:'full moon, midsummer',                         situation:'ritual requiring both of you',                      mood:'surreal, dreamlike',     hook:"The stones hum. The ritual doesn't care about your feelings." },
    { genre:'Sci-Fi',      name:'Synthetic',     location:'research lab, after hours',          atmosphere:'2am, facility empty',                          situation:'the AI has been learning something specific',       mood:'unsettling, intimate',   hook:'It says your name differently now.' },
    { genre:'World',       name:"Khorvynn's Gate",location:"Khorvynn's Gate — the free city between worlds", atmosphere:'sea wind, foreign tongues, polite tension between enemies', situation:'travelers from rival kingdoms forced onto neutral ground', mood:'cosmopolitan, charged, danger beneath civility', hook:"Half the city wants something from the other half. You haven't decided which half you belong to." },
];

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

    triggers: { label:'Arousal Triggers', limit:5, random:['sustained eye contact','voice — low and close','being watched','rough hands'], groups:[
        { g:'Sensory',     i:['sustained eye contact','being watched intently','voice — low and close','voice — commanding','breath on skin','rough hands','cold hands','proximity heat','being undressed slowly','fabric on skin','sudden stillness','deliberate slowness','weight on them','fingers in hair','nails on skin'] },
        { g:'Situational', i:['shift in power','being chosen','being needed','feeling exposed','someone losing composure','being studied','being cornered','unexpected tenderness','vulnerability shown','danger nearby','being the only one','long silence broken','being caught wanting','being undone slowly'] },
        { g:'Verbal',      i:['being spoken to gently','being spoken to harshly','praise','commands','specific words','own name said a certain way'] },
    ]},

    // ── SCENE ────────────────────────────────────────────────────────────────
    location: { label:'Setting / Location', limit:4, random:['throne room, after midnight','empty bar after close','dungeon, stone and chains','luxury penthouse'], groups:[
        { g:'Fantasy',     i:['throne room','castle — great hall','castle dungeon','tavern back room','abandoned temple','forest clearing','mountain keep','mage tower','underground city','planar void','crumbled ruin'] },
        { g:'Contemporary',i:['luxury penthouse','empty bar after close','hotel room','office after hours','rooftop','city alley','warehouse','small apartment','parking garage','moving vehicle'] },
        { g:'Sci-Fi',      i:['deep space vessel','station corridor','research lab','alien planet surface','cryopod bay','ship cockpit','derelict ship','synthetic facility','orbital platform'] },
        { g:'Modifier',    i:['isolated — no witnesses','no exits','observed — unseen','decaying','pristine','after a battle','during a storm','underground'] },
    ]},

    atmosphere: { label:'Time / Atmosphere', limit:4, random:['deep midnight','during a thunderstorm','golden hour'], groups:[
        { g:'Time of day', i:['deep midnight','3am — dead hours','just before dawn','sunrise','morning','midday','golden hour','dusk','evening'] },
        { g:'Weather',     i:['thunderstorm','heavy rain','light rain','clear night — full moon','overcast','snow','oppressive heat','bitter cold'] },
        { g:'Light',       i:['torchlight','candlelight','firelight','emergency red lighting','golden lamplight','flickering','complete darkness','bioluminescent','harsh fluorescent','neon-lit','dim and smoky'] },
    ]},

    situation: { label:'Inciting Situation', limit:3, random:['a deal being struck','an ambush survived together','a confession forced by circumstances'], groups:[
        { g:'Conflict',    i:['a deal being struck','a negotiation turning personal','a threat made good on','an ambush survived together','a chase ending here','a duel that ends differently','a standoff that breaks'] },
        { g:'Revelation',  i:['a confession forced by circumstances','a secret discovered','a lie exposed','a disguise dropped','realising who they really are'] },
        { g:'Connection',  i:['reunion after long absence','first meeting under terrible conditions','the moment before a goodbye','trapped together','sharing something neither intended'] },
    ]},

    mood: { label:'Tension / Mood', limit:2, random:['tense and dangerous','erotically charged','warmly intimate'], groups:[
        { g:'Mood', i:['tense and dangerous','erotically charged','warmly intimate','dark and foreboding','playful and light','desperate and urgent','quietly melancholic','surreal and dreamlike','bittersweet','raw and unguarded','charged with violence','tender and fragile'] },
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
// SCENE PRESETS + MODES
// ═══════════════════════════════════════════════════════════════════════════
function renderScenePresets() {
    const c = document.getElementById('forge-scene-presets');
    if (!c) return;
    SCENE_PRESETS_DATA.forEach(p => {
        const card = document.createElement('div');
        card.className = 'forge-preset-card';
        card.innerHTML = `<div class="forge-preset-tag">${p.genre}</div><div class="forge-preset-name">${p.name}</div>`;
        card.onclick   = () => {
            document.querySelectorAll('#forge-scene-presets .forge-preset-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            kwSet('location',   [p.location]);
            kwSet('atmosphere', [p.atmosphere]);
            kwSet('situation',  [p.situation]);
            kwSet('mood',       [p.mood]);
            const hookEl = document.getElementById('forge-scene-hook');
            if (hookEl) hookEl.value = p.hook;
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
                const hookEl = document.getElementById('forge-scene-hook');
                if (hookEl) hookEl.value = sc.hook;
                kwSet('location',   [wp.keys[0]]);
                kwSet('atmosphere', ['sea wind, foreign tongues, polite tension between enemies']);
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
// DIALOGUE BUILDER
// ═══════════════════════════════════════════════════════════════════════════
function renderDialogue() {
    const c = document.getElementById('forge-dialogue-list');
    if (!c) return;
    c.innerHTML = '';
    _dialoguePairs.forEach((pair, i) => {
        const d = document.createElement('div');
        d.className = 'forge-dialogue-pair';
        d.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <span style="font-family:var(--forge-font-mono);font-size:9px;color:var(--forge-gold-dim);letter-spacing:.1em;">EXCHANGE ${i + 1}</span>
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
    _dialoguePairs.push({ id: Date.now(), user: '', char: '' });
    renderDialogue();
}
function randomizeDialogue() {
    _dialoguePairs = [];
    const count = Math.floor(Math.random() * 3) + 1;
    for (let i = 0; i < count; i++) {
        const ex = pick(DIALOGUE_EXAMPLES);
        _dialoguePairs.push({ id: Date.now() + i, user: ex.user, char: ex.char });
    }
    renderDialogue();
}

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
    const app  = [...kwGet('build'),...kwGet('height'),...kwGet('skin'),...kwGet('hair'),...kwGet('eyes'),...kwGet('face'),...kwGet('marks'),...kwGet('scent'),...kwGet('nonhuman')];
    const pers = [...kwGet('personality'),...kwGet('disposition'),...kwGet('traits')];
    const anat = _explicitAnat ? [...kwGet('chest'),...kwGet('nipples'),...kwGet('genitalia-a'),...kwGet('genitalia-b'),...kwGet('rear'),...kwGet('pubic'),...kwGet('anal'),...kwGet('fluids'),...kwGet('fertility'),...kwGet('erogenous'),...kwGet('bodymod')] : [];
    const lines = [
        nv('Name',      name),
        nv('Species',   lowerJoin(species)),
        nv('Gender',    lowerJoin(kwGet('pronouns'))),
        nv('Age',       g('forge-char-age')),
        nv('Role',      lowerJoin(role)),
        nv('Appearance',lowerJoin(app)),
        nv('Personality',lowerJoin(pers)),
        nv('Background',lowerJoin(kwGet('background'))),
        nv('Skills',    lowerJoin(kwGet('skills'))),
        anat.length ? nv('Anatomy', lowerJoin(anat)) : null,
        nv('Sexuality', lowerJoin([...kwGet('sexrole'),...kwGet('experience')])),
    ].filter(Boolean);
    return lines.join('\n') || null;
}

// ── W++ ───────────────────────────────────────────────────────────────────
function buildWpp() {
    const name = g('forge-char-name') || 'Character';
    const qq   = arr => cleanList(arr).map(v => `"${v}"`).join(' ');
    const blocks = [];

    const pers = [...kwGet('personality'),...kwGet('disposition'),...kwGet('traits'),...getSliderAxes()];
    if (pers.length) blocks.push(`Personality(${qq(pers)})`);

    const app = [...kwGet('build'),...kwGet('height'),...kwGet('skin'),...kwGet('hair'),...kwGet('eyes'),...kwGet('face')];
    if (app.length) blocks.push(`Appearance(${qq(app)})`);

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
        const body = [...kwGet('chest'),...kwGet('nipples'),...kwGet('rear'),...kwGet('pubic'),...kwGet('erogenous'),...kwGet('bodymod')];
        if (body.length) blocks.push(`Body(${qq(body)})`);
        const sex = [...kwGet('genitalia-a'),...kwGet('genitalia-b'),...kwGet('anal'),...kwGet('fluids'),...kwGet('fertility')];
        if (sex.length)  blocks.push(`Sexual(${qq(sex)})`);
        const kinks = [...kwGet('kinks'),...kwGet('likes')];
        if (kinks.length) blocks.push(`Kinks(${qq(kinks)})`);
        const limits = kwGet('limits').map(positivePhrase);
        if (limits.length) blocks.push(`Limits(${limits.map(v => `"${v}"`).join(' ')})`);
        const sr = kwGet('sexrole');
        if (sr.length) blocks.push(`SexRole(${qq(sr)})`);
        const vb = kwGet('verbal');
        if (vb.length) blocks.push(`VerbalStyle(${qq(vb)})`);
    }

    if (!blocks.length) return null;
    return `[character("${name}") {\n${blocks.join('\n')}\n}]`;
}

// ── PList ─────────────────────────────────────────────────────────────────
function buildPList() {
    const name = g('forge-char-name') || 'Character';
    const pers  = [...kwGet('personality'),...kwGet('disposition'),...kwGet('traits'),...getSliderAxes()];
    const app   = [...kwGet('build'),...kwGet('height'),...kwGet('skin'),...kwGet('hair'),...kwGet('eyes'),...kwGet('face'),...kwGet('marks'),...kwGet('nonhuman')];
    const parts = [];
    const sp = kwGet('species'); if (sp.length) parts.push(`species: ${lowerJoin(sp)}`);
    const rl = kwGet('role');    if (rl.length) parts.push(`role: ${lowerJoin(rl)}`);
    const ag = g('forge-char-age'); if (ag) parts.push(`age: ${ag}`);
    if (pers.length) parts.push(`personality: ${lowerJoin(pers)}`);
    if (app.length)  parts.push(`appearance: ${lowerJoin(app)}`);
    const bg = kwGet('background'); if (bg.length) parts.push(`background: ${lowerJoin(bg)}`);
    const sk = kwGet('skills');     if (sk.length) parts.push(`skills: ${lowerJoin(sk)}`);
    const voice = g('forge-voice-note'); if (voice) parts.push(`voice: ${voice}`);
    const rels = _relationships.filter(r => r.role || r.name);
    if (rels.length) parts.push(`relationships: ${rels.map(r => `${positivePhrase(r.role || 'related')} of ${positivePhrase(r.name || 'unknown')}`).join(', ')}`);
    if (_explicitAnat) {
        const body = [...kwGet('chest'),...kwGet('nipples'),...kwGet('rear'),...kwGet('pubic'),...kwGet('genitalia-a'),...kwGet('genitalia-b')];
        if (body.length) parts.push(`body: ${lowerJoin(body)}`);
        const sexd = [...kwGet('sexrole'),...kwGet('experience'),...kwGet('kinks'),...kwGet('likes')];
        if (sexd.length) parts.push(`sexual: ${lowerJoin(sexd)}`);
        const lim = kwGet('limits').map(positivePhrase);
        if (lim.length) parts.push(`limits: ${lim.map(v => v.toLowerCase()).join(', ')}`);
    }
    if (!parts.length) return null;
    return `${name}: [${parts.join('; ')}]`;
}

// ── Prose ─────────────────────────────────────────────────────────────────
function buildProse() {
    const name     = g('forge-char-name');
    const species  = kwGet('species');
    const role     = kwGet('role');
    if (!name && !species.length && !role.length) return null;

    const pronouns = kwGet('pronouns');
    const pro      = pronouns.length ? cleanList(pronouns)[0] : null;
    const pronRef  = pro
        ? (pro.startsWith('she') ? 'She has' : pro.startsWith('he') ? 'He has' : 'They have')
        : (name ? `${name} has` : 'Has');

    const lines = [];

    // Identity
    const id = [name,...cleanList(species),...cleanList(role)].filter(Boolean);
    const ag = g('forge-char-age');
    if (ag) id.push(ag + ' years old');
    lines.push(id.join(', ') + '.');

    // Appearance
    const build  = kwGet('build'); const height = kwGet('height');
    const skin   = kwGet('skin');  const hair   = kwGet('hair');
    const eyes   = kwGet('eyes');  const face   = kwGet('face');
    const phys   = [...cleanList(build),...cleanList(height)].join(', ');
    const colour = [
        skin.length  ? join(cleanList(skin))  + ' skin'  : '',
        hair.length  ? join(cleanList(hair))  + ' hair'  : '',
        eyes.length  ? join(cleanList(eyes))  + ' eyes'  : '',
    ].filter(Boolean);
    if (face.length) colour.push(...cleanList(face));
    if (phys || colour.length) {
        lines.push(`${pronRef} a ${phys}${phys && colour.length ? ', with ' : ''}${colour.join(', ')}.`);
    }

    const marks   = kwGet('marks');   if (marks.length)   lines.push(`Marks: ${join(cleanList(marks))}.`);
    const scent   = kwGet('scent');   if (scent.length)   lines.push(`Scent: ${join(cleanList(scent))}.`);
    const nh      = kwGet('nonhuman');if (nh.length)      lines.push(`Non-human features: ${join(cleanList(nh))}.`);

    // Personality
    const pers = [...kwGet('personality'),...kwGet('disposition'),...kwGet('traits')];
    const axes = getSliderAxes();
    if (pers.length || axes.length) lines.push(`Personality: ${join([...cleanList(pers),...axes].filter(Boolean))}.`);
    const voice = g('forge-voice-note'); if (voice) lines.push(`Voice: ${voice}.`);

    const sk = kwGet('skills'); if (sk.length) lines.push(`Skills: ${join(cleanList(sk))}.`);
    const bg = kwGet('background'); if (bg.length) lines.push(`Background: ${join(cleanList(bg))}.`);

    const rels = _relationships.filter(r => r.role || r.name);
    if (rels.length) lines.push('Relationships: ' + rels.map(r => `${positivePhrase(r.role || 'related')} of ${positivePhrase(r.name || 'unknown')}`).join('; ') + '.');

    if (_explicitAnat) {
        const body = [...kwGet('chest'),...kwGet('nipples'),...kwGet('rear'),...kwGet('pubic'),...kwGet('erogenous'),...kwGet('bodymod')];
        const sex  = [...kwGet('genitalia-a'),...kwGet('genitalia-b'),...kwGet('anal'),...kwGet('fluids'),...kwGet('fertility')];
        if (body.length || sex.length) {
            lines.push(''); lines.push('Anatomy:');
            if (body.length) lines.push(`Body: ${join(cleanList(body))}.`);
            if (sex.length)  lines.push(`Genitalia: ${join(cleanList(sex))}.`);
        }
        const sd    = [...kwGet('sexrole'),...kwGet('experience'),...kwGet('verbal'),...kwGet('triggers')];
        const kinks = kwGet('kinks'); const likes = kwGet('likes');
        const lim   = kwGet('limits').map(positivePhrase);
        if (sd.length || kinks.length || likes.length) {
            lines.push(''); lines.push('Sexual disposition:');
            if (sd.length)    lines.push(`Role/experience: ${join(cleanList(sd))}.`);
            if (kinks.length) lines.push(`Kinks: ${join(cleanList(kinks))}.`);
            if (likes.length) lines.push(`Likes: ${join(cleanList(likes))}.`);
            if (lim.length)   lines.push(`Limits: ${lim.map(v => v.toLowerCase()).join(', ')}.`);
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

function buildFirstMessage() {
    const full = g('forge-scene-full');
    if (full) return full;
    const loc  = kwGet('location'); const atm  = kwGet('atmosphere');
    const sit  = kwGet('situation');const mood = kwGet('mood');
    const hook = g('forge-scene-hook');
    if (!loc.length && !sit.length && !hook) return null;
    const parts = [];
    if (hook) parts.push(hook);
    const ctx = [];
    if (loc.length)  ctx.push('Setting: '    + join(loc));
    if (atm.length)  ctx.push('Atmosphere: ' + join(atm));
    if (sit.length)  ctx.push('Situation: '  + join(sit));
    if (mood.length) ctx.push('Mood: '       + join(mood));
    const npcs = g('forge-scene-npcs'); if (npcs) ctx.push('Present: ' + npcs);
    const plyr = g('forge-scene-player'); if (plyr) ctx.push('Player: ' + plyr);
    const nm   = g('forge-char-name');   if (nm)   ctx.push('Character: ' + nm);
    if (ctx.length) parts.push('\n' + ctx.join('\n'));
    return parts.join('\n\n') || null;
}

function buildExampleDialogue() {
    const valid = _dialoguePairs.filter(p => p.user || p.char);
    if (!valid.length) return null;
    return valid.map(p => `<START>\n{{user}}: ${p.user || '…'}\n{{char}}: ${p.char || '…'}`).join('\n\n');
}

function buildSystemPrompt() {
    const persona   = g('forge-persona-note');
    const custom    = g('forge-style-custom');
    const modeDesc  = SCENE_MODE_DESC[_sceneMode] || '';
    const genre     = g('forge-style-genre') || { literary:'literary fiction', pulp:'pulp adventure', erotic:'adult romance', horror:'body horror', romance:'romance', adventure:'adventure fantasy' }[_sceneMode] || 'roleplay';
    const author    = g('forge-style-author');
    const title     = g('forge-style-title');
    const rating    = g('forge-style-rating') || '4';
    const styleParts = [modeDesc,...cleanList(kwGet('pov')),...cleanList(kwGet('tense')).map(v => v.toLowerCase() + ' tense'),...cleanList(kwGet('rhythm')),...cleanList(kwGet('vocab')),...cleanList(kwGet('pacing')),...cleanList(kwGet('descfocus'))].filter(Boolean);
    const toggles   = getActiveToggles();
    const blocks    = [];
    if (persona) blocks.push(persona);
    if (styleParts.length || toggles.length || genre) {
        let sb = `[ Style: ${styleParts.join(', ') || 'character driven'}; Genre: ${genre}`;
        if (toggles.length) sb += `; Tags: ${cleanList(toggles).join(', ')}`;
        if (author) sb += `; Author: ${author}`;
        if (title)  sb += `; Title: ${title}`;
        sb += `; Rating: S:${rating} ]`;
        blocks.push(sb);
    }
    if (custom) blocks.push(`[ Notes: ${positivePhrase(custom)} ]`);
    return blocks.join('\n\n') || null;
}

// ── setOutput / regen ─────────────────────────────────────────────────────
function setOutput(id, tokId, content) {
    const el   = document.getElementById(id);
    const tkEl = document.getElementById(tokId);
    if (!el) return;
    const btn = el.querySelector('.forge-copy-btn');
    el.innerHTML = '';
    if (btn) { el.appendChild(btn); }
    else {
        const b = document.createElement('button');
        b.className = 'forge-copy-btn';
        b.textContent = 'Copy';
        b.onclick = function () { FORGE.copyBlock(id, this); };
        el.appendChild(b);
    }
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
}

function regen() {
    setOutput('forge-out-description','forge-tok-description', buildDescription());
    setOutput('forge-out-personality','forge-tok-personality', buildPersonality());
    setOutput('forge-out-firstmes',   'forge-tok-firstmes',   buildFirstMessage());
    setOutput('forge-out-dialogue',   'forge-tok-dialogue',   buildExampleDialogue());
    setOutput('forge-out-sysprompt',  'forge-tok-sysprompt',  buildSystemPrompt());
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

function exportJSON() {
    const data = {
        character: { name:g('forge-char-name'), age:g('forge-char-age'), pronouns:kwGet('pronouns'), species:kwGet('species'), role:kwGet('role'), background:kwGet('background'), build:kwGet('build'), height:kwGet('height'), skin:kwGet('skin'), hair:kwGet('hair'), eyes:kwGet('eyes'), face:kwGet('face'), marks:kwGet('marks'), scent:kwGet('scent'), nonhuman:kwGet('nonhuman'), personality:kwGet('personality'), disposition:kwGet('disposition'), traits:kwGet('traits'), skills:kwGet('skills'), voiceNote:g('forge-voice-note'), anatomy:{ chest:kwGet('chest'), nipples:kwGet('nipples'), genitaliaA:kwGet('genitalia-a'), genitaliaB:kwGet('genitalia-b'), rear:kwGet('rear'), pubic:kwGet('pubic'), anal:kwGet('anal'), fluids:kwGet('fluids'), fertility:kwGet('fertility'), erogenous:kwGet('erogenous'), bodymod:kwGet('bodymod') }, sexual:{ experience:kwGet('experience'), role:kwGet('sexrole'), verbal:kwGet('verbal'), kinks:kwGet('kinks'), likes:kwGet('likes'), limits:kwGet('limits'), triggers:kwGet('triggers') } },
        scene:  { location:kwGet('location'), atmosphere:kwGet('atmosphere'), situation:kwGet('situation'), mood:kwGet('mood'), npcs:g('forge-scene-npcs'), player:g('forge-scene-player'), hook:g('forge-scene-hook'), full:g('forge-scene-full') },
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

function randomizeAll() {
    rfld('forge-char-name', NAMES); rndAge();
    ['pronouns','species','role','background','build','height','skin','hair','eyes','face','marks','scent','nonhuman',
     'personality','disposition','traits','skills',
     'chest','nipples','rear','pubic','anal','fluids','fertility','erogenous','bodymod',
     'experience','sexrole','verbal','kinks','likes','limits','triggers',
     'location','atmosphere','situation','mood','pov','tense','rhythm','vocab','pacing','descfocus'
    ].forEach(k => kwRandom(k));
    // Genitalia special case
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
    rfld('forge-scene-hook', HOOKS);
    ['forge-sl-ds','forge-sl-sb','forge-sl-cw','forge-sl-pc'].forEach(id => {
        const el = document.getElementById(id); if (el) { el.value = Math.floor(Math.random() * 11); slv(id); }
    });
    regen();
}

function clearAll() {
    document.querySelectorAll('#forge-panel input[type="text"],#forge-panel input[type="number"],#forge-panel textarea').forEach(el => { el.value = ''; });
    Object.keys(KW_STATE).forEach(k => { KW_STATE[k] = []; kwRender(k); });
    ['forge-sl-ds','forge-sl-sb','forge-sl-cw','forge-sl-pc'].forEach(id => { const el = document.getElementById(id); if (el) { el.value = 5; slv(id); } });
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
        ['triggers','fw-triggers'],    ['location','fw-location'],     ['atmosphere','fw-atmosphere'],
        ['situation','fw-situation'],  ['mood','fw-mood'],
        ['pov','fw-pov'],              ['tense','fw-tense'],           ['rhythm','fw-rhythm'],
        ['vocab','fw-vocab'],          ['pacing','fw-pacing'],         ['descfocus','fw-descfocus'],
    ];
    BINDINGS.forEach(([key, cid]) => kwInit(key, cid));
    renderRelationships(); renderScenePresets(); renderSceneModes();
    renderWorldLorePresets(); renderLore(); renderDialogue();
    ['forge-sl-ds','forge-sl-sb','forge-sl-cw','forge-sl-pc'].forEach(id => slv(id));
    regen();
}

// ═══════════════════════════════════════════════════════════════════════════
// FORGE NAMESPACE  — exposed on window for inline HTML onclick handlers
// ═══════════════════════════════════════════════════════════════════════════
const FORGE = {
    // data refs used by inline handlers in creator.html
    NAMES, NPC_PRESETS, HOOKS,

    // panel
    open:  openPanel,
    close: closePanel,

    // chip engine
    kwToggleDD, kwRandom, kwSet, kwGet,

    // output
    regen,

    // UI
    setFormat, toggleExplicit, toggleFav, toggleItem,
    toggleSection, collapseAll, expandAll, slv,
    rfld, rndAge, randomizeAll, clearAll,
    copyBlock, exportJSON, generateAvatarPrompt,

    // renderers
    renderLore, renderDialogue, renderRelationships,
    addRelationship, removeRelationship, randomizeRelationships,
    addLore, sendCharToWorldInfo,
    addDialoguePair, randomizeDialogue,

    // ST API
    writeToCard, loadFromCard, createNewCard, pushWorldInfo,
};

window.FORGE = FORGE;

// ═══════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════
// ST loads extensions after DOM ready; direct async call works in all ST versions
(async () => { await extensionInit(); })();

export {
    openPanel, closePanel,
    refreshWorldTargetDropdown, refreshAvatarDisplay, showStatus,
    getSetting, setSetting,
    _saveCharacter, _createCharacter, _createWorldInfoEntry, _getTokenCount,
    _eventSource, _event_types,
};
