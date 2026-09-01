'use strict'

const crypto = require('crypto')
const cloud = require('wx-server-sdk')
const {
  createCatOnlineCore,
  DomainError,
  MAX_IMAGE_BYTES,
  RELATION_CONTRACT_ID,
  RELATION_CONTRACT_VERSION,
  RELATION_DIRECTION_STATE,
  RELATION_DIRECTION_VERSION
} = require('./core')
const { sanitizeApprovedImage } = require('./sanitize')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const COLLECTIONS = Object.freeze({
  users: 'ci_users_private',
  communities: 'ci_communities',
  members: 'ci_members',
  pets: 'ci_user_pet_links',
  uploads: 'ci_upload_sessions',
  assets: 'ci_assets',
  sightingsPrivate: 'ci_sightings_private',
  sightingsPublic: 'ci_sightings_public',
  identities: 'ci_cat_identities',
  relationshipEdges: 'ci_relationship_edges',
  relationshipVotes: 'ci_relationship_votes',
  feedback: 'ci_feedback',
  changeProposals: 'ci_change_proposals'
})

function withoutId(value) {
  const output = {}
  Object.keys(value || {}).forEach(key => {
    if (key !== 'id' && key !== '_id' && value[key] !== undefined) output[key] = value[key]
  })
  return output
}

function fromDocument(value) {
  if (!value) return null
  return Object.assign({ id: value._id || value.id }, value, { _id: undefined })
}

function coarseLocationForMembers(value) {
  if (!value || typeof value !== 'object') return null
  const longitude = Number(value.longitude)
  const latitude = Number(value.latitude)
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null
  return {
    cellId: String(value.cellId || '').slice(0, 80),
    precisionKm: Number(value.precisionKm) || 2,
    coordinateSystem: String(value.coordinateSystem || 'gcj02').slice(0, 16),
    longitude,
    latitude
  }
}

function isMissingDocument(error) {
  const text = `${error && error.code || ''} ${error && error.message || ''}`.toLowerCase()
  return text.includes('not exist') || text.includes('not found') || text.includes('document_not_exist')
}

async function getDocument(collection, id, transaction) {
  const source = transaction || db
  try {
    const response = await source.collection(collection).doc(id).get()
    const data = response && response.data
    if (!data || (Array.isArray(data) && !data.length)) return null
    return fromDocument(Array.isArray(data) ? data[0] : data)
  } catch (error) {
    if (isMissingDocument(error)) return null
    throw error
  }
}

async function queryDocuments(collection, where, limit) {
  const response = await db.collection(collection)
    .where(where || {})
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 100))
    .get()
  return ((response && response.data) || []).map(fromDocument)
}

async function queryDocumentsPaged(collection, where, maxItems) {
  const safeMax = Math.min(Math.max(Number(maxItems) || 100, 1), 5000)
  const rows = []
  while (rows.length <= safeMax) {
    const pageSize = Math.min(100, safeMax + 1 - rows.length)
    const response = await db.collection(collection)
      .where(where || {})
      .skip(rows.length)
      .limit(pageSize)
      .get()
    const page = ((response && response.data) || []).map(fromDocument)
    rows.push(...page)
    if (page.length < pageSize) break
  }
  return {
    items: rows.slice(0, safeMax),
    truncated: rows.length > safeMax
  }
}

async function queryRecentDocuments(collection, where, orderField, limit) {
  const response = await db.collection(collection)
    .where(where || {})
    .orderBy(orderField, 'desc')
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 100))
    .get()
  return ((response && response.data) || []).map(fromDocument)
}

async function setDocument(collection, value, transaction) {
  const source = transaction || db
  await source.collection(collection).doc(value.id).set({ data: withoutId(value) })
  return value
}

async function updateDocument(collection, id, patch, transaction) {
  const source = transaction || db
  await source.collection(collection).doc(id).update({ data: withoutId(patch) })
}

class CloudRepository {
  async ensureUser(user) {
    const existing = await getDocument(COLLECTIONS.users, user.id)
    if (existing) {
      await updateDocument(COLLECTIONS.users, user.id, { updatedAt: user.updatedAt })
      return Object.assign({}, existing, { updatedAt: user.updatedAt })
    }
    await setDocument(COLLECTIONS.users, user)
    return user
  }

  async updateConsent(userId, consentVersion, now) {
    await updateDocument(COLLECTIONS.users, userId, { consentVersion, consentUpdatedAt: now, updatedAt: now })
  }

  async createFeedback(feedback) {
    return db.runTransaction(async transaction => {
      const existing = await getDocument(COLLECTIONS.feedback, feedback.id, transaction)
      if (existing) return existing
      await setDocument(COLLECTIONS.feedback, feedback, transaction)
      return feedback
    })
  }

  async listMyFeedback(ownerKey) {
    return queryRecentDocuments(COLLECTIONS.feedback, { ownerKey }, 'createdAt', 30)
  }

  async listChangeProposalsByIds(proposalIds) {
    const ids = Array.from(new Set((proposalIds || []).filter(Boolean))).slice(0, 30)
    if (!ids.length) return []
    return queryDocuments(COLLECTIONS.changeProposals, { _id: _.in(ids) }, ids.length)
  }

  async listMemberships(ownerKey) {
    const memberships = await queryDocuments(COLLECTIONS.members, { ownerKey, status: 'active' }, 100)
    const output = []
    for (const membership of memberships) {
      const community = await getDocument(COLLECTIONS.communities, membership.communityId)
      if (community && community.status === 'active') output.push({ membership, community })
    }
    return output
  }

  async createCommunity(community, membership) {
    return db.runTransaction(async transaction => {
      const existing = await getDocument(COLLECTIONS.communities, community.id, transaction)
      if (existing) return existing
      await setDocument(COLLECTIONS.communities, community, transaction)
      await setDocument(COLLECTIONS.members, membership, transaction)
      return community
    })
  }

  async findCommunityByInviteHash(inviteHash, adminInviteHash) {
    const matches = await queryDocuments(COLLECTIONS.communities, { inviteHash }, 1)
    if (matches[0]) return matches[0]
    if (!adminInviteHash) return null
    const managedMatches = await queryDocuments(COLLECTIONS.communities, { adminInviteHash }, 1)
    return managedMatches[0] || null
  }

  async joinCommunity(community, membership) {
    return db.runTransaction(async transaction => {
      const currentCommunity = await getDocument(COLLECTIONS.communities, community.id, transaction)
      if (!currentCommunity || currentCommunity.status !== 'active') {
        throw new DomainError('INVALID_INVITE', '社区不存在或已停用')
      }
      const existing = await getDocument(COLLECTIONS.members, membership.id, transaction)
      if (existing && existing.status === 'active') return existing
      const claimOwner = currentCommunity.managedByLocalAdmin === true && currentCommunity.ownerPending === true
      const value = existing
        ? Object.assign({}, existing, {
          role: claimOwner ? 'owner' : (existing.role || 'member'),
          status: 'active', updatedAt: membership.updatedAt
        })
        : Object.assign({}, membership, { role: claimOwner ? 'owner' : membership.role })
      await setDocument(COLLECTIONS.members, value, transaction)
      if (claimOwner) {
        await updateDocument(COLLECTIONS.communities, community.id, {
          ownerPending: false,
          creatorOwnerKey: membership.ownerKey,
          claimedAt: membership.updatedAt,
          updatedAt: membership.updatedAt
        }, transaction)
      }
      return value
    })
  }

  async getMembership(communityId, ownerKey) {
    const matches = await queryDocuments(COLLECTIONS.members, { communityId, ownerKey }, 1)
    return matches[0] || null
  }

  async upsertPet(pet) {
    return db.runTransaction(async transaction => {
      const existing = await getDocument(COLLECTIONS.pets, pet.id, transaction)
      const catId = existing && existing.catId ? existing.catId : (pet.catId || pet.id)
      const value = existing
        ? Object.assign({}, existing, {
          catId,
          displayName: pet.displayName,
          breed: pet.breed,
          gender: pet.gender,
          coatColor: pet.coatColor,
          estimatedAge: pet.estimatedAge,
          syncFingerprint: pet.syncFingerprint,
          serverVersion: Math.max(1, Number(existing.serverVersion) || 1) + 1,
          state: 'active',
          updatedAt: pet.updatedAt
        })
        : Object.assign({}, pet, { catId, serverVersion: 1 })
      await setDocument(COLLECTIONS.pets, value, transaction)

      const existingIdentity = await getDocument(COLLECTIONS.identities, catId, transaction)
      if (existingIdentity && existingIdentity.communityId !== pet.communityId) {
        throw new DomainError('CAT_ID_CONFLICT', '猫咪身份与当前小屋不一致')
      }
      const canRefreshIdentityName = !existingIdentity ||
        existingIdentity.sourceUserPetLinkId === pet.id ||
        (existingIdentity.ownerKey && existingIdentity.ownerKey === pet.ownerKey)
      const identity = existingIdentity
        ? Object.assign({}, existingIdentity, {
          displayName: canRefreshIdentityName ? pet.displayName : existingIdentity.displayName,
          canonicalCatId: existingIdentity.canonicalCatId || catId,
          identityVersion: Math.max(1, Number(existingIdentity.identityVersion) || 1) + 1,
          state: existingIdentity.state === 'merged' ? 'merged' : 'active',
          updatedAt: pet.updatedAt
        })
        : {
          id: catId,
          communityId: pet.communityId,
          displayName: pet.displayName,
          state: 'active',
          canonicalCatId: catId,
          identityVersion: 1,
          source: 'synced_user_pet',
          sourceUserPetLinkId: pet.id,
          ownerKey: pet.ownerKey,
          createdAt: pet.createdAt,
          updatedAt: pet.updatedAt
        }
      await setDocument(COLLECTIONS.identities, identity, transaction)
      return value
    })
  }

  async getPet(remotePetId) {
    return getDocument(COLLECTIONS.pets, remotePetId)
  }

  async getCommunityCat(communityId, catId, transaction) {
    let currentId = catId
    const visited = new Set()
    for (let depth = 0; depth < 8 && currentId && !visited.has(currentId); depth += 1) {
      visited.add(currentId)
      const identity = await getDocument(COLLECTIONS.identities, currentId, transaction)
      if (identity && identity.communityId === communityId) {
        const canonicalCatId = identity.canonicalCatId
        if (canonicalCatId && canonicalCatId !== currentId) {
          currentId = canonicalCatId
          continue
        }
        if (identity.state === 'active') return identity
        return null
      }
      const pet = await getDocument(COLLECTIONS.pets, currentId, transaction)
      if (!pet || pet.communityId !== communityId || pet.state !== 'active') return null
      const canonicalCatId = pet.catId
      if (canonicalCatId && canonicalCatId !== currentId) {
        currentId = canonicalCatId
        continue
      }
      return pet
    }
    return null
  }

  async touchCommunityCat(communityId, catId, now, transaction) {
    const identity = await getDocument(COLLECTIONS.identities, catId, transaction)
    if (identity && identity.communityId === communityId && identity.state === 'active') {
      await updateDocument(COLLECTIONS.identities, catId, { relationFenceAt: now }, transaction)
      return true
    }
    const pet = await getDocument(COLLECTIONS.pets, catId, transaction)
    if (pet && pet.communityId === communityId && pet.state === 'active') {
      await updateDocument(COLLECTIONS.pets, catId, { relationFenceAt: now }, transaction)
      return true
    }
    return false
  }

  async createUpload(session) {
    const existing = await getDocument(COLLECTIONS.uploads, session.id)
    if (existing) return existing
    await setDocument(COLLECTIONS.uploads, session)
    return session
  }

  async getUpload(uploadId) {
    return getDocument(COLLECTIONS.uploads, uploadId)
  }

  async submitSighting(input) {
    const { session, asset, sighting, idempotencyKey, requestHash, now } = input
    return db.runTransaction(async transaction => {
      const currentSession = await getDocument(COLLECTIONS.uploads, session.id, transaction)
      if (!currentSession || currentSession.ownerKey !== session.ownerKey) {
        throw new DomainError('UPLOAD_NOT_FOUND', '上传会话不存在')
      }
      if (currentSession.state === 'SUBMITTED') {
        if (currentSession.submitIdempotencyKey !== idempotencyKey || currentSession.submitRequestHash !== requestHash) {
          throw new DomainError('IDEMPOTENCY_CONFLICT', '重复提交参数不一致')
        }
        const existing = await getDocument(COLLECTIONS.sightingsPrivate, currentSession.sightingId, transaction)
        if (!existing) throw new DomainError('INTERNAL_ERROR', '提交事务不完整', true)
        return existing
      }
      if (currentSession.state !== 'CREATED' || Date.parse(currentSession.expiresAt) <= Date.parse(now)) {
        throw new DomainError('UPLOAD_EXPIRED', '上传会话已失效')
      }
      const existingSighting = await getDocument(COLLECTIONS.sightingsPrivate, sighting.id, transaction)
      if (existingSighting) {
        if (existingSighting.submitIdempotencyKey !== idempotencyKey ||
            existingSighting.submitRequestHash !== requestHash ||
            existingSighting.ownerKey !== session.ownerKey) {
          throw new DomainError('IDEMPOTENCY_CONFLICT', '同一提交幂等键不能用于另一条上传记录')
        }
        return existingSighting
      }
      const sightingDocument = Object.assign({}, sighting)
      if (sighting.exactLocation && Number.isFinite(sighting.exactLocation.longitude) &&
          Number.isFinite(sighting.exactLocation.latitude) && db.Geo && typeof db.Geo.Point === 'function') {
        sightingDocument.locationGeo = new db.Geo.Point(
          sighting.exactLocation.longitude,
          sighting.exactLocation.latitude
        )
      }
      await setDocument(COLLECTIONS.assets, asset, transaction)
      await setDocument(COLLECTIONS.sightingsPrivate, sightingDocument, transaction)
      await updateDocument(COLLECTIONS.uploads, session.id, {
        state: 'SUBMITTED',
        sightingId: sighting.id,
        submitIdempotencyKey: idempotencyKey,
        submitRequestHash: requestHash,
        updatedAt: now
      }, transaction)
      return sightingDocument
    })
  }

  async listWorkspace(communityId, ownerKey) {
    const community = await getDocument(COLLECTIONS.communities, communityId)
    if (!community) throw new DomainError('NOT_FOUND', '社区不存在')
    const [myPets, pendingSightings, approvedSightings] = await Promise.all([
      queryDocuments(COLLECTIONS.pets, { communityId, ownerKey, state: 'active' }, 100),
      queryDocuments(COLLECTIONS.sightingsPrivate, { communityId, state: 'PENDING_REVIEW' }, 50),
      queryDocuments(COLLECTIONS.sightingsPublic, { communityId, state: 'APPROVED' }, 50)
    ])
    const pending = []
    for (const sighting of pendingSightings) {
      const asset = await getDocument(COLLECTIONS.assets, sighting.assetId)
      if (asset) pending.push({ sighting, asset })
    }
    const approved = []
    for (const sighting of approvedSightings) {
      const asset = await getDocument(COLLECTIONS.assets, sighting.assetId)
      if (asset && asset.approvedFileID) approved.push({ sighting, asset })
    }
    return { community, myPets, pending, approved }
  }

  async getSighting(sightingId) {
    const sighting = await getDocument(COLLECTIONS.sightingsPrivate, sightingId)
    if (!sighting) return null
    const asset = await getDocument(COLLECTIONS.assets, sighting.assetId)
    if (!asset) return null
    return { sighting, asset }
  }

  async listCommunityInsights(communityId, ownerKey) {
    const [petPage, identityPage, edgePage, votePage, sightings] = await Promise.all([
      queryDocumentsPaged(COLLECTIONS.pets, { communityId, state: 'active' }, 500),
      queryDocumentsPaged(COLLECTIONS.identities, { communityId, state: 'active' }, 500),
      queryDocumentsPaged(COLLECTIONS.relationshipEdges, { communityId, state: 'active' }, 100),
      queryDocumentsPaged(COLLECTIONS.relationshipVotes, { communityId, ownerKey }, 2000),
      queryRecentDocuments(COLLECTIONS.sightingsPublic, { communityId, state: 'APPROVED' }, 'reviewedAt', 100)
    ])
    const cats = new Map()
    petPage.items.forEach(item => cats.set(item.id, item))
    identityPage.items.forEach(item => cats.set(item.id, item))
    return {
      cats: Array.from(cats.values()),
      edges: edgePage.items,
      myVotes: votePage.items,
      sightings,
      catsTruncated: petPage.truncated || identityPage.truncated,
      relationshipsTruncated: edgePage.truncated,
      myVotesTruncated: votePage.truncated
    }
  }

  async castRelationshipVote(input) {
    return db.runTransaction(async transaction => {
      const membership = await getDocument(COLLECTIONS.members, input.membershipId, transaction)
      if (!membership || membership.ownerKey !== input.actorOwnerKey ||
          membership.communityId !== input.edge.communityId || membership.status !== 'active') {
        throw new DomainError('FORBIDDEN', '小屋成员权限已变化，请刷新后重试')
      }
      const [catA, catB] = await Promise.all([
        this.getCommunityCat(input.edge.communityId, input.edge.fromCatId, transaction),
        this.getCommunityCat(input.edge.communityId, input.edge.toCatId, transaction)
      ])
      if (!catA || !catB) throw new DomainError('CAT_NOT_FOUND', '关系中的猫咪已不存在')
      // Fence identity revocation: relationship voting and identity undo both
      // write the same canonical cat document, so a stale snapshot must retry.
      const touchedA = await this.touchCommunityCat(input.edge.communityId, input.edge.fromCatId, input.now, transaction)
      const touchedB = await this.touchCommunityCat(input.edge.communityId, input.edge.toCatId, input.now, transaction)
      if (!touchedA || !touchedB) throw new DomainError('CAT_NOT_FOUND', '关系中的猫咪已不存在')
      for (const sightingId of input.vote.evidenceSightingIds || []) {
        const sighting = await getDocument(COLLECTIONS.sightingsPublic, sightingId, transaction)
        if (!sighting || sighting.communityId !== input.edge.communityId || sighting.state !== 'APPROVED') {
          throw new DomainError('INVALID_EVIDENCE', '关系证据目击不存在或不属于当前小屋')
        }
        const observedCatIds = new Set(Array.isArray(sighting.observedCatIds) ? sighting.observedCatIds : [])
        if (!observedCatIds.has(input.edge.fromCatId) || !observedCatIds.has(input.edge.toCatId)) {
          throw new DomainError('INVALID_EVIDENCE', '关系证据必须是同时包含这两只猫的已审核目击')
        }
      }
      const currentEdge = await getDocument(COLLECTIONS.relationshipEdges, input.edge.id, transaction)
      if (currentEdge && (currentEdge.communityId !== input.edge.communityId ||
          currentEdge.relationshipContractId !== RELATION_CONTRACT_ID ||
          Number(currentEdge.relationshipContractVersion) !== RELATION_CONTRACT_VERSION ||
          Number(currentEdge.directionVersion) !== RELATION_DIRECTION_VERSION ||
          currentEdge.directionState !== RELATION_DIRECTION_STATE ||
          currentEdge.fromCatId !== input.edge.fromCatId || currentEdge.toCatId !== input.edge.toCatId ||
          currentEdge.catAId !== input.edge.fromCatId || currentEdge.catBId !== input.edge.toCatId ||
          currentEdge.directionKey !== input.edge.directionKey)) {
        throw new DomainError('RELATIONSHIP_CONFLICT', '关系记录与当前猫咪不一致')
      }
      const currentVote = await getDocument(COLLECTIONS.relationshipVotes, input.vote.id, transaction)
      if (currentVote && (!currentEdge || currentVote.edgeId !== input.edge.id ||
          currentVote.relationshipContractId !== RELATION_CONTRACT_ID ||
          Number(currentVote.relationshipContractVersion) !== RELATION_CONTRACT_VERSION ||
          Number(currentVote.directionVersion) !== RELATION_DIRECTION_VERSION ||
          currentVote.directionState !== RELATION_DIRECTION_STATE ||
          currentVote.directionKey !== input.vote.directionKey ||
          currentVote.fromCatId !== input.vote.fromCatId ||
          currentVote.toCatId !== input.vote.toCatId)) {
        throw new DomainError('RELATIONSHIP_VOTE_CONFLICT', '投票记录与当前箭头方向不一致')
      }
      if (currentVote && currentVote.idempotencyKey === input.vote.idempotencyKey) {
        if (currentVote.requestHash !== input.vote.requestHash) {
          throw new DomainError('IDEMPOTENCY_CONFLICT', '同一投票幂等键不能用于不同选择')
        }
        return { edge: currentEdge, vote: currentVote }
      }
      const counts = Object.assign({
        bonded: 0,
        playmate: 0,
        housemate: 0,
        needs_space: 0,
        unsure: 0
      }, (currentEdge && currentEdge.voteCounts) || {})
      if (currentVote && Object.prototype.hasOwnProperty.call(counts, currentVote.choice)) {
        counts[currentVote.choice] = Math.max(0, Number(counts[currentVote.choice]) - 1)
      }
      counts[input.vote.choice] = Math.max(0, Number(counts[input.vote.choice]) || 0) + 1
      const totalVotes = Object.values(counts).reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0)
      const edge = Object.assign({}, currentEdge || input.edge, {
        relationshipContractId: input.edge.relationshipContractId,
        relationshipContractVersion: input.edge.relationshipContractVersion,
        directionVersion: RELATION_DIRECTION_VERSION,
        directionState: RELATION_DIRECTION_STATE,
        directionKey: input.edge.directionKey,
        fromCatId: input.edge.fromCatId,
        toCatId: input.edge.toCatId,
        fromCat: { catId: catA.id, displayName: catA.displayName || '未命名猫咪' },
        toCat: { catId: catB.id, displayName: catB.displayName || '未命名猫咪' },
        catAId: input.edge.fromCatId,
        catBId: input.edge.toCatId,
        catA: { catId: catA.id, displayName: catA.displayName || '未命名猫咪' },
        catB: { catId: catB.id, displayName: catB.displayName || '未命名猫咪' },
        voteCounts: counts,
        totalVotes,
        state: 'active',
        updatedAt: input.now
      })
      const vote = Object.assign({}, currentVote || input.vote, input.vote, {
        relationshipContractId: input.vote.relationshipContractId,
        relationshipContractVersion: input.vote.relationshipContractVersion,
        directionVersion: RELATION_DIRECTION_VERSION,
        directionState: RELATION_DIRECTION_STATE,
        directionKey: input.vote.directionKey,
        fromCatId: input.vote.fromCatId,
        toCatId: input.vote.toCatId,
        createdAt: currentVote ? currentVote.createdAt : input.vote.createdAt,
        updatedAt: input.now
      })
      await setDocument(COLLECTIONS.relationshipEdges, edge, transaction)
      await setDocument(COLLECTIONS.relationshipVotes, vote, transaction)
      return { edge, vote }
    })
  }

  async reviewSighting(input) {
    return db.runTransaction(async transaction => {
      const sighting = await getDocument(COLLECTIONS.sightingsPrivate, input.sightingId, transaction)
      if (!sighting) throw new DomainError('NOT_FOUND', '目击记录不存在')
      const asset = await getDocument(COLLECTIONS.assets, sighting.assetId, transaction)
      if (!asset) throw new DomainError('INTERNAL_ERROR', '图片资产不存在', true)
      const legacyResanitize = sighting.state === 'APPROVED' && input.decision === 'approved' && asset.sanitized !== true
      if (sighting.state !== 'PENDING_REVIEW') {
        if (sighting.lastReviewIdempotencyKey === input.idempotencyKey) {
          if (sighting.lastReviewRequestHash !== input.reviewRequestHash) {
            throw new DomainError('IDEMPOTENCY_CONFLICT', '同一审核幂等键不能用于不同决定')
          }
          return sighting
        }
        if (!legacyResanitize) throw new DomainError('STATE_CONFLICT', '这条目击已经被审核')
      }
      if (sighting.version !== input.expectedVersion) {
        throw new DomainError('VERSION_CONFLICT', '记录已更新，请刷新后再审核')
      }
      const reviewerMembership = await getDocument(COLLECTIONS.members, input.reviewerMembershipId, transaction)
      if (!reviewerMembership || reviewerMembership.ownerKey !== input.reviewerOwnerKey ||
          reviewerMembership.communityId !== sighting.communityId || reviewerMembership.status !== 'active' ||
          !['owner', 'admin', 'reviewer'].includes(reviewerMembership.role)) {
        throw new DomainError('FORBIDDEN', '审核权限已变更，请刷新后重试')
      }
      const nextState = input.decision === 'approved' ? 'APPROVED' : 'REJECTED'
      const nextVersion = sighting.version + 1
      const nextSighting = Object.assign({}, sighting, {
        state: nextState,
        version: nextVersion,
        reviewerOwnerKey: input.reviewerOwnerKey,
        reviewerRole: input.reviewerRole,
        reviewNote: input.note,
        reviewedAt: input.now,
        lastReviewIdempotencyKey: input.idempotencyKey,
        lastReviewRequestHash: input.reviewRequestHash,
        updatedAt: input.now
      })
      await setDocument(COLLECTIONS.sightingsPrivate, nextSighting, transaction)
      if (nextState === 'APPROVED') {
        await updateDocument(COLLECTIONS.assets, asset.id, {
          state: 'APPROVED',
          approvedFileID: input.approvedFileID,
          approvedPath: input.approvedPath,
          sourceMime: asset.sourceMime || asset.mime,
          sourceSizeBytes: asset.sourceSizeBytes || asset.sizeBytes,
          sourceSha256: asset.sourceSha256 || asset.sha256,
          mime: input.approvedMime,
          sizeBytes: input.approvedSizeBytes,
          sha256: input.approvedSha256,
          sanitized: true,
          updatedAt: input.now
        }, transaction)
        const existingPublic = await getDocument(COLLECTIONS.sightingsPublic, sighting.id, transaction)
        const publicDocument = Object.assign({}, existingPublic || {}, {
          id: sighting.id,
          ownerKey: sighting.ownerKey,
          communityId: sighting.communityId,
          assetId: sighting.assetId,
          state: 'APPROVED',
          version: nextVersion,
          remotePetId: sighting.remotePetId || (existingPublic && existingPublic.remotePetId) || null,
          catId: sighting.identityCatId || sighting.catId || sighting.remotePetId || (existingPublic && existingPublic.catId) || null,
          cat: sighting.identityCat || sighting.cat || (existingPublic && existingPublic.cat) || null,
          identityCatId: sighting.identityCatId || (existingPublic && existingPublic.identityCatId) || null,
          identityCat: sighting.identityCat || (existingPublic && existingPublic.identityCat) || null,
          identityTemplateReady: Boolean(sighting.identityTemplateReady || (existingPublic && existingPublic.identityTemplateReady)),
          observedTimeBucket: sighting.observedTimeBucket,
          coarseLocation: coarseLocationForMembers(sighting.coarseLocation),
          caption: sighting.caption || '',
          submittedAt: sighting.submittedAt,
          reviewedAt: input.now
        })
        await setDocument(COLLECTIONS.sightingsPublic, publicDocument, transaction)
      } else {
        await updateDocument(COLLECTIONS.assets, asset.id, {
          state: 'REJECTED',
          updatedAt: input.now
        }, transaction)
      }
      return nextSighting
    })
  }
}

function detectMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.length >= 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return ''
}

const media = {
  async inspect(input) {
    const response = await cloud.downloadFile({ fileID: input.fileID })
    const buffer = response && response.fileContent
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new DomainError('INVALID_FILE', '云端图片为空')
    if (buffer.length > Math.min(input.maxBytes || MAX_IMAGE_BYTES, MAX_IMAGE_BYTES)) {
      throw new DomainError('INVALID_FILE_SIZE', '图片超过 8MB')
    }
    if (Number.isInteger(input.expectedSizeBytes) && buffer.length !== input.expectedSizeBytes) {
      throw new DomainError('INVALID_FILE', '图片大小与上传会话不一致')
    }
    const mime = detectMime(buffer)
    if (!mime || mime !== input.expectedMime) throw new DomainError('INVALID_FILE', '图片类型与上传声明不一致')
    return {
      mime,
      sizeBytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex')
    }
  },

  async approve(input) {
    const response = await cloud.downloadFile({ fileID: input.sourceFileID })
    const buffer = response && response.fileContent
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_IMAGE_BYTES) {
      throw new DomainError('MEDIA_PROMOTION_FAILED', '待发布图片无效', true)
    }
    const actualMime = detectMime(buffer)
    const digest = crypto.createHash('sha256').update(buffer).digest('hex')
    if (!actualMime || actualMime !== input.mime || digest !== input.sha256 || buffer.length !== input.sizeBytes) {
      throw new DomainError('MEDIA_CHANGED', '图片在提交后发生变化，请重新上传并审核')
    }
    let sanitized
    try {
      sanitized = await sanitizeApprovedImage(buffer)
    } catch (error) {
      throw new DomainError('MEDIA_SANITIZE_FAILED', '图片无法安全转码，请换一张清晰的单猫照片', true)
    }
    if (!Buffer.isBuffer(sanitized) || !sanitized.length || sanitized.length > MAX_IMAGE_BYTES) {
      throw new DomainError('MEDIA_SANITIZE_FAILED', '图片脱敏转码后大小异常，请更换照片', true)
    }
    const approvedMime = 'image/jpeg'
    const approvedDigest = crypto.createHash('sha256').update(sanitized).digest('hex')
    const cloudPath = `identity-approved/sightings/${input.sightingId}/${approvedDigest.slice(0, 32)}.jpg`
    const uploaded = await cloud.uploadFile({ cloudPath, fileContent: sanitized })
    if (!uploaded || !uploaded.fileID) throw new DomainError('MEDIA_PROMOTION_FAILED', '图片发布失败', true)
    return {
      fileID: uploaded.fileID,
      cloudPath,
      mime: approvedMime,
      sizeBytes: sanitized.length,
      sha256: approvedDigest
    }
  },

  async getTempUrls(requests) {
    const output = {}
    for (let start = 0; start < requests.length; start += 50) {
      const batch = requests.slice(start, start + 50)
      const fileIDs = Array.from(new Set(batch.map(item => item.fileID)))
      const response = await cloud.getTempFileURL({
        fileList: fileIDs.map(fileID => ({ fileID, maxAge: 300 }))
      })
      const byFile = {}
      ;((response && response.fileList) || []).forEach(item => {
        if (item && item.fileID && item.tempFileURL && (!item.status || item.status === 0)) {
          byFile[item.fileID] = item.tempFileURL
        }
      })
      batch.forEach(item => {
        if (byFile[item.fileID]) {
          output[item.key] = {
            url: byFile[item.fileID],
            expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
          }
        }
      })
    }
    return output
  },

  async cleanup(fileID) {
    if (fileID) await cloud.deleteFile({ fileList: [fileID] })
  }
}

const core = createCatOnlineCore({
  repository: new CloudRepository(),
  media,
  ownerSecret: process.env.CAT_ONLINE_OWNER_SECRET || '',
  ownerKeyVersion: process.env.CAT_ONLINE_OWNER_KEY_VERSION || 'v1',
  cloudEnvId: process.env.CLOUDBASE_ENV_ID || 'cloud1-d6gpjpxunc74669d7'
})

exports.main = async event => {
  const context = cloud.getWXContext()
  const result = await core.handle(event || {}, { openid: context && context.OPENID })
  if (!result.ok) {
    console.warn(JSON.stringify({
      action: String(event && event.action || '').slice(0, 40),
      requestId: result.requestId,
      errorCode: result.error && result.error.code
    }))
  }
  return result
}

exports.COLLECTIONS = COLLECTIONS
exports.CloudRepository = CloudRepository
exports.detectMime = detectMime
