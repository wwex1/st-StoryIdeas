/**
 * Story Ideas - Episode Suggestion Extension for SillyTavern
 * 마지막 메시지 아래에 에피소드 추천 카드 표시
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

const DEFAULTS = {
    enabled: true,
    apiSource: 'main',
    connectionProfileId: '',
    count: 3,
    detailLevel: 'brief',
    lang: 'en',
    prompt: INITIAL_PROMPT,
    promptPresets: {},
    cache: {},
};

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

    // 마이그레이션: 이전 버전 잔존 데이터 정리
    migrate();

    await mountSettings();
    bindEvents();
    console.log(`[${EXT_NAME}] Ready.`);
}

function migrate() {
    let changed = false;

    // 이전 버전의 기본 프리셋 제거 (Default는 유지)
    const oldPresets = ['Drama & Conflict', 'Adventure & Exploration', 'Slice of Life'];
    if (cfg.promptPresets) {
        for (const name of oldPresets) {
            if (cfg.promptPresets[name]) {
                delete cfg.promptPresets[name];
                changed = true;
            }
        }
        // Default 프리셋 내용도 새 프롬프트로 업데이트
        if (cfg.promptPresets['Default'] && cfg.promptPresets['Default'].startsWith('Based on the current roleplay context')) {
            cfg.promptPresets['Default'] = INITIAL_PROMPT;
            changed = true;
        }
    }
    // promptPresets가 없으면 Default 하나 생성
    if (!cfg.promptPresets || Object.keys(cfg.promptPresets).length === 0) {
        cfg.promptPresets = { 'Default': INITIAL_PROMPT };
        changed = true;
    }

    // 이전 버전 기본 프롬프트 → 새 프롬프트로 교체
    const oldPromptStart = 'Based on the current roleplay context—characters, world-building, and recent conversation—suggest possible next episode';
    if (cfg.prompt && cfg.prompt.startsWith(oldPromptStart)) {
        cfg.prompt = INITIAL_PROMPT;
        changed = true;
    }

    // 삭제된 설정 키 정리
    if ('detailLevel' in cfg && cfg.detailLevel === 'detailed') {
        cfg.detailLevel = 'normal';
        changed = true;
    }
    if ('cssPresets' in cfg) { delete cfg.cssPresets; changed = true; }
    if ('css' in cfg) { delete cfg.css; changed = true; }
    if ('itemTemplate' in cfg) { delete cfg.itemTemplate; changed = true; }
    if ('openDefault' in cfg) { delete cfg.openDefault; changed = true; }
    if ('maxTokens' in cfg) { delete cfg.maxTokens; changed = true; }
    if ('historyDepth' in cfg) { delete cfg.historyDepth; changed = true; }

    if (changed) {
        persist();
        console.log(`[${EXT_NAME}] Migration completed.`);
    }
}

// ─── 설정 패널 ───

async function mountSettings() {
    const html = await ctx.renderExtensionTemplateAsync(`third-party/${EXT_NAME}`, 'settings');
    $('#extensions_settings').append(html);
    const root = $('.story_ideas_settings');

    root.find('.si_enabled').prop('checked', cfg.enabled).on('change', function () {
        cfg.enabled = $(this).prop('checked');
        persist();
        const btn = document.getElementById('si_menu_btn');
        if (btn) btn.style.display = cfg.enabled ? '' : 'none';
        toastr.info(cfg.enabled ? 'Story Ideas 활성화됨' : 'Story Ideas 비활성화됨');
    });

    root.find('.si_source').val(cfg.apiSource).on('change', function () {
        cfg.apiSource = $(this).val();
        persist();
        $('#si_profile_area').toggle(cfg.apiSource === 'profile');
    });
    $('#si_profile_area').toggle(cfg.apiSource === 'profile');

    ctx.ConnectionManagerRequestService.handleDropdown(
        '.story_ideas_settings .si_connection_profile',
        cfg.connectionProfileId,
        (p) => { cfg.connectionProfileId = p?.id ?? ''; persist(); },
    );

    root.find('.si_count').val(cfg.count).on('change', function () {
        cfg.count = Number($(this).val()); persist();
    });

    root.find('.si_detail_level').val(cfg.detailLevel).on('change', function () {
        cfg.detailLevel = $(this).val(); persist();
    });

    root.find('.si_lang').val(cfg.lang).on('change', function () {
        cfg.lang = $(this).val(); persist();
    });

    root.find('.si_prompt').val(cfg.prompt).on('change', function () {
        cfg.prompt = $(this).val(); persist();
    });

    root.find('.si_prompt_reset').on('click', async function () {
        if (await ctx.Popup.show.confirm('기본 프롬프트로 복원할까요?', '초기화')) {
            cfg.prompt = INITIAL_PROMPT;
            root.find('.si_prompt').val(INITIAL_PROMPT);
            persist();
            toastr.success('프롬프트 초기화됨');
        }
    });

    // 프리셋
    mountPresetUI(root);
}

function mountPresetUI(root) {
    const sel = root.find('.si_prompt_preset');
    function refresh() {
        sel.empty();
        Object.keys(cfg.promptPresets || {}).forEach(n => sel.append(`<option value="${n}">${n}</option>`));
    }
    refresh();

    root.find('.si_preset_load').on('click', () => {
        const n = sel.val();
        if (!n || !cfg.promptPresets[n]) return;
        cfg.prompt = cfg.promptPresets[n];
        root.find('.si_prompt').val(cfg.prompt);
        persist();
        toastr.success(`"${n}" 적용됨`);
    });

    root.find('.si_preset_save').on('click', async () => {
        const n = await ctx.Popup.show.input('프리셋 이름:', '저장');
        if (!n?.trim()) return;
        const t = n.trim();
        if (cfg.promptPresets[t] && !await ctx.Popup.show.confirm(`"${t}" 덮어쓸까요?`, '덮어쓰기')) return;
        cfg.promptPresets[t] = cfg.prompt;
        persist(); refresh(); sel.val(t);
        toastr.success(`"${t}" 저장됨`);
    });

    root.find('.si_preset_del').on('click', async () => {
        const n = sel.val();
        if (!n) return toastr.warning('프리셋을 선택하세요.');
        if (await ctx.Popup.show.confirm(`"${n}" 삭제?`, '삭제')) {
            delete cfg.promptPresets[n];
            persist(); refresh();
            toastr.success(`"${n}" 삭제됨`);
        }
    });
}

// ─── 이벤트 ───

function bindEvents() {
    const menuBtn = document.createElement('div');
    menuBtn.id = 'si_menu_btn';
    menuBtn.className = 'list-group-item flex-container flexGap5 interactable';
    menuBtn.title = '에피소드 추천';
    menuBtn.innerHTML = '<i class="fa-solid fa-lightbulb"></i> 에피소드 추천';
    menuBtn.style.display = cfg.enabled ? '' : 'none';

    menuBtn.addEventListener('click', async () => {
        if (!cfg.enabled || generating) return;
        $('#extensionsMenu').hide();

        const key = chatKey();
        if (key && cfg.cache[key]?.ideas?.length) {
            renderBlock(cfg.cache[key].ideas);
            scrollToBlock();
            return;
        }
        await generate();
    });

    const extMenu = document.getElementById('extensionsMenu');
    if (extMenu) {
        extMenu.appendChild(menuBtn);
    } else {
        const obs = new MutationObserver((_, o) => {
            const m = document.getElementById('extensionsMenu');
            if (m) { m.appendChild(menuBtn); o.disconnect(); }
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

async function generate() {
    if (generating || !cfg.enabled) return;

    if (cfg.apiSource === 'profile' && !cfg.connectionProfileId) {
        toastr.warning('Connection Profile을 선택하세요.');
        return;
    }
    if (!ctx.chat?.length) { toastr.warning('대화 내역이 없습니다.'); return; }

    const lastBot = findLastBot();
    if (lastBot === -1) { toastr.warning('봇 메시지가 없습니다.'); return; }

    generating = true;
    showLoading();

    try {
        const instruction = buildInstruction();
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

        const ideas = parseIdeas(raw);
        if (!ideas?.length) throw new Error('파싱 실패');

        const key = chatKey();
        if (key) { cfg.cache[key] = { ideas, ts: Date.now() }; persist(); }

        renderBlock(ideas);
        scrollToBlock();

    } catch (err) {
        console.error(`[${EXT_NAME}]`, err);
        showError(err.message);
        toastr.error(`추천 생성 실패: ${err.message}`);
    } finally {
        generating = false;
    }
}

// ─── 프롬프트 ───

function buildInstruction() {
    const langNote = (cfg.lang || 'en') === 'ko'
        ? '⚠️ 모든 추천을 한국어로 작성하세요.'
        : '⚠️ Write all suggestions in English.';

    const detailMap = {
        brief: 'Keep each description to 1-2 sentences (brief and concise)',
        normal: 'Write 3-5 sentences per description (moderate detail)',
    };
    const detailNote = detailMap[cfg.detailLevel] || detailMap.brief;

    return `${ctx.substituteParams(cfg.prompt)}

${langNote}

OUTPUT FORMAT - Use this EXACT structure:
<suggestions>
[Title of idea 1]
Description here.

[Title of idea 2]
Description here.
</suggestions>

Rules:
- Exactly ${cfg.count} suggestions
- ${detailNote}
- Title in [brackets], description on next lines
- Wrap in <suggestions>...</suggestions>
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

// ─── 렌더링 ───

function renderBlock(ideas) {
    removeBlock();

    const block = $('<div id="si-block" class="si-block"></div>');

    const head = $('<div class="si-block-head"></div>');
    head.append('<span class="si-block-title">💡 에피소드 추천</span>');
    const btns = $('<div class="si-block-btns"></div>');
    btns.append('<button class="si-block-btn si-do-refresh" title="새로 생성">🔄</button>');
    btns.append('<button class="si-block-btn si-do-delete" title="삭제">🗑️</button>');
    head.append(btns);
    block.append(head);

    const cards = $('<div class="si-cards"></div>');
    ideas.forEach((idea, i) => {
        const bodyText = idea.body || '';

        const card = $(`
            <div class="si-idea">
                <div class="si-idea-head">
                    <span class="si-idea-num">${i + 1}</span>
                    <span class="si-idea-title">${esc(idea.title || `아이디어 ${i + 1}`)}</span>
                </div>
                <div class="si-idea-desc">${esc(bodyText)}</div>
                <div class="si-idea-actions">
                    <button class="si-idea-act si-act-copy" title="설명 복사">📋 복사</button>
                    <button class="si-idea-act si-act-insert" title="입력창에 삽입">✏️ 삽입</button>
                </div>
            </div>
        `);

        card.find('.si-act-copy').on('click', function () {
            navigator.clipboard.writeText(bodyText).then(() => {
                toastr.success('복사됨');
            }).catch(() => {
                const ta = document.createElement('textarea');
                ta.value = bodyText;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                toastr.success('복사됨');
            });
        });

        card.find('.si-act-insert').on('click', function () {
            const textarea = $('#send_textarea');
            if (!textarea.length) { toastr.warning('입력창을 찾을 수 없습니다.'); return; }
            const current = textarea.val();
            textarea.val(current ? current + '\n' + bodyText : bodyText);
            textarea.trigger('input');
            textarea.focus();
            toastr.success('입력창에 삽입됨');
        });

        cards.append(card);
    });
    block.append(cards);
    $('#chat').append(block);

    block.find('.si-do-refresh').on('click', async () => {
        if (generating) return;
        const key = chatKey();
        if (key && cfg.cache[key]) { delete cfg.cache[key]; persist(); }
        await generate();
    });

    block.find('.si-do-delete').on('click', () => {
        const key = chatKey();
        if (key && cfg.cache[key]) { delete cfg.cache[key]; persist(); }
        removeBlock();
        toastr.success('추천 삭제됨');
    });
}

function showLoading() {
    removeBlock();
    const block = $('<div id="si-block" class="si-block si-block-loading"></div>');
    block.html(`
        <div class="si-loading">
            <div class="si-spin"></div>
            <span>에피소드 추천 생성 중...</span>
        </div>
    `);
    $('#chat').append(block);
    scrollToBlock();
}

function showError(msg) {
    removeBlock();
    const block = $('<div id="si-block" class="si-block"></div>');
    block.html(`
        <div class="si-err">
            <div>❌ 생성 실패</div>
            <div style="margin-top:4px;opacity:0.7;font-size:0.85em;">${esc(msg)}</div>
            <button class="si-err-retry">🔄 재시도</button>
        </div>
    `);
    $('#chat').append(block);
    block.find('.si-err-retry').on('click', () => generate());
    scrollToBlock();
}

jQuery(async () => { await boot(); });
