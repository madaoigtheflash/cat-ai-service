const test = require('node:test')
const assert = require('node:assert/strict')

const online = require('../services/online')

test('online service accepts both top-level and data envelopes', () => {
  assert.deepEqual(
    online._test.normalizeResult({ result: { success: true, communities: [] } }),
    { success: true, communities: [] }
  )
  assert.deepEqual(
    online._test.normalizeResult({ result: { ok: true, data: { role: 'owner' } } }),
    { role: 'owner' }
  )
})

test('online service exposes stable cloud errors without leaking the response object', () => {
  assert.throws(
    () => online._test.normalizeResult({ result: { ok: false, error: { code: 'FORBIDDEN', message: '没有权限' } } }),
    /没有权限/
  )
  assert.throws(() => online._test.normalizeResult(null), /云函数未返回结果/)
})

test('image MIME is derived from trusted image metadata before the path suffix', () => {
  assert.equal(online._test.imageMime({ type: 'png' }, 'tmp.jpg'), 'image/png')
  assert.equal(online._test.imageMime({ type: 'webp' }, 'tmp'), 'image/webp')
  assert.equal(online._test.imageMime({}, 'photo.PNG?x=1'), 'image/png')
  assert.equal(online._test.imageMime({}, 'photo.unknown'), 'image/jpeg')
})

test('request tokens are scoped and non-static', () => {
  const first = online._test.makeToken('upload')
  const second = online._test.makeToken('upload')
  assert.match(first, /^upload_/)
  assert.notEqual(first, second)
})

test('pet sync sends only the public profile plus a stable fingerprint', async () => {
  let payload
  global.wx = {
    cloud: {
      callFunction(options) {
        payload = options.data
        return Promise.resolve({ result: { ok: true, data: { pet: { remotePetId: 'pet_cloud_1' } } } })
      }
    }
  }
  const pet = {
    id: 'pet_local_1',
    name: '奶糖',
    breed: '中华田园猫',
    coatColor: '橘白',
    medical: [{ diagnosis: '不会上传' }]
  }
  await online.syncPet('com_1', pet)
  assert.equal(payload.action, 'syncPet')
  assert.match(payload.pet.syncFingerprint, /^[a-f0-9]{16}$/)
  assert.equal(payload.pet.localPetId, 'pet_local_1')
  assert.equal(Object.prototype.hasOwnProperty.call(payload.pet, 'medical'), false)
  assert.equal(payload.pet.syncFingerprint, online._test.petSyncFingerprint(pet))
  delete global.wx
})

test('relationship vote uses the cloud action and bounded evidence list', async () => {
  let payload
  global.wx = {
    cloud: {
      callFunction(options) {
        payload = options.data
        return Promise.resolve({ result: { ok: true, data: { relationship: { myChoice: 'bonded' } } } })
      }
    }
  }
  await online.castRelationshipVote({
    communityId: 'com_1',
    fromCatId: 'cat_a',
    toCatId: 'cat_b',
    choice: 'bonded',
    evidenceSightingIds: ['sig_1', 'sig_2', 'sig_3', 'sig_4']
  })
  assert.equal(payload.action, 'castRelationshipVote')
  assert.equal(payload.relationshipContractId, 'cat-ai.relationship.directed')
  assert.equal(payload.relationshipContractVersion, 2)
  assert.equal(payload.directionVersion, 2)
  assert.equal(payload.fromCatId, 'cat_a')
  assert.equal(payload.toCatId, 'cat_b')
  assert.equal(payload.choice, 'bonded')
  assert.deepEqual(payload.evidenceSightingIds, ['sig_1', 'sig_2', 'sig_3'])
  delete global.wx
})

test('community creation reuses its persisted intent key after an ambiguous response loss', async () => {
  const keys = []
  let attempts = 0
  global.wx = {
    cloud: {
      callFunction(options) {
        keys.push(options.data.idempotencyKey)
        attempts += 1
        if (attempts === 1) return Promise.reject(new Error('network response lost'))
        return Promise.resolve({ result: { ok: true, data: { community: { id: 'com_1' } } } })
      }
    }
  }
  await assert.rejects(() => online.createCommunity('樱花猫友小屋'), /network response lost/)
  const result = await online.createCommunity('樱花猫友小屋')
  assert.equal(result.community.id, 'com_1')
  assert.equal(keys.length, 2)
  assert.equal(keys[0], keys[1])
  delete global.wx
})

test('sighting upload follows the server-issued path and phase-one contract', async () => {
  const calls = []
  global.wx = {
    compressImage(options) { options.success({ tempFilePath: 'compressed.jpg' }) },
    getFileInfo(options) { options.success({ size: 321 }) },
    getImageInfo(options) { options.success({ type: 'jpeg', width: 800, height: 600 }) },
    cloud: {
      callFunction(options) {
        calls.push(options.data)
        if (options.data.action === 'createUpload') {
          return Promise.resolve({ result: { ok: true, data: { uploadId: 'up_1', cloudPath: 'identity-pending/b/up_1/source.jpg' } } })
        }
        return Promise.resolve({ result: { ok: true, data: { sightingId: 'sig_1' } } })
      },
      uploadFile(options) {
        assert.equal(options.cloudPath, 'identity-pending/b/up_1/source.jpg')
        return Promise.resolve({ fileID: 'cloud://env/identity-pending/b/up_1/source.jpg' })
      },
      deleteFile() { return Promise.resolve() }
    }
  }

  const result = await online.uploadSighting({
    communityId: 'com_1',
    imagePath: 'source.jpg',
    localPetId: 'local_pet_1',
    observedAt: '2026-08-28T12:00:00+08:00',
    areaText: '樱花公园东门',
    location: { source: 'map', longitude: 121.4737, latitude: 31.2304, accuracyM: 50 },
    caption: '右耳有缺口'
  })

  assert.equal(result.sightingId, 'sig_1')
  assert.equal(calls[0].action, 'createUpload')
  assert.equal(calls[0].localPetId, 'local_pet_1')
  assert.equal(calls[0].file.mime, 'image/jpeg')
  assert.equal(calls[1].action, 'submitSighting')
  assert.equal(calls[1].uploadId, 'up_1')
  assert.equal(calls[1].observation.location.areaText, '樱花公园东门')
  assert.equal(calls[1].observation.location.longitude, 121.4737)
  assert.equal(calls[1].observation.location.source, 'map')
  assert.equal(calls[1].caption, '右耳有缺口')
  assert.equal(Object.prototype.hasOwnProperty.call(calls[1], 'catId'), false)
  delete global.wx
})

test('review maps UI decisions and carries optimistic version', async () => {
  let payload
  global.wx = {
    cloud: {
      callFunction(options) {
        payload = options.data
        return Promise.resolve({ result: { ok: true, data: { state: 'APPROVED' } } })
      }
    }
  }
  await online.reviewSighting('sig_1', 3, 'approve')
  assert.equal(payload.decision, 'approved')
  assert.equal(payload.expectedVersion, 3)
  delete global.wx
})

test('feedback submission and personal status use bounded cloud contracts', async () => {
  const calls = []
  global.wx = {
    cloud: {
      callFunction(options) {
        calls.push(options.data)
        return Promise.resolve({ result: { ok: true, data: {} } })
      }
    }
  }
  await online.submitFeedback({
    category: 'feature',
    title: '增加反馈入口',
    content: '希望可以查看处理状态',
    steps: '从首页进入',
    client: { version: '1.0.0', platform: 'ios' }
  })
  await online.listFeedbackCenter()
  assert.equal(calls[0].action, 'submitFeedback')
  assert.match(calls[0].idempotencyKey, /^submit_feedback_/)
  assert.equal(calls[1].action, 'listFeedbackCenter')
  assert.equal(Object.prototype.hasOwnProperty.call(calls[1], 'idempotencyKey'), false)
  assert.equal(typeof online.decideChangeProposal, 'undefined')
  delete global.wx
})

test('ambiguous submit failure never deletes a file that may already be committed', async () => {
  let deletes = 0
  let uploads = 0
  let createCalls = 0
  let submitCalls = 0
  const submitKeys = []
  global.wx = {
    compressImage(options) { options.success({ tempFilePath: 'compressed.jpg' }) },
    getFileInfo(options) { options.success({ size: 321 }) },
    getImageInfo(options) { options.success({ type: 'jpeg', width: 800, height: 600 }) },
    cloud: {
      callFunction(options) {
        if (options.data.action === 'createUpload') {
          createCalls += 1
          return Promise.resolve({ result: { ok: true, data: { uploadId: 'up_2', cloudPath: 'identity-pending/b/up_2/source.jpg' } } })
        }
        submitCalls += 1
        submitKeys.push(options.data.idempotencyKey)
        if (submitCalls === 1) return Promise.reject(new Error('network response lost'))
        return Promise.resolve({ result: { ok: true, data: { sightingId: 'sig_recovered' } } })
      },
      uploadFile() { uploads += 1; return Promise.resolve({ fileID: 'cloud://env/identity-pending/b/up_2/source.jpg' }) },
      deleteFile() { deletes += 1; return Promise.resolve() }
    }
  }
  await assert.rejects(() => online.uploadSighting({
    communityId: 'com_1', imagePath: 'source.jpg'
  }), /network response lost/)
  assert.equal(deletes, 0)
  const recovered = await online.uploadSighting({
    communityId: 'com_1', imagePath: 'source.jpg'
  })
  assert.equal(recovered.sightingId, 'sig_recovered')
  assert.equal(createCalls, 1)
  assert.equal(uploads, 1)
  assert.equal(submitCalls, 2)
  assert.equal(submitKeys[0], submitKeys[1])
  delete global.wx
})

test('persisted upload intent recovers a committed sighting after a module restart without storing private draft text', async () => {
  const modulePath = require.resolve('../services/online')
  const storage = {}
  const storageKey = 'catai_mini_online_retry_v1'
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
  let phase = 'submit_lost'
  global.wx = {
    getStorageSync(key) { return clone(storage[key]) },
    setStorageSync(key, value) { storage[key] = clone(value) },
    compressImage(options) { options.success({ tempFilePath: 'persisted-compressed.jpg' }) },
    getFileInfo(options) { options.success({ size: 654 }) },
    getImageInfo(options) { options.success({ type: 'jpeg', width: 900, height: 700 }) },
    cloud: {
      uploadFile() {
        return Promise.resolve({ fileID: 'cloud://env/identity-pending/b/up_restart/source.jpg' })
      },
      callFunction(options) {
        const action = options.data.action
        if (action === 'createUpload') {
          return Promise.resolve({ result: { ok: true, data: { uploadId: 'up_restart', cloudPath: 'identity-pending/b/up_restart/source.jpg' } } })
        }
        if (action === 'submitSighting' && phase === 'submit_lost') {
          return Promise.reject(new Error('network response lost after commit'))
        }
        if (action === 'bootstrap') {
          return Promise.resolve({ result: { ok: true, data: { communities: [] } } })
        }
        if (action === 'recoverSighting') {
          if (phase === 'pending') {
            return Promise.resolve({ result: { ok: true, data: { found: false, state: 'PENDING' } } })
          }
          return Promise.resolve({ result: { ok: true, data: {
            found: true,
            sightingId: 'sig_recovered_after_restart',
            communityId: 'com_restart',
            state: 'PENDING_REVIEW',
            version: 1
          } } })
        }
        throw new Error(`unexpected action ${action}`)
      }
    }
  }

  delete require.cache[modulePath]
  const beforeRestart = require('../services/online')
  await assert.rejects(() => beforeRestart.uploadSighting({
    communityId: 'com_restart',
    imagePath: 'wxfile://private-photo.jpg',
    observedAt: '2026-08-28T21:30:00+08:00',
    areaText: '私密公园位置',
    caption: '只有我知道的门牌描述'
  }), /network response lost after commit/)
  const persistedText = JSON.stringify(storage[storageKey])
  assert.match(persistedText, /up_restart/)
  assert.equal(persistedText.includes('私密公园位置'), false)
  assert.equal(persistedText.includes('只有我知道的门牌描述'), false)
  assert.equal(persistedText.includes('wxfile:\/\/private-photo.jpg'), false)
  const originalRetryKey = storage[storageKey].upload_sighting.idempotencyKey

  phase = 'pending'
  delete require.cache[modulePath]
  const pendingRestart = require('../services/online')
  await assert.rejects(() => pendingRestart.uploadSighting({
    communityId: 'com_restart',
    imagePath: 'wxfile://different-photo.jpg',
    observedAt: '2026-08-28T21:32:00+08:00'
  }), /仍在云端确认/)
  assert.equal(storage[storageKey].upload_sighting.idempotencyKey, originalRetryKey)

  phase = 'recover'
  delete require.cache[modulePath]
  const afterRestart = require('../services/online')
  const bootstrapped = await afterRestart.bootstrap()
  assert.equal(bootstrapped.uploadRecovery.found, true)
  assert.equal(bootstrapped.uploadRecovery.sightingId, 'sig_recovered_after_restart')
  assert.equal(storage[storageKey].upload_sighting, undefined)

  delete require.cache[modulePath]
  delete global.wx
})
