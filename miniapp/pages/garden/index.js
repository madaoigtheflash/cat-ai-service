const storage = require('../../utils/storage')
const online = require('../../services/online')
const dashboard = require('./dashboard')

const COMMUNITY_KEY = 'catai_mini_online_community_v1'
const CLOUD_REFRESH_INTERVAL_MS = 30 * 1000

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key)
}

function normalizeCommunity(item) {
  const communityId = item && (item.communityId || item.id)
  return Object.assign({}, item, { id: communityId, communityId })
}

Page({
  data: {
    initialLoading: true,
    petNames: [],
    selectedPetIndex: 0,
    pets: [],
    petOptions: [],
    activePet: null,
    activePetId: '',
    hasMorePets: false,
    settings: {},
    greeting: '你好',
    configured: false,
    communities: [],
    communityNames: [],
    selectedCommunityIndex: 0,
    currentCommunity: null,
    cloudSightings: [],
    onlineLoading: false,
    onlineError: '',
    feedbackMessage: '',
    todayCards: [],
    recentActivity: [],
    calmMode: false
  },

  onShow() {
    let calmMode = false
    try { calmMode = wx.getStorageSync('catai_showcase_reduce_motion_v1') === true } catch (_) {}
    if (calmMode !== this.data.calmMode) this.setData({ calmMode })
    const hour = new Date().getHours()
    const greeting = hour < 11 ? '早上好' : hour < 18 ? '下午好' : '晚上好'
    const settings = storage.getSettings()
    const app = getApp()
    const configured = Boolean(wx.cloud && app && app.globalData && app.globalData.cloudReady)
    const savedCommunityId = wx.getStorageSync(COMMUNITY_KEY)
    const knownCommunity = this.data.communities.find(item => item.id === savedCommunityId)
    const currentCommunityId = this.data.currentCommunity && this.data.currentCommunity.id
    const communityChanged = Boolean(savedCommunityId && savedCommunityId !== currentCommunityId)
    this.applyContext({
      pets: storage.listPets(),
      settings,
      greeting,
      configured,
      currentCommunity: knownCommunity || this.data.currentCommunity,
      cloudSightings: knownCommunity && communityChanged ? [] : this.data.cloudSightings
    })
    if (!configured) {
      this.setData({ initialLoading: false })
      return
    }
    const now = Date.now()
    if (communityChanged || !this._lastCloudLoadAt || now - this._lastCloudLoadAt > CLOUD_REFRESH_INTERVAL_MS) {
      this.refreshOnlineContext()
    } else {
      this.setData({ initialLoading: false })
    }
  },

  onPullDownRefresh() {
    const settings = storage.getSettings()
    this.applyContext({ pets: storage.listPets(), settings })
    if (!this.data.configured) {
      wx.stopPullDownRefresh()
      return
    }
    this.refreshOnlineContext(true).finally(() => wx.stopPullDownRefresh())
  },

  onUnload() {
    this._cloudLoadToken = (this._cloudLoadToken || 0) + 1
    clearTimeout(this._feedbackTimer)
  },

  applyContext(patch) {
    const input = patch || {}
    const pets = hasOwn(input, 'pets') ? input.pets : this.data.pets
    const settings = hasOwn(input, 'settings') ? input.settings : this.data.settings
    const communities = hasOwn(input, 'communities') ? input.communities : this.data.communities
    const currentCommunity = hasOwn(input, 'currentCommunity') ? input.currentCommunity : this.data.currentCommunity
    const cloudSightings = hasOwn(input, 'cloudSightings') ? input.cloudSightings : this.data.cloudSightings
    const preferredPetId = hasOwn(input, 'activePetId')
      ? input.activePetId
      : settings.homeSelectedPetId || this.data.activePetId
    const activePet = dashboard.chooseActivePet(pets, preferredPetId)
    const relationships = storage.listRelationships()
    const link = activePet && currentCommunity
      ? storage.getOnlineLink(currentCommunity.id, activePet.id)
      : null
    const syncFingerprint = activePet ? online.petSyncFingerprint(activePet) : ''
    const todayCards = dashboard.buildStatusCards({
      pet: activePet,
      relationships,
      community: currentCommunity,
      link,
      syncFingerprint,
      nowMs: Date.now()
    })
    const recentActivity = dashboard.buildRecentActivity({
      pet: activePet,
      pets,
      relationships,
      sightings: cloudSightings,
      nowMs: Date.now()
    })
    const selectedCommunityIndex = currentCommunity
      ? Math.max(communities.findIndex(item => item.id === currentCommunity.id), 0)
      : 0

    this.setData(Object.assign({}, input, {
      pets,
      petNames: pets.map(item => item.name || '未命名猫咪'),
      selectedPetIndex: Math.max(0, pets.findIndex(item => item.id === (activePet && activePet.id))),
      settings,
      communities,
      communityNames: communities.map(item => item.name || '未命名小屋'),
      selectedCommunityIndex,
      currentCommunity,
      cloudSightings,
      activePet,
      activePetId: activePet ? activePet.id : '',
      petOptions: dashboard.buildPetOptions(pets, activePet && activePet.id),
      hasMorePets: pets.length > 4,
      todayCards,
      recentActivity
    }))
  },

  async refreshOnlineContext(force) {
    if (!this.data.configured) return false
    if (this.data.onlineLoading && !force) return false
    const loadToken = (this._cloudLoadToken || 0) + 1
    this._cloudLoadToken = loadToken
    this.setData({ onlineLoading: true, onlineError: '' })
    try {
      const bootstrap = await online.bootstrap()
      if (loadToken !== this._cloudLoadToken) return false
      const communities = (bootstrap.communities || []).map(normalizeCommunity)
      const savedCommunityId = wx.getStorageSync(COMMUNITY_KEY)
      const currentId = this.data.currentCommunity && this.data.currentCommunity.id
      let selectedCommunityIndex = communities.findIndex(item => item.id === (savedCommunityId || currentId))
      if (selectedCommunityIndex < 0) selectedCommunityIndex = 0
      const currentCommunity = communities[selectedCommunityIndex] || null
      const communityChanged = Boolean(currentCommunity && currentCommunity.id !== currentId)
      const recovery = bootstrap.uploadRecovery || {}
      const feedbackMessage = recovery.found
        ? '已找回上次提交的目击记录'
        : recovery.state === 'PENDING'
          ? '上一条目击仍在确认，请勿重复提交'
          : this.data.feedbackMessage
      this.applyContext({
        communities,
        currentCommunity,
        cloudSightings: currentCommunity && !communityChanged ? this.data.cloudSightings : [],
        feedbackMessage
      })
      if (currentCommunity) {
        wx.setStorageSync(COMMUNITY_KEY, currentCommunity.id)
        await this.loadCommunityWorkspace(currentCommunity.id, loadToken)
      }
      if (loadToken !== this._cloudLoadToken) return false
      this._lastCloudLoadAt = Date.now()
      return true
    } catch (error) {
      if (loadToken !== this._cloudLoadToken) return false
      this.setData({ onlineError: error.message || '小屋动态暂时无法刷新，本地档案不受影响' })
      return false
    } finally {
      if (loadToken === this._cloudLoadToken) this.setData({ onlineLoading: false, initialLoading: false })
    }
  },

  async loadCommunityWorkspace(communityId, loadToken) {
    const workspace = await online.listWorkspace(communityId)
    if (loadToken !== this._cloudLoadToken) return false
    const communities = this.data.communities.slice()
    const workspaceCommunity = normalizeCommunity(workspace.community || {})
    const currentCommunity = Object.assign(
      {},
      communities.find(item => item.id === communityId) || {},
      workspaceCommunity,
      { id: communityId, communityId }
    )
    const communityIndex = communities.findIndex(item => item.id === communityId)
    if (communityIndex >= 0) communities[communityIndex] = currentCommunity
    storage.reconcileOnlineLinks(communityId, workspace.myPets || [])
    const cloudSightings = (workspace.pendingReview || []).concat(workspace.approvedSightings || [])
    this.applyContext({ communities, currentCommunity, cloudSightings })
    return true
  },

  selectPet(event) {
    const activePetId = event.currentTarget.dataset.id
    if (!activePetId || activePetId === this.data.activePetId) return
    const activePet = this.data.pets.find(item => item.id === activePetId)
    storage.saveSettings({ homeSelectedPetId: activePetId })
    this.applyContext({ activePetId, settings: storage.getSettings() })
    this.showFeedback(`已切换到${(activePet && activePet.name) || '这只猫咪'}`)
  },

  onPetChange(event) {
    const pet = this.data.pets[Number(event.detail.value)]
    if (pet) this.selectPet({ currentTarget: { dataset: { id: pet.id } } })
  },

  onCommunityChange(event) {
    const selectedCommunityIndex = Number(event.detail.value) || 0
    const currentCommunity = this.data.communities[selectedCommunityIndex]
    if (!currentCommunity) return
    wx.setStorageSync(COMMUNITY_KEY, currentCommunity.id)
    const loadToken = (this._cloudLoadToken || 0) + 1
    this._cloudLoadToken = loadToken
    this.applyContext({ selectedCommunityIndex, currentCommunity, cloudSightings: [] })
    this.setData({ onlineLoading: true, onlineError: '' })
    this.loadCommunityWorkspace(currentCommunity.id, loadToken)
      .then(() => {
        if (loadToken === this._cloudLoadToken) {
          this._lastCloudLoadAt = Date.now()
          this.showFeedback(`已切换到${currentCommunity.name || '当前小屋'}`)
        }
      })
      .catch(error => {
        if (loadToken === this._cloudLoadToken) {
          this.setData({ onlineError: error.message || '小屋动态暂时无法刷新，本地档案不受影响' })
        }
      })
      .finally(() => {
        if (loadToken === this._cloudLoadToken) this.setData({ onlineLoading: false })
      })
  },

  showFeedback(message) {
    clearTimeout(this._feedbackTimer)
    this.setData({ feedbackMessage: message })
    this._feedbackTimer = setTimeout(() => this.setData({ feedbackMessage: '' }), 2200)
  },

  retryOnline() {
    this.refreshOnlineContext(true)
  },

  handleHeroPet() {
    if (this.data.activePetId) this.openActivePet()
    else this.goIdentify()
  },

  goIdentify() { wx.navigateTo({ url: '/pages/identify/index' }) },
  goPets() { wx.switchTab({ url: '/pages/pets/index' }) },
  goKnowledge() { wx.switchTab({ url: '/pages/social/index' }) },
  goRelationships() {
    const query = this.data.activePetId ? `?id=${encodeURIComponent(this.data.activePetId)}` : ''
    wx.navigateTo({ url: `/pages/relationships/index${query}` })
  },
  goOnline() { wx.navigateTo({ url: '/pages/online/index' }) },
  goCreateHouse() { wx.navigateTo({ url: '/pages/online/index?section=home&mode=create' }) },
  goJoinHouse() { wx.navigateTo({ url: '/pages/online/index?section=home&mode=join' }) },
  goInviteHouse() { wx.navigateTo({ url: '/pages/online/index?section=home&mode=invite' }) },
  goSighting() { wx.navigateTo({ url: '/pages/online/index?section=upload' }) },
  goFeedback() { wx.navigateTo({ url: '/pages/feedback/index' }) },
  goSettings() { wx.navigateTo({ url: '/pages/settings/index' }) },
  openActivePet() {
    if (!this.data.activePetId) {
      this.goIdentify()
      return
    }
    wx.navigateTo({ url: `/pages/pet-detail/index?id=${this.data.activePetId}` })
  },
  goCare() {
    if (this.data.activePetId) this.openActivePet()
    else this.goPets()
  },
  openActivity(event) {
    const kind = event.currentTarget.dataset.kind
    if (kind === 'sighting') this.goOnline()
    else if (kind === 'relationship') this.goRelationships()
    else this.openActivePet()
  },

  goInsights() {
    const community = this.data.currentCommunity
    if (!community) {
      this.goOnline()
      return
    }
    wx.navigateTo({
      url: `/pages/community-insights/index?communityId=${encodeURIComponent(community.id)}&name=${encodeURIComponent(community.name || '')}`
    })
  },

  // 图库详情里的分享按钮经 open-type="share" 触发本方法，按按钮 dataset 定制分享卡。
  onShareAppMessage(event) {
    const dataset = event && event.from === 'button' && event.target && event.target.dataset
      ? event.target.dataset : {}
    if (dataset.shareTitle) {
      return {
        title: String(dataset.shareTitle).slice(0, 30),
        path: '/pages/home/index?from=garden',
        imageUrl: dataset.shareImage || ''
      }
    }
    const count = this.data.pets.length
    return {
      title: count ? `我在猫猫小屋记录了 ${count} 只猫` : '来猫猫小屋一起记录熟悉的猫咪',
      path: '/pages/home/index?from=share'
    }
  },

  onShareTimeline() {
    const count = this.data.pets.length
    return {
      title: count ? `我在猫猫小屋记录了 ${count} 只猫` : '来猫猫小屋一起记录熟悉的猫咪',
      query: 'from=timeline'
    }
  }
})
