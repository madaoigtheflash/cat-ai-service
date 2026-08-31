/**
 * Android 独立版适配层。
 *
 * 普通浏览器中 window.AndroidBridge 不存在，本文件立即退出，原 Web/FastAPI
 * 行为完全不变；APK WebView 中则把现有 /api 调用映射到原生模型请求和本地档案。
 */
(function setupAndroidAdapter() {
  if (!window.AndroidBridge) return;

  const originalFetch = window.fetch.bind(window);
  const petsStorageKey = 'cat_ai_android_pets_v1';
  const pendingIdentifications = new Map();
  const pendingChats = new Map();
  let requestSequence = 0;
  let nativePetStoreReady = false;

  function jsonResponse(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return body; },
      async text() { return JSON.stringify(body); },
    };
  }

  function nativeConfig() {
    try {
      return JSON.parse(window.AndroidBridge.getConfig());
    } catch (error) {
      return { provider: 'minimax', model: '内置视觉模型', hasKey: false, standalone: true };
    }
  }

  function initializePetStore() {
    if (typeof window.AndroidBridge.listPets !== 'function'
        || typeof window.AndroidBridge.replacePets !== 'function') {
      return;
    }
    try {
      const legacyJson = localStorage.getItem(petsStorageKey) || '[]';
      if (typeof window.AndroidBridge.migrateLegacyPets === 'function') {
        const migration = JSON.parse(window.AndroidBridge.migrateLegacyPets(legacyJson));
        if (!migration.success) throw new Error(migration.detail || '档案迁移失败');
      }
      const value = JSON.parse(window.AndroidBridge.listPets());
      if (!Array.isArray(value)) throw new Error(value.detail || '档案数据库返回异常');
      nativePetStoreReady = true;
      localStorage.removeItem(petsStorageKey);
    } catch (error) {
      console.error('初始化原生档案数据库失败，继续使用旧版存储:', error);
      nativePetStoreReady = false;
    }
  }

  function readPets() {
    if (nativePetStoreReady) {
      try {
        const value = JSON.parse(window.AndroidBridge.listPets());
        if (!Array.isArray(value)) throw new Error(value.detail || '读取失败');
        return value;
      } catch (error) {
        console.error('读取原生档案失败:', error);
        return [];
      }
    }
    try {
      const value = JSON.parse(localStorage.getItem(petsStorageKey) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (error) {
      return [];
    }
  }

  function savePets(pets) {
    if (nativePetStoreReady) {
      const result = JSON.parse(window.AndroidBridge.replacePets(JSON.stringify(pets)));
      if (!result.success) throw new Error(result.detail || '保存失败');
      return;
    }
    localStorage.setItem(petsStorageKey, JSON.stringify(pets));
  }

  initializePetStore();

  function fileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
  }

  function resizeImage(dataUrl, maxSide, quality, fallback) {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) {
          resolve(fallback);
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      image.onerror = () => resolve(fallback);
      image.src = dataUrl;
    });
  }

  function identifyWithNative(imageDataUrl, thumbnail, model) {
    return new Promise((resolve) => {
      const requestId = `identify_${Date.now()}_${++requestSequence}`;
      pendingIdentifications.set(requestId, { resolve, thumbnail });
      window.AndroidBridge.identify(requestId, imageDataUrl, model || '');
    });
  }

  function chatWithNative(question, breedContext) {
    return new Promise((resolve) => {
      const requestId = `chat_${Date.now()}_${++requestSequence}`;
      pendingChats.set(requestId, { resolve });
      window.AndroidBridge.chat(requestId, question, breedContext || '');
    });
  }

  window.CatAiAndroid = {
    onIdentifyResult(requestId, success, payloadText) {
      const pending = pendingIdentifications.get(requestId);
      if (!pending) return;
      pendingIdentifications.delete(requestId);

      let payload;
      try {
        payload = JSON.parse(payloadText);
      } catch (error) {
        payload = { detail: '原生识别结果解析失败' };
        success = false;
      }
      if (success) payload.image_url = pending.thumbnail || '';
      pending.resolve(jsonResponse(payload, success ? 200 : 500));
    },

    onChatResult(requestId, success, payloadText) {
      const pending = pendingChats.get(requestId);
      if (!pending) return;
      pendingChats.delete(requestId);

      let payload;
      try {
        payload = JSON.parse(payloadText);
      } catch (error) {
        payload = { detail: 'AI 问答结果解析失败' };
        success = false;
      }
      pending.resolve(jsonResponse(payload, success ? 200 : 500));
    },
  };

  window.fetch = async function androidFetch(input, init = {}) {
    const rawUrl = typeof input === 'string' ? input : input.url;
    const url = new URL(rawUrl, window.location.href);
    const path = url.pathname;
    const method = (init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();

    // ─── 模型列表 ──────────────────────────────
    if (path === '/api/models' && method === 'GET') {
      const config = nativeConfig();
      return jsonResponse({
        default: 'bundled',
        models: [{
          id: 'bundled',
          label: `内置模型 / ${config.model}`,
          model: config.model,
          vision: true,
          available: Boolean(config.hasKey),
        }],
      });
    }

    // ─── 识别 ──────────────────────────────────
    if (path === '/api/cat/identify' && method === 'POST') {
      const form = init.body;
      const imageFile = form && form.get ? form.get('image') : null;
      if (!(imageFile instanceof Blob)) {
        return jsonResponse({ detail: '请先选择一张猫咪照片' }, 400);
      }
      if (imageFile.size > 20 * 1024 * 1024) {
        return jsonResponse({ detail: '图片过大，请选择 20MB 以内的照片' }, 413);
      }
      const imageDataUrl = await fileAsDataUrl(imageFile);
      const modelImage = await resizeImage(imageDataUrl, 1280, 0.86, imageDataUrl);
      const thumbnail = await resizeImage(imageDataUrl, 480, 0.72, '');
      return identifyWithNative(modelImage, thumbnail, form.get('model') || '');
    }

    // ─── 登记 ──────────────────────────────────
    if (path === '/api/cat/register' && method === 'POST') {
      const form = init.body;
      if (!form || !form.get) {
        return jsonResponse({ detail: '登记数据格式无效' }, 400);
      }
      const now = Date.now() / 1000;
      const pet = {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        name: String(form.get('name') || '').trim(),
        breed: String(form.get('breed') || ''),
        breed_confidence: String(form.get('breed_confidence') || ''),
        color: String(form.get('color') || ''),
        pattern: String(form.get('pattern') || ''),
        estimated_age: String(form.get('estimated_age') || ''),
        gender: String(form.get('gender') || '未知'),
        weight: Number.parseFloat(form.get('weight')) || 0,
        health_status: String(form.get('health_status') || ''),
        avatar_path: String(form.get('avatar_path') || ''),
        notes: String(form.get('notes') || ''),
        knowledge_summary: String(form.get('knowledge_summary') || ''),
        created_at: now,
        updated_at: now,
        vaccines: [],
        deworming: [],
        weights: [],
        medical: [],
      };
      if (!pet.name) {
        return jsonResponse({ detail: '请填写猫咪昵称' }, 400);
      }

      const pets = readPets();
      pets.unshift(pet);
      try {
        savePets(pets);
      } catch (error) {
        pet.avatar_path = '';
        try {
          savePets(pets);
        } catch (retryError) {
          return jsonResponse({ detail: '手机本地存储空间不足，登记失败' }, 507);
        }
      }
      return jsonResponse({ success: true, pet, message: `「${pet.name}」登记成功！` });
    }

    // ─── 宠物列表 ──────────────────────────────
    if (path === '/api/cat/pets' && method === 'GET') {
      const pets = readPets().sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      return jsonResponse({ count: pets.length, pets });
    }

    // ─── 单个宠物详情 ──────────────────────────
    const singlePetMatch = path.match(/^\/api\/cat\/pets\/([^/]+)$/);
    if (singlePetMatch && method === 'GET') {
      const petId = decodeURIComponent(singlePetMatch[1]);
      const pets = readPets();
      const pet = pets.find(p => p.id === petId);
      if (!pet) {
        return jsonResponse({ detail: '猫咪档案不存在' }, 404);
      }
      return jsonResponse({ pet });
    }

    // ─── 更新宠物 ──────────────────────────────
    if (singlePetMatch && method === 'PUT') {
      const petId = decodeURIComponent(singlePetMatch[1]);
      const pets = readPets();
      const index = pets.findIndex(p => p.id === petId);
      if (index < 0) {
        return jsonResponse({ detail: '猫咪档案不存在' }, 404);
      }
      let updates;
      try {
        updates = typeof init.body === 'string' ? JSON.parse(init.body) : {};
      } catch (e) {
        updates = {};
      }
      const allowed = ['name','breed','breed_confidence','color','pattern','estimated_age',
        'gender','weight','health_status','avatar_path','notes','knowledge_summary',
        'birth_date','is_neutered','microchip'];
      allowed.forEach(key => {
        if (updates[key] !== undefined) {
          pets[index][key] = updates[key];
        }
      });
      pets[index].updated_at = Date.now() / 1000;
      savePets(pets);
      return jsonResponse({ success: true, pet: pets[index] });
    }

    // ─── 删除宠物 ──────────────────────────────
    if (singlePetMatch && method === 'DELETE') {
      const petId = decodeURIComponent(singlePetMatch[1]);
      const pets = readPets();
      const remaining = pets.filter((pet) => pet.id !== petId);
      if (remaining.length === pets.length) {
        return jsonResponse({ detail: '宠物不存在' }, 404);
      }
      savePets(remaining);
      return jsonResponse({ success: true, message: '删除成功' });
    }

    // ─── 重新识别 ──────────────────────────────
    const reidentifyMatch = path.match(/^\/api\/cat\/pets\/([^/]+)\/reidentify$/);
    if (reidentifyMatch && method === 'POST') {
      const petId = decodeURIComponent(reidentifyMatch[1]);
      const pets = readPets();
      const petIndex = pets.findIndex(p => p.id === petId);
      if (petIndex < 0) {
        return jsonResponse({ detail: '猫咪档案不存在' }, 404);
      }
      const form = init.body;
      const imageFile = form && form.get ? form.get('image') : null;
      if (!(imageFile instanceof Blob)) {
        return jsonResponse({ detail: '请先选择一张猫咪照片' }, 400);
      }
      const imageDataUrl = await fileAsDataUrl(imageFile);
      const modelImage = await resizeImage(imageDataUrl, 1280, 0.86, imageDataUrl);
      const thumbnail = await resizeImage(imageDataUrl, 480, 0.72, '');
      const result = await identifyWithNative(modelImage, thumbnail, form.get('model') || '');
      if (!result.ok) return result;

      const data = await result.json();
      pets[petIndex].breed = data.identification?.breed || pets[petIndex].breed;
      pets[petIndex].breed_confidence = data.identification?.confidence || '';
      pets[petIndex].color = data.identification?.appearance?.color || '';
      pets[petIndex].pattern = data.identification?.appearance?.pattern || '';
      pets[petIndex].estimated_age = data.identification?.estimated_age || '';
      pets[petIndex].health_status = data.identification?.health_observation || '';
      pets[petIndex].avatar_path = data.image_url || '';
      pets[petIndex].updated_at = Date.now() / 1000;
      savePets(pets);
      return jsonResponse(data);
    }

    // ─── 健康记录（添加 / 删除）─────────────────
    const recordMatch = path.match(/^\/api\/cat\/pets\/([^/]+)\/records\/([^/]+)(?:\/([^/]+))?$/);
    if (recordMatch) {
      const petId = decodeURIComponent(recordMatch[1]);
      const kind = recordMatch[2];
      const recordId = recordMatch[3];
      const pets = readPets();
      const petIndex = pets.findIndex(p => p.id === petId);
      if (petIndex < 0) {
        return jsonResponse({ detail: '猫咪档案不存在' }, 404);
      }

      if (method === 'POST' && !recordId) {
        let record;
        try {
          record = typeof init.body === 'string' ? JSON.parse(init.body) : {};
        } catch (e) {
          record = {};
        }
        const newRecord = {
          id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
          ...record,
        };
        if (!Array.isArray(pets[petIndex][kind])) {
          pets[petIndex][kind] = [];
        }
        pets[petIndex][kind].push(newRecord);
        pets[petIndex].updated_at = Date.now() / 1000;
        if (kind === 'weights' && newRecord.weight > 0) {
          pets[petIndex].weight = newRecord.weight;
        }
        savePets(pets);
        return jsonResponse({ success: true, record: newRecord });
      }

      if (method === 'DELETE' && recordId) {
        if (!Array.isArray(pets[petIndex][kind])) {
          return jsonResponse({ detail: '记录不存在' }, 404);
        }
        const beforeLen = pets[petIndex][kind].length;
        pets[petIndex][kind] = pets[petIndex][kind].filter(r => String(r.id) !== recordId);
        if (pets[petIndex][kind].length === beforeLen) {
          return jsonResponse({ detail: '记录不存在' }, 404);
        }
        pets[petIndex].updated_at = Date.now() / 1000;
        savePets(pets);
        return jsonResponse({ success: true });
      }
    }

    // ─── 本地知识库搜索（不消耗模型额度）──────────
    if ((path === '/api/cat/knowledge/search' || path === '/api/cat/knowledge')
        && method === 'POST') {
      const form = init.body;
      const query = form && form.get ? form.get('query') : '';
      if (!query || !query.trim()) {
        return jsonResponse({ results: [] });
      }
      try {
        const topK = Number.parseInt(form.get('top_k'), 10) || 5;
        const data = JSON.parse(window.AndroidBridge.searchKnowledge(query.trim(), topK));
        return jsonResponse(data);
      } catch (error) {
        return jsonResponse({ detail: '本地知识库搜索失败：' + error.message }, 500);
      }
    }

    // ─── AI 知识问答（用户主动触发）──────────────
    if (path === '/api/cat/knowledge/ask' && method === 'POST') {
      const form = init.body;
      const query = form && form.get ? form.get('query') : '';
      if (!query || !query.trim()) {
        return jsonResponse({ detail: '请输入问题' }, 400);
      }
      let breedContext = String(form.get('breed') || '');
      try {
        if (!breedContext) {
          const currentPetId = new URLSearchParams(location.search).get('id');
          const pets = readPets();
          const pet = pets.find(p => p.id === currentPetId);
          if (pet) breedContext = pet.breed || '';
        }
      } catch (e) {}

      const result = await chatWithNative(query.trim(), breedContext);
      if (!result.ok) return result;

      const data = await result.json();
      return jsonResponse(data);
    }

    return originalFetch(input, init);
  };
})();
