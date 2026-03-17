/**
 * Story Ideas - Episode Suggestion, Response Choices & Persona Gen for SillyTavern
 * 에피소드 추천 + 선택지 생성 + 페르소나 생성 (트리플 모드)
 */

import { event_types } from '../../../events.js';
import { getCurrentChatId, user_avatar } from '../../../../script.js';
import { power_user } from '../../../power-user.js';
import { getWorldInfoPrompt } from '../../../world-info.js';

const EXT_NAME = 'st-StoryIdeas';

const INITIAL_PROMPT = `Based on the current roleplay context, suggest diverse episode ideas that could naturally follow from the story so far.

Each suggestion should mix and vary tone and genre. For example, you may combine elements such as:
- Lighthearted or comedic moments
- Emotional or heartfelt scenes
- Suspenseful or mysterious developments
- Action or adventure scenarios
- Quiet slice-of-life interactions
- Dramatic reveals or turning points
- Romantic or relationship-focused events
- World-building or lore-expanding episodes

Draw actively from the characters' personalities, unresolved threads, established world details, and recent events.

All episodes must maintain narrative plausibility within the current storyline. Avoid developments that ignore established settings, emotional arcs, or prior events.

Each idea should feel like a distinctly different narrative flavor—not merely tonal variations of the same concept.`;

const CHOICES_PROMPT = `Based on the current roleplay context, generate possible next response options for the user's character.

Each option should be a natural continuation that the user's character might say or do next, reflecting their established personality, speech patterns, and mannerisms. Each option's format should be RANDOMLY chosen from:
- Narration/action only (describing what the character does, their body language, inner thoughts)
- Dialogue only (what the character says)
- Mixed dialogue and narration

The format order must be randomized every time—do NOT follow a fixed pattern like "narration, dialogue, mixed" or any predictable sequence. Any format can appear multiple times or not at all.

IMPORTANT: Each choice must be ONE single continuous response. Do NOT split dialogue into multiple separate quoted lines. If a character speaks, write it as one continuous speech in a single set of quotation marks, not broken into separate quotes.

Keep options diverse in tone and approach—assertive, hesitant, playful, serious, emotional, practical, etc. Each should feel like a meaningfully different choice that would take the story in a different direction, while still feeling true to who the character is.

Write narration in third-person past tense (e.g. ~했다, ~였다). Never use ~했습니다/~였습니다 style in narration.`;

const DEFAULTS = {
    enabled: true,
    ideasEnabled: true,
    choicesEnabled: true,
    personaEnabled: true,
    apiSource: 'main',
    connectionProfileId: '',
    // 에피소드 추천 설정
    count: 3,
    detailLevel: 'brief',
    lang: 'en',
    prompt: INITIAL_PROMPT,
    promptPresets: {},
    cache: {},
    // 선택지 생성 설정
    choicesCount: 3,
    choicesDetail: 'brief',
    choicesLang: 'en',
    choicesPrompt: CHOICES_PROMPT,
    choicesPresets: {},
    choicesCache: {},
    // 페르소나 생성 설정
    personaLang: 'ko',
    personaDetail: 'normal',
    personaHistory: [],
    personaViewIdx: -1,
};

let activeMode = 'ideas'; // 'ideas' | 'choices' | 'persona'
let cfg = {};
let ctx = null;
let generating = false;
let personaInputs = {};

function persist() { ctx.saveSettingsDebounced(); }

function esc(str) {
    const d = document.createElement('span');
    d.textContent = str;
    return d.innerHTML;
}

function chatKey() { return getCurrentChatId() || null; }

// 모드별 캐시 (ideas/choices) — 쓰기용 (없으면 생성)
function getCache(mode) {
    const key = chatKey();
    if (!key) return null;
    const cacheObj = mode === 'choices' ? cfg.choicesCache : cfg.cache;
    if (!cacheObj[key]) cacheObj[key] = { history: [], viewIdx: -1 };
    if (cacheObj[key].ideas && !cacheObj[key].history) {
        cacheObj[key] = { history: [cacheObj[key].ideas], viewIdx: 0 };
        delete cacheObj[key].ideas;
        delete cacheObj[key].ts;
        persist();
    }
    return cacheObj[key];
}

// 모드별 캐시 — 읽기용 (없으면 null, 빈 캐시 생성 안 함)
function peekCache(mode) {
    const key = chatKey();
    if (!key) return null;
    const cacheObj = mode === 'choices' ? cfg.choicesCache : cfg.cache;
    const entry = cacheObj[key];
    if (!entry || !entry.history?.length) return null;
    return entry;
}

// ─── 프로필 탐지 ───

function discoverProfiles() {
    const cmrs = ctx.ConnectionManagerRequestService;
    if (!cmrs) return [];

    // 알려진 메서드 시도
    const knownMethods = ['getConnectionProfiles', 'getAllProfiles', 'getProfiles', 'listProfiles'];
    for (const m of knownMethods) {
        if (typeof cmrs[m] === 'function') {
            try {
                const result = cmrs[m]();
                if (Array.isArray(result) && result.length) {
                    console.log(`[${EXT_NAME}] 프로필 발견 via ${m}()`);
                    return result;
                }
            } catch (e) { console.log(`[${EXT_NAME}] ${m}() 실패:`, e); }
        }
    }

    // 동적 탐색: 'rofile' 포함 메서드
    try {
        const proto = Object.getPrototypeOf(cmrs);
        const dynamicMethods = Object.getOwnPropertyNames(proto)
            .filter(k => typeof cmrs[k] === 'function' && /rofile/i.test(k) && !knownMethods.includes(k));
        for (const m of dynamicMethods) {
            try {
                const result = cmrs[m]();
                if (Array.isArray(result) && result.length) {
                    console.log(`[${EXT_NAME}] 프로필 발견 via dynamic ${m}()`);
                    return result;
                }
            } catch {}
        }
    } catch {}

    // extensionSettings fallback
    const paths = [
        ctx.extensionSettings?.connectionManager?.profiles,
        ctx.extensionSettings?.ConnectionManager?.profiles,
        ctx.extensionSettings?.connection_manager?.profiles,
    ];
    for (const s of paths) {
        if (!s) continue;
        const arr = Array.isArray(s) ? s : Object.values(s);
        if (arr.length) { console.log(`[${EXT_NAME}] 프로필 발견 via extensionSettings fallback`); return arr; }
    }

    return [];
}

function getProfileId(p) {
    return p.id || p.profileId || p.profile_id || p.uuid || '';
}

function getProfileName(p) {
    return p.name || p.profileName || p.profile_name || p.displayName || getProfileId(p);
}

// ─── sendRequest 공통 ───

async function sendProfileRequest(msgs, maxTokens) {
    const cmrs = ctx.ConnectionManagerRequestService;
    if (!cmrs) throw new Error('Connection Manager 미로드');

    const optionSets = [
        { stream: false, extractData: true, includePreset: false, includeInstruct: false },
        { streaming: false, extractData: true, includePreset: false, includeInstruct: false },
        { stream: false, extractData: true },
        { streaming: false },
    ];

    let lastError = null;
    for (const opts of optionSets) {
        try {
            const resp = await cmrs.sendRequest(cfg.connectionProfileId, msgs, maxTokens, opts);
            if (typeof resp === 'string') return resp;
            if (resp?.choices?.[0]?.message) {
                const m = resp.choices[0].message;
                return m.reasoning_content || m.content || '';
            }
            if (resp?.content) return resp.content;
            if (resp?.message) return resp.message;
            // 응답은 왔는데 텍스트 추출 실패 — 다음 옵션 시도
            lastError = new Error('응답 형식 인식 실패');
        } catch (e) {
            lastError = e;
            console.log(`[${EXT_NAME}] sendRequest 옵션 실패:`, opts, e.message);
        }
    }
    throw new Error(`Profile 오류: ${lastError?.message || '알 수 없는 오류'}`);
}

// ─── 복사 유틸 ───

async function copyToClipboard(text) {
    // 1순위: Clipboard API
    if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(text); return true; }
        catch (e) { console.log(`[${EXT_NAME}] clipboard API failed:`, e); }
    }
    // 2순위: textarea (순수 텍스트 보장)
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) return true;
    } catch (e) { console.log(`[${EXT_NAME}] textarea fallback failed:`, e); }
    return false;
}

// ─── 부팅 ───

async function boot() {
    console.log(`[${EXT_NAME}] Booting...`);
    ctx = SillyTavern.getContext();

    if (!ctx.extensionSettings[EXT_NAME]) {
        ctx.extensionSettings[EXT_NAME] = structuredClone(DEFAULTS);
    }
    cfg = ctx.extensionSettings[EXT_NAME];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (cfg[k] === undefined) cfg[k] = v;
    }

    migrate();
    await mountSettings();
    bindEvents();
    console.log(`[${EXT_NAME}] Ready.`);
}

function migrate() {
    let changed = false;
    const oldPresets = ['Drama & Conflict', 'Adventure & Exploration', 'Slice of Life'];
    if (cfg.promptPresets) {
        for (const name of oldPresets) {
            if (cfg.promptPresets[name]) { delete cfg.promptPresets[name]; changed = true; }
        }
        if (cfg.promptPresets['Default'] && cfg.promptPresets['Default'].startsWith('Based on the current roleplay context')) {
            cfg.promptPresets['Default'] = INITIAL_PROMPT; changed = true;
        }
    }
    if (!cfg.promptPresets || Object.keys(cfg.promptPresets).length === 0) {
        cfg.promptPresets = { 'Default': INITIAL_PROMPT }; changed = true;
    }
    const oldPromptStart = 'Based on the current roleplay context—characters, world-building, and recent conversation—suggest possible next episode';
    if (cfg.prompt && cfg.prompt.startsWith(oldPromptStart)) { cfg.prompt = INITIAL_PROMPT; changed = true; }
    for (const k of ['cssPresets', 'css', 'itemTemplate', 'openDefault', 'maxTokens', 'historyDepth']) {
        if (k in cfg) { delete cfg[k]; changed = true; }
    }
    if (cfg.detailLevel === 'detailed') { cfg.detailLevel = 'normal'; changed = true; }
    if (!cfg.choicesPresets || Object.keys(cfg.choicesPresets).length === 0) {
        cfg.choicesPresets = { 'Default': CHOICES_PROMPT }; changed = true;
    }
    if (changed) { persist(); console.log(`[${EXT_NAME}] Migration done.`); }
}

// ─── 설정 패널 ───

async function mountSettings() {
    const html = await ctx.renderExtensionTemplateAsync(`third-party/${EXT_NAME}`, 'settings');
    $('#extensions_settings').append(html);
    const root = $('.story_ideas_settings');

    root.find('.si_enabled').prop('checked', cfg.enabled).on('change', function () {
        cfg.enabled = $(this).prop('checked'); persist();
        updateMenuVisibility();
        toastr.info(cfg.enabled ? 'Story Ideas 활성화됨' : 'Story Ideas 비활성화됨');
    });
    root.find('.si_ideas_enabled').prop('checked', cfg.ideasEnabled).on('change', function () {
        cfg.ideasEnabled = $(this).prop('checked'); persist(); updateMenuVisibility();
    });
    root.find('.sc_choices_enabled').prop('checked', cfg.choicesEnabled).on('change', function () {
        cfg.choicesEnabled = $(this).prop('checked'); persist(); updateMenuVisibility();
    });
    root.find('.sp_persona_enabled').prop('checked', cfg.personaEnabled).on('change', function () {
        cfg.personaEnabled = $(this).prop('checked'); persist(); updateMenuVisibility();
    });

    // API 소스
    const sourceSelect = root.find('.si_source');
    sourceSelect.empty();
    sourceSelect.append('<option value="main">Main API</option>');
    try {
        const profiles = discoverProfiles();
        console.log(`[${EXT_NAME}] 프로필 ${profiles.length}개 발견`);
        if (profiles.length) {
            profiles.forEach(p => {
                const id = getProfileId(p);
                const name = getProfileName(p);
                if (id) sourceSelect.append(`<option value="profile:${id}">${name}</option>`);
            });
        }
    } catch (e) { console.log(`[${EXT_NAME}] 프로필 목록 로드 실패:`, e); }

    const currentVal = cfg.apiSource === 'profile' && cfg.connectionProfileId ? `profile:${cfg.connectionProfileId}` : 'main';
    sourceSelect.val(currentVal);
    sourceSelect.on('change', function () {
        const val = $(this).val();
        if (val === 'main') { cfg.apiSource = 'main'; cfg.connectionProfileId = ''; }
        else { cfg.apiSource = 'profile'; cfg.connectionProfileId = val.replace('profile:', ''); }
        persist();
    });

    // ─── 에피소드 추천 탭 ───
    root.find('.si_count').val(cfg.count).on('change', function () { cfg.count = Number($(this).val()); persist(); });
    root.find('.si_detail_level').val(cfg.detailLevel).on('change', function () { cfg.detailLevel = $(this).val(); persist(); });
    root.find('.si_lang').val(cfg.lang).on('change', function () { cfg.lang = $(this).val(); persist(); });
    root.find('.si_prompt').val(cfg.prompt).on('change', function () { cfg.prompt = $(this).val(); persist(); });

    root.find('.si_prompt_reset').on('click', async function () {
        if (await ctx.Popup.show.confirm('에피소드 추천 프롬프트를 초기화할까요?', '설정 초기화')) {
            cfg.prompt = INITIAL_PROMPT; root.find('.si_prompt').val(INITIAL_PROMPT); persist(); toastr.success('프롬프트 초기화됨');
        }
    });
    root.find('.si_cache_clear').on('click', async function () {
        const total = Object.keys(cfg.cache || {}).length;
        if (!total) { toastr.info('캐시가 없습니다.'); return; }
        if (await ctx.Popup.show.confirm(`에피소드 추천 캐시 ${total}건을 삭제할까요?`, '캐시 초기화')) {
            cfg.cache = {}; persist(); if (activeMode === 'ideas') removeBlock(); toastr.success('에피소드 캐시 초기화됨');
        }
    });
    mountPresetUI(root, '.si_prompt_preset', '.si_preset_load', '.si_preset_save', '.si_preset_del',
        () => cfg.promptPresets, v => { cfg.promptPresets = v; },
        () => cfg.prompt, v => { cfg.prompt = v; root.find('.si_prompt').val(v); });

    // ─── 선택지 생성 탭 ───
    root.find('.sc_count').val(cfg.choicesCount).on('change', function () { cfg.choicesCount = Number($(this).val()); persist(); });
    root.find('.sc_detail_level').val(cfg.choicesDetail).on('change', function () { cfg.choicesDetail = $(this).val(); persist(); });
    root.find('.sc_lang').val(cfg.choicesLang).on('change', function () { cfg.choicesLang = $(this).val(); persist(); });
    root.find('.sc_prompt').val(cfg.choicesPrompt).on('change', function () { cfg.choicesPrompt = $(this).val(); persist(); });

    root.find('.sc_prompt_reset').on('click', async function () {
        if (await ctx.Popup.show.confirm('선택지 생성 프롬프트를 초기화할까요?', '설정 초기화')) {
            cfg.choicesPrompt = CHOICES_PROMPT; root.find('.sc_prompt').val(CHOICES_PROMPT); persist(); toastr.success('프롬프트 초기화됨');
        }
    });
    root.find('.sc_cache_clear').on('click', async function () {
        const total = Object.keys(cfg.choicesCache || {}).length;
        if (!total) { toastr.info('캐시가 없습니다.'); return; }
        if (await ctx.Popup.show.confirm(`선택지 캐시 ${total}건을 삭제할까요?`, '캐시 초기화')) {
            cfg.choicesCache = {}; persist(); if (activeMode === 'choices') removeBlock(); toastr.success('선택지 캐시 초기화됨');
        }
    });
    mountPresetUI(root, '.sc_prompt_preset', '.sc_preset_load', '.sc_preset_save', '.sc_preset_del',
        () => cfg.choicesPresets, v => { cfg.choicesPresets = v; },
        () => cfg.choicesPrompt, v => { cfg.choicesPrompt = v; root.find('.sc_prompt').val(v); });

    // ─── 페르소나 생성 탭 ───
    root.find('.sp_lang').val(cfg.personaLang).on('change', function () { cfg.personaLang = $(this).val(); persist(); });
    root.find('.sp_detail').val(cfg.personaDetail).on('change', function () { cfg.personaDetail = $(this).val(); persist(); });
    root.find('.sp_cache_clear').on('click', async function () {
        const total = cfg.personaHistory?.length || 0;
        if (!total) { toastr.info('캐시가 없습니다.'); return; }
        if (await ctx.Popup.show.confirm(`페르소나 캐시 ${total}건을 삭제할까요?`, '캐시 초기화')) {
            cfg.personaHistory = []; cfg.personaViewIdx = -1; persist();
            if (activeMode === 'persona') removeBlock(); toastr.success('페르소나 캐시 초기화됨');
        }
    });

    // ─── 전체 캐시 초기화 ───
    root.find('.si_all_cache_clear').on('click', async function () {
        const c1 = Object.keys(cfg.cache || {}).length;
        const c2 = Object.keys(cfg.choicesCache || {}).length;
        const c3 = cfg.personaHistory?.length || 0;
        const total = c1 + c2 + c3;
        if (!total) { toastr.info('캐시가 없습니다.'); return; }
        if (await ctx.Popup.show.confirm(`전체 캐시를 삭제할까요?\n에피소드 ${c1}건 / 선택지 ${c2}건 / 페르소나 ${c3}건`, '전체 캐시 초기화')) {
            cfg.cache = {}; cfg.choicesCache = {}; cfg.personaHistory = []; cfg.personaViewIdx = -1;
            persist(); removeBlock(); toastr.success('전체 캐시 초기화됨');
        }
    });
}

function mountPresetUI(root, selSel, loadSel, saveSel, delSel, getPresets, setPresets, getPrompt, setPrompt) {
    const sel = root.find(selSel);
    function refresh() {
        sel.empty();
        Object.keys(getPresets() || {}).forEach(n => sel.append(`<option value="${n}">${n}</option>`));
    }
    refresh();
    root.find(loadSel).on('click', () => {
        const n = sel.val(); if (!n || !getPresets()[n]) return;
        setPrompt(getPresets()[n]); persist(); toastr.success(`"${n}" 적용됨`);
    });
    root.find(saveSel).on('click', async () => {
        const n = await ctx.Popup.show.input('프리셋 이름:', '저장');
        if (!n?.trim()) return; const t = n.trim(); const presets = getPresets();
        if (presets[t] && !await ctx.Popup.show.confirm(`"${t}" 덮어쓸까요?`, '덮어쓰기')) return;
        presets[t] = getPrompt(); setPresets(presets); persist(); refresh(); sel.val(t); toastr.success(`"${t}" 저장됨`);
    });
    root.find(delSel).on('click', async () => {
        const n = sel.val(); if (!n) return toastr.warning('프리셋을 선택하세요.');
        if (await ctx.Popup.show.confirm(`"${n}" 삭제?`, '삭제')) {
            const presets = getPresets(); delete presets[n]; setPresets(presets); persist(); refresh(); toastr.success(`"${n}" 삭제됨`);
        }
    });
}

// ─── 이벤트 ───

function updateMenuVisibility() {
    const btn1 = document.getElementById('si_menu_btn');
    const btn2 = document.getElementById('si_choices_btn');
    const btn3 = document.getElementById('si_persona_btn');
    if (btn1) btn1.style.display = (cfg.enabled && cfg.ideasEnabled) ? '' : 'none';
    if (btn2) btn2.style.display = (cfg.enabled && cfg.choicesEnabled) ? '' : 'none';
    if (btn3) btn3.style.display = (cfg.enabled && cfg.personaEnabled) ? '' : 'none';
}

function bindEvents() {
    const menuBtn = document.createElement('div');
    menuBtn.id = 'si_menu_btn';
    menuBtn.className = 'list-group-item flex-container flexGap5 interactable';
    menuBtn.title = '에피소드 추천';
    menuBtn.innerHTML = '<i class="fa-solid fa-lightbulb"></i> 에피소드 추천';
    menuBtn.style.display = (cfg.enabled && cfg.ideasEnabled) ? '' : 'none';
    menuBtn.addEventListener('click', async () => {
        if (!cfg.enabled || generating) return;
        $('#extensionsMenu').hide(); activeMode = 'ideas';
        const cache = peekCache('ideas');
        if (cache) { renderBlock('ideas'); scrollToBlock(); return; }
        await generate(false, 'ideas');
    });

    const choicesBtn = document.createElement('div');
    choicesBtn.id = 'si_choices_btn';
    choicesBtn.className = 'list-group-item flex-container flexGap5 interactable';
    choicesBtn.title = '선택지 생성';
    choicesBtn.innerHTML = '<i class="fa-solid fa-list-check"></i> 선택지 생성';
    choicesBtn.style.display = (cfg.enabled && cfg.choicesEnabled) ? '' : 'none';
    choicesBtn.addEventListener('click', async () => {
        if (!cfg.enabled || generating) return;
        $('#extensionsMenu').hide(); activeMode = 'choices';
        const cache = peekCache('choices');
        if (cache) { renderBlock('choices'); scrollToBlock(); return; }
        await generate(false, 'choices');
    });

    const personaBtn = document.createElement('div');
    personaBtn.id = 'si_persona_btn';
    personaBtn.className = 'list-group-item flex-container flexGap5 interactable';
    personaBtn.title = '페르소나 생성';
    personaBtn.innerHTML = '<i class="fa-solid fa-user-pen"></i> 페르소나 생성';
    personaBtn.style.display = (cfg.enabled && cfg.personaEnabled) ? '' : 'none';
    personaBtn.addEventListener('click', () => {
        if (!cfg.enabled || generating) return;
        $('#extensionsMenu').hide(); activeMode = 'persona';
        if (cfg.personaHistory.length > 0) { showPersonaResult(); } else { showPersonaForm(); }
    });

    const extMenu = document.getElementById('extensionsMenu');
    if (extMenu) {
        extMenu.appendChild(menuBtn); extMenu.appendChild(choicesBtn); extMenu.appendChild(personaBtn);
    } else {
        const obs = new MutationObserver((_, o) => {
            const m = document.getElementById('extensionsMenu');
            if (m) { m.appendChild(menuBtn); m.appendChild(choicesBtn); m.appendChild(personaBtn); o.disconnect(); }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    ctx.eventSource.on(event_types.CHAT_CHANGED, () => {
        removeBlock();
    });
}

// ─── 블록 ───

function removeBlock() { $('#si-block').remove(); }

function scrollToBlock() {
    const el = document.getElementById('si-block');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

// ─── 생성 (ideas/choices) ───

async function generate(isRetry, mode) {
    if (generating || !cfg.enabled) return;
    activeMode = mode;
    if (cfg.apiSource === 'profile' && !cfg.connectionProfileId) { toastr.warning('Connection Profile을 선택하세요.'); return; }
    if (!ctx.chat?.length) { toastr.warning('대화 내역이 없습니다.'); return; }
    const lastBot = findLastBot();
    if (lastBot === -1) { toastr.warning('봇 메시지가 없습니다.'); return; }

    generating = true;
    const label = mode === 'choices' ? '선택지 생성' : '에피소드 추천';
    if (isRetry) {
        $('#si-cards-area').html(`<div class="si-regen-overlay"><div class="si-dots"><span></span><span></span><span></span></div><span>재생성 중...</span></div>`);
    } else { showLoading(mode); }

    try {
        const instruction = buildInstruction(mode);
        let raw = '';
        if (cfg.apiSource === 'main') {
            const bg = await gatherPlain(lastBot);
            const { generateRaw } = ctx;
            if (!generateRaw) throw new Error('generateRaw not available');
            raw = await generateRaw({ systemPrompt: bg, prompt: instruction, streaming: false });
        } else {
            const msgs = await gatherMessages(lastBot);
            msgs.push({ role: 'user', content: instruction });
            raw = await sendProfileRequest(msgs, 4000);
        }
        const items = mode === 'choices' ? parseChoices(raw) : parseIdeas(raw);
        if (!items?.length) throw new Error('파싱 실패');
        const cache = getCache(mode);
        cache.history.push(items); cache.viewIdx = cache.history.length - 1; persist();
        renderBlock(mode); scrollToBlock();
    } catch (err) {
        console.error(`[${EXT_NAME}]`, err); toastr.error(`${label} 실패: ${err.message}`);
        if (isRetry) { const cache = peekCache(mode); if (cache) renderBlock(mode); }
        else { showFail(err.message, mode); }
    } finally { generating = false; }
}

// ─── 페르소나 생성 ───

function getCharacterData() {
    try {
        const c = SillyTavern.getContext();
        const ch = c.characters?.[c.characterId];
        if (!ch) return null;
        const d = ch.data || ch;
        return { name: ch.name || '', description: d.description || '', personality: d.personality || '', scenario: d.scenario || '' };
    } catch { return null; }
}

function showPersonaForm() {
    removeBlock();
    const char = getCharacterData();
    if (!char) { toastr.warning('캐릭터가 선택되지 않았습니다.'); return; }

    const block = $('<div id="si-block" class="si-block"></div>');
    const head = $('<div class="si-block-head"></div>');
    head.append(`<span class="si-block-title">👤 페르소나 생성 — ${esc(char.name)}</span>`);
    const closeBtn = $('<button class="si-block-btn" title="닫기">✕</button>');
    closeBtn.on('click', removeBlock);
    head.append(closeBtn);
    block.append(head);

    const form = $(`
        <div class="pg-form">
            <div class="pg-form-field"><small>이름</small>
                <input type="text" class="pg-input-name" placeholder="비우면 자동 생성" value="${esc(personaInputs.name || '')}" /></div>
            <div class="pg-form-field"><small>나이</small>
                <input type="text" class="pg-input-age" placeholder="비우면 자동 생성" value="${esc(personaInputs.age || '')}" /></div>
            <div class="pg-form-field"><small>외모</small>
                <textarea class="pg-input-appearance" rows="2" placeholder="비우면 자동 생성">${esc(personaInputs.appearance || '')}</textarea></div>
            <div class="pg-form-field"><small>특징 / 성격</small>
                <textarea class="pg-input-traits" rows="2" placeholder="비우면 자동 생성">${esc(personaInputs.traits || '')}</textarea></div>
            <label class="pg-form-check">
                <input type="checkbox" class="pg-input-relation" ${personaInputs.relation ? 'checked' : ''} />
                <span>{{char}}와의 관계 설정 포함</span>
            </label>
            <div class="pg-form-actions">
                <button class="si-block-btn pg-btn-cancel">취소</button>
                <button class="pg-btn pg-btn-primary pg-btn-generate">생성</button>
            </div>
        </div>
    `);

    form.find('.pg-btn-cancel').on('click', removeBlock);
    form.find('.pg-btn-generate').on('click', () => {
        personaInputs = {
            name: form.find('.pg-input-name').val().trim(),
            age: form.find('.pg-input-age').val().trim(),
            appearance: form.find('.pg-input-appearance').val().trim(),
            traits: form.find('.pg-input-traits').val().trim(),
            relation: form.find('.pg-input-relation').prop('checked'),
        };
        generatePersona(null);
    });

    block.append(form);
    $('#chat').append(block);
    scrollToBlock();
}

function showPersonaResult() {
    removeBlock();
    if (!cfg.personaHistory.length) return;

    const total = cfg.personaHistory.length;
    const idx = cfg.personaViewIdx;
    const text = cfg.personaHistory[idx];

    const block = $('<div id="si-block" class="si-block"></div>');
    const head = $('<div class="si-block-head"></div>');
    head.append('<span class="si-block-title">👤 페르소나 생성 결과</span>');
    const btns = $('<div class="si-block-btns"></div>');

    const nav = $('<div class="si-nav"></div>');
    const prevBtn = $('<button class="si-nav-btn" title="이전">◀</button>');
    const navLabel = $(`<span class="si-nav-label">${idx + 1}/${total}</span>`);
    const nextBtn = $('<button class="si-nav-btn" title="다음">▶</button>');
    if (idx <= 0) prevBtn.prop('disabled', true);
    if (idx >= total - 1) nextBtn.prop('disabled', true);
    prevBtn.on('click', () => { if (cfg.personaViewIdx > 0) { cfg.personaViewIdx--; persist(); showPersonaResult(); } });
    nextBtn.on('click', () => { if (cfg.personaViewIdx < cfg.personaHistory.length - 1) { cfg.personaViewIdx++; persist(); showPersonaResult(); } });

    nav.append(prevBtn, navLabel, nextBtn);
    btns.append(nav);
    btns.append('<button class="si-block-btn pg-do-back" title="입력으로 돌아가기">↩️</button>');
    btns.append('<button class="si-block-btn pg-do-refresh" title="재생성">🔄</button>');
    btns.append('<button class="si-block-btn pg-do-delete" title="전체 삭제">🗑️</button>');
    btns.append('<button class="si-block-btn pg-do-close" title="닫기">✕</button>');
    head.append(btns);
    block.append(head);

    const result = $(`
        <div class="pg-result">
            <div class="pg-result-text">${esc(text)}</div>
            <textarea class="pg-result-editable" style="display:none;">${esc(text)}</textarea>
            <div class="pg-result-actions">
                <button class="si-idea-act pg-act-copy">📋 복사</button>
                <button class="si-idea-act pg-act-edit">✏️ 수정</button>
                <button class="si-idea-act pg-act-save" style="display:none;">💾 저장</button>
                <button class="si-idea-act pg-act-translate">🌐 번역</button>
            </div>
        </div>
    `);

    const resultDiv = result.find('.pg-result-text');
    const resultTextarea = result.find('.pg-result-editable');
    const editBtn = result.find('.pg-act-edit');
    const saveBtn = result.find('.pg-act-save');

    editBtn.on('click', () => {
        resultDiv.hide();
        resultTextarea.val(cfg.personaHistory[cfg.personaViewIdx]).show().focus();
        editBtn.hide();
        saveBtn.show();
    });

    saveBtn.on('click', () => {
        const edited = resultTextarea.val();
        cfg.personaHistory[cfg.personaViewIdx] = edited;
        persist();
        resultDiv.text(edited);
        resultTextarea.hide();
        resultDiv.show();
        saveBtn.hide();
        editBtn.show();
        toastr.success('저장됨');
    });

    result.find('.pg-act-copy').on('click', async () => {
        const current = resultTextarea.is(':visible') ? resultTextarea.val() : cfg.personaHistory[cfg.personaViewIdx];
        const ok = await copyToClipboard(current);
        if (ok) toastr.success('복사됨');
    });
    result.find('.pg-act-translate').on('click', () => {
        const current = resultTextarea.is(':visible') ? resultTextarea.val() : cfg.personaHistory[cfg.personaViewIdx];
        translatePersona(current);
    });
    block.append(result);

    const revise = $(`
        <div class="pg-revise">
            <textarea class="pg-revise-input" rows="2" placeholder="수정사항 입력 (예: 나이를 25살로 변경, 성격을 더 활발하게)"></textarea>
            <button class="pg-btn pg-btn-primary pg-btn-revise">수정 반영</button>
        </div>
    `);
    revise.find('.pg-btn-revise').on('click', () => {
        const reviseText = revise.find('.pg-revise-input').val().trim();
        if (!reviseText) { toastr.warning('수정사항을 입력하세요.'); return; }
        generatePersona(reviseText);
    });
    block.append(revise);

    block.find('.pg-do-back').on('click', () => showPersonaForm());
    block.find('.pg-do-close').on('click', removeBlock);
    block.find('.pg-do-refresh').on('click', () => { if (!generating) generatePersona(null); });
    block.find('.pg-do-delete').on('click', async () => {
        if (await ctx.Popup.show.confirm(`캐시 ${total}건을 삭제할까요?`, '전체 삭제')) {
            cfg.personaHistory = []; cfg.personaViewIdx = -1; persist(); removeBlock(); toastr.success('전체 삭제됨');
        }
    });

    $('#chat').append(block);
    scrollToBlock();
}

async function generatePersona(reviseText) {
    if (generating) return;
    if (cfg.apiSource === 'profile' && !cfg.connectionProfileId) { toastr.warning('Connection Profile을 선택하세요.'); return; }
    const char = getCharacterData();
    if (!char) { toastr.warning('캐릭터가 선택되지 않았습니다.'); return; }

    generating = true;
    showPersonaLoading(reviseText ? '수정 반영 중...' : '페르소나 생성 중...');

    try {
        const baseResult = reviseText && cfg.personaHistory.length > 0 ? cfg.personaHistory[cfg.personaViewIdx] : null;
        const instruction = buildPersonaPrompt(char, personaInputs, reviseText, baseResult);
        let raw = '';

        if (cfg.apiSource === 'main') {
            const { generateRaw } = ctx;
            if (!generateRaw) throw new Error('generateRaw not available');
            raw = await generateRaw({ systemPrompt: buildPersonaSystemContext(char), prompt: instruction, streaming: false });
        } else {
            const msgs = [{ role: 'system', content: buildPersonaSystemContext(char) }, { role: 'user', content: instruction }];
            raw = await sendProfileRequest(msgs, 10000);
        }

        const parsed = parsePersonaResult(raw);
        if (!parsed) throw new Error('파싱 실패');
        cfg.personaHistory.push(parsed); cfg.personaViewIdx = cfg.personaHistory.length - 1; persist();
        showPersonaResult();
    } catch (err) {
        console.error(`[${EXT_NAME}]`, err); toastr.error(`페르소나 생성 실패: ${err.message}`);
        if (cfg.personaHistory.length > 0) showPersonaResult(); else showPersonaForm();
    } finally { generating = false; }
}

async function translatePersona(sourceText) {
    if (generating || !sourceText) return;
    generating = true;
    showPersonaLoading('번역 중...');

    try {
        const targetLang = cfg.personaLang === 'ko' ? 'English' : '한국어';
        const instruction = `Translate the following character profile into ${targetLang}. Keep the EXACT same format, structure, and field names (translate field names too). Output ONLY the translated profile, no explanation or commentary.\n\n${sourceText}`;
        let raw = '';

        if (cfg.apiSource === 'main') {
            const { generateRaw } = ctx;
            if (!generateRaw) throw new Error('generateRaw not available');
            raw = await generateRaw({ systemPrompt: '', prompt: instruction, streaming: false });
        } else {
            const msgs = [{ role: 'user', content: instruction }];
            raw = await sendProfileRequest(msgs, 10000);
        }

        const parsed = parsePersonaResult(raw);
        if (!parsed) throw new Error('번역 파싱 실패');
        cfg.personaHistory.push(parsed); cfg.personaViewIdx = cfg.personaHistory.length - 1; persist();
        showPersonaResult();
    } catch (err) {
        console.error(`[${EXT_NAME}]`, err); toastr.error(`번역 실패: ${err.message}`);
        showPersonaResult();
    } finally { generating = false; }
}

function showPersonaLoading(msg) {
    removeBlock();
    const block = $('<div id="si-block" class="si-block"></div>');
    block.html(`<div class="si-block-head"><span class="si-block-title">👤 페르소나 생성</span></div>
        <div class="si-loading"><div class="si-dots"><span></span><span></span><span></span></div><span>${msg}</span></div>`);
    $('#chat').append(block); scrollToBlock();
}

function buildPersonaSystemContext(char) {
    let t = '=== CHARACTER INFO ===\n';
    if (char.name) t += `Name: ${char.name}\n`;
    if (char.description) t += `\nDescription:\n${char.description}\n`;
    if (char.personality) t += `\nPersonality:\n${char.personality}\n`;
    if (char.scenario) t += `\nScenario:\n${char.scenario}\n`;
    return t.trim();
}

function buildPersonaPrompt(char, inputs, reviseText, baseResult) {
    const langNote = cfg.personaLang === 'ko' ? '⚠️ 모든 출력을 한국어로 작성하세요.' : '⚠️ Write all output in English.';
    const detailMap = {
        brief: 'Keep the profile concise and compact (around 200-400 characters)',
        normal: 'Write a moderately detailed profile (around 400-800 characters)',
    };

    let userHints = '';
    if (inputs.name) userHints += `- Name: ${inputs.name}\n`;
    if (inputs.age) userHints += `- Age: ${inputs.age}\n`;
    if (inputs.appearance) userHints += `- Appearance: ${inputs.appearance}\n`;
    if (inputs.traits) userHints += `- Traits/Personality: ${inputs.traits}\n`;

    let prompt = `You are a character profile writer for roleplay. Based on the character ({{char}}) information provided above, create a user character ({{user}}) profile.

CRITICAL RULES:
1. Analyze the FORMAT and STRUCTURE of {{char}}'s description carefully.
2. Write {{user}}'s profile in the SAME FORMAT as {{char}}'s description (e.g., if {{char}} uses prose style, use prose; if {{char}} uses structured fields, use the same field names; if {{char}} uses W++, use W++; if {{char}} uses JSON, use JSON).
3. The {{user}} character should fit naturally within the same world, setting, and tone as {{char}}. Use {{char}}'s description to understand the genre, era, atmosphere, and level of detail expected.
4. Any fields NOT specified by the user should be creatively filled in by you to match the setting and world.`;

    if (inputs.relation) {
        prompt += `\n5. Define a specific relationship between {{user}} and {{char}} that fits the setting naturally. This can be any type of relationship (friend, rival, colleague, lover, family, etc.) — choose what feels most compelling for the story. Include how they met or how they are connected.`;
    } else {
        prompt += `\n5. Do NOT tie {{user}} directly to {{char}}. Do NOT define a specific relationship with {{char}} (e.g., lover, rival, friend, enemy). Do NOT reference {{char}} by name in the profile. {{user}} should be a standalone character who could work with any character in a similar setting.`;
    }

    prompt += `\n\n${langNote}\n${detailMap[cfg.personaDetail] || detailMap.normal}`;

    if (userHints) prompt += `\n\nUser-specified attributes (use these exactly, fill in everything else):\n${userHints}`;
    else prompt += '\n\nNo attributes specified — create everything from scratch to fit the setting and world.';

    if (!inputs.name) {
        prompt += '\n\n⚠️ The user did not specify a name. You MUST invent an original, fitting name for the character. Do NOT use placeholders like {{user}}, "User", "You", or any generic label.';
    }

    if (reviseText && baseResult) {
        prompt += `\n\n--- REVISION REQUEST ---

## Critical Rules
- Your ONLY task is to apply the specific changes requested below to the existing profile.
- Do NOT alter, rephrase, reword, or "improve" any part that is NOT mentioned in the feedback.
- Sections, sentences, and details not referenced in the feedback must remain EXACTLY as they are — same wording, same structure, same values.
- Do NOT reorganize, reformat, or restructure the profile layout.
- Output the COMPLETE profile with ONLY the requested changes applied.

## Previous Profile
${baseResult}

## Requested Changes
${reviseText}

Remember: Apply ONLY the requested changes above. Every other part of the profile must stay identical to the previous version. If in doubt whether something should change, keep the original.`;
    }

    prompt += `\n\nOUTPUT FORMAT:\n- Output ONLY the character profile/description itself\n- Do NOT include any explanation, commentary, or meta text\n- Do NOT wrap in code blocks or tags\n- Match {{char}}'s description format exactly`;
    return prompt;
}

function parsePersonaResult(raw) {
    if (!raw || !raw.trim()) return null;
    let text = raw.trim();
    text = text.replace(/^```[\s\S]*?\n/, '').replace(/\n?```\s*$/, '');
    text = text.replace(/^<[^>]+>\s*/i, '').replace(/\s*<\/[^>]+>$/i, '');
    return text.trim() || null;
}

// ─── 프롬프트 (ideas/choices) ───

function buildInstruction(mode) {
    if (mode === 'choices') return buildChoicesInstruction();
    return buildIdeasInstruction();
}

function buildIdeasInstruction() {
    const langNote = (cfg.lang || 'en') === 'ko' ? '⚠️ 모든 추천을 한국어로 작성하세요.' : '⚠️ Write all suggestions in English.';
    const detailMap = { brief: 'Keep each description to 1-2 sentences (brief and concise)', normal: 'Write 3-5 sentences per description (moderate detail)' };
    let avoidNote = '';
    const cache = peekCache('ideas');
    if (cache && cache.history.length > 0) {
        const prevTitles = [];
        for (const ideas of cache.history) { for (const idea of ideas) { if (idea.title) prevTitles.push(idea.title); } }
        if (prevTitles.length > 0) avoidNote = `\n\n⚠️ IMPORTANT: The following ideas were already suggested. Do NOT repeat or closely resemble any of them. Come up with completely different ideas:\n${prevTitles.map(t => `- ${t}`).join('\n')}`;
    }
    return `${ctx.substituteParams(cfg.prompt)}\n\n${langNote}${avoidNote}\n\nOUTPUT FORMAT - Use this EXACT structure:\n<suggestions>\n[Title of idea 1]\nDescription here.\n\n[Title of idea 2]\nDescription here.\n</suggestions>\n\nRules:\n- Exactly ${cfg.count} suggestions\n- ${detailMap[cfg.detailLevel] || detailMap.brief}\n- Title in [brackets], description on next lines\n- Wrap in <suggestions>...</suggestions>\n- NO text outside the tags`;
}

function buildChoicesInstruction() {
    const lang = cfg.choicesLang || 'en';
    let langNote;
    if (lang === 'ko') langNote = '⚠️ 모든 선택지를 한국어로 작성하세요.';
    else if (lang === 'ko-en') langNote = '⚠️ 지문(나레이션/행동 묘사)은 한국어로 작성하세요. 대사는 영어 전체를 먼저 쓰고, 그 뒤에 한국어 번역 전체를 괄호로 한 번만 병기하세요. 문장마다 끊어서 번역하지 마세요. 예: "I missed you. Where have you been all this time? (보고 싶었어. 그동안 어디 있었던 거야?)"';
    else langNote = '⚠️ Write all choices in English.';
    const detailMap = { brief: 'Keep each choice to 1-3 sentences (brief)', normal: 'Write 3-6 sentences per choice (moderate detail)' };
    let avoidNote = '';
    const cache = peekCache('choices');
    if (cache && cache.history.length > 0) {
        const prevBodies = [];
        for (const choices of cache.history) { for (const c of choices) { if (c.body) prevBodies.push(c.body.substring(0, 60)); } }
        if (prevBodies.length > 0) avoidNote = `\n\n⚠️ IMPORTANT: The following responses were already suggested. Do NOT repeat or closely resemble any of them:\n${prevBodies.map(b => `- ${b}...`).join('\n')}`;
    }
    return `${ctx.substituteParams(cfg.choicesPrompt)}\n\n${langNote}${avoidNote}\n\nOUTPUT FORMAT - Use this EXACT structure:\n<choices>\n[1]\nResponse content here. For mixed dialogue+narration, use separate paragraphs.\n\n[2]\nResponse content here.\n\n[3]\nResponse content here.\n</choices>\n\nRules:\n- Exactly ${cfg.choicesCount} choices\n- ${detailMap[cfg.choicesDetail] || detailMap.brief}\n- Each choice starts with [number]\n- Randomly mix: narration only, dialogue only, or dialogue+narration\n- Write as the user's character would actually speak/act\n- Wrap in <choices>...</choices>\n- NO text outside the tags`;
}

// ─── 컨텍스트 수집 ───

function findLastBot() {
    for (let i = ctx.chat.length - 1; i >= 0; i--) { if (!ctx.chat[i].is_user) return i; }
    return -1;
}

function getPersona() {
    try {
        if (!user_avatar || !power_user) return '';
        let s = ''; const name = power_user.personas?.[user_avatar] || power_user.name || 'User';
        s += `User/Persona: ${name}\n`;
        const desc = power_user.persona_descriptions?.[user_avatar];
        if (desc?.description) s += `\nPersona Description:\n${desc.description}\n`;
        else if (power_user.persona_description) s += `\nPersona Description:\n${power_user.persona_description}\n`;
        return s.trim();
    } catch { return ''; }
}

function getCharacter() {
    try {
        const c = SillyTavern.getContext(); const ch = c.characters?.[c.characterId];
        if (!ch) return ''; const d = ch.data || ch; let s = '';
        if (ch.name) s += `Character: ${ch.name}\n`;
        if (d.description) s += `\nDescription:\n${d.description}\n`;
        if (d.personality) s += `\nPersonality:\n${d.personality}\n`;
        if (d.scenario) s += `\nScenario:\n${d.scenario}\n`;
        if (d.creator_notes) s += `\nCreator Notes:\n${d.creator_notes}\n`;
        if (d.system_prompt) s += `\nSystem Prompt:\n${d.system_prompt}\n`;
        if (d.character_book?.entries) {
            const entries = Object.values(d.character_book.entries);
            if (entries.length) { s += `\n\nCharacter Lore (${entries.length} entries):\n`; entries.forEach(e => { if (e.content) s += `- ${e.content}\n`; }); }
        }
        return s.trim();
    } catch { return ''; }
}

async function getLore() {
    if (!ctx.chat?.length) return '';
    try {
        const lines = ctx.chat.map(m => m?.mes || '').filter(Boolean);
        if (!lines.length) return '';
        const r = await getWorldInfoPrompt(lines, 8000, true, undefined);
        return r?.worldInfoString?.trim() || '';
    } catch { return ''; }
}

async function gatherPlain(upTo) {
    let t = ''; const p = getPersona(); if (p) t += '=== PERSONA ===\n' + p + '\n\n';
    const c = getCharacter(); if (c) t += '=== CHARACTER ===\n' + c + '\n\n';
    const l = await getLore(); if (l) t += '=== LOREBOOK ===\n' + l + '\n\n';
    t += '=== CONVERSATION ===\n'; const start = Math.max(0, upTo - 29);
    for (let i = start; i <= upTo; i++) { const m = ctx.chat[i]; if (!m) continue; const who = m.is_user ? (m.name || 'User') : (m.name || 'Character'); t += `${who}: ${m.extra?.display_text ?? m.mes}\n\n`; }
    return t.trim();
}

async function gatherMessages(upTo) {
    const msgs = []; const p = getPersona(), c = getCharacter(), l = await getLore();
    let sys = ''; if (p) sys += p; if (c) sys += (sys ? '\n\n' : '') + c; if (l) sys += (sys ? '\n\n=== LOREBOOK ===\n' : '') + l;
    if (sys) msgs.push({ role: 'system', content: sys }); const start = Math.max(0, upTo - 29);
    for (let i = start; i <= upTo; i++) { const m = ctx.chat[i]; if (!m) continue; msgs.push({ role: m.is_user ? 'user' : 'assistant', content: m.extra?.display_text ?? m.mes }); }
    return msgs;
}

// ─── 파싱 (ideas/choices) ───

function parseIdeas(content) {
    if (!content) return null;
    const tagMatch = content.match(/<suggestions>\s*([\s\S]*?)\s*<\/suggestions>/i);
    const body = tagMatch ? tagMatch[1] : content;
    const blocks = []; const re = /\[([^\]]+)\]\s*\n([\s\S]*?)(?=\n\s*\[|\s*$)/g; let m;
    while ((m = re.exec(body)) !== null) { const title = m[1].trim(), desc = m[2].trim(); if (title && desc.length > 5) blocks.push({ title, body: desc }); }
    if (blocks.length) return blocks.slice(0, cfg.count || 8);
    const nums = []; const nr = /\d+\.\s*\*?\*?([^*\n:]+)\*?\*?\s*[-:]\s*([\s\S]*?)(?=\n\d+\.|$)/g;
    while ((m = nr.exec(body)) !== null) { const title = m[1].trim(), desc = m[2].trim(); if (title && desc.length > 5) nums.push({ title, body: desc }); }
    if (nums.length >= 2) return nums.slice(0, cfg.count || 8);
    const bullets = body.split('\n').map(l => l.trim()).filter(l => /^[-*•]\s+/.test(l)).map(l => l.replace(/^[-*•]\s*/, '').trim()).filter(l => l.length > 10);
    if (bullets.length >= 2) return bullets.slice(0, cfg.count || 8).map(b => ({ title: '', body: b }));
    return null;
}

function parseChoices(content) {
    if (!content) return null;
    const tagMatch = content.match(/<choices>\s*([\s\S]*?)\s*<\/choices>/i);
    const body = tagMatch ? tagMatch[1] : content;
    const blocks = []; const re = /\[(\d+)\]\s*\n([\s\S]*?)(?=\n\s*\[\d+\]|\s*$)/g; let m;
    while ((m = re.exec(body)) !== null) { const text = m[2].trim(); if (text.length > 5) blocks.push({ title: `선택지 ${m[1]}`, body: text }); }
    if (blocks.length) return blocks.slice(0, cfg.choicesCount || 8);
    const nums = []; const nr = /(\d+)\.\s*([\s\S]*?)(?=\n\d+\.|\s*$)/g;
    while ((m = nr.exec(body)) !== null) { const text = m[2].trim(); if (text.length > 5) nums.push({ title: `선택지 ${m[1]}`, body: text }); }
    if (nums.length >= 2) return nums.slice(0, cfg.choicesCount || 8);
    const paras = body.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 10);
    if (paras.length >= 2) return paras.slice(0, cfg.choicesCount || 8).map((p, i) => ({ title: `선택지 ${i + 1}`, body: p }));
    return null;
}

// ─── 렌더링 (ideas/choices) ───

function renderBlock(mode) {
    removeBlock();
    const cache = peekCache(mode); if (!cache) return;
    const total = cache.history.length, idx = cache.viewIdx, items = cache.history[idx];
    const isChoices = mode === 'choices';
    const blockTitle = isChoices ? '🎯 선택지' : '💡 에피소드 추천';
    const block = $('<div id="si-block" class="si-block"></div>');
    const head = $('<div class="si-block-head"></div>');
    head.append(`<span class="si-block-title">${blockTitle}</span>`);
    const right = $('<div class="si-block-btns"></div>');
    const nav = $('<div class="si-nav"></div>');
    const prevBtn = $('<button class="si-nav-btn" title="이전">◀</button>');
    const navLabel = $(`<span class="si-nav-label">${idx + 1}/${total}</span>`);
    const nextBtn = $('<button class="si-nav-btn" title="다음">▶</button>');
    if (idx <= 0) prevBtn.prop('disabled', true);
    if (idx >= total - 1) nextBtn.prop('disabled', true);
    prevBtn.on('click', () => { if (cache.viewIdx > 0) { cache.viewIdx--; persist(); renderBlock(mode); } });
    nextBtn.on('click', () => { if (cache.viewIdx < cache.history.length - 1) { cache.viewIdx++; persist(); renderBlock(mode); } });
    nav.append(prevBtn, navLabel, nextBtn); right.append(nav);
    right.append('<button class="si-block-btn si-do-collapse" title="접기/펼치기">▲</button>');
    right.append('<button class="si-block-btn si-do-refresh" title="새로 생성">🔄</button>');
    right.append('<button class="si-block-btn si-do-delete" title="전체 삭제">🗑️</button>');
    head.append(right); block.append(head);

    const cardsWrap = $('<div id="si-cards-area"></div>'); const cards = $('<div class="si-cards"></div>');
    items.forEach((item, i) => {
        const bodyText = item.body || '';
        const titleText = isChoices ? `선택지 ${i + 1}` : (item.title || `아이디어 ${i + 1}`);
        const card = $(`<div class="si-idea"><div class="si-idea-head"><span class="si-idea-num">${i + 1}</span><span class="si-idea-title">${esc(titleText)}</span></div><div class="si-idea-desc">${esc(bodyText).replace(/\n/g, '<br>')}</div><div class="si-idea-actions"><button class="si-idea-act si-act-copy" title="복사">📋 복사</button><button class="si-idea-act si-act-insert" title="입력창에 삽입">✏️ 삽입</button></div></div>`);
        card.find('.si-act-copy').on('click', async () => { const ok = await copyToClipboard(bodyText); if (ok) toastr.success('복사됨'); });
        card.find('.si-act-insert').on('click', () => {
            const textarea = $('#send_textarea'); if (!textarea.length) { toastr.warning('입력창을 찾을 수 없습니다.'); return; }
            const cur = textarea.val(); textarea.val(cur ? cur + '\n' + bodyText : bodyText); textarea.trigger('input'); textarea.focus(); toastr.success('입력창에 삽입됨');
        });
        cards.append(card);
    });
    cardsWrap.append(cards); block.append(cardsWrap); $('#chat').append(block);

    block.find('.si-do-collapse').on('click', function () { const area = $('#si-cards-area'); area.slideToggle(200); $(this).text(area.is(':visible') ? '▼' : '▲'); });
    block.find('.si-do-refresh').on('click', async () => { if (generating) return; await generate(true, mode); });
    block.find('.si-do-delete').on('click', () => {
        const key = chatKey(); const cacheObj = mode === 'choices' ? cfg.choicesCache : cfg.cache;
        if (key && cacheObj[key]) { delete cacheObj[key]; persist(); } removeBlock(); toastr.success('전체 삭제됨');
    });
}

function showLoading(mode) {
    removeBlock();
    const label = mode === 'choices' ? '🎯 선택지' : '💡 에피소드 추천';
    const loadMsg = mode === 'choices' ? '선택지 생성 중...' : '에피소드 추천 생성 중...';
    const block = $('<div id="si-block" class="si-block"></div>');
    block.html(`<div class="si-block-head"><span class="si-block-title">${label}</span></div><div id="si-cards-area"><div class="si-loading"><div class="si-dots"><span></span><span></span><span></span></div><span>${loadMsg}</span></div></div>`);
    $('#chat').append(block); scrollToBlock();
}

function showFail(msg, mode) {
    removeBlock();
    const label = mode === 'choices' ? '🎯 선택지' : '💡 에피소드 추천';
    const block = $('<div id="si-block" class="si-block"></div>');
    block.html(`<div class="si-block-head"><span class="si-block-title">${label}</span></div><div class="si-fail"><div class="si-fail-icon">${mode === 'choices' ? '🎯' : '💡'}</div><div class="si-fail-msg">생성에 실패했어요</div><div class="si-fail-detail">${esc(msg)}</div><div class="si-fail-btns"><button class="si-fail-retry">다시 시도</button><button class="si-fail-dismiss">닫기</button></div></div>`);
    $('#chat').append(block);
    block.find('.si-fail-retry').on('click', () => generate(false, mode));
    block.find('.si-fail-dismiss').on('click', () => removeBlock());
    scrollToBlock();
}

jQuery(async () => { await boot(); });
