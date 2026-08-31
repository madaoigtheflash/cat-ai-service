/**
 * Cat-AI 独立猫咪档案页
 * 功能：重新拍照识别 / 档案信息管理 / 知识库搜索
 */

const state = {
  pet: null,
  currentImage: null,
  identificationResult: null,
  knowledgeResult: null,
};

const petId = new URLSearchParams(location.search).get('id');

// ─── 初始化 ─────────────────────────────

async function init() {
  if (!petId) {
    alert('缺少猫咪 ID');
    location.href = 'index.html';
    return;
  }
  await loadPet();
  loadModels();
  setupUpload();
  setupEditForm();
  setupAiAsk();
  setupKnowledgeSearch();
  setupDelete();
  setupHealth();
}

async function loadPet() {
  try {
    const res = await fetch(`/api/cat/pets/${petId}`);
    if (!res.ok) {
      alert('猫咪档案不存在');
      location.href = 'index.html';
      return;
    }
    state.pet = (await res.json()).pet;
    renderHero();
    fillForm();
  } catch (err) {
    console.error('加载档案失败:', err);
  }
}

// ─── 档案头卡 ────────────────────────────

function renderHero() {
  const p = state.pet;
  const avatar = document.getElementById('heroAvatar');
  if (p.avatar_path) {
    avatar.innerHTML = `<img src="${escapeHtml(p.avatar_path)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" alt="">`;
  } else {
    avatar.textContent = getPetEmoji(p.breed);
  }

  const genderIcon = p.gender === '公' ? '♂' : p.gender === '母' ? '♀' : '';
  document.getElementById('heroName').textContent = `${p.name} ${genderIcon}`;
  document.getElementById('heroBreed').textContent =
    (p.breed || '未知品种') + (p.breed_confidence ? `（${p.breed_confidence}置信度）` : '');

  const meta = [];
  if (p.estimated_age) meta.push(p.estimated_age);
  if (p.birth_date) meta.push('生于 ' + p.birth_date);
  if (p.is_neutered) meta.push('已绝育');
  if (p.weight > 0) meta.push(p.weight + ' kg');
  if (p.color) meta.push(p.color);
  document.getElementById('heroMeta').textContent = meta.join(' · ') || '暂无更多信息';

  const fmt = ts => ts ? new Date(ts * 1000).toLocaleDateString('zh-CN') : '-';
  document.getElementById('heroDates').textContent =
    `登记于 ${fmt(p.created_at)} · 更新于 ${fmt(p.updated_at)}`;

  if (p.knowledge_summary) {
    document.getElementById('summaryArea').classList.remove('hidden');
    document.getElementById('summaryContent').textContent = p.knowledge_summary;
  }
}

// ─── 模型选择 ────────────────────────────

let availableModels = [];

async function loadModels() {
  const select = document.getElementById('modelSelect');
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    availableModels = data.models || [];

    select.innerHTML = availableModels.map(m => {
      const tags = [];
      if (m.vision) tags.push('👁️ 视觉');
      else tags.push('🚫 不支持图片');
      if (!m.available) tags.push('未配置密钥');
      const disabled = (!m.vision || !m.available) ? 'disabled' : '';
      return `<option value="${m.id}" ${disabled}>${m.label}（${tags.join(' · ')}）</option>`;
    }).join('');

    const saved = localStorage.getItem('catai_model');
    const usable = availableModels.filter(m => m.vision && m.available);
    const initial = (saved && usable.some(m => m.id === saved))
      ? saved
      : (usable.find(m => m.id === data.default) || usable[0] || {}).id;
    if (initial) select.value = initial;

    select.addEventListener('change', () => localStorage.setItem('catai_model', select.value));
  } catch (err) {
    select.innerHTML = '<option value="">默认模型</option>';
  }
}

// ─── 重新拍照识别 ─────────────────────────

function setupUpload() {
  const uploadArea = document.getElementById('uploadArea');
  const imageInput = document.getElementById('imageInput');
  const cameraInput = document.getElementById('cameraInput');
  const identifyBtn = document.getElementById('identifyBtn');

  uploadArea.addEventListener('click', () => imageInput.click());
  uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) handleImage(file);
  });
  imageInput.addEventListener('change', e => { if (e.target.files[0]) handleImage(e.target.files[0]); });

  document.getElementById('cameraBtn').addEventListener('click', () => cameraInput.click());
  cameraInput.addEventListener('change', e => { if (e.target.files[0]) handleImage(e.target.files[0]); });

  identifyBtn.addEventListener('click', doReidentify);
  document.getElementById('applyBtn').addEventListener('click', applyIdentification);
}

function handleImage(file) {
  state.currentImage = file;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('previewImg').src = e.target.result;
    document.getElementById('previewArea').classList.remove('hidden');
    document.getElementById('identifyBtn').disabled = false;
  };
  reader.readAsDataURL(file);
}

async function doReidentify() {
  if (!state.currentImage) return;
  const btn = document.getElementById('identifyBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 识别中...';

  const formData = new FormData();
  formData.append('image', state.currentImage);
  const model = document.getElementById('modelSelect').value;
  if (model) formData.append('model', model);

  try {
    const res = await fetch(`/api/cat/pets/${petId}/reidentify`, { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || '识别失败');
    }
    const data = await res.json();
    state.identificationResult = data.identification;
    state.knowledgeResult = data.knowledge;

    renderIdentifyResult(data);

    // 头像已被后端更新，刷新头卡
    state.pet.avatar_path = data.image_url;
    renderHero();

    showToast('✅ 识别成功，头像已更新', 'success');
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🔍 重新识别';
  }
}

function renderIdentifyResult(data) {
  const id = data.identification;
  document.getElementById('resultBreed').textContent = id.breed || '未知品种';
  const badge = document.getElementById('resultConfidence');
  badge.textContent = (id.confidence || '未知') + '置信度';
  badge.className = 'confidence-badge confidence-' +
    (id.confidence === '高' ? 'high' : id.confidence === '中' ? 'medium' : 'low');
  document.getElementById('resultColor').textContent = id.appearance?.color || '-';
  document.getElementById('resultPattern').textContent = id.appearance?.pattern || '-';
  document.getElementById('resultBody').textContent = id.appearance?.body_type || '-';
  document.getElementById('resultAge').textContent = id.estimated_age || '-';
  document.getElementById('resultHealth').textContent = id.health_observation || '-';
  document.getElementById('resultDesc').textContent = id.description || '-';
  document.getElementById('modelUsed').textContent = data.model_used ? `识别模型：${data.model_used}` : '';
  document.getElementById('resultArea').classList.remove('hidden');
}

// 把识别结果写入档案字段
async function applyIdentification() {
  const id = state.identificationResult;
  if (!id) return;

  const knowledge = state.knowledgeResult;
  const updates = {
    breed: id.breed || '',
    breed_confidence: id.confidence || '',
    color: id.appearance?.color || '',
    pattern: id.appearance?.pattern || '',
    estimated_age: id.estimated_age || '',
    health_status: id.health_observation || '',
    knowledge_summary: [
      '【基础信息】', knowledge?.basic?.slice(0, 500) || '',
      '\n【健康须知】', knowledge?.health?.slice(0, 500) || '',
      '\n【饲养建议】', knowledge?.care?.slice(0, 500) || '',
    ].join('\n'),
  };

  try {
    const res = await fetch(`/api/cat/pets/${petId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    const data = await res.json();
    if (data.success) {
      state.pet = data.pet;
      renderHero();
      fillForm();
      showToast('✅ 识别结果已应用到档案', 'success');
    } else {
      throw new Error(data.detail || '更新失败');
    }
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
}

// ─── 档案信息编辑 ─────────────────────────

function fillForm() {
  const p = state.pet;
  document.getElementById('fName').value = p.name || '';
  document.getElementById('fBreed').value = p.breed || '';
  document.getElementById('fGender').value = p.gender || '未知';
  document.getElementById('fWeight').value = p.weight || '';
  document.getElementById('fColor').value = p.color || '';
  document.getElementById('fPattern').value = p.pattern || '';
  document.getElementById('fAge').value = p.estimated_age || '';
  document.getElementById('fBirthDate').value = p.birth_date || '';
  document.getElementById('fNeutered').value = p.is_neutered ? 'true' : 'false';
  document.getElementById('fMicrochip').value = p.microchip || '';
  document.getElementById('fConfidence').value = p.breed_confidence || '';
  document.getElementById('fHealth').value = p.health_status || '';
  document.getElementById('fNotes').value = p.notes || '';
}

function setupEditForm() {
  document.getElementById('editForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 保存中...';

    const updates = {
      name: document.getElementById('fName').value,
      breed: document.getElementById('fBreed').value,
      gender: document.getElementById('fGender').value,
      weight: parseFloat(document.getElementById('fWeight').value) || 0,
      color: document.getElementById('fColor').value,
      pattern: document.getElementById('fPattern').value,
      estimated_age: document.getElementById('fAge').value,
      birth_date: document.getElementById('fBirthDate').value,
      is_neutered: document.getElementById('fNeutered').value === 'true',
      microchip: document.getElementById('fMicrochip').value,
      breed_confidence: document.getElementById('fConfidence').value,
      health_status: document.getElementById('fHealth').value,
      notes: document.getElementById('fNotes').value,
    };

    try {
      const res = await fetch(`/api/cat/pets/${petId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (data.success) {
        state.pet = data.pet;
        renderHero();
        showToast('💾 保存成功', 'success');
      } else {
        throw new Error(data.detail || '保存失败');
      }
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '💾 保存修改';
    }
  });
}

// ─── AI 知识问答 ───────────────────────────

function setupAiAsk() {
  const input = document.getElementById('aiQuestion');
  const btn = document.getElementById('aiAskBtn');
  btn.addEventListener('click', () => askAi(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      askAi(input.value);
    }
  });
  document.querySelectorAll('.ai-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const breed = state.pet?.breed || '';
      const question = breed ? `${breed}：${chip.dataset.q}` : chip.dataset.q;
      input.value = question;
      askAi(question);
    });
  });
}

async function askAi(question) {
  question = (question || '').trim();
  if (!question) return;

  const box = document.getElementById('aiAnswer');
  const btn = document.getElementById('aiAskBtn');
  box.innerHTML = '<div class="search-empty">AI 思考中…</div>';
  btn.disabled = true;
  try {
    const formData = new FormData();
    formData.append('query', question);
    formData.append('breed', state.pet?.breed || '');
    formData.append('model', document.getElementById('modelSelect')?.value || '');
    const res = await fetch('/api/cat/knowledge/ask', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `请求失败：${res.status}`);
    if (!data.answer) throw new Error('模型没有返回有效回答');

    const citations = (data.citations || []).map(item =>
      `<span style="display:inline-block;margin-right:8px;">📄 ${escapeHtml(item.title || item.id || '')}</span>`
    ).join('');
    box.innerHTML = `
      <div class="search-result">
        <div class="doc-title">🤖 AI 知识问答</div>
        <div class="doc-content">${escapeHtml(data.answer)}</div>
        ${citations ? `<div style="font-size:11px;color:#999;margin-top:8px;">参考：${citations}</div>` : ''}
        ${data.model_used ? `<div style="font-size:11px;color:#999;margin-top:6px;">模型：${escapeHtml(data.model_used)}</div>` : ''}
      </div>`;
  } catch (err) {
    box.innerHTML = '<div class="search-empty">AI 问答失败：' + escapeHtml(err.message) + '</div>';
  } finally {
    btn.disabled = false;
  }
}

// ─── 本地知识库搜索 ─────────────────────────

function setupKnowledgeSearch() {
  const input = document.getElementById('kbQuery');
  const btn = document.getElementById('kbSearchBtn');
  if (state.pet?.breed) input.value = state.pet.breed;

  btn.addEventListener('click', () => searchKnowledge(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchKnowledge(input.value);
    }
  });
  document.querySelectorAll('.kb-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const breed = state.pet?.breed || '';
      const query = breed ? `${breed} ${chip.dataset.q}` : chip.dataset.q;
      input.value = query;
      searchKnowledge(query);
    });
  });

  // 自动加载只执行本地检索，不调用 AI。
  if (input.value.trim()) searchKnowledge(input.value);
}

async function searchKnowledge(query) {
  query = (query || '').trim();
  if (!query) return;

  const box = document.getElementById('kbResults');
  box.innerHTML = '<div class="search-empty">搜索中…</div>';

  try {
    const formData = new FormData();
    formData.append('query', query);
    formData.append('top_k', 5);
    const res = await fetch('/api/cat/knowledge/search', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `请求失败：${res.status}`);

    if (!data.results || data.results.length === 0) {
      box.innerHTML = '<div class="search-empty">没有找到相关知识，换个关键词试试</div>';
      return;
    }

    box.innerHTML = data.results.map(r => `
      <div class="search-result">
        <div class="doc-title">${escapeHtml(r.title || r.id)}</div>
        <div class="doc-content">${escapeHtml(r.content || '')}</div>
        ${r.model_used ? `<div style="font-size:11px;color:#999;margin-top:6px;">模型：${escapeHtml(r.model_used)}</div>` : ''}
      </div>
    `).join('');
  } catch (err) {
    box.innerHTML = '<div class="search-empty">搜索失败：' + escapeHtml(err.message) + '</div>';
  }
}

// ─── 健康管理（疫苗/驱虫/体重/医疗）─────────────

function setupHealth() {
  // Tab 切换
  document.querySelectorAll('.health-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.health-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.health-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    });
  });

  // 默认日期填今天
  const today = new Date().toISOString().slice(0, 10);
  ['wDate', 'dDate', 'mDate'].forEach(id => { document.getElementById(id).value = today; });

  // 添加按钮
  document.getElementById('vAdd').addEventListener('click', () => {
    addRecord('vaccines', {
      vaccine_name: document.getElementById('vName').value,
      note: document.getElementById('vNote').value,
      due_date: document.getElementById('vDue').value,
      completed_date: document.getElementById('vDone').value,
    }, ['due_date']);
  });

  document.getElementById('dAdd').addEventListener('click', () => {
    addRecord('deworming', {
      type: document.getElementById('dType').value,
      product: document.getElementById('dProduct').value,
      date: document.getElementById('dDate').value,
      next_date: document.getElementById('dNext').value,
    }, ['date']);
  });

  document.getElementById('wAdd').addEventListener('click', () => {
    addRecord('weights', {
      date: document.getElementById('wDate').value,
      weight: parseFloat(document.getElementById('wWeight').value) || 0,
      note: document.getElementById('wNote').value,
    }, ['date', 'weight']);
  });

  document.getElementById('mAdd').addEventListener('click', () => {
    addRecord('medical', {
      date: document.getElementById('mDate').value,
      hospital: document.getElementById('mHospital').value,
      doctor: document.getElementById('mDoctor').value,
      diagnosis: document.getElementById('mDiagnosis').value,
      notes: document.getElementById('mNotes').value,
    }, ['date']);
  });

  renderHealthAll();
}

async function addRecord(kind, record, requiredFields) {
  for (const f of requiredFields) {
    if (!record[f]) {
      showToast('请填写完整：' + ({ due_date: '应接种日期', date: '日期', weight: '体重' }[f] || f), 'error');
      return;
    }
  }
  try {
    const res = await fetch(`/api/cat/pets/${petId}/records/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.detail || '添加失败');

    state.pet[kind].push(data.record);
    if (kind === 'weights') {
      state.pet.weights.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      state.pet.weight = data.record.weight;  // 后端已联动当前体重
      renderHero();
      fillForm();
    }
    renderHealth(kind);
    showToast('✅ 记录已添加', 'success');
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
}

async function deleteRecord(kind, recordId) {
  try {
    const res = await fetch(`/api/cat/pets/${petId}/records/${kind}/${recordId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) throw new Error(data.detail || '删除失败');
    state.pet[kind] = state.pet[kind].filter(r => r.id !== recordId);
    renderHealth(kind);
    showToast('🗑️ 记录已删除', 'success');
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
}

function renderHealthAll() {
  ['vaccines', 'deworming', 'weights', 'medical'].forEach(renderHealth);
}

function renderHealth(kind) {
  const box = document.getElementById('list-' + kind);
  const records = state.pet?.[kind] || [];
  if (!records.length) {
    box.innerHTML = '<div class="empty-tip">暂无记录</div>';
    if (kind === 'weights') document.getElementById('weightChart').classList.add('hidden');
    return;
  }

  const renderers = {
    vaccines: renderVaccine,
    deworming: renderDeworm,
    weights: renderWeight,
    medical: renderMedical,
  };
  box.innerHTML = records.map(r => renderRecordItem(kind, r, renderers[kind])).join('');

  box.querySelectorAll('.rec-del').forEach(btn => {
    btn.addEventListener('click', () => deleteRecord(kind, btn.dataset.rid));
  });

  if (kind === 'weights') renderWeightChart(records);
}

function renderRecordItem(kind, r, bodyFn) {
  return `
    <div class="record-item">
      ${bodyFn(r)}
      <button class="rec-del" data-rid="${r.id}" title="删除">✕</button>
    </div>`;
}

function vaccineStatus(r) {
  if (r.completed_date) return ['已完成', 'status-completed'];
  const today = new Date().toISOString().slice(0, 10);
  if (r.due_date && r.due_date < today) return ['已超期', 'status-overdue'];
  return ['待接种', 'status-pending'];
}

function renderVaccine(r) {
  const [text, cls] = vaccineStatus(r);
  return `
    <div class="rec-main">
      <div class="rec-title">💉 ${escapeHtml(r.vaccine_name)}${r.note ? ' · ' + escapeHtml(r.note) : ''}</div>
      <div class="rec-sub">
        ${r.completed_date ? '✅ 已接种 ' + r.completed_date : '📅 应接种 ' + (r.due_date || '-')}
        ${r.completed_date && r.due_date ? ' · 原定 ' + r.due_date : ''}
      </div>
    </div>
    <span class="status-badge ${cls}">${text}</span>`;
}

function renderDeworm(r) {
  const overdue = r.next_date && r.next_date < new Date().toISOString().slice(0, 10);
  return `
    <div class="rec-main">
      <div class="rec-title">💊 ${escapeHtml(r.type)}${r.product ? ' · ' + escapeHtml(r.product) : ''}</div>
      <div class="rec-sub">📅 ${r.date || '-'}${r.next_date ? ' · 下次 ' + r.next_date : ''}</div>
    </div>
    ${overdue ? '<span class="status-badge status-overdue">已超期</span>' : ''}`;
}

function renderWeight(r) {
  return `
    <div class="rec-main">
      <div class="rec-title">⚖️ ${r.weight} kg</div>
      <div class="rec-sub">📅 ${r.date || '-'}${r.note ? ' · ' + escapeHtml(r.note) : ''}</div>
    </div>`;
}

function renderMedical(r) {
  return `
    <div class="rec-main">
      <div class="rec-title">🩺 ${escapeHtml(r.diagnosis || '就诊记录')}</div>
      <div class="rec-sub">
        📅 ${r.date || '-'} · ${escapeHtml(r.hospital || '')}${r.doctor ? ' · ' + escapeHtml(r.doctor) : ''}
        ${r.notes ? '<br>' + escapeHtml(r.notes) : ''}
      </div>
    </div>`;
}

// 体重趋势 SVG 折线图
function renderWeightChart(records) {
  const svg = document.getElementById('weightChart');
  const pts = records.filter(r => r.date && r.weight > 0);
  if (pts.length < 2) { svg.classList.add('hidden'); return; }
  svg.classList.remove('hidden');

  const W = 600, H = 180, PAD = 40;
  const ws = pts.map(r => r.weight);
  const min = Math.min(...ws), max = Math.max(...ws);
  const span = (max - min) || 1;
  const x = i => PAD + i * (W - 2 * PAD) / (pts.length - 1);
  const y = w => H - PAD - (w - min) / span * (H - 2 * PAD);

  const line = pts.map((r, i) => `${x(i)},${y(r.weight)}`).join(' ');
  const dots = pts.map((r, i) =>
    `<circle cx="${x(i)}" cy="${y(r.weight)}" r="4" fill="#FF7043"/>
     <text x="${x(i)}" y="${y(r.weight) - 10}" text-anchor="middle" font-size="11" fill="#795548">${r.weight}</text>`
  ).join('');
  const dates = pts.map((r, i) =>
    `<text x="${x(i)}" y="${H - 12}" text-anchor="middle" font-size="10" fill="#aaa">${(r.date || '').slice(5)}</text>`
  ).join('');

  svg.innerHTML = `
    <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="#F5E6E0"/>
    <polyline points="${line}" fill="none" stroke="#FF7043" stroke-width="2.5" stroke-linejoin="round"/>
    ${dots}${dates}`;
}

// ─── 删除 ────────────────────────────────

function setupDelete() {
  document.getElementById('deleteBtn').addEventListener('click', async () => {
    if (!confirm(`确定要删除「${state.pet.name}」的档案吗？此操作不可恢复。`)) return;
    try {
      const res = await fetch(`/api/cat/pets/${petId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        showToast('🗑️ 档案已删除', 'success');
        setTimeout(() => location.href = 'index.html', 800);
      } else {
        throw new Error(data.detail || '删除失败');
      }
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    }
  });
}

// ─── 工具函数 ─────────────────────────────

function getPetEmoji(breed) {
  const map = {
    '英短': '😺', '美短': '🐱', '布偶': '😻', '暹罗': '😸',
    '缅因': '🦁', '波斯': '😽', '加菲': '😹', '德文': '😾',
    '斯芬克斯': '😿', '孟加拉': '🙀', '田园': '😼', '狸花': '😼', '橘': '🐈',
  };
  for (const [key, emoji] of Object.entries(map)) {
    if (breed && breed.includes(key)) return emoji;
  }
  return '🐱';
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showToast(message, type) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

document.addEventListener('DOMContentLoaded', init);
