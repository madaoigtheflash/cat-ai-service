const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const PAGE_PATH = path.join(__dirname, '..', 'pages', 'online', 'index.js')

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function setPath(target, key, value) {
  const parts = key.split('.')
  let cursor = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!cursor[parts[index]]) cursor[parts[index]] = {}
    cursor = cursor[parts[index]]
  }
  cursor[parts[parts.length - 1]] = value
}

function makePage({ onlineOverrides = {}, listPets = () => [], wxOverrides = {} } = {}) {
  let definition
  const persisted = {}
  const online = Object.assign({
    petSyncFingerprint: pet => `fingerprint-${pet.id}`,
    bootstrap: async () => ({ communities: [] }),
    listWorkspace: async () => ({ community: {}, myPets: [], pendingReview: [], approvedSightings: [] }),
    uploadSighting: async () => ({}),
    syncPet: async () => ({})
  }, onlineOverrides)
  const storage = {
    listPets,
    reconcileOnlineLinks() {},
    saveOnlineLink() {}
  }
  const sandbox = {
    require(request) {
      if (request === '../../services/online') return online
      if (request === '../../services/identity') return { enrollLinkedSighting: async () => ({}) }
      if (request === '../../utils/storage') return storage
      throw new Error(`Unexpected require: ${request}`)
    },
    Page(value) { definition = value },
    wx: Object.assign({
      getStorageSync(key) { return clone(persisted[key]) },
      setStorageSync(key, value) { persisted[key] = clone(value) },
      showToast() {},
      stopPullDownRefresh() {},
      navigateTo() {},
      setClipboardData() {}
    }, wxOverrides),
    console
  }
  vm.runInNewContext(fs.readFileSync(PAGE_PATH, 'utf8'), sandbox, { filename: PAGE_PATH })
  const page = Object.assign({}, definition, { data: clone(definition.data) })
  page.setData = patch => {
    Object.entries(patch).forEach(([key, value]) => setPath(page.data, key, clone(value)))
  }
  return { page, persisted, online }
}

function workspace(communityId, cats = []) {
  return {
    community: { communityId, name: communityId, role: 'member' },
    myPets: cats,
    pendingReview: [],
    approvedSightings: []
  }
}

test('a stale workspace response cannot overwrite a newer community switch', async () => {
  const requests = { a: deferred(), b: deferred() }
  const { page, persisted } = makePage({
    onlineOverrides: { listWorkspace: communityId => requests[communityId].promise }
  })
  page.data.communities = [
    { id: 'a', communityId: 'a', name: 'A 小屋' },
    { id: 'b', communityId: 'b', name: 'B 小屋' }
  ]
  page.data.communityNames = ['A 小屋', 'B 小屋']
  page.data.currentCommunity = page.data.communities[0]
  page.data.cloudCats = [{ remotePetId: 'old', localPetId: 'old-local' }]
  page.data.cloudCatNames = ['暂不确认身份', '旧猫']

  const staleRequest = page.loadWorkspace('a')
  page.onCommunityChange({ detail: { value: 1 } })

  assert.equal(page.data.currentCommunity.id, 'b')
  assert.equal(page.data.loading, true)
  assert.deepEqual(page.data.cloudCats, [])

  requests.b.resolve(workspace('b', [{ remotePetId: 'b-cat', localPetId: 'b-local', displayName: 'B 猫' }]))
  await Promise.resolve()
  await Promise.resolve()
  requests.a.resolve(workspace('a', [{ remotePetId: 'a-cat', localPetId: 'a-local', displayName: 'A 猫' }]))
  assert.equal(await staleRequest, false)
  await Promise.resolve()

  assert.equal(page.data.currentCommunity.id, 'b')
  assert.equal(page.data.cloudCats[0].remotePetId, 'b-cat')
  assert.equal(persisted.catai_mini_online_community_v1, 'b')
})

test('refresh preserves picker choices by stable IDs and clears a missing cloud cat', async () => {
  let pets = [{ id: 'local-2', name: '二号' }, { id: 'local-1', name: '一号' }]
  let cats = [
    { remotePetId: 'remote-2', localPetId: 'local-2', displayName: '二号' },
    { remotePetId: 'remote-1', localPetId: 'local-1', displayName: '一号' }
  ]
  const { page } = makePage({
    listPets: () => pets,
    onlineOverrides: { listWorkspace: async () => workspace('home', cats) }
  })
  page.data.communities = [{ id: 'home', communityId: 'home', name: '小屋' }]
  page.data.currentCommunity = page.data.communities[0]
  page.data.localPets = [{ id: 'local-1' }, { id: 'local-2' }]
  page.data.localPetIndex = 1
  page.data.selectedLocalPetId = 'local-2'
  page.data.cloudCats = [cats[1], cats[0]]
  page.data.draft.catIndex = 2
  page.data.draft.localPetId = 'local-2'
  page.data.draft.remotePetId = 'remote-2'

  await page.loadWorkspace('home')
  assert.equal(page.data.localPetIndex, 0)
  assert.equal(page.data.selectedLocalPetId, 'local-2')
  assert.equal(page.data.draft.catIndex, 1)
  assert.equal(page.data.draft.remotePetId, 'remote-2')

  cats = [cats[1]]
  await page.loadWorkspace('home')
  assert.equal(page.data.draft.catIndex, 0)
  assert.equal(page.data.draft.localPetId, '')
  assert.equal(page.data.draft.remotePetId, '')
})

test('sighting submission resolves the linked cat by stable ID instead of picker position', async () => {
  let submitted
  const cats = [
    { remotePetId: 'remote-2', localPetId: 'local-2', displayName: '二号' },
    { remotePetId: 'remote-1', localPetId: 'local-1', displayName: '一号' }
  ]
  const { page } = makePage({
    onlineOverrides: {
      uploadSighting: async payload => { submitted = payload },
      listWorkspace: async () => workspace('home', cats)
    }
  })
  page.data.communities = [{ id: 'home', communityId: 'home', name: '小屋' }]
  page.data.currentCommunity = page.data.communities[0]
  page.data.cloudCats = cats
  page.data.draft = Object.assign({}, page.data.draft, {
    imagePath: 'wxfile://cat.jpg',
    catIndex: 2,
    localPetId: 'local-2',
    remotePetId: 'remote-2'
  })

  await page.submitSighting()
  assert.equal(submitted.localPetId, 'local-2')
})

test('map selection keeps the returned POI local and never copies it into the shared area note', () => {
  let chooseCalls = 0
  const { page } = makePage({
    wxOverrides: {
      chooseLocation(options) {
        chooseCalls += 1
        options.success({
          name: '测试小区 18 号楼',
          address: '测试路 88 号',
          longitude: 121.4737,
          latitude: 31.2304
        })
      }
    }
  })
  page.data.draft.areaText = '樱花公园一带'

  page.chooseLocation()

  assert.equal(chooseCalls, 1)
  assert.equal(page.data.draft.areaText, '樱花公园一带')
  assert.equal(page.data.draft.locationLabel, '测试小区 18 号楼')
  assert.equal(page.data.draft.location.source, 'map')
  assert.equal(page.data.draft.location.areaText, '')
  assert.equal(page.data.draft.location.longitude, 121.4737)

  page.clearLocation()
  assert.equal(page.data.draft.location, null)
  assert.equal(page.data.draft.locationLabel, '')
  assert.equal(page.data.draft.areaText, '樱花公园一带')
})

test('cancelling or denying map selection leaves the optional upload path usable', () => {
  const toasts = []
  let failure = { errMsg: 'chooseLocation:fail cancel' }
  const { page } = makePage({
    wxOverrides: {
      chooseLocation(options) { options.fail(failure) },
      showToast(options) { toasts.push(options.title) }
    }
  })

  page.chooseLocation()
  assert.equal(page.data.draft.location, null)
  assert.equal(page.data.errorMessage, '')
  assert.deepEqual(toasts, [])

  failure = { errMsg: 'chooseLocation:fail auth deny' }
  page.chooseLocation()
  assert.equal(page.data.draft.location, null)
  assert.match(page.data.errorMessage, /位置可跳过/)
  assert.equal(toasts.length, 1)
})
