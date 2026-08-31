const fs = require('fs');
const path = require('path');
const vm = require('vm');

const adapterPath = path.resolve(__dirname, '../../frontend/android.js');
const adapterSource = fs.readFileSync(adapterPath, 'utf8');
const browserFetch = async () => 'browser';
const browserWindow = { fetch: browserFetch };
vm.runInNewContext(adapterSource, { window: browserWindow });
if (browserWindow.fetch !== browserFetch) {
  throw new Error('Browser mode should remain untouched without AndroidBridge');
}

const storage = new Map();
storage.set('cat_ai_android_pets_v1', JSON.stringify([{
  id: 'legacy-cat',
  name: '旧版猫咪',
  created_at: 1,
  updated_at: 1,
  vaccines: [],
  deworming: [],
  weights: [],
  medical: [],
}]));
global.localStorage = {
  getItem: (key) => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
};

let nativePets = [];
let migrationCompleted = false;

global.window = {
  AndroidBridge: {
    getConfig: () => JSON.stringify({ model: 'test-vision', hasKey: true }),
    listPets: () => JSON.stringify(nativePets),
    replacePets: (petsJson) => {
      nativePets = JSON.parse(petsJson);
      return JSON.stringify({ success: true, count: nativePets.length });
    },
    migrateLegacyPets: (petsJson) => {
      if (!migrationCompleted) nativePets = JSON.parse(petsJson);
      migrationCompleted = true;
      return JSON.stringify({ success: true, imported: nativePets.length });
    },
    identify: (requestId) => {
      setImmediate(() => window.CatAiAndroid.onIdentifyResult(
        requestId,
        true,
        JSON.stringify({
          success: true,
          identification: { breed: '狸花猫', appearance: {} },
          knowledge: {},
        }),
      ));
    },
    searchKnowledge: (query) => JSON.stringify({
      query,
      count: 1,
      results: [{ id: 'kb-1', title: '饮食与禁忌', content: '猫不能吃巧克力。' }],
    }),
    chat: (requestId) => {
      setImmediate(() => window.CatAiAndroid.onChatResult(
        requestId,
        true,
        JSON.stringify({
          success: true,
          answer: '巧克力对猫有毒。',
          model_used: 'test/test-chat',
          citations: [{ id: 'kb-1', title: '饮食与禁忌' }],
        }),
      ));
    },
  },
  fetch: async () => { throw new Error('Unexpected network fetch'); },
  location: { href: 'file:///android_asset/index.html' },
};

global.FileReader = class FileReaderMock {
  readAsDataURL() {
    this.result = 'data:image/jpeg;base64,AA==';
    this.onload();
  }
};
global.Image = class ImageMock {
  set src(value) {
    this.naturalWidth = 100;
    this.naturalHeight = 80;
    this.onload();
  }
};
global.document = {
  createElement: () => ({
    getContext: () => ({ drawImage() {} }),
    toDataURL: () => 'data:image/jpeg;base64,THUMB',
  }),
};

vm.runInThisContext(adapterSource, { filename: adapterPath });

(async () => {
  const models = await (await window.fetch('/api/models')).json();
  if (models.models[0].model !== 'test-vision' || !models.models[0].available) {
    throw new Error('Models adapter failed');
  }
  if (!migrationCompleted) throw new Error('Native pet migration was not initialized');

  const migrated = await (await window.fetch('/api/cat/pets')).json();
  if (migrated.count !== 1 || migrated.pets[0].id !== 'legacy-cat') {
    throw new Error('Legacy localStorage migration failed');
  }
  const removedLegacy = await (await window.fetch('/api/cat/pets/legacy-cat', {
    method: 'DELETE',
  })).json();
  if (!removedLegacy.success) throw new Error('Migrated profile delete failed');

  const identifyForm = new FormData();
  identifyForm.append('image', new Blob(['image'], { type: 'image/jpeg' }), 'cat.jpg');
  identifyForm.append('model', 'bundled');
  const identifiedResponse = await window.fetch('/api/cat/identify', {
    method: 'POST',
    body: identifyForm,
  });
  const identified = await identifiedResponse.json();
  if (!identifiedResponse.ok || identified.identification.breed !== '狸花猫'
      || identified.image_url !== 'data:image/jpeg;base64,THUMB') {
    throw new Error('Identify bridge adapter failed');
  }

  const searchForm = new FormData();
  searchForm.append('query', '猫不能吃什么');
  searchForm.append('top_k', '5');
  const searched = await (await window.fetch('/api/cat/knowledge/search', {
    method: 'POST',
    body: searchForm,
  })).json();
  if (searched.count !== 1 || !searched.results[0].content.includes('巧克力')) {
    throw new Error('Local knowledge search adapter failed');
  }

  const askForm = new FormData();
  askForm.append('query', '猫能吃巧克力吗');
  askForm.append('breed', '狸花猫');
  const answered = await (await window.fetch('/api/cat/knowledge/ask', {
    method: 'POST',
    body: askForm,
  })).json();
  if (!answered.answer.includes('有毒') || answered.citations.length !== 1) {
    throw new Error('AI knowledge answer adapter failed');
  }

  const form = new FormData();
  form.append('name', '测试猫');
  form.append('breed', '狸花猫');
  form.append('weight', '4.2');
  const created = await (await window.fetch('/api/cat/register', {
    method: 'POST',
    body: form,
  })).json();
  if (!created.success) throw new Error('Register adapter failed');

  const listed = await (await window.fetch('/api/cat/pets')).json();
  if (listed.count !== 1 || listed.pets[0].name !== '测试猫') {
    throw new Error('List adapter failed');
  }

  const removed = await (await window.fetch(`/api/cat/pets/${created.pet.id}`, {
    method: 'DELETE',
  })).json();
  const empty = await (await window.fetch('/api/cat/pets')).json();
  if (!removed.success || empty.count !== 0) {
    throw new Error('Delete adapter failed');
  }
  if (storage.has('cat_ai_android_pets_v1')) {
    throw new Error('Legacy localStorage should be cleared after native migration');
  }

  console.log('Android JS adapter CRUD/model tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
