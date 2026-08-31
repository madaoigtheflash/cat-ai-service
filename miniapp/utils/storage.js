const PETS_KEY = 'catai_mini_pets_v1'
const RELATIONSHIPS_KEY = 'catai_mini_relationships_v1'
const ONLINE_LINKS_KEY = 'catai_mini_online_links_v1'
const SETTINGS_KEY = 'catai_mini_settings_v1'
const ENDPOINT_VERSION = 2
const DEFAULT_API_BASE_URL = 'http://yacoyacoyaco.asuscomm.com:8503'
const RELATIONSHIP_SCHEMA_VERSION = 2
const LEGACY_DIRECTION_STATUS = 'legacy_direction_pending'
const LEGACY_MUTUAL_ROLES = Object.freeze({
  bonded: 'friend',
  playmate: 'playmate',
  housemate: 'housemate',
  acquainting: 'observing',
  needs_space: 'needs_space'
})

function listPets() {
  const pets = wx.getStorageSync(PETS_KEY)
  if (!Array.isArray(pets)) return []
  return pets.slice().sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
}

function getPet(id) {
  return listPets().find(pet => pet.id === id) || null
}

function savePet(input) {
  const pets = listPets()
  const now = Date.now()
  const pet = Object.assign({
    id: `pet_${now}_${Math.random().toString(36).slice(2, 7)}`,
    name: '',
    breed: '',
    gender: '未知',
    weight: '',
    coatColor: '',
    birthday: '',
    notes: '',
    healthStatus: '',
    imagePath: '',
    vaccines: [],
    deworming: [],
    weights: [],
    medical: [],
    createdAt: now
  }, input, { updatedAt: now })
  const index = pets.findIndex(item => item.id === pet.id)
  if (index >= 0) pets[index] = pet
  else pets.unshift(pet)
  wx.setStorageSync(PETS_KEY, pets)
  return pet
}

function removePet(id) {
  const pets = listPets()
  const target = pets.find(pet => pet.id === id)
  const remaining = pets.filter(pet => pet.id !== id)
  wx.setStorageSync(PETS_KEY, remaining)
  removePetRelationships(id)
  removePetOnlineLinks(id)
  if (target && target.imagePath && target.imagePath.indexOf(wx.env.USER_DATA_PATH) === 0) {
    try { wx.getFileSystemManager().unlinkSync(target.imagePath) } catch (error) { /* file may already be gone */ }
  }
  return remaining.length !== pets.length
}

function relationshipPair(petAId, petBId) {
  return [String(petAId || ''), String(petBId || '')].sort()
}

function cleanRelationshipRole(value) {
  const role = String(value || '').trim().slice(0, 32)
  return /^[a-z][a-z0-9_]*$/.test(role) ? role : ''
}

function normalizeRelationship(item) {
  if (!item || !item.petAId || !item.petBId || item.petAId === item.petBId) return null
  const pair = relationshipPair(item.petAId, item.petBId)
  const base = Object.assign({}, item, {
    petAId: pair[0],
    petBId: pair[1],
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION
  })
  const directionMode = item.directionMode === 'directed' || item.directionMode === 'mutual'
    ? item.directionMode
    : ''
  const fromPetId = String(item.fromPetId || '')
  const toPetId = String(item.toPetId || '')
  const fromRole = cleanRelationshipRole(item.fromRole)
  const toRole = cleanRelationshipRole(item.toRole)
  const hasExactPair = fromPetId !== toPetId && pair.includes(fromPetId) && pair.includes(toPetId)

  if (Number(item.schemaVersion) >= RELATIONSHIP_SCHEMA_VERSION &&
      item.directionStatus !== LEGACY_DIRECTION_STATUS && directionMode && hasExactPair && fromRole && toRole) {
    return Object.assign(base, {
      directionMode,
      directionStatus: 'confirmed',
      fromPetId,
      toPetId,
      fromRole,
      toRole
    })
  }

  const safeLegacyRole = LEGACY_MUTUAL_ROLES[String(item.type || '')]
  if (safeLegacyRole) {
    return Object.assign(base, {
      directionMode: 'mutual',
      directionStatus: 'confirmed',
      fromPetId: pair[0],
      toPetId: pair[1],
      fromRole: safeLegacyRole,
      toRole: safeLegacyRole,
      migratedFromSchemaVersion: Number(item.schemaVersion) || 1
    })
  }

  // V1 only stored an unordered pair and a broad interaction type. It cannot
  // safely tell which cat was a parent, child, caregiver, or cared-for cat.
  // Symmetric V1 types are migrated above; family and unknown types stay pending
  // instead of guessing a direction or fabricating exact endpoint identities.
  return Object.assign(base, {
    directionMode: 'legacy',
    directionStatus: LEGACY_DIRECTION_STATUS,
    fromPetId: '',
    toPetId: '',
    fromRole: LEGACY_DIRECTION_STATUS,
    toRole: LEGACY_DIRECTION_STATUS
  })
}

function listRelationships() {
  const stored = wx.getStorageSync(RELATIONSHIPS_KEY)
  if (!Array.isArray(stored)) return []
  const byPair = new Map()
  stored.forEach(item => {
    const relationship = normalizeRelationship(item)
    if (!relationship) return
    const key = `${relationship.petAId}::${relationship.petBId}`
    const existing = byPair.get(key)
    if (!existing || Number(relationship.updatedAt || 0) >= Number(existing.updatedAt || 0)) {
      byPair.set(key, relationship)
    }
  })
  const relationships = Array.from(byPair.values())
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
  if (JSON.stringify(relationships) !== JSON.stringify(stored)) {
    wx.setStorageSync(RELATIONSHIPS_KEY, relationships)
  }
  return relationships
}

function getRelationship(petAId, petBId) {
  const pair = relationshipPair(petAId, petBId)
  if (!pair[0] || !pair[1] || pair[0] === pair[1]) return null
  return listRelationships().find(item => item.petAId === pair[0] && item.petBId === pair[1]) || null
}

function saveRelationship(input) {
  const inputPetAId = String((input && input.petAId) || '')
  const inputPetBId = String((input && input.petBId) || '')
  const pair = relationshipPair(inputPetAId, inputPetBId)
  if (!pair[0] || !pair[1] || pair[0] === pair[1]) throw new Error('请选择两只不同的猫咪')
  const petIds = new Set(listPets().map(pet => pet.id))
  if (!petIds.has(pair[0]) || !petIds.has(pair[1])) throw new Error('猫咪档案不存在或已删除')
  const relationships = listRelationships()
  const index = relationships.findIndex(item => item.petAId === pair[0] && item.petBId === pair[1])
  const existing = index >= 0 ? relationships[index] : null
  const now = Date.now()
  const requestedMode = input && (input.directionMode === 'directed' || input.directionMode === 'mutual')
    ? input.directionMode
    : ''
  const requestedFromId = String((input && input.fromPetId) || '')
  const requestedToId = String((input && input.toPetId) || '')
  const requestedFromRole = cleanRelationshipRole(input && input.fromRole)
  const requestedToRole = cleanRelationshipRole(input && input.toRole)
  const hasRequestedDirection = requestedMode && requestedFromId !== requestedToId &&
    pair.includes(requestedFromId) && pair.includes(requestedToId) &&
    requestedFromRole && requestedToRole
  const keepExistingDirection = existing && existing.directionStatus === 'confirmed'
  const safeLegacyRole = LEGACY_MUTUAL_ROLES[String((input && input.type) || (existing && existing.type) || '')]
  const replacesLegacyType = Boolean(safeLegacyRole && input && Object.prototype.hasOwnProperty.call(input, 'type') &&
    (!existing || input.type !== existing.type || existing.migratedFromSchemaVersion))
  const direction = hasRequestedDirection
    ? {
        directionMode: requestedMode,
        directionStatus: 'confirmed',
        fromPetId: requestedFromId,
        toPetId: requestedToId,
        fromRole: requestedFromRole,
        toRole: requestedToRole,
        migratedFromSchemaVersion: null
      }
    : replacesLegacyType
      ? {
          directionMode: 'mutual',
          directionStatus: 'confirmed',
          fromPetId: pair[0],
          toPetId: pair[1],
          fromRole: safeLegacyRole,
          toRole: safeLegacyRole,
          migratedFromSchemaVersion: 1
        }
    : keepExistingDirection
      ? {
          directionMode: existing.directionMode,
          directionStatus: existing.directionStatus,
          fromPetId: existing.fromPetId,
          toPetId: existing.toPetId,
          fromRole: existing.fromRole,
          toRole: existing.toRole
        }
      : safeLegacyRole
        ? {
            directionMode: 'mutual',
            directionStatus: 'confirmed',
            fromPetId: pair[0],
            toPetId: pair[1],
            fromRole: safeLegacyRole,
            toRole: safeLegacyRole,
            migratedFromSchemaVersion: 1
          }
      : {
          directionMode: 'legacy',
          directionStatus: LEGACY_DIRECTION_STATUS,
          fromPetId: '',
          toPetId: '',
          fromRole: LEGACY_DIRECTION_STATUS,
          toRole: LEGACY_DIRECTION_STATUS
        }
  const relationship = Object.assign({
    id: `relationship_${now}_${Math.random().toString(36).slice(2, 7)}`,
    petAId: pair[0],
    petBId: pair[1],
    type: 'housemate',
    note: '',
    source: 'owner',
    confirmed: true,
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
    createdAt: now
  }, existing || {}, input || {}, direction, {
    petAId: pair[0],
    petBId: pair[1],
    note: String((input && input.note) || '').trim().slice(0, 160),
    source: 'owner',
    confirmed: true,
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
    updatedAt: now
  })
  if (index >= 0) relationships[index] = relationship
  else relationships.unshift(relationship)
  wx.setStorageSync(RELATIONSHIPS_KEY, relationships)
  return relationship
}

function relationshipRoles(relationship, sourcePetId, targetPetId) {
  const normalized = normalizeRelationship(relationship)
  const sourceId = String(sourcePetId || '')
  const targetId = String(targetPetId || '')
  if (!normalized || !sourceId || !targetId || sourceId === targetId ||
      ![normalized.petAId, normalized.petBId].includes(sourceId) ||
      ![normalized.petAId, normalized.petBId].includes(targetId)) return null
  if (normalized.directionStatus === LEGACY_DIRECTION_STATUS) {
    return {
      sourceRole: LEGACY_DIRECTION_STATUS,
      targetRole: LEGACY_DIRECTION_STATUS,
      arrow: '?',
      directionClass: 'legacy',
      directionStatus: LEGACY_DIRECTION_STATUS
    }
  }
  const sourceIsFrom = normalized.fromPetId === sourceId
  return {
    sourceRole: sourceIsFrom ? normalized.fromRole : normalized.toRole,
    targetRole: sourceIsFrom ? normalized.toRole : normalized.fromRole,
    arrow: normalized.directionMode === 'mutual' ? '↔' : sourceIsFrom ? '→' : '←',
    directionClass: normalized.directionMode === 'mutual' ? 'mutual' : sourceIsFrom ? 'forward' : 'reverse',
    directionStatus: 'confirmed'
  }
}

function removeRelationship(petAId, petBId) {
  const pair = relationshipPair(petAId, petBId)
  const relationships = listRelationships()
  const remaining = relationships.filter(item => item.petAId !== pair[0] || item.petBId !== pair[1])
  wx.setStorageSync(RELATIONSHIPS_KEY, remaining)
  return remaining.length !== relationships.length
}

function removePetRelationships(petId) {
  if (!petId) return false
  const relationships = listRelationships()
  const remaining = relationships.filter(item => item.petAId !== petId && item.petBId !== petId)
  wx.setStorageSync(RELATIONSHIPS_KEY, remaining)
  return remaining.length !== relationships.length
}

function listOnlineLinks(communityId) {
  const links = wx.getStorageSync(ONLINE_LINKS_KEY)
  if (!Array.isArray(links)) return []
  return links
    .filter(item => item && item.communityId && item.localPetId && item.remotePetId)
    .filter(item => !communityId || item.communityId === communityId)
    .slice()
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
}

function getOnlineLink(communityId, localPetId) {
  if (!communityId || !localPetId) return null
  return listOnlineLinks(communityId).find(item => item.localPetId === localPetId) || null
}

function saveOnlineLink(input) {
  const communityId = String((input && input.communityId) || '').trim()
  const localPetId = String((input && input.localPetId) || '').trim()
  const remotePetId = String((input && input.remotePetId) || '').trim()
  if (!communityId || !localPetId || !remotePetId) throw new Error('云端档案关联信息不完整')
  const links = listOnlineLinks()
  const index = links.findIndex(item => item.communityId === communityId && item.localPetId === localPetId)
  const now = Date.now()
  const existing = index >= 0 ? links[index] : null
  const link = Object.assign({
    id: `${communityId}::${localPetId}`,
    communityId,
    localPetId,
    remotePetId,
    syncedFingerprint: '',
    syncedAt: '',
    displayName: '',
    createdAt: now
  }, existing || {}, input || {}, {
    id: `${communityId}::${localPetId}`,
    communityId,
    localPetId,
    remotePetId,
    catId: String((input && input.catId) || (existing && existing.catId) || remotePetId),
    serverVersion: Math.max(1, Number((input && input.serverVersion) || (existing && existing.serverVersion)) || 1),
    syncedFingerprint: String((input && (input.syncedFingerprint || input.syncFingerprint)) ||
      (existing && existing.syncedFingerprint) || ''),
    syncedAt: String((input && input.syncedAt) || (existing && existing.syncedAt) || ''),
    updatedAt: now
  })
  if (index >= 0) links[index] = link
  else links.unshift(link)
  wx.setStorageSync(ONLINE_LINKS_KEY, links)
  return link
}

function reconcileOnlineLinks(communityId, remotePets) {
  const localIds = new Set(listPets().map(pet => pet.id))
  ;(Array.isArray(remotePets) ? remotePets : []).forEach(remotePet => {
    const localPetId = remotePet && remotePet.localPetId
    if (!localPetId || !localIds.has(localPetId) || !remotePet.remotePetId) return
    saveOnlineLink({
      communityId,
      localPetId,
      remotePetId: remotePet.remotePetId,
      catId: remotePet.catId || remotePet.remotePetId,
      serverVersion: remotePet.serverVersion || 1,
      syncedFingerprint: remotePet.syncFingerprint || '',
      syncedAt: remotePet.syncedAt || '',
      displayName: remotePet.displayName || ''
    })
  })
  return listOnlineLinks(communityId)
}

function removePetOnlineLinks(localPetId) {
  if (!localPetId) return false
  const links = listOnlineLinks()
  const remaining = links.filter(item => item.localPetId !== localPetId)
  wx.setStorageSync(ONLINE_LINKS_KEY, remaining)
  return remaining.length !== links.length
}

function persistImage(tempFilePath) {
  if (!tempFilePath || tempFilePath.indexOf(wx.env.USER_DATA_PATH) === 0) return Promise.resolve(tempFilePath)
  return new Promise(resolve => {
    wx.saveFile({
      tempFilePath,
      success: result => resolve(result.savedFilePath || tempFilePath),
      fail: () => resolve(tempFilePath)
    })
  })
}

function getSettings() {
  const saved = wx.getStorageSync(SETTINGS_KEY) || {}
  const oldLocalAddress = /^http:\/\/(localhost|127\.0\.0\.1):8503\/?$/i.test(saved.apiBaseUrl || '')
  if (saved.endpointVersion !== ENDPOINT_VERSION && (!saved.apiBaseUrl || oldLocalAddress)) {
    saved.apiBaseUrl = DEFAULT_API_BASE_URL
    saved.endpointVersion = ENDPOINT_VERSION
    wx.setStorageSync(SETTINGS_KEY, saved)
  }
  return Object.assign({ apiBaseUrl: DEFAULT_API_BASE_URL, provider: 'minimax', endpointVersion: ENDPOINT_VERSION }, saved)
}

function saveSettings(settings) {
  const value = Object.assign({}, getSettings(), settings)
  wx.setStorageSync(SETTINGS_KEY, value)
  const app = getApp()
  if (app && app.globalData) app.globalData.settings = value
  return value
}

module.exports = {
  listPets,
  getPet,
  savePet,
  removePet,
  persistImage,
  listRelationships,
  getRelationship,
  saveRelationship,
  relationshipRoles,
  removeRelationship,
  removePetRelationships,
  listOnlineLinks,
  getOnlineLink,
  saveOnlineLink,
  reconcileOnlineLinks,
  removePetOnlineLinks,
  getSettings,
  saveSettings
}
