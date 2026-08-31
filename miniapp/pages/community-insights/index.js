const online = require('../../services/online')

const VOTE_CHOICES = [
  { value: 'bonded', label: '主动亲近', fromRole: '主动亲近方', toRole: '亲近对象', hint: '箭头起点会主动依偎、梳毛或靠近箭头终点' },
  { value: 'playmate', label: '发起玩耍', fromRole: '玩耍发起方', toRole: '玩耍回应方', hint: '箭头起点常发起游戏，终点会回应且互动能自然停下' },
  { value: 'housemate', label: '平静共处', fromRole: '平静共处方', toRole: '共处伙伴', hint: '从箭头起点的观察看，可以与终点共享空间' },
  { value: 'needs_space', label: '需要空间', fromRole: '需要空间方', toRole: '相处对象', hint: '箭头起点会持续回避、哈气或需要与终点分区观察' },
  { value: 'unsure', label: '暂时看不准', fromRole: '观察发起方', toRole: '观察对象', hint: '这个方向的证据还不够，先保留观察，不勉强判断' }
]

const CHOICE_LABELS = VOTE_CHOICES.reduce((output, item) => {
  output[item.value] = item.label
  return output
}, {})

function safeDecode(value) {
  try {
    return decodeURIComponent(value || '')
  } catch (error) {
    return String(value || '')
  }
}

function directionKey(fromCatId, toCatId) {
  return `${String(fromCatId || '')}::${String(toCatId || '')}`
}

function timeBucketLabel(value) {
  const text = String(value || '')
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})/)
  if (!match) return text ? `最近记录：${text}` : '最近时间未记录'
  return `最近记录：${Number(match[2])}月${Number(match[3])}日 ${match[4]}时左右`
}

function normalizeCat(item) {
  return {
    catId: item.catId,
    displayName: item.displayName || '未命名猫咪',
    breed: item.breed || '',
    coatColor: item.coatColor || '',
    isMine: Boolean(item.isMine),
    source: item.source || ''
  }
}

function leadingChoice(counts) {
  const ranked = VOTE_CHOICES.map(choice => ({
    value: choice.value,
    count: Number(counts && counts[choice.value]) || 0
  }))
  const maxCount = Math.max(0, ...ranked.map(item => item.count))
  if (!maxCount) return null
  const leaders = ranked.filter(item => item.count === maxCount)
  return leaders.length === 1
    ? leaders[0]
    : { value: '', count: maxCount, tied: true, values: leaders.map(item => item.value) }
}

function choiceDefinition(value) {
  return VOTE_CHOICES.find(item => item.value === value) || null
}

function roleSentence(value, fromCat, toCat) {
  const choice = choiceDefinition(value)
  if (!choice || !fromCat || !toCat) return ''
  return `${fromCat.displayName}：${choice.fromRole}；${toCat.displayName}：${choice.toRole}`
}

function distributionRows(relationship) {
  const counts = relationship && relationship.voteCounts
  const total = VOTE_CHOICES.reduce((sum, choice) => sum + (Number(counts && counts[choice.value]) || 0), 0)
  return VOTE_CHOICES.map(choice => {
    const count = Number(counts && counts[choice.value]) || 0
    const percent = total ? Math.round(count * 100 / total) : 0
    return Object.assign({}, choice, {
      count,
      percent,
      widthStyle: `width:${percent}%`
    })
  })
}

function normalizeRelationship(item) {
  const expectedDirectionKey = item.fromCat && item.toCat
    ? directionKey(item.fromCat.catId, item.toCat.catId)
    : ''
  const directed = item.relationshipContractId === 'cat-ai.relationship.directed' &&
    Number(item.relationshipContractVersion) === 2 &&
    item.directionState === 'directed' && Number(item.directionVersion) === 2 &&
    item.directionKey === expectedDirectionKey && item.fromCat && item.toCat
  if (!directed) {
    const catA = item.catA || {}
    const catB = item.catB || {}
    return {
      id: item.relationshipId || item.id,
      directionVersion: Number(item.directionVersion) || 1,
      directionState: 'legacy_pending',
      isLegacy: true,
      directionKey: '',
      fromCat: {},
      toCat: {},
      catA: { catId: catA.catId, displayName: catA.displayName || '未命名猫咪' },
      catB: { catId: catB.catId, displayName: catB.displayName || '未命名猫咪' },
      legacyPairLabel: `${catA.displayName || '未命名猫咪'} × ${catB.displayName || '未命名猫咪'}`,
      totalVotes: Number(item.totalVotes) || 0,
      voteCounts: null,
      distributionVisible: false,
      canSeeDistribution: false,
      myChoice: '',
      myChoiceLabel: '',
      leadingLabel: '旧版无向记录 · 方向待重新确认',
      roleSummary: '旧票没有保存原始箭头方向，不能自动转换或复制。',
      updatedAt: item.updatedAt || ''
    }
  }
  const fromCat = item.fromCat || {}
  const toCat = item.toCat || {}
  const relationship = {
    id: item.relationshipId || item.id,
    relationshipContractId: item.relationshipContractId,
    relationshipContractVersion: Number(item.relationshipContractVersion),
    directionVersion: 2,
    directionState: 'directed',
    isLegacy: false,
    directionKey: item.directionKey || directionKey(fromCat.catId, toCat.catId),
    fromCat: { catId: fromCat.catId, displayName: fromCat.displayName || '未命名猫咪' },
    toCat: { catId: toCat.catId, displayName: toCat.displayName || '未命名猫咪' },
    totalVotes: Number(item.totalVotes) || 0,
    voteCounts: item.voteCounts || null,
    distributionVisible: Boolean(item.distributionVisible),
    myChoice: item.myChoice || '',
    updatedAt: item.updatedAt || ''
  }
  relationship.myChoiceLabel = CHOICE_LABELS[relationship.myChoice] || ''
  relationship.canSeeDistribution = Boolean(relationship.distributionVisible && relationship.myChoice)
  const leading = relationship.canSeeDistribution ? leadingChoice(relationship.voteCounts) : null
  relationship.leadingLabel = leading && leading.tied
    ? `意见并列 · 各 ${leading.count} 票`
    : leading
      ? `${CHOICE_LABELS[leading.value]} · ${leading.count} 票`
    : relationship.canSeeDistribution ? '还没有有效投票' : '先投票，再查看这个方向的分布'
  relationship.roleSummary = leading && leading.tied
    ? '当前没有单一主导观察，请继续分别记录双方的互动线索。'
    : leading
    ? roleSentence(leading.value, relationship.fromCat, relationship.toCat)
    : roleSentence(relationship.myChoice, relationship.fromCat, relationship.toCat)
  return relationship
}

function mapFillColor(count) {
  if (count >= 8) return '#FF6F917A'
  if (count >= 4) return '#FF6F915C'
  if (count >= 2) return '#FF91AA4D'
  return '#FFD4DF66'
}

function normalizeMapCell(item) {
  const sightingCount = Number(item.sightingCount) || 0
  const catCount = Number(item.catCount) || 0
  const precisionKm = Number(item.precisionKm) || 2
  const catNames = Array.isArray(item.catNames) ? item.catNames.filter(Boolean) : []
  return {
    id: item.cellId,
    cellId: item.cellId,
    longitude: Number(item.longitude),
    latitude: Number(item.latitude),
    precisionKm,
    areaText: item.areaText || '未命名粗略区域',
    sightingCount,
    catCount,
    catNamesText: catNames.length ? catNames.join('、') : '身份仍在确认中',
    latestLabel: timeBucketLabel(item.latestTimeBucket),
    intensity: sightingCount >= 8 ? 'high' : sightingCount >= 4 ? 'medium' : sightingCount >= 2 ? 'low' : 'light'
  }
}

function buildMap(mapCells) {
  const validCells = mapCells.filter(item => Number.isFinite(item.longitude) && Number.isFinite(item.latitude))
  if (!validCells.length) {
    return {
      hasMap: false,
      mapLatitude: 39.9,
      mapLongitude: 116.4,
      mapPoints: [],
      mapCircles: []
    }
  }
  const latitude = validCells.reduce((sum, item) => sum + item.latitude, 0) / validCells.length
  const longitude = validCells.reduce((sum, item) => sum + item.longitude, 0) / validCells.length
  return {
    hasMap: true,
    mapLatitude: latitude,
    mapLongitude: longitude,
    mapPoints: validCells.map(item => ({ latitude: item.latitude, longitude: item.longitude })),
    mapCircles: validCells.map(item => ({
      latitude: item.latitude,
      longitude: item.longitude,
      radius: Math.max(650, Math.min(2400, item.precisionKm * 500)),
      color: '#D94F7599',
      fillColor: mapFillColor(item.sightingCount),
      strokeWidth: 1
    }))
  }
}

Page({
  data: {
    loading: true,
    actionLoading: '',
    errorMessage: '',
    feedbackMessage: '',
    communityId: '',
    communityName: '猫友小屋',
    cats: [],
    catNames: [],
    catAIndex: 0,
    catBIndex: 1,
    pairInvalid: true,
    directionReady: false,
    voteChoices: VOTE_CHOICES,
    selectedChoice: '',
    selectedRelationship: null,
    selectedPairLabel: '',
    selectedRoleSummary: '',
    distributionRows: [],
    relationships: [],
    catsTruncated: false,
    relationshipTruncated: false,
    mapCells: [],
    mapTruncated: false,
    hasMap: false,
    mapLatitude: 39.9,
    mapLongitude: 116.4,
    mapPoints: [],
    mapCircles: []
  },

  onLoad(options) {
    const communityId = safeDecode(options.communityId)
    const communityName = safeDecode(options.name) || '猫友小屋'
    this.setData({ communityId, communityName })
    wx.setNavigationBarTitle({ title: '小屋关系与地图' })
    if (!communityId) {
      this.setData({ loading: false, errorMessage: '缺少小屋信息，请从“猫友小屋”重新进入。' })
      return
    }
    this.loadInsights()
  },

  onPullDownRefresh() {
    this.loadInsights(true).finally(() => wx.stopPullDownRefresh())
  },

  async loadInsights(fromRefresh) {
    this.setData({ loading: !fromRefresh, errorMessage: '' })
    try {
      const result = await online.listCommunityInsights(this.data.communityId)
      this.applyInsights(result)
    } catch (error) {
      this.setData({ errorMessage: error.message || '暂时无法读取小屋关系与地图' })
    } finally {
      this.setData({ loading: false })
    }
  },

  applyInsights(result) {
    const previousA = this.data.cats[this.data.catAIndex]
    const previousB = this.data.cats[this.data.catBIndex]
    const cats = (result.cats || []).map(normalizeCat).sort((left, right) => {
      const mineOrder = Number(right.isMine) - Number(left.isMine)
      return mineOrder || left.displayName.localeCompare(right.displayName, 'zh-CN')
    })
    const relationships = (result.relationships || []).map(normalizeRelationship)
    const mapCells = (result.mapCells || []).map(normalizeMapCell)
    const map = buildMap(mapCells)
    let catAIndex = Math.max(0, cats.findIndex(item => previousA && item.catId === previousA.catId))
    let catBIndex = Math.max(0, cats.findIndex(item => previousB && item.catId === previousB.catId))
    if (!previousA) catAIndex = 0
    if (!previousB) catBIndex = cats.length > 1 ? 1 : 0
    if (cats.length > 1 && catAIndex === catBIndex) catBIndex = catAIndex === 0 ? 1 : 0
    this.setData(Object.assign({
      cats,
      catNames: cats.map(item => item.displayName),
      catAIndex,
      catBIndex,
      relationships,
      mapCells,
      directionReady: result.policy && result.policy.relationshipContractId === 'cat-ai.relationship.directed' &&
        Number(result.policy && result.policy.relationshipContractVersion) === 2 &&
        Number(result.policy && result.policy.relationshipDirectionVersion) === 2 &&
        result.policy && result.policy.relationshipEdgeUniqueness === 'communityId+directionKey',
      catsTruncated: Boolean(result.policy && result.policy.catsTruncated),
      relationshipTruncated: Boolean(result.policy && result.policy.relationshipTruncated),
      mapTruncated: Boolean(result.policy && result.policy.mapTruncated)
    }, map), () => this.refreshSelectedPair())
  },

  onCatAChange(event) {
    this.setData({ catAIndex: Number(event.detail.value) || 0 }, () => this.refreshSelectedPair())
  },

  onCatBChange(event) {
    this.setData({ catBIndex: Number(event.detail.value) || 0 }, () => this.refreshSelectedPair())
  },

  selectRelationship(event) {
    if (event.currentTarget.dataset.state !== 'directed') {
      wx.showToast({ title: '旧关系需要重新选择方向', icon: 'none' })
      return
    }
    const fromCatId = event.currentTarget.dataset.from
    const toCatId = event.currentTarget.dataset.to
    const catAIndex = this.data.cats.findIndex(item => item.catId === fromCatId)
    const catBIndex = this.data.cats.findIndex(item => item.catId === toCatId)
    if (catAIndex < 0 || catBIndex < 0) return
    this.setData({ catAIndex, catBIndex }, () => this.refreshSelectedPair())
  },

  refreshSelectedPair() {
    const catA = this.data.cats[this.data.catAIndex]
    const catB = this.data.cats[this.data.catBIndex]
    const pairInvalid = !catA || !catB || catA.catId === catB.catId
    const selectedRelationship = pairInvalid
      ? null
      : this.data.relationships.find(item =>
        item.directionState === 'directed' && item.directionKey === directionKey(catA.catId, catB.catId)
      ) || null
    const selectedChoice = selectedRelationship ? selectedRelationship.myChoice : ''
    this.setData({
      pairInvalid,
      selectedRelationship,
      selectedPairLabel: pairInvalid ? '' : `${catA.displayName} → ${catB.displayName}`,
      selectedChoice,
      selectedRoleSummary: pairInvalid ? '' : roleSentence(selectedChoice, catA, catB),
      distributionRows: selectedRelationship && selectedRelationship.canSeeDistribution
        ? distributionRows(selectedRelationship)
        : []
    })
  },

  selectChoice(event) {
    if (this.data.actionLoading) return
    if (!this.data.directionReady) {
      wx.showToast({ title: '云端有向关系尚未启用', icon: 'none' })
      return
    }
    const selectedChoice = event.currentTarget.dataset.value || ''
    const fromCat = this.data.cats[this.data.catAIndex]
    const toCat = this.data.cats[this.data.catBIndex]
    this.setData({
      selectedChoice,
      selectedRoleSummary: roleSentence(selectedChoice, fromCat, toCat)
    })
  },

  castVote() {
    if (!this.data.directionReady) {
      wx.showToast({ title: '云端有向关系尚未启用', icon: 'none' })
      return
    }
    const fromCat = this.data.cats[this.data.catAIndex]
    const toCat = this.data.cats[this.data.catBIndex]
    const choice = this.data.selectedChoice
    if (!fromCat || !toCat || fromCat.catId === toCat.catId) {
      wx.showToast({ title: '请选择两只不同的猫咪', icon: 'none' })
      return
    }
    if (!choice) {
      wx.showToast({ title: '请先选择一种观察', icon: 'none' })
      return
    }
    wx.showModal({
      title: `记录为“${CHOICE_LABELS[choice]}”？`,
      content: '请依据持续、亲眼观察到的互动判断。单次同框或外貌相似不能证明长期关系或亲缘。',
      confirmText: '提交观察',
      confirmColor: '#FF6F91',
      success: result => {
        if (result.confirm) this.submitVote(fromCat, toCat, choice)
      }
    })
  },

  async submitVote(fromCat, toCat, choice) {
    this.setData({ actionLoading: 'vote', errorMessage: '', feedbackMessage: '' })
    try {
      const result = await online.castRelationshipVote({
        communityId: this.data.communityId,
        fromCatId: fromCat.catId,
        toCatId: toCat.catId,
        choice,
        evidenceSightingIds: []
      })
      const saved = normalizeRelationship(result.relationship || result)
      const relationships = this.data.relationships.slice()
      const index = relationships.findIndex(item => item.id === saved.id ||
        (item.directionState === 'directed' && item.directionKey === saved.directionKey))
      if (index >= 0) relationships[index] = saved
      else relationships.unshift(saved)
      this.setData({
        relationships,
        feedbackMessage: '这次观察已保存，现在可以查看小屋投票分布。'
      }, () => this.refreshSelectedPair())
    } catch (error) {
      this.setData({ errorMessage: error.message || '投票保存失败，请稍后重试' })
    } finally {
      this.setData({ actionLoading: '' })
    }
  }
})
