/**
 * Cat-AI 前端逻辑
 */

// 全局状态
const state = {
  currentImage: null,
  uploadedImageUrl: '',   // 识别后服务端返回的图片 URL，用作登记头像
  identificationResult: null,
  knowledgeResult: null,
};

// DOM 元素
const uploadArea = document.getElementById('uploadArea');
const imageInput = document.getElementById('imageInput');
const cameraInput = document.getElementById('cameraInput');
const cameraBtn = document.getElementById('cameraBtn');
const previewArea = document.getElementById('previewArea');
const previewImg = document.getElementById('previewImg');
const identifyBtn = document.getElementById('identifyBtn');
const resultArea = document.getElementById('resultArea');
const registerForm = document.getElementById('registerForm');

// 初始化
function init() {
  loadModels();
  setupUpload();
  setupTabs();
  setupForm();
  loadPets();
}

// ─── 模型选择 ─────────────────────────────

let availableModels = [];

async function loadModels() {
  const select = document.getElementById('modelSelect');
  const hint = document.getElementById('modelHint');
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    availableModels = data.models || [];

    select.innerHTML = availableModels.map(m => {
      const tags = [];
      if (m.vision) tags.push('👁️ 视觉');
      else tags.push('🚫 不支持图片');
      if (!m.available) tags.push('未配置密钥');
      const label = `${m.label}（${tags.join(' · ')}）`;
      const disabled = (!m.vision || !m.available) ? 'disabled' : '';
      return `<option value="${escapeAttribute(m.id)}" ${disabled}>${escapeHtml(label)}</option>`;
    }).join('');

    // 恢复上次选择，否则用后端默认
    const saved = localStorage.getItem('catai_model');
    const usable = availableModels.filter(m => m.vision && m.available);
    const initial = (saved && usable.some(m => m.id === saved))
      ? saved
      : (usable.find(m => m.id === data.default) || usable[0] || {}).id;
    if (initial) select.value = initial;

    updateModelHint();
  } catch (err) {
    select.innerHTML = '<option value="">默认模型</option>';
    hint.textContent = '模型列表加载失败';
    console.error('加载模型列表失败:', err);
  }
}

function updateModelHint() {
  const select = document.getElementById('modelSelect');
  const hint = document.getElementById('modelHint');
  const m = availableModels.find(x => x.id === select.value);
  if (m) {
    hint.textContent = m.vision ? '支持图片识别' : '该模型不支持图片识别';
    hint.className = 'model-hint' + (m.vision ? '' : ' warn');
  }
  localStorage.setItem('catai_model', select.value);
}

// 上传区域事件
function setupUpload() {
  uploadArea.addEventListener('click', () => imageInput.click());
  
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });
  
  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });
  
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      handleImage(file);
    }
  });
  
  imageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleImage(file);
  });

  cameraBtn.addEventListener('click', () => cameraInput.click());
  cameraInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleImage(file);
  });

  identifyBtn.addEventListener('click', doIdentify);
  document.getElementById('modelSelect').addEventListener('change', updateModelHint);

}

// 处理图片
function handleImage(file) {
  state.currentImage = file;
  
  const reader = new FileReader();
  reader.onload = (e) => {
    previewImg.src = e.target.result;
    previewArea.classList.remove('hidden');
    identifyBtn.disabled = false;
  };
  reader.readAsDataURL(file);
}

// 执行识别
async function doIdentify() {
  if (!state.currentImage) return;
  
  identifyBtn.disabled = true;
  identifyBtn.innerHTML = '<span class="spinner"></span> 识别中...';
  
  const formData = new FormData();
  formData.append('image', state.currentImage);
  const modelSelect = document.getElementById('modelSelect');
  if (modelSelect.value) formData.append('model', modelSelect.value);
  
  try {
    const res = await fetch('/api/cat/identify', {
      method: 'POST',
      body: formData,
    });
    
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || '识别失败');
    }
    
    const data = await res.json();
    state.identificationResult = data.identification;
    state.knowledgeResult = data.knowledge;
    state.uploadedImageUrl = data.image_url || '';
    
    renderResult(data);
    renderKnowledge(data.knowledge);
    autoFillRegister(data.identification);
    
    showToast('✅ 识别成功！', 'success');
    
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
    console.error(err);
  } finally {
    identifyBtn.disabled = false;
    identifyBtn.innerHTML = '<span>🔍 开始识别</span>';
  }
}

// 渲染识别结果
function renderResult(data) {
  const id = data.identification;
  
  document.getElementById('breedName').textContent = id.breed || '未知品种';
  
  const badge = document.getElementById('confidenceBadge');
  badge.textContent = (id.confidence || '未知') + '置信度';
  badge.className = 'confidence-badge confidence-' + (id.confidence === '高' ? 'high' : id.confidence === '中' ? 'medium' : 'low');
  
  document.getElementById('colorValue').textContent = id.appearance?.color || '-';
  document.getElementById('patternValue').textContent = id.appearance?.pattern || '-';
  document.getElementById('bodyValue').textContent = id.appearance?.body_type || '-';
  document.getElementById('ageValue').textContent = id.estimated_age || '-';
  document.getElementById('healthValue').textContent = id.health_observation || '-';
  document.getElementById('descValue').textContent = id.description || '-';
  document.getElementById('modelUsed').textContent = data.model_used ? `识别模型：${data.model_used}` : '';
  
  resultArea.classList.remove('hidden');
}

// 渲染知识库
function renderKnowledge(knowledge) {
  document.getElementById('knowledgePlaceholder').classList.add('hidden');
  document.getElementById('knowledgeArea').classList.remove('hidden');
  
  document.getElementById('tab-basic').textContent = knowledge?.basic || '暂无基础信息';
  document.getElementById('tab-health').textContent = knowledge?.health || '暂无健康信息';
  document.getElementById('tab-care').textContent = knowledge?.care || '暂无饲养建议';
  document.getElementById('tab-price').textContent = knowledge?.price || '暂无价格信息';
}

// 自动填充登记表单
function autoFillRegister(id) {
  document.getElementById('regBreed').value = id.breed || '';
}

// 知识库标签切换
function setupTabs() {
  document.querySelectorAll('.knowledge-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.knowledge-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      const target = tab.dataset.tab;
      document.querySelectorAll('.knowledge-content').forEach(c => c.classList.add('hidden'));
      document.getElementById('tab-' + target).classList.remove('hidden');
    });
  });
}

// 登记表单
function setupForm() {
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const btn = document.getElementById('registerBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 保存中...';
    
    const id = state.identificationResult;
    const knowledge = state.knowledgeResult;
    
    const formData = new FormData();
    formData.append('name', document.getElementById('regName').value);
    formData.append('breed', document.getElementById('regBreed').value);
    formData.append('breed_confidence', id?.confidence || '');
    formData.append('color', id?.appearance?.color || '');
    formData.append('pattern', id?.appearance?.pattern || '');
    formData.append('estimated_age', id?.estimated_age || '');
    formData.append('gender', document.getElementById('regGender').value);
    formData.append('weight', document.getElementById('regWeight').value);
    formData.append('health_status', id?.health_observation || '');
    formData.append('avatar_path', state.uploadedImageUrl || '');
    formData.append('notes', document.getElementById('regNotes').value);
    formData.append('knowledge_summary', [
      '【基础信息】', knowledge?.basic?.slice(0, 500) || '',
      '\n【健康须知】', knowledge?.health?.slice(0, 500) || '',
      '\n【饲养建议】', knowledge?.care?.slice(0, 500) || '',
    ].join('\n'));
    
    try {
      const res = await fetch('/api/cat/register', {
        method: 'POST',
        body: formData,
      });
      
      const data = await res.json();
      if (data.success) {
        showToast('🎉 ' + data.message, 'success');
        registerForm.reset();
        document.getElementById('regBreed').value = '';
        loadPets();
      } else {
        throw new Error(data.message || '登记失败');
      }
    } catch (err) {
      showToast('❌ ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span>💾 确认登记</span>';
    }
  });
}

// 加载宠物列表
async function loadPets() {
  try {
    const res = await fetch('/api/cat/pets');
    const data = await res.json();
    
    document.getElementById('petCount').textContent = data.count;
    
    const list = document.getElementById('petList');
    if (data.count === 0) {
      list.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: #999; padding: 40px;">还没有登记的猫咪，快去识别一只吧！🐱</div>';
      return;
    }
    
    list.innerHTML = data.pets.map(pet => {
      const avatarSrc = safeImageSrc(pet.avatar_path);
      const weight = formatWeight(pet.weight);
      return `
        <div class="pet-card" data-id="${escapeAttribute(pet.id)}">
          <div class="avatar">${avatarSrc
            ? `<img src="${avatarSrc}" alt="${escapeAttribute(pet.name)}">`
            : getPetEmoji(pet.breed)}</div>
          <div class="name">${escapeHtml(pet.name)}</div>
          <div class="breed">${escapeHtml(pet.breed)}</div>
          <div class="meta">
            ${pet.gender !== '未知' ? escapeHtml(pet.gender) + ' · ' : ''}
            ${escapeHtml(pet.estimated_age || '')}
            ${weight ? ' · ' + escapeHtml(weight) + 'kg' : ''}
          </div>
        </div>
      `;
    }).join('');

    // 点击卡片进入该猫咪的独立档案页
    list.querySelectorAll('.pet-card').forEach(card => {
      card.addEventListener('click', () => {
        location.href = `pet.html?id=${card.dataset.id}`;
      });
    });
    
  } catch (err) {
    console.error('加载宠物列表失败:', err);
  }
}

function getPetEmoji(breed) {
  const map = {
    '英短': '😺', '美短': '🐱', '布偶': '😻', '暹罗': '😸',
    '缅因': '🦁', '波斯': '😽', '加菲': '😹', '德文': '😾',
    '斯芬克斯': '😿', '孟加拉': '🙀', '田园': '😼', '橘': '🐈',
  };
  for (const [key, emoji] of Object.entries(map)) {
    if (breed && breed.includes(key)) return emoji;
  }
  return '🐱';
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

function escapeAttribute(text) {
  return escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeImageSrc(value) {
  const src = String(value || '').trim();
  const isUpload = /^\/uploads\/[A-Za-z0-9._-]+$/.test(src);
  const isInlineImage = /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(src);
  return isUpload || isInlineImage ? escapeAttribute(src) : '';
}

function formatWeight(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? String(number) : '';
}

// Toast 提示
function showToast(message, type) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// 启动
document.addEventListener('DOMContentLoaded', init);
