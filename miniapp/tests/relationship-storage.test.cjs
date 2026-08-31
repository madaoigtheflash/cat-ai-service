const assert = require('node:assert/strict')
const path = require('node:path')

const values = new Map()
global.wx = {
  env: { USER_DATA_PATH: '/mock-user-data' },
  getStorageSync(key) { return values.get(key) },
  setStorageSync(key, value) { values.set(key, JSON.parse(JSON.stringify(value))) },
  getFileSystemManager() { return { unlinkSync() {} } }
}
global.getApp = () => ({ globalData: {} })

const storagePath = path.resolve(__dirname, '../utils/storage.js')
delete require.cache[storagePath]
const storage = require(storagePath)

const catA = storage.savePet({ id: 'cat_a', name: '奶糖' })
const catB = storage.savePet({ id: 'cat_b', name: '莓莓' })
const catC = storage.savePet({ id: 'cat_c', name: '团子' })

const first = storage.saveRelationship({ petAId: catB.id, petBId: catA.id, type: 'playmate', note: '会轮流追逐' })
assert.equal(first.petAId, 'cat_a')
assert.equal(first.petBId, 'cat_b')
assert.equal(first.schemaVersion, 2)
assert.equal(first.directionMode, 'mutual')
assert.equal(first.fromRole, 'playmate')
assert.equal(first.toRole, 'playmate')
assert.equal(storage.relationshipRoles(first, catB.id, catA.id).arrow, '↔')
assert.equal(storage.listRelationships().length, 1)

const updated = storage.saveRelationship({ petAId: catA.id, petBId: catB.id, type: 'bonded', note: '会靠在一起睡觉' })
assert.equal(updated.id, first.id)
assert.equal(storage.listRelationships().length, 1)
assert.equal(storage.getRelationship(catB.id, catA.id).type, 'bonded')
assert.equal(storage.getRelationship(catB.id, catA.id).fromRole, 'friend')

storage.saveRelationship({ petAId: catA.id, petBId: catC.id, type: 'housemate' })
assert.equal(storage.listRelationships().length, 2)
storage.saveOnlineLink({
  communityId: 'com_1',
  localPetId: catA.id,
  remotePetId: 'pet_cloud_a',
  syncedFingerprint: '0123456789abcdef'
})
assert.equal(storage.getOnlineLink('com_1', catA.id).remotePetId, 'pet_cloud_a')
storage.removePet(catA.id)
assert.equal(storage.listRelationships().length, 0)
assert.equal(storage.getOnlineLink('com_1', catA.id), null)

storage.reconcileOnlineLinks('com_1', [{
  localPetId: catB.id,
  remotePetId: 'pet_cloud_b',
  syncFingerprint: 'fedcba9876543210',
  syncedAt: '2026-08-29T00:00:00.000Z'
}])
assert.equal(storage.getOnlineLink('com_1', catB.id).syncedFingerprint, 'fedcba9876543210')

const directed = storage.saveRelationship({
  petAId: catB.id,
  petBId: catC.id,
  type: 'family',
  roleProfile: 'mother_child',
  directionMode: 'directed',
  fromPetId: catB.id,
  toPetId: catC.id,
  fromRole: 'mother',
  toRole: 'child'
})
assert.equal(directed.directionStatus, 'confirmed')
assert.deepEqual(storage.relationshipRoles(directed, catB.id, catC.id), {
  sourceRole: 'mother',
  targetRole: 'child',
  arrow: '→',
  directionClass: 'forward',
  directionStatus: 'confirmed'
})
assert.deepEqual(storage.relationshipRoles(directed, catC.id, catB.id), {
  sourceRole: 'child',
  targetRole: 'mother',
  arrow: '←',
  directionClass: 'reverse',
  directionStatus: 'confirmed'
})

assert.throws(() => storage.saveRelationship({ petAId: catB.id, petBId: catB.id }), /两只不同/)
assert.throws(() => storage.saveRelationship({ petAId: catB.id, petBId: 'missing' }), /档案不存在/)

values.clear()
storage.savePet({ id: 'legacy_a', name: '旧档案甲' })
storage.savePet({ id: 'legacy_b', name: '旧档案乙' })
storage.savePet({ id: 'legacy_c', name: '旧档案丙' })
values.set('catai_mini_relationships_v1', [
  { id: 'legacy_mutual', petAId: 'legacy_b', petBId: 'legacy_a', type: 'bonded', note: '旧版贴贴记录', schemaVersion: 1, updatedAt: 20 },
  { id: 'legacy_family', petAId: 'legacy_c', petBId: 'legacy_a', type: 'family', note: '只知道可能有亲缘', schemaVersion: 1, updatedAt: 10 }
])
const migratedRelationships = storage.listRelationships()
const migratedMutual = migratedRelationships.find(item => item.id === 'legacy_mutual')
const pendingFamily = migratedRelationships.find(item => item.id === 'legacy_family')
assert.equal(migratedMutual.petAId, 'legacy_a')
assert.equal(migratedMutual.directionMode, 'mutual')
assert.equal(migratedMutual.fromRole, 'friend')
assert.equal(migratedMutual.toRole, 'friend')
assert.equal(migratedMutual.migratedFromSchemaVersion, 1)
assert.equal(pendingFamily.schemaVersion, 2)
assert.equal(pendingFamily.directionStatus, 'legacy_direction_pending')
assert.equal(pendingFamily.fromPetId, '')
assert.equal(storage.relationshipRoles(pendingFamily, 'legacy_a', 'legacy_c').arrow, '?')
assert.equal(values.get('catai_mini_relationships_v1')[0].schemaVersion, 2, 'migration is persisted once')

values.clear()
const fixturePets = [
  ['focus', '奶糖公主'],
  ['partner_1', '草莓牛奶小圆子'],
  ['partner_2', '团子'],
  ['partner_3', '小花🌸'],
  ['partner_4', '中华田园猫小橘'],
  ['partner_5', '莓莓'],
  ['partner_6', '布丁']
].map(([id, name]) => storage.savePet({ id, name }))
const relationTypes = ['bonded', 'playmate', 'housemate', 'acquainting', 'needs_space', 'family']
fixturePets.slice(1).forEach((pet, index) => {
  const input = {
    petAId: fixturePets[0].id,
    petBId: pet.id,
    type: relationTypes[index]
  }
  if (input.type === 'family') Object.assign(input, {
    roleProfile: 'mother_child',
    directionMode: 'directed',
    fromPetId: fixturePets[0].id,
    toPetId: pet.id,
    fromRole: 'mother',
    toRole: 'child'
  })
  storage.saveRelationship(input)
})

let relationshipPage
global.Page = definition => { relationshipPage = definition }
require(path.resolve(__dirname, '../pages/relationships/index.js'))
const pageState = { focusedPetId: '' }
const pageContext = {
  data: pageState,
  initialPetId: '',
  buildLayout: relationshipPage.buildLayout,
  setData(update) { Object.assign(pageState, update) }
}
relationshipPage.loadNetwork.call(pageContext, fixturePets[0].id)
assert.equal(pageState.nodes.length, 7)
assert.equal(pageState.lines.length, 6)
assert.equal(pageState.relationshipRows.length, 6)
assert.equal(pageState.hiddenPetCount, 0)
assert.equal(pageState.lines.filter(line => line.directionClass === 'mutual').length, 5)
assert.equal(pageState.lines.filter(line => line.directionClass === 'forward').length, 1)
assert.equal(pageState.relationshipRows.find(row => row.relationship.type === 'family').roleSummary, '母亲 → 孩子')
assert(pageState.nodes.every(node => node.x >= 0 && node.x <= 530), 'node x coordinates stay inside the stage')
assert(pageState.nodes.every(node => node.y >= 0 && node.y <= 400), 'node y coordinates stay inside the stage')

relationshipPage.loadNetwork.call(pageContext, fixturePets[6].id)
const reverseFamilyRow = pageState.relationshipRows.find(row => row.pet.id === fixturePets[0].id)
assert.equal(reverseFamilyRow.roleSummary, '孩子 ← 母亲')
assert.equal(pageState.lines[0].directionClass, 'reverse')

console.log('relationship storage and layout contract: PASS')
