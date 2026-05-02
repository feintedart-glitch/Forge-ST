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
    archetype: { label:'Archetype', limit:1, random:['The Shadow','The Lover','The Trickster','The Beast','The Sage','The Outlaw'], groups:[
        { g:'Archetype', i:['The Innocent','The Sage','The Explorer','The Outlaw','The Magician','The Hero','The Lover','The Jester','The Caregiver','The Ruler','The Creator','The Shadow','The Trickster','The Beast','The Oracle','The Martyr','The Deviant'] },
    ]},

    disposition: { label:'Disposition', limit:3, random:['cold and calculating','playfully teasing','hungrily predatory','darkly sardonic'], groups:[
        { g:'Warm',         i:['warm and open','quietly nurturing','gently protective','earnestly sincere','sweetly affectionate','openly adoring'] },
        { g:'Controlled',   i:['cold and calculating','serenely detached','clinically precise','quietly observant','measured and patient','professionally distant'] },
        { g:'Intense',      i:['volatilely passionate','explosively emotional','desperately sincere','overwhelmingly devoted','obsessive','all-consuming'] },
        { g:'Playful / Dark',i:['playfully teasing','darkly sardonic','wickedly charming','bluntly honest','hungrily predatory','arrogantly commanding','bashfully curious','anxiously eager-to-please','pleasantly vicious'] },
    ]},

    traits: { label:'Personality Traits', limit:7, random:['fiercely loyal','compulsively honest','wildly impulsive','darkly humorous','protectively possessive'], groups:[
        { g:'Positive',  i:['fiercely loyal','deeply empathetic','achingly sincere','quietly protective','steadfastly reliable','genuinely kind'] },
        { g:'Complex',   i:['compulsively honest','chronically flirtatious','disturbingly patient','masterfully deceptive','stubbornly principled','secretly soft'] },
        { g:'Volatile',  i:['wildly impulsive','explosively emotional','hauntingly sorrowful','darkly humorous','protectively possessive','disturbingly intense','self-destructive'] },
        { g:'Detached',  i:['quietly observant','clinically detached','unshakeably calm','charmingly self-deprecating','aggressively self-reliant','impossible to read'] },
    ]},

    skills: { label:'Skills', limit:7, random:['combat — blades','seduction','deception','tracking','stealth'], groups:[
        { g:'Combat',    i:['combat — unarmed','combat — blades','combat — polearms','combat — improvised','archery','dual-wielding','siege weapons'] },
        { g:'Magic',     i:['magic — elemental','magic — arcane','magic — blood','magic — illusion','divine channelling','necromancy','shapeshifting','bardic magic','binding'] },
        { g:'Social',    i:['seduction','persuasion','intimidation','deception','manipulation','performance','disguise','negotiation'] },
        { g:'Physical',  i:['stealth','tracking','acrobatics','climbing','swimming','riding — horse','riding — beast','parkour'] },
        { g:'Knowledge', i:['healing','alchemy','linguistics','navigation','forgery','lockpicking','poisons','cartography'] },
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
        { g:'Role', i:['dominant top','dominant — service top','submissive bottom','submissive — pillow princess','versatile switch','tends dominant','tends submissive','service-oriented','prey — hunted','predatory — hunter','caretaker','brat — resistant','brat — secretly eager','worshipper','exhibitionist','voyeur'] },
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

    triggers: { label:'Arousal Triggers', limit:5, random:['sustained eye contact','commanding voice','being held firmly'], groups:[
        { g:'Sensory',     i:['sustained eye contact','commanding voice','specific scent','being held firmly','warm breath near neck','low quiet voice','deliberate fingertips on skin','cold touch'] },
        { g:'Situational', i:['feeling of danger','being observed','feeling of powerlessness','being chosen','being the only one','unexpected vulnerability in other','shift in power'] },
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
