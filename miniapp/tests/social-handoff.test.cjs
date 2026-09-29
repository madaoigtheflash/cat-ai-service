const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const handoff = require('../utils/social-handoff')

const clone = value => JSON.parse(JSON.stringify(value))

function makePage(name, overrides = {}) {
  let definition
  let modal
  let saves = 0
  const events = []
  const pets = new Map()
  const storage = Object.assign({
    getPet: id => pets.get(id) || null,
    persistImage: async image => { events.push('persist'); return image },
    savePet(input) {
      events.push('save')
      saves += 1
      const pet = Object.assign({}, input, { id: input.id || 'local-cat-1' })
      pets.set(pet.id, pet)
      return pet
    }
  }, overrides.storage)
  const wx = Object.assign({
    showModal(options) { modal = options },
    showToast(options) { events.push(['toast', options.title]) },
    navigateTo(options) { events.push(['navigate', options.url]); if (options.success) options.success(); if (options.complete) options.complete() },
    redirectTo(options) { events.push(['redirect', options.url]); if (options.success) options.success(); if (options.complete) options.complete() },
    navigateBack(options) { events.push('back'); if (options.success) options.success() },
    setNavigationBarTitle() {}
  }, overrides.wx)
  const filename = path.join(__dirname, '..', 'pages', name, 'index.js')
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(request) {
      if (request === '../../utils/storage') return storage
      if (request === '../../utils/social-handoff') return handoff
      if (request === '../../services/api') return {}
      throw new Error(`Unexpected dependency ${request}`)
    },
    Page(value) { definition = value }, wx,
    getApp: () => ({ globalData: {} })
  }, { filename })
  const page = Object.assign({}, definition, { data: clone(definition.data) })
  page.setData = patch => Object.entries(patch).forEach(([key, value]) => {
    const keys = key.split('.')
    const last = keys.pop()
    const target = keys.reduce((object, part) => object[part], page.data)
    target[last] = value
  })
  return { page, events, pets, get modal() { return modal }, get saves() { return saves } }
}

const result = { breed: '中华田园猫', coat_color: '橘白', estimated_age: '约 2 岁', description: '观察信息', features: ['短毛'] }
const privatePet = {
  id: 'local-cat-1', name: ' 小橘 ', breed: ' 中华田园猫 ', coatColor: ' 橘白 ',
  imagePath: 'wxfile://usr/cat.jpg', notes: '私密备注', healthStatus: '私密健康情况',
  location: { latitude: 1, longitude: 2 }, vaccines: ['疫苗记录'], medical: ['病历'],
  weights: ['体重'], deworming: ['驱虫'], recognition: result,
  ownerId: 'secret-owner', birthday: '2020-01-01', futureSensitiveField: 'should never leak'
}

test('public cat handoff is a strict three-field whitelist, not an archive copy', () => {
  const publicCat = handoff.toPublicCat(privatePet)
  assert.deepEqual(publicCat, { name: '小橘', breed: '中华田园猫', coatColor: '橘白' })
  assert.deepEqual(Object.keys(publicCat), ['name', 'breed', 'coatColor'])
  assert.equal(privatePet.name, ' 小橘 ')
})

test('public text is bounded and non-string fields are never serialized', () => {
  assert.deepEqual(handoff.toPublicCat({ id: 'x', name: {}, breed: { secret: 'no' }, coatColor: ['no'] }), {
    name: '未命名猫咪', breed: '', coatColor: ''
  })
  const actual = handoff.toPublicCat({ id: 'x', name: '猫'.repeat(30), breed: '猫'.repeat(90), coatColor: '白'.repeat(90) })
  assert.equal(actual.name.length, 20)
  assert.equal(actual.breed.length, 60)
  assert.equal(actual.coatColor.length, 60)
})

test('photo candidate is separate, local-only, and never included in public text', () => {
  assert.equal(handoff.getPhotoCandidate(privatePet), 'wxfile://usr/cat.jpg')
  assert.equal(handoff.getPhotoCandidate({ ...privatePet, imagePath: 'https://external.example/photo.jpg' }), '')
  assert.equal(handoff.getPhotoCandidate({ ...privatePet, imagePath: 'cloud://private-archive/photo.jpg' }), '')
  assert.equal(handoff.getPhotoCandidate({ ...privatePet, imagePath: '//external.example/photo.jpg' }), '')
  assert.equal('imagePath' in handoff.toPublicCat(privatePet), false)
})

test('demo records cannot enter either registration or sharing boundary', () => {
  assert.equal(handoff.canRegisterResult({ ...result, demo: true }), false)
  for (const pet of [null, { name: 'missing id' }, { ...privatePet, demo: true }, { ...privatePet, recognition: { demo: true } }]) {
    assert.equal(handoff.canSharePet(pet), false)
    assert.equal(handoff.toPublicCat(pet), null)
    assert.equal(handoff.getPhotoCandidate(pet), '')
  }
})

test('composer route carries an encoded local id, no archive contents', () => {
  assert.equal(handoff.composeUrl('cat &?中文'), '/pages/social-compose/index?petId=cat%20%26%3F%E4%B8%AD%E6%96%87')
  assert.throws(() => handoff.composeUrl(''), /先保存/)
})

test('identify registers locally before opening composer and never publishes', async () => {
  const state = makePage('identify')
  state.page.setData({ imagePath: 'wxfile://tmp/cat.jpg', result })
  state.page.registerAndShare()
  assert.equal(state.page.data.saving, true)
  assert.equal(state.saves, 0)
  await state.modal.success({ confirm: true, content: '小橘' })
  assert.deepEqual(state.events, ['persist', 'save', ['navigate', '/pages/social-compose/index?petId=local-cat-1']])
  assert.equal(state.page.data.savedPetId, 'local-cat-1')
  assert.equal(state.page.data.saving, false)
})

test('identify private-only save opens local detail, cancellation has no write', async () => {
  const state = makePage('identify')
  state.page.setData({ imagePath: 'wxfile://tmp/cat.jpg', result })
  state.page.saveToPet()
  await state.modal.success({ confirm: false })
  assert.equal(state.saves, 0)
  assert.equal(state.page.data.saving, false)
  state.page.saveToPet()
  await state.modal.success({ confirm: true, content: '小橘' })
  assert.deepEqual(state.events.at(-1), ['navigate', '/pages/pet-detail/index?id=local-cat-1'])
})

test('identify demo UI and handlers both block registration and sharing', () => {
  const state = makePage('identify')
  state.page.setData({ result: { ...result, demo: true } })
  state.page.registerAndShare()
  state.page.saveToPet()
  assert.equal(state.modal, undefined)
  assert.equal(state.saves, 0)
  const wxml = fs.readFileSync(path.join(__dirname, '..', 'pages/identify/index.wxml'), 'utf8')
  assert.match(wxml, /wx:if="\{\{!result\.demo\}\}" class="register-actions"/)
})

test('identify prevents duplicate saving and reuses archive after navigation failure', async () => {
  let finishImage
  const imagePromise = new Promise(resolve => { finishImage = resolve })
  const state = makePage('identify', {
    storage: { persistImage: () => imagePromise },
    wx: { navigateTo: options => options.fail() }
  })
  state.page.setData({ imagePath: 'wxfile://tmp/cat.jpg', result })
  state.page.registerAndShare()
  const modal = state.modal
  state.page.registerAndShare()
  assert.equal(state.modal, modal)
  const pending = modal.success({ confirm: true, content: '小橘' })
  state.page.saveToPet()
  assert.equal(state.saves, 0)
  finishImage('wxfile://usr/cat.jpg')
  await pending
  assert.equal(state.saves, 1)
  assert.equal(state.page.data.saving, false)
  assert.match(state.page.data.error, /已保存在本机/)
  state.page.registerAndShare()
  assert.equal(state.saves, 1)
  assert.equal(state.modal, modal)
})

test('failed local registration never navigates and can be retried', async () => {
  const state = makePage('identify', { storage: { savePet: () => { throw new Error('quota') } } })
  state.page.setData({ imagePath: 'wxfile://tmp/cat.jpg', result })
  state.page.registerAndShare()
  await state.modal.success({ confirm: true, content: '小橘' })
  assert.equal(state.page.data.saving, false)
  assert.equal(state.page.data.savedPetId, '')
  assert.equal(state.events.some(event => Array.isArray(event) && event[0] === 'navigate'), false)
  assert.match(state.page.data.error, /没有发布任何内容/)
})

test('manual registration saves once before share and a retry retains the same id', async () => {
  const state = makePage('pet-edit', { wx: { redirectTo: options => options.fail() } })
  state.page.onLoad({})
  state.page.setData({ 'form.name': '小橘', 'form.notes': '不公开的备注' })
  await state.page.saveAndShare()
  assert.equal(state.page.data.id, 'local-cat-1')
  assert.equal(state.pets.size, 1)
  assert.equal(state.page.data.saving, false)
  await state.page.saveAndShare()
  assert.equal(state.pets.size, 1)
  assert.equal(state.pets.get('local-cat-1').notes, '不公开的备注')
})

test('manual registration prevents concurrent writes and demo publishing', async () => {
  let finishImage
  const state = makePage('pet-edit', { storage: { persistImage: () => new Promise(resolve => { finishImage = resolve }) } })
  state.page.onLoad({})
  state.page.setData({ 'form.name': '小橘' })
  const pending = state.page.saveAndShare()
  await state.page.saveAndShare()
  finishImage('')
  await pending
  assert.equal(state.saves, 1)
  const demo = makePage('pet-edit')
  demo.page.setData({ 'form.name': '演示猫', 'form.recognition': { demo: true } })
  await demo.page.saveAndShare()
  assert.equal(demo.saves, 0)
})

test('existing archive share is explicit and OS sharing does not expose private archive', () => {
  const state = makePage('pet-detail')
  state.pets.set(privatePet.id, privatePet)
  state.page.onLoad({ id: privatePet.id })
  state.page.onShow()
  assert.equal(state.events.length, 0)
  state.page.sharePet()
  assert.deepEqual(state.events.at(-1), ['navigate', '/pages/social-compose/index?petId=local-cat-1'])
  const share = clone(state.page.onShareAppMessage())
  assert.deepEqual(share, { title: '来猫猫小屋，聊聊猫咪的日常', path: '/pages/home/index', imageUrl: '/assets/showcase/cozy-nap.jpg' })
  assert.equal(JSON.stringify(state.page.onShareTimeline()).includes(privatePet.id), false)
})

test('deleted or demo archive cannot be passed to composer from detail', () => {
  const state = makePage('pet-detail')
  state.page.onLoad({ id: privatePet.id })
  state.page.sharePet()
  state.pets.set(privatePet.id, { ...privatePet, recognition: { demo: true } })
  state.page.sharePet()
  assert.equal(state.events.some(event => Array.isArray(event) && event[0] === 'navigate'), false)
})
