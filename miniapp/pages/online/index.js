const online = require('../../services/online')
const identity = require('../../services/identity')
const storage = require('../../utils/storage')

const COMMUNITY_KEY = 'catai_mini_online_community_v1'
const INVITE_CODES_KEY = 'catai_mini_online_invites_v1'

function pad(value) {
  return String(value).padStart(2, '0')
}

function currentDraft() {
  const now = new Date()
  return {
    imagePath: '',
    observedDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    observedTime: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    areaText: '',
    location: null,
    locationLabel: '',
    caption: '',
    catIndex: 0,
    localPetId: '',
    remotePetId: ''
  }
}

function remotePetId(item) {
  return String(item && (item.remotePetId || item.id) || '')
}

function localPetId(item) {
  return String(item && item.localPetId || '')
}

function selectedLocalPetId(data) {
  const stableId = String(data && data.selectedLocalPetId || '')
  if (stableId) return stableId
  const pets = data && data.localPets || []
  const selected = pets[Number(data && data.localPetIndex) || 0]
  return String(selected && selected.id || '')
}

function resolveLocalPetSelection(localPets, stableId) {
  const pets = localPets || []
  let index = pets.findIndex(item => String(item && item.id || '') === String(stableId || ''))
  if (index < 0) index = pets.length ? 0 : 0
  return {
    index,
    localPetId: String(pets[index] && pets[index].id || '')
  }
}

function selectedCloudIdentity(data) {
  const draft = data && data.draft || {}
  if (draft.remotePetId || draft.localPetId) {
    return {
      remotePetId: String(draft.remotePetId || ''),
      localPetId: String(draft.localPetId || '')
    }
  }
  const cats = data && data.cloudCats || []
  const selected = Number(draft.catIndex) > 0 ? cats[Number(draft.catIndex) - 1] : null
  return {
    remotePetId: remotePetId(selected),
    localPetId: localPetId(selected)
  }
}

function resolveCloudCatSelection(cloudCats, stableIdentity) {
  const cats = cloudCats || []
  const selectedRemotePetId = String(stableIdentity && stableIdentity.remotePetId || '')
  const selectedLocalPetId = String(stableIdentity && stableIdentity.localPetId || '')
  let index = selectedRemotePetId
    ? cats.findIndex(item => remotePetId(item) === selectedRemotePetId)
    : -1
  if (index < 0 && selectedLocalPetId) {
    index = cats.findIndex(item => localPetId(item) === selectedLocalPetId)
  }
  const selected = index >= 0 ? cats[index] : null
  return {
    index: selected ? index + 1 : 0,
    remotePetId: remotePetId(selected),
    localPetId: localPetId(selected)
  }
}

function statusLabel(status) {
  return {
    pending_review: '等待小屋管理员确认',
    approved: '已在小屋中可见',
    rejected: '未通过确认',
    processing: '正在处理'
  }[status] || '状态待更新'
}

function normalizeCommunity(item, inviteCodes) {
  const communityId = item && (item.communityId || item.id)
  return Object.assign({}, item, {
    id: communityId,
    communityId,
    inviteCode: (inviteCodes && inviteCodes[communityId]) || item.inviteCode || ''
  })
}

function observedLabel(value) {
  const text = String(value || '')
  if (!text) return '时间未填写'
  const match = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})/)
  return match ? `${match[1]} · ${match[2]}:00 左右` : text
}

function normalizeSighting(item) {
  const status = String(item.state || item.status || '').toLowerCase()
  const cat = item.cat || {}
  const coarseLocation = item.coarseLocation || {}
  return Object.assign({}, item, {
    id: item.sightingId || item.id,
    status,
    thumbnail: item.media || item.thumbnail || {},
    catName: cat.displayName || item.catName || '',
    areaText: coarseLocation.areaText || item.areaText || '',
    caption: item.caption || '',
    statusLabel: statusLabel(status),
    canReview: Boolean(item.canReview),
    canMatch: Boolean(item.canMatch),
    canEnroll: Boolean(item.canEnroll),
    identityTemplateReady: Boolean(item.identityTemplateReady),
    observedLabel: observedLabel(item.observedTimeBucket || item.observedAt)
  })
}

function localPetRows(localPets, communityId, cloudCats) {
  const remoteByLocal = new Map((cloudCats || []).map(item => [item.localPetId, item]))
  return (localPets || []).map(pet => {
    const remote = remoteByLocal.get(pet.id)
    const fingerprint = online.petSyncFingerprint(pet)
    const synced = Boolean(remote && remote.syncFingerprint && remote.syncFingerprint === fingerprint)
    return {
      id: pet.id,
      pet,
      remotePetId: remote && remote.remotePetId,
      status: !remote ? 'not_linked' : synced ? 'synced' : 'needs_sync',
      statusLabel: !remote ? '未连接' : synced ? '已同步' : '有更新',
      communityId
    }
  })
}

Page({
  data: {
    loading: true,
    refreshing: false,
    identityEnabled: true,
    actionLoading: '',
    errorMessage: '',
    feedbackMessage: '',
    communities: [],
    communityNames: [],
    selectedCommunityIndex: 0,
    currentCommunity: null,
    role: '',
    canReview: false,
    newCommunityName: '',
    inviteCode: '',
    localPets: [],
    localPetNames: [],
    localPetRows: [],
    localPetIndex: 0,
    selectedLocalPetId: '',
    cloudCats: [],
    cloudCatNames: ['暂不确认身份'],
    sightings: [],
    draft: currentDraft()
  },

  onLoad() {
    this._onlineLoaded = false
    this.loadOnline().finally(() => {
      this._onlineLoaded = true
    })
  },

  onShow() {
    const community = this.data.currentCommunity
    if (!this._onlineLoaded || !community || this.data.loading) return
    this.loadWorkspace(community.id).catch(error => {
      this.setData({ errorMessage: error.message || '刷新猫友小屋失败' })
    })
  },

  onPullDownRefresh() {
    this.loadOnline(true).finally(() => wx.stopPullDownRefresh())
  },

  async loadOnline(fromRefresh) {
    const loadToken = (this._onlineLoadToken || 0) + 1
    this._onlineLoadToken = loadToken
    this.setData({
      loading: !fromRefresh,
      refreshing: Boolean(fromRefresh),
      errorMessage: ''
    })
    try {
      const bootstrap = await online.bootstrap()
      if (loadToken !== this._onlineLoadToken) return false
      const recovery = bootstrap.uploadRecovery
      const recoveryMessage = recovery && recovery.found
        ? '已找回上次网络中断前提交的目击，不会重复创建。'
        : recovery && recovery.state === 'PENDING'
          ? '上一条上传仍在云端确认，请稍后下拉刷新，先不要重复提交同一张照片。'
          : recovery && recovery.state === 'RETRY_ALLOWED'
            ? '上一条上传未完成，现在可以重新提交。'
            : recovery && recovery.state === 'UNKNOWN'
              ? '暂时无法确认上一条上传结果，请稍后下拉刷新，先不要重复提交。'
            : ''
      const inviteCodes = wx.getStorageSync(INVITE_CODES_KEY) || {}
      const communities = (bootstrap.communities || []).map(item => normalizeCommunity(item, inviteCodes))
      const savedId = wx.getStorageSync(COMMUNITY_KEY)
      let selectedCommunityIndex = communities.findIndex(item => item.id === savedId)
      if (selectedCommunityIndex < 0) selectedCommunityIndex = 0
      const localPets = storage.listPets()
      const localSelection = resolveLocalPetSelection(localPets, selectedLocalPetId(this.data))
      const nextCommunity = communities[selectedCommunityIndex] || null
      const previousCommunityId = this.data.currentCommunity && this.data.currentCommunity.id
      const communityChanged = Boolean(previousCommunityId && nextCommunity && previousCommunityId !== nextCommunity.id)
      const nextDraft = communityChanged
        ? Object.assign({}, this.data.draft, { catIndex: 0, localPetId: '', remotePetId: '' })
        : this.data.draft
      this.setData({
        communities,
        communityNames: communities.map(item => item.name),
        selectedCommunityIndex,
        currentCommunity: nextCommunity,
        feedbackMessage: recoveryMessage || this.data.feedbackMessage,
        localPets,
        localPetNames: localPets.map(item => item.name || '未命名猫咪'),
        localPetRows: localPetRows(localPets, nextCommunity && nextCommunity.id, communityChanged ? [] : this.data.cloudCats),
        localPetIndex: localSelection.index,
        selectedLocalPetId: localSelection.localPetId,
        draft: nextDraft,
        cloudCats: communityChanged ? [] : this.data.cloudCats,
        cloudCatNames: communityChanged ? ['暂不确认身份'] : this.data.cloudCatNames,
        sightings: communityChanged ? [] : this.data.sightings,
        role: communityChanged ? '' : this.data.role,
        canReview: communityChanged ? false : this.data.canReview
      })
      if (communities.length) await this.loadWorkspace(communities[selectedCommunityIndex].id)
      else {
        this._workspaceLoadToken = (this._workspaceLoadToken || 0) + 1
        this._workspaceCommunityId = ''
        this.setData({
          currentCommunity: null,
          role: '',
          canReview: false,
          cloudCats: [],
          cloudCatNames: ['暂不确认身份'],
          sightings: [],
          'draft.catIndex': 0,
          'draft.localPetId': '',
          'draft.remotePetId': ''
        })
      }
      return true
    } catch (error) {
      if (loadToken !== this._onlineLoadToken) return false
      this.setData({ errorMessage: error.message || '联机服务暂时不可用，本地档案不受影响' })
      return false
    } finally {
      if (loadToken === this._onlineLoadToken) this.setData({ loading: false, refreshing: false })
    }
  },

  async loadWorkspace(communityId) {
    const activeCommunityId = this.data.currentCommunity && this.data.currentCommunity.id
    if (activeCommunityId && activeCommunityId !== communityId) return false
    const loadToken = (this._workspaceLoadToken || 0) + 1
    this._workspaceLoadToken = loadToken
    this._workspaceCommunityId = communityId
    let workspace
    try {
      workspace = await online.listWorkspace(communityId)
    } catch (error) {
      if (loadToken !== this._workspaceLoadToken || this._workspaceCommunityId !== communityId) return false
      throw error
    }
    if (loadToken !== this._workspaceLoadToken || this._workspaceCommunityId !== communityId) return false
    const communities = this.data.communities
    const localPets = storage.listPets()
    const inviteCodes = wx.getStorageSync(INVITE_CODES_KEY) || {}
    const currentCommunity = normalizeCommunity(
      workspace.community || communities.find(item => item.id === communityId) || {},
      inviteCodes
    )
    const role = currentCommunity.role || 'member'
    const cloudCats = (workspace.myPets || []).map(item => Object.assign({}, item, {
      id: item.remotePetId,
      name: item.displayName
    }))
    const localSelection = resolveLocalPetSelection(localPets, selectedLocalPetId(this.data))
    const cloudSelection = resolveCloudCatSelection(cloudCats, selectedCloudIdentity(this.data))
    storage.reconcileOnlineLinks(communityId, cloudCats)
    const petRows = localPetRows(localPets, communityId, cloudCats)
    const sightings = (workspace.pendingReview || [])
      .concat(workspace.approvedSightings || [])
      .map(item => normalizeSighting(item))
    wx.setStorageSync(COMMUNITY_KEY, communityId)
    this.setData({
      currentCommunity,
      selectedCommunityIndex: Math.max(communities.findIndex(item => item.id === communityId), 0),
      role,
      canReview: ['owner', 'admin', 'reviewer'].includes(role),
      localPets,
      localPetNames: localPets.map(item => item.name || '未命名猫咪'),
      localPetIndex: localSelection.index,
      selectedLocalPetId: localSelection.localPetId,
      cloudCats,
      localPetRows: petRows,
      cloudCatNames: ['暂不确认身份'].concat(cloudCats.map(item => item.name || '未命名猫咪')),
      sightings,
      'draft.catIndex': cloudSelection.index,
      'draft.localPetId': cloudSelection.localPetId,
      'draft.remotePetId': cloudSelection.remotePetId
    })
    return true
  },

  onCommunityChange(event) {
    const index = Number(event.detail.value) || 0
    const community = this.data.communities[index]
    if (!community) return
    this._onlineLoadToken = (this._onlineLoadToken || 0) + 1
    this.setData({
      loading: true,
      selectedCommunityIndex: index,
      currentCommunity: community,
      role: '',
      canReview: false,
      cloudCats: [],
      cloudCatNames: ['暂不确认身份'],
      sightings: [],
      localPetRows: localPetRows(this.data.localPets, community.id, []),
      'draft.catIndex': 0,
      'draft.localPetId': '',
      'draft.remotePetId': '',
      errorMessage: '',
      feedbackMessage: ''
    })
    const request = this.loadWorkspace(community.id)
    const loadToken = this._workspaceLoadToken
    request.catch(error => {
      if (loadToken === this._workspaceLoadToken) {
        this.setData({ errorMessage: error.message || '切换小屋失败' })
      }
    }).finally(() => {
      if (loadToken === this._workspaceLoadToken) this.setData({ loading: false })
    })
  },

  onNewCommunityName(event) { this.setData({ newCommunityName: event.detail.value }) },
  onInviteCode(event) { this.setData({ inviteCode: event.detail.value }) },
  onLocalPetChange(event) {
    const index = Number(event.detail.value) || 0
    const pet = this.data.localPets[index]
    this.setData({
      localPetIndex: index,
      selectedLocalPetId: String(pet && pet.id || '')
    })
  },
  onCloudCatChange(event) {
    const index = Number(event.detail.value) || 0
    const cat = index > 0 ? this.data.cloudCats[index - 1] : null
    this.setData({
      'draft.catIndex': index,
      'draft.localPetId': localPetId(cat),
      'draft.remotePetId': remotePetId(cat)
    })
  },
  onObservedDate(event) { this.setData({ 'draft.observedDate': event.detail.value }) },
  onObservedTime(event) { this.setData({ 'draft.observedTime': event.detail.value }) },
  onAreaInput(event) { this.setData({ 'draft.areaText': event.detail.value }) },
  onCaptionInput(event) { this.setData({ 'draft.caption': event.detail.value }) },

  async createCommunity() {
    const name = String(this.data.newCommunityName || '').trim()
    if (!name) return wx.showToast({ title: '先给猫友小屋起个名字', icon: 'none' })
    this.setData({ actionLoading: 'create', errorMessage: '', feedbackMessage: '' })
    try {
      const created = await online.createCommunity(name)
      const community = created.community || {}
      const communityId = community.communityId || community.id
      if (communityId && created.inviteCode) {
        const inviteCodes = wx.getStorageSync(INVITE_CODES_KEY) || {}
        inviteCodes[communityId] = created.inviteCode
        wx.setStorageSync(INVITE_CODES_KEY, inviteCodes)
        wx.setStorageSync(COMMUNITY_KEY, communityId)
      }
      this.setData({ newCommunityName: '', feedbackMessage: '猫友小屋创建成功，可以邀请熟悉的猫友加入。' })
      await this.loadOnline()
    } catch (error) {
      this.setData({ errorMessage: error.message || '创建失败，请稍后重试' })
    } finally {
      this.setData({ actionLoading: '' })
    }
  },

  async joinCommunity() {
    const inviteCode = String(this.data.inviteCode || '').trim()
    if (!inviteCode) return wx.showToast({ title: '请输入邀请口令', icon: 'none' })
    this.setData({ actionLoading: 'join', errorMessage: '', feedbackMessage: '' })
    try {
      await online.joinCommunity(inviteCode)
      this.setData({ inviteCode: '', feedbackMessage: '已经加入猫友小屋。' })
      await this.loadOnline()
    } catch (error) {
      this.setData({ errorMessage: error.message || '加入失败，请检查邀请口令' })
    } finally {
      this.setData({ actionLoading: '' })
    }
  },

  async syncLocalPet() {
    const community = this.data.currentCommunity
    const pet = this.data.localPets.find(item => String(item && item.id || '') === String(this.data.selectedLocalPetId || ''))
    if (!community || !pet) return wx.showToast({ title: '请先选择本地猫咪档案', icon: 'none' })
    this.setData({ actionLoading: 'sync', errorMessage: '', feedbackMessage: '' })
    try {
      const result = await online.syncPet(community.id, pet)
      if (result && result.pet) storage.saveOnlineLink(result.pet)
      this.setData({ feedbackMessage: `${pet.name || '猫咪'}的基础身份已同步，健康记录仍只在本机。` })
      await this.loadWorkspace(community.id)
    } catch (error) {
      this.setData({ errorMessage: error.message || '同步失败，请稍后重试' })
    } finally {
      this.setData({ actionLoading: '' })
    }
  },

  async syncAllLocalPets() {
    const community = this.data.currentCommunity
    const pendingRows = this.data.localPetRows.filter(item => item.status !== 'synced')
    const pets = pendingRows.map(item => item.pet)
    if (!community || !this.data.localPets.length) return wx.showToast({ title: '还没有可同步的本地档案', icon: 'none' })
    if (!pets.length) return wx.showToast({ title: '全部档案已经同步', icon: 'success' })
    this.setData({ actionLoading: 'sync_all', errorMessage: '', feedbackMessage: '' })
    let completed = 0
    try {
      for (const pet of pets) {
        const result = await online.syncPet(community.id, pet)
        if (result && result.pet) storage.saveOnlineLink(result.pet)
        completed += 1
      }
      this.setData({ feedbackMessage: `已连接 ${completed} 份本地档案；健康记录仍只保存在本机。` })
      await this.loadWorkspace(community.id)
    } catch (error) {
      this.setData({ errorMessage: `已完成 ${completed} 份，随后同步失败：${error.message || '请稍后重试'}` })
    } finally {
      this.setData({ actionLoading: '' })
    }
  },

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['original', 'compressed'],
      success: result => {
        const file = result.tempFiles && result.tempFiles[0]
        if (file && file.tempFilePath) this.setData({ 'draft.imagePath': file.tempFilePath })
      }
    })
  },

  clearImage() {
    this.setData({ 'draft.imagePath': '' })
  },

  chooseLocation() {
    this.setData({ errorMessage: '', feedbackMessage: '' })
    wx.chooseLocation({
      success: result => {
        this.setData({
          'draft.locationLabel': String(result.name || result.address || '已选择地图位置').slice(0, 60),
          'draft.location': {
            source: 'map',
            longitude: result.longitude,
            latitude: result.latitude,
            accuracyM: null,
            areaText: ''
          },
          feedbackMessage: '已选择本次目击地点；提交前可随时清除。'
        })
      },
      fail: error => {
        if (!String(error && error.errMsg || '').includes('cancel')) {
          const message = '未能打开地图选点；位置可跳过，仍可提交照片和粗略备注。'
          this.setData({ errorMessage: message })
          wx.showToast({ title: message, icon: 'none' })
        }
      }
    })
  },

  clearLocation() {
    this.setData({
      'draft.location': null,
      'draft.locationLabel': '',
      feedbackMessage: '已清除地图坐标；给审核员的粗略备注仍保留，可继续修改。'
    })
  },

  async submitSighting() {
    const community = this.data.currentCommunity
    const draft = this.data.draft
    if (!community) return wx.showToast({ title: '请先创建或加入猫友小屋', icon: 'none' })
    if (!draft.imagePath) return wx.showToast({ title: '请先选择猫咪照片', icon: 'none' })
    const cat = draft.remotePetId
      ? this.data.cloudCats.find(item => remotePetId(item) === String(draft.remotePetId))
      : draft.localPetId
        ? this.data.cloudCats.find(item => localPetId(item) === String(draft.localPetId))
        : null
    this.setData({ actionLoading: 'upload', errorMessage: '', feedbackMessage: '' })
    try {
      await online.uploadSighting({
        communityId: community.id,
        imagePath: draft.imagePath,
        observedAt: `${draft.observedDate}T${draft.observedTime}:00+08:00`,
        areaText: draft.areaText,
        location: draft.location,
        caption: draft.caption,
        localPetId: cat && cat.localPetId
      })
      this.setData({
        draft: currentDraft(),
        feedbackMessage: '目击照片已安全提交，等待小屋管理员确认后展示。'
      })
      await this.loadWorkspace(community.id)
    } catch (error) {
      this.setData({ errorMessage: error.message || '上传失败，请稍后重试' })
    } finally {
      this.setData({ actionLoading: '' })
    }
  },

  reviewSighting(event) {
    const sightingId = event.currentTarget.dataset.id
    const expectedVersion = Number(event.currentTarget.dataset.version)
    const decision = event.currentTarget.dataset.decision
    const title = decision === 'approve' ? '确认公开到小屋？' : '不展示这条目击？'
    const content = decision === 'approve'
      ? '确认照片中没有住址、联系方式或其他不适合共享的信息。'
      : '这条记录不会在小屋展示；如需补拍或修改，请重新上传。'
    wx.showModal({
      title,
      content,
      confirmText: decision === 'approve' ? '确认展示' : '不展示',
      confirmColor: decision === 'approve' ? '#FF6F91' : '#B94955',
      success: async result => {
        if (!result.confirm) return
        this.setData({ actionLoading: `review_${sightingId}`, errorMessage: '', feedbackMessage: '' })
        try {
          await online.reviewSighting(sightingId, expectedVersion, decision)
          this.setData({ feedbackMessage: decision === 'approve' ? '目击已加入小屋动态。' : '目击已停止展示。' })
          await this.loadWorkspace(this.data.currentCommunity.id)
        } catch (error) {
          this.setData({ errorMessage: error.message || '处理失败，请稍后重试' })
        } finally {
          this.setData({ actionLoading: '' })
        }
      }
    })
  },

  openIdentity(event) {
    const id = event.currentTarget.dataset.id
    const communityId = this.data.currentCommunity && this.data.currentCommunity.id
    wx.navigateTo({
      url: `/pages/identity/index?sightingId=${encodeURIComponent(id)}&communityId=${encodeURIComponent(communityId || '')}`
    })
  },

  enrollLinkedSighting(event) {
    const sightingId = event.currentTarget.dataset.id
    const community = this.data.currentCommunity
    if (!sightingId || !community || this.data.actionLoading) return
    wx.showModal({
      title: '加入同猫识别图库？',
      content: '这张已审核照片会作为所关联猫咪的识别样本，只帮助后续生成同猫候选，不会自动合并任何档案。',
      confirmText: '确认加入',
      confirmColor: '#FF6F91',
      success: result => {
        if (result.confirm) this.submitLinkedEnrollment(community.id, sightingId)
      }
    })
  },

  async submitLinkedEnrollment(communityId, sightingId) {
    this.setData({ actionLoading: `enroll_${sightingId}`, errorMessage: '', feedbackMessage: '' })
    try {
      const result = await identity.enrollLinkedSighting(communityId, sightingId)
      this.setData({
        feedbackMessage: result.notice || '照片已加入识别图库；它只用于生成候选，不会自动合并档案。'
      })
      await this.loadWorkspace(communityId)
    } catch (error) {
      this.setData({ errorMessage: error.message || '识别样本登记失败，请稍后重试' })
    } finally {
      this.setData({ actionLoading: '' })
    }
  },

  openCommunityInsights() {
    const community = this.data.currentCommunity
    if (!community) return
    wx.navigateTo({
      url: `/pages/community-insights/index?communityId=${encodeURIComponent(community.id)}&name=${encodeURIComponent(community.name || '')}`
    })
  },

  copyInviteCode() {
    const code = this.data.currentCommunity && this.data.currentCommunity.inviteCode
    if (!code) return
    wx.setClipboardData({ data: code })
  }
})
