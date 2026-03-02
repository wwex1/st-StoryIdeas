/**
 * Story Ideas - Episode Suggestion & Response Choices for SillyTavern
 * 에피소드 추천 + 선택지 생성 (듀얼 모드)
 */

import { event_types } from '../../../events.js';
import { getCurrentChatId, user_avatar } from '../../../../script.js';
import { power_user } from '../../../power-user.js';
import { getWorldInfoPrompt } from '../../../world-info.js';

const EXT_NAME = 'SillyTavern-StoryIdeas';

const INITIAL_PROMPT = `Based on the current roleplay context, suggest diverse episode ideas that could naturally follow from the story so far.

Vary the tone and genre of each suggestion—mix and match from possibilities like:
- Lighthearted or comedic moments
- Emotional or heartfelt scenes
- Suspenseful or mysterious developments
- Action or adventure scenarios
- Quiet slice-of-life interactions
- Dramatic reveals or turning points
- Romantic or relationship-focused events
- World-building or lore-expanding episodes

Draw from the characters' personalities, unresolved threads, world details, and recent events. Each idea should feel like a distinct flavor, not just variations of the same mood.`;

const CHOICES_PROMPT = `Based on the current roleplay context, generate possible next response options for the user's character.

Each option should be a natural continuation that the user's character might say or do next. Randomly vary the format of each option—some should be:
- Narration/action only (describing what the character does, their body language, inner thoughts)
- Dialogue only (what the character says)
- Mixed dialogue and narration (MUST be written as separate paragraphs — dialogue in one paragraph, narration in another, with a blank line between them)

CRITICAL FORMAT RULE for mixed dialogue+narration options:
Dialogue and narration MUST be in separate paragraphs with a blank line between them. Never combine dialogue and narration in the same paragraph.

Keep options diverse in tone and approach—assertive, hesitant, playful, serious, emotional, practical, etc. Each should feel like a meaningfully different choice that would take the story in a different direction.`;

const DEFAULTS = {
    enabled: true,
    ideasEnabled: true,
    choicesEnabled: true,
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
};

// 현재 활성 모드
let activeMode = 'ideas'; // 'ideas' | 'choices'

let cfg = {};
let ctx = null;
let generating = false;

function persist() { ctx.saveSettingsDebounced(); }

function esc(str) {
    const d = document.createElement('span');
    d.textContent = str;
    return d.innerHTML;
}

function chatKey() { return getCurrentChatId() || null; }

// 모드별 캐시
function getCache(mode) {
    const key = chatKey();
    if (!key) return null;
    const cacheObj = mode === 'choices' ? cfg.choicesCache : cfg.cache;
    if (!cacheObj[key]) cacheObj[key] = { history: [], viewIdx: -1 };
    // 마이그레이션
    if (cacheObj[key].ideas && !cacheObj[key].history) {
        cacheObj[key] = { history: [cacheObj[key].ideas], viewIdx: 0 };
        delete cacheObj[key].ideas;
        delete cacheObj[key].ts;
        persist();
    }
    return cacheObj[key];
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
            cfg.promptPresets['Default'] = INITIAL_PROMPT;
            changed = true;
        }
    }
    if (!cfg.promptPresets || Object.keys(cfg.promptPresets).length === 0) {
        cfg.promptPresets = { 'Default': INITIAL_PROMPT };
        changed = true;
    }

    const oldPromptStart = 'Based on the current roleplay context—characters, world-building, and recent conversation—suggest possible next episode';
    if (cfg.prompt && cfg.prompt.startsWith(oldPromptStart)) {
        cfg.prompt = INITIAL_PROMPT;
        changed = true;
    }

    for (const k of ['cssPresets', 'css', 'itemTemplate', 'openDefault', 'maxTokens', 'historyDepth']) {
        if (k in cfg) { delete cfg[k]; changed = true; }
    }
    if (cfg.detailLevel === 'detailed') { cfg.detailLevel = 'normal'; changed = true; }

    // 선택지 기본 프리셋
    if (!cfg.choicesPresets || Object.keys(cfg.choicesPresets).length === 0) {
        cfg.choicesPresets = { 'Default': CHOICES_PROMPT };
        changed = true;
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
        cfg.ideasEnabled = $(this).prop('checked'); persist();
        updateMenuVisibility();
    });

    root.find('.sc_choices_enabled').prop('checked', cfg.choicesEnabled).on('change', function () {
        cfg.choicesEnabled = $(this).prop('checked'); persist();
        updateMenuVisibility();
    });

    // 통합 API 소스 드롭다운
    const sourceSelect = root.find('.si_source');
    sourceSelect.empty();
    sourceSelect.append('<option value="main">Main API</option>');

    try {
        const cmrs = ctx.ConnectionManagerRequestService;
        let profiles = [];
        if (cmrs) {
            if (typeof cmrs.getConnectionProfiles === 'function') profiles = cmrs.getConnectionProfiles() || [];
            else if (typeof cmrs.getAllProfiles === 'function') profiles = cmrs.getAllProfiles() || [];
            else if (typeof cmrs.getProfiles === 'function') profiles = cmrs.getProfiles() || [];
            if (!profiles.length) {
                const s = ctx.extensionSettings?.connectionManager?.profiles
                    || ctx.extensionSettings?.ConnectionManager?.profiles;
                if (Array.isArray(s)) profiles = s;
                else if (s && typeof s === 'object') profiles = Object.values(s);
            }
        }
        console.log(`[${EXT_NAME}] 프로필 ${profiles.length}개 발견`);
        if (profiles.length) {
            profiles.forEach(p => {
                const id = p.id || p.profileId || '';
                const name = p.name || p.profileName || id;
                if (id) sourceSelect.append(`<option value="profile:${id}">${name}</option>`);
            });
        }
    } catch (e) {
        console.log(`[${EXT_NAME}] 프로필 목록 로드 실패:`, e);
    }

    const currentVal = cfg.apiSource === 'profile' && cfg.connectionProfileId
        ? `profile:${cfg.connectionProfileId}` : 'main';
    sourceSelect.val(currentVal);
    sourceSelect.on('change', function () {
        const val = $(this).val();
        if (val === 'main') {
            cfg.apiSource = 'main';
            cfg.connectionProfileId = '';
        } else {
            cfg.apiSource = 'profile';
            cfg.connectionProfileId = val.replace('profile:', '');
        }
        persist();
    });

    // ─── 에피소드 추천 탭 ───
    root.find('.si_count').val(cfg.count).on('change', function () { cfg.count = Number($(this).val()); persist(); });
    root.find('.si_detail_level').val(cfg.detailLevel).on('change', function () { cfg.detailLevel = $(this).val(); persist(); });
    root.find('.si_lang').val(cfg.lang).on('change', function () { cfg.lang = $(this).val(); persist(); });
    root.find('.si_prompt').val(cfg.prompt).on('change', function () { cfg.prompt = $(this).val(); persist(); });

    root.find('.si_prompt_reset').on('click', async function () {
        if (await ctx.Popup.show.confirm('에피소드 추천 프롬프트를 초기화할까요?', '설정 초기화')) {
            cfg.prompt = INITIAL_PROMPT;
            root.find('.si_prompt').val(INITIAL_PROMPT);
            persist(); toastr.success('프롬프트 초기화됨');
        }
    });

    root.find('.si_cache_clear').on('click', async function () {
        const total = Object.keys(cfg.cache || {}).length;
        if (!total) { toastr.info('캐시가 없습니다.'); return; }
        if (await ctx.Popup.show.confirm(`에피소드 추천 캐시 ${total}건을 삭제할까요?`, '캐시 초기화')) {
            cfg.cache = {};
            persist();
            if (activeMode === 'ideas') removeBlock();
            toastr.success('에피소드 캐시 초기화됨');
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
            cfg.choicesPrompt = CHOICES_PROMPT;
            root.find('.sc_prompt').val(CHOICES_PROMPT);
            persist(); toastr.success('프롬프트 초기화됨');
        }
    });

    root.find('.sc_cache_clear').on('click', async function () {
        const total = Object.keys(cfg.choicesCache || {}).length;
        if (!total) { toastr.info('캐시가 없습니다.'); return; }
        if (await ctx.Popup.show.confirm(`선택지 캐시 ${total}건을 삭제할까요?`, '캐시 초기화')) {
            cfg.choicesCache = {};
            persist();
            if (activeMode === 'choices') removeBlock();
            toastr.success('선택지 캐시 초기화됨');
        }
    });

    mountPresetUI(root, '.sc_prompt_preset', '.sc_preset_load', '.sc_preset_save', '.sc_preset_del',
        () => cfg.choicesPresets, v => { cfg.choicesPresets = v; },
        () => cfg.choicesPrompt, v => { cfg.choicesPrompt = v; root.find('.sc_prompt').val(v); });
}

function mountPresetUI(root, selSel, loadSel, saveSel, delSel, getPresets, setPresets, getPrompt, setPrompt) {
    const sel = root.find(selSel);
    function refresh() {
        sel.empty();
        Object.keys(getPresets() || {}).forEach(n => sel.append(`<option value="${n}">${n}</option>`));
    }
    refresh();

    root.find(loadSel).on('click', () => {
        const n = sel.val();
        if (!n || !getPresets()[n]) return;
        setPrompt(getPresets()[n]);
        persist();
        toastr.success(`"${n}" 적용됨`);
    });

    root.find(saveSel).on('click', async () => {
        const n = await ctx.Popup.show.input('프리셋 이름:', '저장');
        if (!n?.trim()) return;
        const t = n.trim();
        const presets = getPresets();
        if (presets[t] && !await ctx.Popup.show.confirm(`"${t}" 덮어쓸까요?`, '덮어쓰기')) return;
        presets[t] = getPrompt();
        setPresets(presets);
        persist(); refresh(); sel.val(t);
        toastr.success(`"${t}" 저장됨`);
    });

    root.find(delSel).on('click', async () => {
        const n = sel.val();
        if (!n) return toastr.warning('프리셋을 선택하세요.');
        if (await ctx.Popup.show.confirm(`"${n}" 삭제?`, '삭제')) {
            const presets = getPresets();
            delete presets[n];
            setPresets(presets);
            persist(); refresh();
            toastr.success(`"${n}" 삭제됨`);
        }
    });
}

// ─── 이벤트 ───

function updateMenuVisibility() {
    const btn1 = document.getElementById('si_menu_btn');
    const btn2 = document.getElementById('si_choices_btn');
    if (btn1) btn1.style.display = (cfg.enabled && cfg.ideasEnabled) ? '' : 'none';
    if (btn2) btn2.style.display = (cfg.enabled && cfg.choicesEnabled) ? '' : 'none';
}

function bindEvents() {
    // 에피소드 추천 버튼
    const menuBtn = document.createElement('div');
    menuBtn.id = 'si_menu_btn';
    menuBtn.className = 'list-group-item flex-container flexGap5 interactable';
    menuBtn.title = '에피소드 추천';
    menuBtn.innerHTML = '<i class="fa-solid fa-lightbulb"></i> 에피소드 추천';
    menuBtn.style.display = (cfg.enabled && cfg.ideasEnabled) ? '' : 'none';

    menuBtn.addEventListener('click', async () => {
        if (!cfg.enabled || generating) return;
        $('#extensionsMenu').hide();
        activeMode = 'ideas';

        const cache = getCache('ideas');
        if (cache && cache.history.length > 0) {
            renderBlock('ideas');
            scrollToBlock();
            return;
        }
        await generate(false, 'ideas');
    });

    // 선택지 생성 버튼
    const choicesBtn = document.createElement('div');
    choicesBtn.id = 'si_choices_btn';
    choicesBtn.className = 'list-group-item flex-container flexGap5 interactable';
    choicesBtn.title = '선택지 생성';
    choicesBtn.innerHTML = '<i class="fa-solid fa-list-check"></i> 선택지 생성';
    choicesBtn.style.display = (cfg.enabled && cfg.choicesEnabled) ? '' : 'none';

    choicesBtn.addEventListener('click', async () => {
        if (!cfg.enabled || generating) return;
        $('#extensionsMenu').hide();
        activeMode = 'choices';

        const cache = getCache('choices');
        if (cache && cache.history.length > 0) {
            renderBlock('choices');
            scrollToBlock();
            return;
        }
        await generate(false, 'choices');
    });

    const extMenu = document.getElementById('extensionsMenu');
    if (extMenu) {
        extMenu.appendChild(menuBtn);
        extMenu.appendChild(choicesBtn);
    } else {
        const obs = new MutationObserver((_, o) => {
            const m = document.getElementById('extensionsMenu');
            if (m) { m.appendChild(menuBtn); m.appendChild(choicesBtn); o.disconnect(); }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    ctx.eventSource.on(event_types.CHAT_CHANGED, () => removeBlock());
}

// ─── 블록 ───

function removeBlock() { $('#si-block').remove(); }

function scrollToBlock() {
    const el = document.getElementById('si-block');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

// ─── 생성 ───

async function generate(isRetry, mode) {
    if (generating || !cfg.enabled) return;
    activeMode = mode;

    if (cfg.apiSource === 'profile' && !cfg.connectionProfileId) {
        toastr.warning('Connection Profile을 선택하세요.'); return;
    }
    if (!ctx.chat?.length) { toastr.warning('대화 내역이 없습니다.'); return; }
    const lastBot = findLastBot();
    if (lastBot === -1) { toastr.warning('봇 메시지가 없습니다.'); return; }

    generating = true;
    const label = mode === 'choices' ? '선택지 생성' : '에피소드 추천';

    if (isRetry) {
        $('#si-cards-area').html(`
            <div class="si-regen-overlay">
                <div class="si-dots"><span></span><span></span><span></span></div>
                <span>재생성 중...</span>
            </div>
        `);
    } else {
        showLoading(mode);
    }

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
            if (!ctx.ConnectionManagerRequestService) throw new Error('Connection Manager 미로드');
            const resp = await ctx.ConnectionManagerRequestService.sendRequest(
                cfg.connectionProfileId, msgs, 4000,
                { stream: false, extractData: true, includePreset: false, includeInstruct: false },
            ).catch(e => { throw new Error(`Profile 오류: ${e.message}`); });

            if (typeof resp === 'string') raw = resp;
            else if (resp?.choices?.[0]?.message) {
                const m = resp.choices[0].message;
                raw = m.reasoning_content || m.content || '';
            } else raw = resp?.content || resp?.message || '';
        }

        const items = mode === 'choices' ? parseChoices(raw) : parseIdeas(raw);
        if (!items?.length) throw new Error('파싱 실패');

        const cache = getCache(mode);
        cache.history.push(items);
        cache.viewIdx = cache.history.length - 1;
        persist();

        renderBlock(mode);
        scrollToBlock();

    } catch (err) {
        console.error(`[${EXT_NAME}]`, err);
        toastr.error(`${label} 실패: ${err.message}`);

        if (isRetry) {
            const cache = getCache(mode);
            if (cache && cache.history.length > 0) renderBlock(mode);
        } else {
            showFail(err.message, mode);
        }
    } finally {
        generating = false;
    }
}

// ─── 프롬프트 ───

function buildInstruction(mode) {
    if (mode === 'choices') return buildChoicesInstruction();
    return buildIdeasInstruction();
}

function buildIdeasInstruction() {
    const langNote = (cfg.lang || 'en') === 'ko'
        ? '⚠️ 모든 추천을 한국어로 작성하세요.'
        : '⚠️ Write all suggestions in English.';
    const detailMap = {
        brief: 'Keep each description to 1-2 sentences (brief and concise)',
        normal: 'Write 3-5 sentences per description (moderate detail)',
    };

    let avoidNote = '';
    const cache = getCache('ideas');
    if (cache && cache.history.length > 0) {
        const prevTitles = [];
        for (const ideas of cache.history) {
            for (const idea of ideas) {
                if (idea.title) prevTitles.push(idea.title);
            }
        }
        if (prevTitles.length > 0) {
            avoidNote = `\n\n⚠️ IMPORTANT: The following ideas were already suggested. Do NOT repeat or closely resemble any of them. Come up with completely different ideas:\n${prevTitles.map(t => `- ${t}`).join('\n')}`;
        }
    }

    return `${ctx.substituteParams(cfg.prompt)}

${langNote}${avoidNote}

OUTPUT FORMAT - Use this EXACT structure:
<suggestions>
[Title of idea 1]
Description here.

[Title of idea 2]
Description here.
</suggestions>

Rules:
- Exactly ${cfg.count} suggestions
- ${detailMap[cfg.detailLevel] || detailMap.brief}
- Title in [brackets], description on next lines
- Wrap in <suggestions>...</suggestions>
- NO text outside the tags`;
}

function buildChoicesInstruction() {
    const langNote = (cfg.choicesLang || 'en') === 'ko'
        ? '⚠️ 모든 선택지를 한국어로 작성하세요.'
        : '⚠️ Write all choices in English.';
    const detailMap = {
        brief: 'Keep each choice to 1-3 sentences (brief)',
        normal: 'Write 3-6 sentences per choice (moderate detail)',
    };

    let avoidNote = '';
    const cache = getCache('choices');
    if (cache && cache.history.length > 0) {
        const prevBodies = [];
        for (const choices of cache.history) {
            for (const c of choices) {
                if (c.body) prevBodies.push(c.body.substring(0, 60));
            }
        }
        if (prevBodies.length > 0) {
            avoidNote = `\n\n⚠️ IMPORTANT: The following responses were already suggested. Do NOT repeat or closely resemble any of them:\n${prevBodies.map(b => `- ${b}...`).join('\n')}`;
        }
    }

    return `${ctx.substituteParams(cfg.choicesPrompt)}

${langNote}${avoidNote}

OUTPUT FORMAT - Use this EXACT structure:
<choices>
[1]
Response content here. For mixed dialogue+narration, use separate paragraphs.

[2]
Response content here.

[3]
Response content here.
</choices>

Rules:
- Exactly ${cfg.choicesCount} choices
- ${detailMap[cfg.choicesDetail] || detailMap.brief}
- Each choice starts with [number]
- Randomly mix: narration only, dialogue only, or dialogue+narration
- When mixing dialogue and narration, ALWAYS separate them with a blank line (different paragraphs)
- Write as the user's character would actually speak/act
- Wrap in <choices>...</choices>
- NO text outside the tags`;
}

// ─── 컨텍스트 수집 ───

function findLastBot() {
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        if (!ctx.chat[i].is_user) return i;
    }
    return -1;
}

function getPersona() {
    try {
        if (!user_avatar || !power_user) return '';
        let s = '';
        const name = power_user.personas?.[user_avatar] || power_user.name || 'User';
        s += `User/Persona: ${name}\n`;
        const desc = power_user.persona_descriptions?.[user_avatar];
        if (desc?.description) s += `\nPersona Description:\n${desc.description}\n`;
        else if (power_user.persona_description) s += `\nPersona Description:\n${power_user.persona_description}\n`;
        return s.trim();
    } catch { return ''; }
}

function getCharacter() {
    try {
        const c = SillyTavern.getContext();
        const ch = c.characters?.[c.characterId];
        if (!ch) return '';
        const d = ch.data || ch;
        let s = '';
        if (ch.name) s += `Character: ${ch.name}\n`;
        if (d.description) s += `\nDescription:\n${d.description}\n`;
        if (d.personality) s += `\nPersonality:\n${d.personality}\n`;
        if (d.scenario) s += `\nScenario:\n${d.scenario}\n`;
        if (d.creator_notes) s += `\nCreator Notes:\n${d.creator_notes}\n`;
        if (d.system_prompt) s += `\nSystem Prompt:\n${d.system_prompt}\n`;
        if (d.character_book?.entries) {
            const entries = Object.values(d.character_book.entries);
            if (entries.length) {
                s += `\n\nCharacter Lore (${entries.length} entries):\n`;
                entries.forEach(e => { if (e.content) s += `- ${e.content}\n`; });
            }
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
    let t = '';
    const p = getPersona();
    if (p) t += '=== PERSONA ===\n' + p + '\n\n';
    const c = getCharacter();
    if (c) t += '=== CHARACTER ===\n' + c + '\n\n';
    const l = await getLore();
    if (l) t += '=== LOREBOOK ===\n' + l + '\n\n';
    t += '=== CONVERSATION ===\n';
    const start = Math.max(0, upTo - 29);
    for (let i = start; i <= upTo; i++) {
        const m = ctx.chat[i];
        if (!m) continue;
        const who = m.is_user ? (m.name || 'User') : (m.name || 'Character');
        t += `${who}: ${m.extra?.display_text ?? m.mes}\n\n`;
    }
    return t.trim();
}

async function gatherMessages(upTo) {
    const msgs = [];
    const p = getPersona(), c = getCharacter(), l = await getLore();
    let sys = '';
    if (p) sys += p;
    if (c) sys += (sys ? '\n\n' : '') + c;
    if (l) sys += (sys ? '\n\n=== LOREBOOK ===\n' : '') + l;
    if (sys) msgs.push({ role: 'system', content: sys });
    const start = Math.max(0, upTo - 29);
    for (let i = start; i <= upTo; i++) {
        const m = ctx.chat[i];
        if (!m) continue;
        msgs.push({ role: m.is_user ? 'user' : 'assistant', content: m.extra?.display_text ?? m.mes });
    }
    return msgs;
}

// ─── 파싱 ───

function parseIdeas(content) {
    if (!content) return null;
    const tagMatch = content.match(/<suggestions>\s*([\s\S]*?)\s*<\/suggestions>/i);
    const body = tagMatch ? tagMatch[1] : content;

    const blocks = [];
    const re = /\[([^\]]+)\]\s*\n([\s\S]*?)(?=\n\s*\[|\s*$)/g;
    let m;
    while ((m = re.exec(body)) !== null) {
        const title = m[1].trim(), desc = m[2].trim();
        if (title && desc.length > 5) blocks.push({ title, body: desc });
    }
    if (blocks.length) return blocks.slice(0, cfg.count || 8);

    const nums = [];
    const nr = /\d+\.\s*\*?\*?([^*\n:]+)\*?\*?\s*[-:]\s*([\s\S]*?)(?=\n\d+\.|$)/g;
    while ((m = nr.exec(body)) !== null) {
        const title = m[1].trim(), desc = m[2].trim();
        if (title && desc.length > 5) nums.push({ title, body: desc });
    }
    if (nums.length >= 2) return nums.slice(0, cfg.count || 8);

    const bullets = body.split('\n').map(l => l.trim())
        .filter(l => /^[-*•]\s+/.test(l))
        .map(l => l.replace(/^[-*•]\s*/, '').trim())
        .filter(l => l.length > 10);
    if (bullets.length >= 2) return bullets.slice(0, cfg.count || 8).map(b => ({ title: '', body: b }));

    return null;
}

function parseChoices(content) {
    if (!content) return null;
    const tagMatch = content.match(/<choices>\s*([\s\S]*?)\s*<\/choices>/i);
    const body = tagMatch ? tagMatch[1] : content;

    // [1] ... [2] ... 형식
    const blocks = [];
    const re = /\[(\d+)\]\s*\n([\s\S]*?)(?=\n\s*\[\d+\]|\s*$)/g;
    let m;
    while ((m = re.exec(body)) !== null) {
        const text = m[2].trim();
        if (text.length > 5) blocks.push({ title: `선택지 ${m[1]}`, body: text });
    }
    if (blocks.length) return blocks.slice(0, cfg.choicesCount || 8);

    // 폴백: 번호 리스트
    const nums = [];
    const nr = /(\d+)\.\s*([\s\S]*?)(?=\n\d+\.|\s*$)/g;
    while ((m = nr.exec(body)) !== null) {
        const text = m[2].trim();
        if (text.length > 5) nums.push({ title: `선택지 ${m[1]}`, body: text });
    }
    if (nums.length >= 2) return nums.slice(0, cfg.choicesCount || 8);

    // 폴백: 단락 분리
    const paras = body.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 10);
    if (paras.length >= 2) {
        return paras.slice(0, cfg.choicesCount || 8).map((p, i) => ({ title: `선택지 ${i + 1}`, body: p }));
    }

    return null;
}

// ─── 렌더링 ───

function renderBlock(mode) {
    removeBlock();
    const cache = getCache(mode);
    if (!cache || cache.history.length === 0) return;

    const total = cache.history.length;
    const idx = cache.viewIdx;
    const items = cache.history[idx];
    const isChoices = mode === 'choices';
    const blockTitle = isChoices ? '🎯 선택지' : '💡 에피소드 추천';

    const block = $('<div id="si-block" class="si-block"></div>');

    // 헤더
    const head = $('<div class="si-block-head"></div>');
    head.append(`<span class="si-block-title">${blockTitle}</span>`);

    const right = $('<div class="si-block-btns"></div>');

    const nav = $('<div class="si-nav"></div>');
    const prevBtn = $(`<button class="si-nav-btn" title="이전">◀</button>`);
    const navLabel = $(`<span class="si-nav-label">${idx + 1}/${total}</span>`);
    const nextBtn = $(`<button class="si-nav-btn" title="다음">▶</button>`);

    if (idx <= 0) prevBtn.prop('disabled', true);
    if (idx >= total - 1) nextBtn.prop('disabled', true);

    prevBtn.on('click', () => {
        if (cache.viewIdx > 0) { cache.viewIdx--; persist(); renderBlock(mode); }
    });
    nextBtn.on('click', () => {
        if (cache.viewIdx < cache.history.length - 1) { cache.viewIdx++; persist(); renderBlock(mode); }
    });

    nav.append(prevBtn, navLabel, nextBtn);
    right.append(nav);
    right.append('<button class="si-block-btn si-do-refresh" title="새로 생성">🔄</button>');
    right.append('<button class="si-block-btn si-do-delete" title="전체 삭제">🗑️</button>');

    head.append(right);
    block.append(head);

    // 카드 영역
    const cardsWrap = $('<div id="si-cards-area"></div>');
    const cards = $('<div class="si-cards"></div>');

    items.forEach((item, i) => {
        const bodyText = item.body || '';
        const titleText = isChoices ? `선택지 ${i + 1}` : (item.title || `아이디어 ${i + 1}`);

        const card = $(`
            <div class="si-idea">
                <div class="si-idea-head">
                    <span class="si-idea-num">${i + 1}</span>
                    <span class="si-idea-title">${esc(titleText)}</span>
                </div>
                <div class="si-idea-desc">${esc(bodyText)}</div>
                <div class="si-idea-actions">
                    <button class="si-idea-act si-act-copy" title="복사">📋 복사</button>
                    <button class="si-idea-act si-act-insert" title="입력창에 삽입">✏️ 삽입</button>
                </div>
            </div>
        `);

        card.find('.si-act-copy').on('click', () => {
            navigator.clipboard.writeText(bodyText).then(() => toastr.success('복사됨')).catch(() => {
                const ta = document.createElement('textarea');
                ta.value = bodyText; document.body.appendChild(ta);
                ta.select(); document.execCommand('copy');
                document.body.removeChild(ta); toastr.success('복사됨');
            });
        });

        card.find('.si-act-insert').on('click', () => {
            const textarea = $('#send_textarea');
            if (!textarea.length) { toastr.warning('입력창을 찾을 수 없습니다.'); return; }
            const cur = textarea.val();
            textarea.val(cur ? cur + '\n' + bodyText : bodyText);
            textarea.trigger('input'); textarea.focus();
            toastr.success('입력창에 삽입됨');
        });

        cards.append(card);
    });

    cardsWrap.append(cards);
    block.append(cardsWrap);
    $('#chat').append(block);

    block.find('.si-do-refresh').on('click', async () => {
        if (generating) return;
        await generate(true, mode);
    });

    block.find('.si-do-delete').on('click', () => {
        const key = chatKey();
        const cacheObj = mode === 'choices' ? cfg.choicesCache : cfg.cache;
        if (key && cacheObj[key]) { delete cacheObj[key]; persist(); }
        removeBlock();
        toastr.success('전체 삭제됨');
    });
}

function showLoading(mode) {
    removeBlock();
    const label = mode === 'choices' ? '🎯 선택지' : '💡 에피소드 추천';
    const loadMsg = mode === 'choices' ? '선택지 생성 중...' : '에피소드 추천 생성 중...';
    const block = $('<div id="si-block" class="si-block"></div>');
    block.html(`
        <div class="si-block-head">
            <span class="si-block-title">${label}</span>
        </div>
        <div id="si-cards-area">
            <div class="si-loading">
                <div class="si-dots"><span></span><span></span><span></span></div>
                <span>${loadMsg}</span>
            </div>
        </div>
    `);
    $('#chat').append(block);
    scrollToBlock();
}

function showFail(msg, mode) {
    removeBlock();
    const label = mode === 'choices' ? '🎯 선택지' : '💡 에피소드 추천';
    const block = $('<div id="si-block" class="si-block"></div>');
    block.html(`
        <div class="si-block-head">
            <span class="si-block-title">${label}</span>
        </div>
        <div class="si-fail">
            <div class="si-fail-icon">${mode === 'choices' ? '🎯' : '💡'}</div>
            <div class="si-fail-msg">생성에 실패했어요</div>
            <div class="si-fail-detail">${esc(msg)}</div>
            <div class="si-fail-btns">
                <button class="si-fail-retry">다시 시도</button>
                <button class="si-fail-dismiss">닫기</button>
            </div>
        </div>
    `);
    $('#chat').append(block);
    block.find('.si-fail-retry').on('click', () => generate(false, mode));
    block.find('.si-fail-dismiss').on('click', () => removeBlock());
    scrollToBlock();
}

jQuery(async () => { await boot(); });
