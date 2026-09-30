// 「我的」页：聚合个人资产（猫咪档案 / 喜欢的猫片 / 我的目击提交）与设置入口。
// 本地档案即时展示；云端计数（喜欢、目击审核状态）失败时降级为占位，不伪造数字。
const storage = require('../../utils/storage')
const online = require('../../services/online')
const showcase = require('../../services/showcase')

function sightingStatusLabel(status) {
  return {
    pending_review: '等待小屋管理员确认',
    approved: '已在小屋中可见',
    rejected: '未通过确认',
    processing: '正在处理'
  }[status] || '状态待更新'
}

function observedLabel(value) {
  const text = String(value || '')
  if (!text) return '时间未填写'
  const match = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})/)
  return match ? `${match[1]} · ${match[2]}:00 左右` : text
}

function normalizeMineSighting(item) {
  const status = String(item.state || item.status || '').toLowerCase()
  const cat = item.cat || {}
  const coarseLocation = item.coarseLocation || {}
  return {
    id: item.sightingId || item.id,
    status,
    statusLabel: sightingStatusLabel(status),
    catName: cat.displayName || item.catName || '身份待确认的猫咪',
    areaText: coarseLocation.areaText || item.areaText || '',
    observedLabel: observedLabel(item.observedTimeBucket || item.observedAt)
  }
}

Page({
  data: {
    loading: true,
    errorMessage: '',
    petCount: 0,
    avatars: [],
    communityCount: 0,
    favoriteCount: -1,
    sightingTotal: 0,
    sightingPending: 0,
    recentSightings: []
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 })
    }
    const pets = storage.listPets()
    this.setData({
      petCount: pets.length,
      avatars: pets.filter(pet => pet.imagePath).slice(0, 3).map(pet => pet.imagePath)
    })
    this.loadCloud()
  },

  onPullDownRefresh() {
    const pets = storage.listPets()
    this.setData({
      petCount: pets.length,
      avatars: pets.filter(pet => pet.imagePath).slice(0, 3).map(pet => pet.imagePath)
    })
    this.loadCloud().finally(() => wx.stopPullDownRefresh())
  },

  async loadCloud() {
    const app = getApp()
    if (!app.globalData.cloudReady) {
      this.setData({ loading: false, errorMessage: '当前微信版本不支持云开发，云端计数暂不可用。' })
      return
    }
    this.setData({ loading: true, errorMessage: '' })
    const [showcaseResult, bootstrapResult] = await Promise.allSettled([
      showcase.refresh(),
      online.bootstrap()
    ])

    const patch = { loading: false }
    if (showcaseResult.status === 'fulfilled') {
      patch.favoriteCount = showcaseResult.value.filter(asset => asset.liked).length
    } else {
      patch.favoriteCount = -1
    }

    if (bootstrapResult.status === 'fulfilled') {
      const communities = bootstrapResult.value.communities || []
      patch.communityCount = communities.length
      const workspaceResults = await Promise.allSettled(
        communities.slice(0, 5).map(item => online.listWorkspace(item.communityId || item.id))
      )
      const mine = []
      for (const result of workspaceResults) {
        if (result.status !== 'fulfilled') continue
        const workspace = result.value || {}
        const sightings = (workspace.pendingReview || []).concat(workspace.approvedSightings || [])
        for (const item of sightings) {
          if (item && item.isMine) mine.push(normalizeMineSighting(item))
        }
      }
      patch.sightingTotal = mine.length
      patch.sightingPending = mine.filter(item => item.status === 'pending_review').length
      patch.recentSightings = mine.slice(0, 3)
    } else {
      patch.errorMessage = '云端暂时不可用，喜欢的猫片和我的目击计数稍后下拉重试。'
    }
    this.setData(patch)
  },

  goPets() { wx.switchTab({ url: '/pages/pets/index' }) },
  goOwnData() { wx.navigateTo({ url: '/pages/companion-data/index' }) },
  goGarden() { wx.navigateTo({ url: '/pages/garden/index' }) },
  goSocial() { wx.switchTab({ url: '/pages/social/index' }) },
  goOnline() { wx.navigateTo({ url: '/pages/online/index' }) },
  goFeedback() { wx.navigateTo({ url: '/pages/feedback/index' }) },
  goSettings() { wx.navigateTo({ url: '/pages/settings/index' }) },
  retry() { this.loadCloud() },

  openPrivacy() {
    wx.showModal({
      title: '隐私说明',
      content: '档案、健康记录、对话、未发送文字和登记草稿保存在本机；本机地点仅保存约 2 公里粗位置，不自动同步。小桃使用本地规则回应，本版本不开放云端文字对话。照片只在你主动点击观察或确认分享时上传。广场仅提交你确认的故事、所选照片和基础猫咪名片；审核通过后公开，评论也会公开。小屋目击须另行提交，审核后仅成员可见模糊热区，不自动进入广场。喜欢、反馈按原有用途处理。地图不会自动或持续定位；主动选点可跳过。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#FF6F91'
    })
  },

  onShareAppMessage() {
    const count = this.data.petCount
    return {
      title: count ? `我在猫猫小屋记录了 ${count} 只猫` : '来猫猫小屋一起记录熟悉的猫咪',
      path: '/pages/home/index?from=share'
    }
  }
})
