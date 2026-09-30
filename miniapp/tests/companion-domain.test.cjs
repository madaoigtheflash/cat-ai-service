'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const storage = require('../utils/storage')
const { createService, KEYS } = require('../services/companion')
const { parseIntent, coarseLocation } = require('../utils/companion-intents')

const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
function fixture() {
  const values = new Map()
  const writes = []
  let sequence = 0
  let fault = null
  const io = {
    env: { USER_DATA_PATH: '/local' },
    getStorageSync(key) { if (fault && fault.mode === 'read' && fault.key === key) { fault = null; throw new Error('read failure') }; return copy(values.get(key)) },
    setStorageSync(key, value) {
      writes.push(key)
      const active = fault && fault.key === key && (!fault.match || fault.match(value)) ? fault : null
      if (active) fault = null
      if (active && active.mode === 'before') throw new Error('write failure')
      if (!active || active.mode !== 'silent') values.set(key, copy(value))
      if (active && active.mode === 'after') throw new Error('lost receipt')
    },
    getFileSystemManager() { return { unlinkSync() {} } }
  }
  global.wx = io
  const options = { io, storage, now: () => 1800000000000, makeId: () => 'id' + (++sequence) }
  const api = createService(options)
  return { api, values, writes, io, again: () => createService(options), fail(key, mode, match) { fault = { key, mode, match } }, pet(id, name) { return storage.savePet({ id, name }) } }
}
function assertCode(fn, code) { assert.throws(fn, error => error.code === code) }

test('exact supported registration returns an editable draft without creating a pet', () => {
  const f = fixture(); const result = f.api.send('登记猫咪叫奶糖')
  assert.equal(result.draft.fields.name, '奶糖'); assert.equal(storage.listPets().length, 0)
  assert.equal(result.messages.length, 2); assert.equal(result.source, '本地引导')
  assert.match(result.reply, /尚未登记/)
})

test('uncertain, negated, compound and question sentences never create a draft', () => {
  const f = fixture()
  for (const text of ['不要登记猫咪叫奶糖', '登记猫咪叫奶糖？', '奶糖可能是团子的妈妈', '奶糖不是团子的妈妈', '如果奶糖是团子的妈妈', '登记猫咪叫奶糖；添加猫咪叫团子', '随便聊聊']) {
    assert.equal(f.api.send(text).draft, null)
  }
  assert.equal(storage.listPets().length, 0)
})

test('medical wording does not diagnose or generate treatment actions', () => {
  const f = fixture(); const result = f.api.send('猫咪不吃东西，还吐血')
  assert.equal(result.draft, null); assert.match(result.reply, /不能据此诊断/); assert.match(result.reply, /兽医/)
})

test('empty and oversized messages are rejected without history writes', () => {
  const f = fixture()
  assertCode(() => f.api.send('   '), 'INVALID_INPUT'); assertCode(() => f.api.send('字'.repeat(2001)), 'INVALID_INPUT')
  assert.equal(f.writes.length, 0)
})

test('single pending draft is never silently replaced by another conversation', () => {
  const f = fixture(); const first = f.api.send('登记猫咪叫奶糖').draft
  const second = f.api.send('登记猫咪叫团子')
  assert.equal(second.draft.id, first.id); assert.equal(second.draft.fields.name, '奶糖'); assert.equal(second.messages.length, 4)
  assertCode(() => f.api.createDraft('pet', { name: '豆豆' }), 'PENDING_DRAFT')
})

test('incomplete pet drafts remain editable and are rejected only at confirmation', () => {
  const f = fixture(); const draft = f.api.createDraft('pet', {})
  assert.equal(draft.fields.name, '')
  assert.throws(() => f.api.confirm(draft.id), /名字/)
  f.api.updateDraft(draft.id, { name: '奶糖' }); f.api.updateDraft(draft.id, { name: '' })
  assert.equal(f.api.getDraft().fields.name, '')
  f.api.updateDraft(draft.id, { name: '团子' }); f.api.confirm(draft.id)
  assert.equal(storage.listPets()[0].name, '团子')
})

test('pet confirmation reuses actual storage.savePet and clears pending only on success', () => {
  const f = fixture(); const draft = f.api.createDraft('pet', { name: '奶糖', imagePath: '/local/cat.jpg' })
  const result = f.api.confirm(draft.id)
  assert.equal(result.status, 'confirmed'); assert.equal(result.localOnly, true)
  assert.equal(storage.getPet(result.targetId).name, '奶糖'); assert.deepEqual(storage.getPet(result.targetId).vaccines, [])
  assert.equal(f.api.getDraft(), null); assert.ok(f.writes.includes('catai_mini_pets_v1'))
})

test('confirmed command retry never recreates a subsequently deleted pet', () => {
  const f = fixture(); const draft = f.api.createDraft('pet', { name: '奶糖' }); const result = f.api.confirm(draft.id)
  storage.removePet(result.targetId)
  assert.equal(f.api.confirm(draft.id).status, 'already-confirmed'); assert.equal(storage.listPets().length, 0)
  assert.equal(f.again().confirm(draft.id).status, 'already-confirmed')
})

test('cancel retains all conversation and rejects a later confirmation', () => {
  const f = fixture(); const draft = f.api.send('登记猫咪叫奶糖').draft
  f.api.cancel(draft.id)
  assert.equal(f.api.listMessages().length, 2); assert.equal(f.api.getDraft(), null)
  assertCode(() => f.api.confirm(draft.id), 'STALE_DRAFT'); assert.equal(storage.listPets().length, 0)
})

test('same-name real cat prevents accidental duplicate creation', () => {
  const f = fixture(); f.pet('real', '奶糖'); const draft = f.api.createDraft('pet', { name: '奶糖' })
  assertCode(() => f.api.confirm(draft.id), 'DUPLICATE_NAME'); assert.equal(storage.listPets().length, 1)
})

test('natural mother statement resolves exact real IDs and stores correct directed roles', () => {
  const f = fixture(); f.pet('z_mother', '奶糖'); f.pet('a_child', '团子')
  const draft = f.api.send('奶糖是团子的妈妈').draft
  assert.equal(draft.fields.fromPetId, 'z_mother'); assert.equal(draft.fields.toPetId, 'a_child')
  assert.equal(storage.listRelationships().length, 0); f.api.confirm(draft.id)
  const relation = storage.getRelationship('z_mother', 'a_child')
  assert.equal(relation.petAId, 'a_child'); assert.equal(relation.fromPetId, 'z_mother'); assert.equal(relation.fromRole, 'mother')
  assert.equal(storage.relationshipRoles(relation, 'a_child', 'z_mother').arrow, '←')
})

test('missing or ambiguous names do not invent cats or relationships', () => {
  const f = fixture(); f.pet('a', '奶糖')
  assert.equal(f.api.send('奶糖是团子的妈妈').draft, null)
  f.pet('b', '团子'); f.pet('c', '团子')
  assert.equal(f.api.send('奶糖是团子的妈妈').draft, null); assert.equal(storage.listRelationships().length, 0)
})

test('existing same-pair relationship is not silently overwritten even if reverse direction', () => {
  const f = fixture(); f.pet('a', '奶糖'); f.pet('b', '团子')
  storage.saveRelationship({ petAId: 'a', petBId: 'b', type: 'bonded' })
  const before = copy(storage.listRelationships()); const draft = f.api.send('团子是奶糖的妈妈').draft
  assertCode(() => f.api.confirm(draft.id), 'RELATION_EXISTS'); assert.deepEqual(storage.listRelationships(), before)
})

test('deleted relationship targets fail without recreating entities', () => {
  const f = fixture(); f.pet('a', '奶糖'); f.pet('b', '团子'); const draft = f.api.send('奶糖是团子的妈妈').draft
  storage.removePet('b'); assertCode(() => f.api.confirm(draft.id), 'STALE_TARGET'); assert.equal(storage.listRelationships().length, 0)
})

test('changed target must be re-edited and reviewed before confirmation', () => {
  const f = fixture(); f.pet('a', '奶糖'); f.pet('b', '团子'); const draft = f.api.send('奶糖是团子的妈妈').draft
  storage.savePet(Object.assign({}, storage.getPet('b'), { name: '新团子' }))
  assertCode(() => f.api.confirm(draft.id), 'STALE_TARGET')
  f.api.updateDraft(draft.id, { note: '已重新核对名字' }); f.api.confirm(draft.id)
  assert.equal(storage.listRelationships().length, 1)
})

test('same-cat relationships, unsupported roles and extra metadata are rejected', () => {
  const f = fixture(); f.pet('a', '奶糖')
  const draft = f.api.createDraft('relationship', { fromPetId: 'a', toPetId: 'a', fromRole: 'mother', toRole: 'child' })
  assertCode(() => f.api.confirm(draft.id), 'SAME_CAT'); f.api.cancel(draft.id)
  assertCode(() => f.api.createDraft('relationship', { fromRole: 'boss', toRole: 'servant' }), 'INVALID_INPUT')
  assertCode(() => f.api.createDraft('pet', { name: '奶糖', ownerToken: 'not-stored' }), 'INVALID_INPUT')
})

test('manual caregiver and symmetric friend roles map to existing storage schema', () => {
  for (const [fromRole, toRole, directionMode, type] of [['caregiver', 'cared_for', 'directed', 'caregiver'], ['friend', 'friend', 'mutual', 'bonded'], ['playmate', 'playmate', 'mutual', 'playmate']]) {
    const f = fixture(); f.pet('a', '奶糖'); f.pet('b', '团子')
    const draft = f.api.createDraft('relationship', { fromPetId: 'a', toPetId: 'b', fromRole, toRole })
    f.api.confirm(draft.id); const relation = storage.listRelationships()[0]
    assert.equal(relation.directionMode, directionMode); assert.equal(relation.type, type)
  }
})

test('location drafts immediately coarse coordinates and never persist raw location metadata', () => {
  const f = fixture(); f.pet('a', '奶糖')
  const raw = { latitude: 31.2345678, longitude: 121.4567891 }
  const draft = f.api.createDraft('location', { petId: 'a', areaText: '公园树荫一带', ...raw })
  assert.notEqual(draft.fields.latitude, raw.latitude); assert.notEqual(draft.fields.longitude, raw.longitude)
  assert.deepEqual({ latitude: draft.fields.latitude, longitude: draft.fields.longitude }, coarseLocation(raw.latitude, raw.longitude))
  const saved = JSON.stringify([...f.values.entries()]); assert.ok(!saved.includes(String(raw.latitude))); assert.ok(!saved.includes(String(raw.longitude)))
  f.api.confirm(draft.id)
  assert.deepEqual(Object.keys(f.api.listLocations()[0]).sort(), ['petId', 'areaText', 'latitude', 'longitude', 'time'].sort())
})

test('location area edits never shift an already-coarsened coordinate', () => {
  const f = fixture(); f.pet('a', '奶糖'); const draft = f.api.createDraft('location', { petId: 'a', areaText: '公园', latitude: 31.2345, longitude: 121.4567 })
  const edited = f.api.updateDraft(draft.id, { areaText: '公园北侧' })
  assert.equal(edited.fields.latitude, draft.fields.latitude); assert.equal(edited.fields.longitude, draft.fields.longitude)
})

test('incomplete location draft cannot be confirmed and text never infers coordinates', () => {
  const f = fixture(); f.pet('a', '奶糖'); const draft = f.api.createDraft('location', { petId: 'a' })
  assert.equal(draft.fields.latitude, null); assert.throws(() => f.api.confirm(draft.id))
  f.api.updateDraft(draft.id, { areaText: '人民公园' }); assert.throws(() => f.api.confirm(draft.id))
  assert.equal(f.api.listLocations().length, 0)
})

test('precise address text, invalid coordinates and future observation times are rejected', () => {
  const f = fixture(); f.pet('a', '奶糖')
  assertCode(() => f.api.createDraft('location', { petId: 'a', areaText: '幸福路18号', latitude: 31, longitude: 121 }), 'PRECISE_LOCATION')
  assert.throws(() => coarseLocation(NaN, 121)); assert.throws(() => coarseLocation(91, 121)); assert.throws(() => coarseLocation(31, 181))
  assertCode(() => f.api.createDraft('location', { petId: 'a', areaText: '公园', latitude: 31, longitude: 121, time: 1800000000001 }), 'INVALID_INPUT')
})

test('location retry is idempotent and cancelled location does not save', () => {
  const f = fixture(); f.pet('a', '奶糖'); const draft = f.api.createDraft('location', { petId: 'a', areaText: '公园', latitude: 31, longitude: 121 })
  f.api.confirm(draft.id); f.api.confirm(draft.id); assert.equal(f.api.listLocations().length, 1)
  const next = f.api.createDraft('location', { petId: 'a', areaText: '树林', latitude: 32, longitude: 122 }); f.api.cancel(next.id)
  assert.equal(f.api.listLocations().length, 1)
})

test('appendExchange marks true cloud reply but never parses or executes its text', () => {
  const f = fixture(); const result = f.api.appendExchange('登记猫咪叫奶糖', '我可以帮你核对', '云端回复', 'cloud_req_1')
  assert.equal(result.source, '云端回复'); assert.equal(result.messages[1].source, '云端回复')
  assert.equal(f.api.getDraft(), null); assert.equal(storage.listPets().length, 0)
})

test('cloud request ID is idempotent and cannot be reused with changed content', () => {
  const f = fixture(); f.api.appendExchange('你好', '你好呀', '云端回复', 'req')
  assert.equal(f.api.appendExchange('你好', '你好呀', '云端回复', 'req').duplicate, true)
  assert.equal(f.api.listMessages().length, 2)
  assertCode(() => f.api.appendExchange('你好', '改过的回复', '云端回复', 'req'), 'ID_REUSE')
})

test('unsent composer persists independently and export does not upload', () => {
  const f = fixture(); f.api.saveComposerDraft('  还没发出去  '); f.api.send('你好')
  assert.equal(f.again().getComposerDraft(), '  还没发出去  ')
  const exported = JSON.parse(f.api.exportHistory())
  assert.equal(exported.messages.length, 2); assert.equal(exported.composerText, '  还没发出去  '); assert.match(exported.scope, /本机/)
  assert.ok(f.writes.includes(KEYS.composer)); assert.ok(f.writes.includes(KEYS.messages))
})

test('intentionally clearing the composer is verified as an empty string, not a missing value', () => {
  const f = fixture(); f.api.saveComposerDraft('尚未发送')
  assert.equal(f.api.saveComposerDraft(''), '')
  assert.equal(f.values.get(KEYS.composer), ''); assert.equal(f.again().getComposerDraft(), '')
})

test('default clock and IDs support real send then composer clear then confirmed storage', () => {
  const f = fixture(); const api = createService({ storage, io: f.io })
  api.saveComposerDraft('登记猫咪叫奶糖')
  const result = api.send('登记猫咪叫奶糖')
  api.saveComposerDraft('')
  assert.equal(api.getState().draft.fields.name, '奶糖'); assert.equal(api.getState().composerText, '')
  api.confirm(result.draft.id)
  assert.equal(storage.listPets().length, 1); assert.equal(api.getDraft(), null)
})

test('overview counts match actual local stores and use no mock cloud data', () => {
  const f = fixture(); f.pet('a', '奶糖'); f.api.send('你好')
  assert.deepEqual(f.api.getOverview().counts, { pets: 1, relationships: 0, locations: 0, messages: 2 })
})

test('overview and export include confirmation receipts with an explicit privacy allowlist', () => {
  const f = fixture(); const draft = f.api.send('登记猫咪叫奶糖').draft; const result = f.api.confirm(draft.id)
  const overview = f.api.getOverview(); const exported = JSON.parse(f.api.exportHistory())
  assert.deepEqual(exported.actionReceipts, overview.actionReceipts)
  assert.deepEqual(Object.keys(exported.actionReceipts[0]).sort(), ['id', 'kind', 'targetId', 'confirmedAt'].sort())
  assert.equal(exported.actionReceipts[0].targetId, result.targetId)
  assert.equal(exported.actionReceipts[0].fingerprint, undefined)
  assert.ok(!JSON.stringify(exported.actionReceipts).includes('奶糖'))
})

test('deleted cat retains only its historical receipt in overview/export and is not resurrected', () => {
  const f = fixture(); const draft = f.api.createDraft('pet', { name: '奶糖' }); const result = f.api.confirm(draft.id)
  storage.removePet(result.targetId)
  const overview = f.api.getOverview(); const exported = JSON.parse(f.api.exportHistory())
  assert.equal(overview.pets.length, 0); assert.equal(overview.actionReceipts.length, 1)
  assert.equal(exported.actionReceipts[0].targetId, result.targetId)
  assert.match(exported.scope, /回执不表示目标仍存在/)
  assert.equal(f.api.confirm(draft.id).status, 'already-confirmed'); assert.equal(storage.listPets().length, 0)
})

test('raw image cloud URLs are rejected instead of silently downloaded', () => {
  const f = fixture()
  for (const imagePath of ['https://example.test/a.jpg', 'https://usr.evil.test/a.jpg', 'https://usr@evil.test/a.jpg', '//evil.test/a.jpg', 'cloud://photo', 'data:image/jpeg;base64,x', 'wxfile://tmp/photo.jpg', 'http://tmp/photo.jpg']) {
    assertCode(() => f.api.createDraft('pet', { name: '奶糖', imagePath }), 'INVALID_INPUT')
  }
})

test('WeChat persisted local pseudo-origin images are accepted without network calls', () => {
  for (const imagePath of ['http://usr/photo.jpg', 'https://usr/photo.jpg', 'wxfile://usr/photo.jpg', '/local/photo.jpg', 'C:\\photos\\cat.jpg']) {
    const f = fixture(); const draft = f.api.createDraft('pet', { name: '奶糖', imagePath })
    f.api.confirm(draft.id); assert.equal(storage.listPets()[0].imagePath, imagePath)
  }
})

test('message write failure after draft creation never confirms that pending draft', () => {
  const f = fixture(); f.fail(KEYS.messages, 'before')
  assert.throws(() => f.api.send('登记猫咪叫奶糖'), /write failure/)
  assert.equal(f.api.getDraft().status, 'pending'); assert.equal(storage.listPets().length, 0); assert.equal(f.api.listMessages().length, 0)
})

test('cloud reply lost storage receipt can be safely replayed with the same request ID', () => {
  const f = fixture(); f.fail(KEYS.messages, 'after')
  assert.throws(() => f.api.appendExchange('你好', '真实返回', '云端回复', 'cloud_request'), /lost receipt/)
  assert.equal(f.api.appendExchange('你好', '真实返回', '云端回复', 'cloud_request').duplicate, true)
  assert.equal(f.api.listMessages().length, 2); assert.equal(f.api.getState().replySource, '云端回复')
})

test('target guards and history export do not copy private medical records', () => {
  const f = fixture(); storage.savePet({ id: 'a', name: '奶糖', medical: [{ privateClinicalNote: '私有诊疗内容' }] }); f.pet('b', '团子')
  f.api.send('奶糖是团子的妈妈')
  assert.ok(!JSON.stringify(f.values.get(KEYS.draft)).includes('私有诊疗内容'))
  const exported = JSON.parse(f.api.exportHistory())
  assert.equal(exported.draft.targets, undefined); assert.ok(!JSON.stringify(exported).includes('私有诊疗内容'))
})

test('draft read failure and corrupt original store never overwrite with empty data', () => {
  const f = fixture(); f.fail(KEYS.draft, 'read')
  assert.throws(() => f.api.createDraft('pet', { name: '奶糖' }), /read failure/); assert.equal(f.writes.length, 0)
  f.values.set('catai_mini_pets_v1', { corrupt: true })
  assertCode(() => f.api.createDraft('pet', { name: '奶糖' }), 'CORRUPT_DATA'); assert.equal(f.writes.length, 0)
})

test('unknown schema and tampered content fingerprints block mutation', () => {
  const f = fixture(); f.values.set(KEYS.draft, { schema: 99, revision: 0, receipts: [], pending: null })
  assertCode(() => f.api.getDraft(), 'CORRUPT_DATA')
  f.values.delete(KEYS.draft); const draft = f.api.createDraft('pet', { name: '奶糖' })
  const state = f.values.get(KEYS.draft); state.pending.fields.name = '被替换'
  assertCode(() => f.api.confirm(draft.id), 'CORRUPT_DATA'); assert.equal(storage.listPets().length, 0)
})

test('other-page changes are detected rather than overwritten', () => {
  const f = fixture(); const draft = f.api.createDraft('pet', { name: '奶糖' }); const other = f.again()
  other.getDraft(); other.updateDraft(draft.id, { name: '团子' })
  assertCode(() => f.api.updateDraft(draft.id, { name: '豆豆' }), 'STALE_DRAFT')
  assert.equal(f.api.getDraft().fields.name, '团子')
})

test('write-ahead failure does not call savePet and can be retried when no write occurred', () => {
  const f = fixture(); const draft = f.api.createDraft('pet', { name: '奶糖' })
  f.fail(KEYS.draft, 'before', value => value.pending && value.pending.status === 'saving')
  assert.throws(() => f.api.confirm(draft.id), /write failure/); assert.equal(storage.listPets().length, 0)
  f.api.confirm(draft.id); assert.equal(storage.listPets().length, 1)
})

test('entity write failure is surfaced, retains chat, and does not blindly recreate unknown results', () => {
  const f = fixture(); const draft = f.api.send('登记猫咪叫奶糖').draft
  f.fail('catai_mini_pets_v1', 'before')
  assert.throws(() => f.api.confirm(draft.id), /保存结果尚未确认/)
  assert.equal(f.api.listMessages().length, 2); assert.equal(f.api.getDraft().status, 'saving')
  assertCode(() => f.api.confirm(draft.id), 'UNKNOWN_COMMIT')
  assert.equal(f.api.cancel(draft.id).uncertain, true)
  const next = f.api.createDraft('pet', { name: '奶糖' }); f.api.confirm(next.id); assert.equal(storage.listPets().length, 1)
})

test('write then lost receipt reconciles exact saved pet once across a service reload', () => {
  const f = fixture(); const draft = f.api.createDraft('pet', { name: '奶糖' })
  f.fail('catai_mini_pets_v1', 'after'); assert.throws(() => f.api.confirm(draft.id), /lost receipt/)
  assert.equal(storage.listPets().length, 1)
  const restarted = f.again(); assert.equal(restarted.confirm(draft.id).status, 'confirmed')
  assert.equal(storage.listPets().length, 1); assert.equal(restarted.getDraft(), null)
})

test('an uncertain applied entity deleted before recovery is never resurrected', () => {
  const f = fixture(); const draft = f.api.createDraft('pet', { name: '奶糖' })
  f.fail('catai_mini_pets_v1', 'after'); assert.throws(() => f.api.confirm(draft.id)); storage.removePet(draft.targetId)
  assertCode(() => f.again().confirm(draft.id), 'UNKNOWN_COMMIT'); assert.equal(storage.listPets().length, 0)
})

test('changed uncertain entity is not overwritten during reconciliation', () => {
  const f = fixture(); const draft = f.api.createDraft('pet', { name: '奶糖' })
  f.fail('catai_mini_pets_v1', 'after'); assert.throws(() => f.api.confirm(draft.id))
  storage.savePet(Object.assign({}, storage.getPet(draft.targetId), { name: '改名了' }))
  assertCode(() => f.api.confirm(draft.id), 'UNKNOWN_COMMIT'); assert.equal(storage.getPet(draft.targetId).name, '改名了')
})

test('receipt storage failure after save reconciles without a second entity write', () => {
  const f = fixture(); const draft = f.api.createDraft('pet', { name: '奶糖' })
  f.fail(KEYS.draft, 'before', value => value.pending === null && value.receipts.length === 1)
  assert.throws(() => f.api.confirm(draft.id), /write failure/)
  const count = f.writes.filter(key => key === 'catai_mini_pets_v1').length
  f.api.getDraft(); f.api.confirm(draft.id)
  assert.equal(f.writes.filter(key => key === 'catai_mini_pets_v1').length, count)
})

test('silent write loss is detected and original messages remain intact', () => {
  const f = fixture(); f.api.send('你好'); f.fail(KEYS.messages, 'silent')
  assertCode(() => f.api.send('再聊一句'), 'WRITE_UNCONFIRMED'); assert.equal(f.api.listMessages().length, 2)
})

test('saving-state drafts cannot have their content rewritten', () => {
  const f = fixture(); const draft = f.api.createDraft('pet', { name: '奶糖' })
  f.fail('catai_mini_pets_v1', 'after'); assert.throws(() => f.api.confirm(draft.id))
  assertCode(() => f.api.updateDraft(draft.id, { name: '团子' }), 'UNKNOWN_COMMIT')
})

test('location write then failure reconciles once, with no raw position in persistent state', () => {
  const f = fixture(); f.pet('a', '奶糖'); const draft = f.api.createDraft('location', { petId: 'a', areaText: '公园', latitude: 31.1234567, longitude: 121.7654321 })
  f.fail(KEYS.locations, 'after'); assert.throws(() => f.api.confirm(draft.id))
  f.api.confirm(draft.id); assert.equal(f.api.listLocations().length, 1)
})

test('relation write then failure reconciles normalized sorted pair and does not duplicate', () => {
  const f = fixture(); f.pet('z', '奶糖'); f.pet('a', '团子'); const draft = f.api.send('奶糖是团子的妈妈').draft
  f.fail('catai_mini_relationships_v1', 'after'); assert.throws(() => f.api.confirm(draft.id))
  f.api.confirm(draft.id); assert.equal(storage.listRelationships().length, 1)
})

test('returned values are detached snapshots, not mutable live storage', () => {
  const f = fixture(); const draft = f.api.send('登记猫咪叫奶糖').draft
  draft.fields.name = '外部改名'; const state = f.api.getState(); state.messages[0].text = '外部修改'
  assert.equal(f.api.getDraft().fields.name, '奶糖'); assert.equal(f.api.listMessages()[0].text, '登记猫咪叫奶糖')
})

test('father intention is directional and ordinary discussion does not become registration', () => {
  assert.equal(parseIntent('奶糖是团子的爸爸').fields.fromRole, 'father')
  assert.equal(parseIntent('我想知道怎么登记猫咪叫奶糖').kind, 'unknown')
  assert.equal(parseIntent('奶糖是团子的妈妈，然后去玩').kind, 'unknown')
})
