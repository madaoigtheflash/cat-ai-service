const storage = require('../../utils/storage')

const RELATION_TYPES = [
  { value: 'bonded', label: '贴贴搭子', shortLabel: '贴贴', className: 'bond', hint: '经常依偎、互相梳毛或主动靠近' },
  { value: 'playmate', label: '玩耍伙伴', shortLabel: '玩伴', className: 'play', hint: '会相互追逐、邀请游戏并能自然停下' },
  { value: 'housemate', label: '平静同住', shortLabel: '同住', className: 'home', hint: '可以共享空间，日常相处整体平稳' },
  { value: 'acquainting', label: '熟悉中', shortLabel: '熟悉中', className: 'grow', hint: '仍在适应彼此，需要循序渐进地接触' },
  { value: 'needs_space', label: '需要空间', shortLabel: '需空间', className: 'space', hint: '出现持续回避、哈气或资源冲突，应分区观察' },
  { value: 'family', label: '亲缘关系', shortLabel: '亲缘', className: 'family', hint: '仅记录主人已经确认的亲子关系' },
  { value: 'caregiver', label: '照护关系', shortLabel: '照护', className: 'care', hint: '一方持续照料、保护或带领另一方' }
]

const ROLE_LABELS = {
  friend: '朋友',
  playmate: '玩伴',
  housemate: '室友',
  observing: '观察中伙伴',
  mother: '母亲',
  father: '父亲',
  child: '孩子',
  older_littermate: '年长同窝',
  younger_littermate: '年幼同窝',
  caregiver: '照护者',
  cared_for: '被照护',
  needs_space: '需要空间',
  legacy_direction_pending: '身份待确认'
}

const ROLE_PROFILES = [
  { value: 'friends', label: '朋友 ↔ 朋友', type: 'bonded', fromRole: 'friend', toRole: 'friend', directionMode: 'mutual' },
  { value: 'playmates', label: '玩伴 ↔ 玩伴', type: 'playmate', fromRole: 'playmate', toRole: 'playmate', directionMode: 'mutual' },
  { value: 'housemates', label: '室友 ↔ 室友', type: 'housemate', fromRole: 'housemate', toRole: 'housemate', directionMode: 'mutual' },
  { value: 'observing', label: '观察伙伴 ↔ 观察伙伴', type: 'acquainting', fromRole: 'observing', toRole: 'observing', directionMode: 'mutual' },
  { value: 'mother_child', label: '母亲 → 孩子', type: 'family', fromRole: 'mother', toRole: 'child', directionMode: 'directed' },
  { value: 'father_child', label: '父亲 → 孩子', type: 'family', fromRole: 'father', toRole: 'child', directionMode: 'directed' },
  { value: 'older_younger_littermate', label: '年长同窝 → 年幼同窝', type: 'family', fromRole: 'older_littermate', toRole: 'younger_littermate', directionMode: 'directed' },
  { value: 'caregiver_cared_for', label: '照护者 → 被照护', type: 'caregiver', fromRole: 'caregiver', toRole: 'cared_for', directionMode: 'directed' },
  { value: 'needs_space', label: '需要空间 ↔ 需要空间', type: 'needs_space', fromRole: 'needs_space', toRole: 'needs_space', directionMode: 'mutual' }
]

const STAGE_WIDTH = 650
const NODE_WIDTH = 176
const NODE_CENTER_OFFSET = NODE_WIDTH / 2
const NODE_AVATAR_CENTER_Y = 52
const NODE_AVATAR_RADIUS = 58
const STAGE_TOP_PADDING = 30
const STAGE_BOTTOM_PADDING = 30
const NODE_ROW_GAP = 52
const NODE_COLUMN_X = Object.freeze({ left: 14, center: 237, right: 460 })

function textUnits(value) {
  return Array.from(String(value || '')).reduce((total, character) => {
    return total + (/^[\u0000-\u00ff]$/.test(character) ? 0.58 : 1)
  }, 0)
}

function estimatedNodeHeight(name, relationLabel) {
  // The estimate intentionally leaves room for the WeChat large-font setting.
  // Absolute children do not contribute to their parent's height, so the stage
  // uses this conservative value to keep complete labels inside its bounds.
  const nameLines = Math.max(1, Math.ceil(textUnits(name) / 5.5))
  const relationLines = Math.max(1, Math.ceil(textUnits(relationLabel) / 5.5))
  return 126 + nameLines * 42 + relationLines * 41
}

function slotPlan(otherCount) {
  if (otherCount <= 0) {
    return { focus: { row: 0, column: 'center' }, others: [] }
  }
  if (otherCount === 1) {
    return {
      focus: { row: 0, column: 'left' },
      others: [{ row: 0, column: 'right' }]
    }
  }
  if (otherCount === 2) {
    return {
      focus: { row: 0, column: 'center' },
      others: [{ row: 1, column: 'left' }, { row: 1, column: 'right' }]
    }
  }
  if (otherCount === 3) {
    return {
      focus: { row: 1, column: 'center' },
      others: [
        { row: 0, column: 'center' },
        { row: 1, column: 'left' },
        { row: 1, column: 'right' }
      ]
    }
  }
  if (otherCount === 4) {
    return {
      focus: { row: 1, column: 'center' },
      others: [
        { row: 0, column: 'left' },
        { row: 0, column: 'right' },
        { row: 2, column: 'left' },
        { row: 2, column: 'right' }
      ]
    }
  }
  if (otherCount === 5) {
    return {
      focus: { row: 1, column: 'center' },
      others: [
        { row: 0, column: 'left' },
        { row: 0, column: 'right' },
        { row: 1, column: 'left' },
        { row: 1, column: 'right' },
        { row: 2, column: 'center' }
      ]
    }
  }
  return {
    focus: { row: 1, column: 'center' },
    others: [
      { row: 0, column: 'left' },
      { row: 0, column: 'right' },
      { row: 1, column: 'left' },
      { row: 1, column: 'right' },
      { row: 2, column: 'left' },
      { row: 2, column: 'right' }
    ]
  }
}

const RELATION_ACTIONS = [
  { label: '朋友 ↔ 朋友', profile: 'friends' },
  { label: '玩伴 ↔ 玩伴', profile: 'playmates' },
  { label: '室友 ↔ 室友', profile: 'housemates' },
  { label: '亲缘身份（选择方向）', group: 'family' },
  { label: '照护者 → 被照护', profile: 'caregiver_cared_for' },
  { label: '熟悉中 / 需要空间', group: 'observation' }
]

function roleProfile(value) {
  return ROLE_PROFILES.find(item => item.value === value) || null
}

function relationType(value) {
  return RELATION_TYPES.find(item => item.value === value) || RELATION_TYPES[2]
}

function roleLabel(value) {
  return ROLE_LABELS[value] || '身份待确认'
}

function relationshipPresentation(relationship, sourcePetId, targetPetId) {
  const type = relationType(relationship && relationship.type)
  const roles = relationship && storage.relationshipRoles(relationship, sourcePetId, targetPetId)
  const isLegacy = !roles || roles.directionStatus === 'legacy_direction_pending'
  if (isLegacy) {
    return {
      type,
      isLegacy: true,
      sourceRoleLabel: '身份待确认',
      targetRoleLabel: '身份待确认',
      arrow: '?',
      roleSummary: '旧版无方向记录 · 待确认双方身份',
      directionClass: 'legacy'
    }
  }
  const sourceRoleLabel = roleLabel(roles.sourceRole)
  const targetRoleLabel = roleLabel(roles.targetRole)
  return {
    type,
    isLegacy: false,
    sourceRoleLabel,
    targetRoleLabel,
    arrow: roles.arrow,
    roleSummary: `${sourceRoleLabel} ${roles.arrow} ${targetRoleLabel}`,
    directionClass: roles.directionClass
  }
}

Page({
  data: {
    pets: [],
    focusedPetId: '',
    focusedPet: null,
    nodes: [],
    lines: [],
    relationshipRows: [],
    relationCount: 0,
    hiddenPetCount: 0,
    stageHeight: 300,
    relationTypes: RELATION_TYPES
  },

  onLoad(options) {
    this.initialPetId = options.id || ''
  },

  onShow() {
    this.loadNetwork(this.data.focusedPetId || this.initialPetId)
  },

  onPullDownRefresh() {
    this.loadNetwork(this.data.focusedPetId || this.initialPetId)
    wx.stopPullDownRefresh()
  },

  onShareAppMessage() {
    const focused = this.data.focusedPet
    return {
      title: focused ? `${focused.name || '这只猫'} 的猫际关系网` : '记录猫咪之间的相处关系',
      path: `/pages/relationships/index${this.data.focusedPetId ? `?id=${this.data.focusedPetId}` : ''}`
    }
  },

  onShareTimeline() {
    const focused = this.data.focusedPet
    return {
      title: focused ? `${focused.name || '这只猫'} 的猫际关系网` : '记录猫咪之间的相处关系',
      query: this.data.focusedPetId ? `id=${this.data.focusedPetId}` : ''
    }
  },

  loadNetwork(preferredId) {
    const pets = storage.listPets()
    const relationships = storage.listRelationships()
    const validIds = new Set(pets.map(pet => pet.id))
    const validRelationships = relationships.filter(item => validIds.has(item.petAId) && validIds.has(item.petBId))
    const focusedPet = pets.find(pet => pet.id === preferredId) || pets[0] || null

    if (!focusedPet) {
      this.setData({ pets: [], focusedPetId: '', focusedPet: null, nodes: [], lines: [], relationshipRows: [], relationCount: 0, hiddenPetCount: 0, stageHeight: 300 })
      return
    }

    const relationshipFor = petId => validRelationships.find(item =>
      (item.petAId === focusedPet.id && item.petBId === petId) ||
      (item.petBId === focusedPet.id && item.petAId === petId)
    ) || null

    const otherPets = pets
      .filter(pet => pet.id !== focusedPet.id)
      .sort((left, right) => Number(Boolean(relationshipFor(right.id))) - Number(Boolean(relationshipFor(left.id))))
    const visibleOthers = otherPets.slice(0, 6)
    const layout = this.buildLayout(focusedPet, visibleOthers, relationshipFor)
    const relationshipRows = otherPets.map(pet => {
      const relationship = relationshipFor(pet.id)
      const type = relationship ? relationType(relationship.type) : null
      const presentation = relationship
        ? relationshipPresentation(relationship, focusedPet.id, pet.id)
        : null
      return {
        petId: pet.id,
        pet,
        relationship,
        typeLabel: presentation ? presentation.type.label : '待记录',
        typeHint: type ? type.hint : '记录你亲眼观察到的相处线索',
        displayNote: relationship && relationship.note ? relationship.note : (type ? type.hint : '记录你亲眼观察到的相处线索'),
        className: type ? type.className : 'unlinked',
        isLegacy: Boolean(presentation && presentation.isLegacy),
        sourceRoleLabel: presentation ? presentation.sourceRoleLabel : '',
        targetRoleLabel: presentation ? presentation.targetRoleLabel : '',
        arrow: presentation ? presentation.arrow : '',
        roleSummary: presentation ? presentation.roleSummary : '尚未建立身份关系'
      }
    })

    this.setData({
      pets,
      focusedPetId: focusedPet.id,
      focusedPet,
      nodes: layout.nodes,
      lines: layout.lines,
      relationshipRows,
      relationCount: validRelationships.length,
      hiddenPetCount: Math.max(0, otherPets.length - visibleOthers.length),
      stageHeight: layout.stageHeight
    })
  },

  buildLayout(focusedPet, otherPets, relationshipFor) {
    const plan = slotPlan(otherPets.length)
    const focusName = focusedPet.name || '未命名猫咪'
    const nodeDescriptors = [{
      id: focusedPet.id,
      name: focusName,
      imagePath: focusedPet.imagePath || '',
      current: true,
      relationLabel: '当前焦点',
      className: 'current',
      accessibilityLabel: `当前焦点，${focusName}`,
      slot: plan.focus,
      visualHeight: estimatedNodeHeight(focusName, '当前焦点')
    }]

    otherPets.forEach((pet, index) => {
      const relationship = relationshipFor(pet.id)
      const type = relationship ? relationType(relationship.type) : null
      const presentation = relationship
        ? relationshipPresentation(relationship, focusedPet.id, pet.id)
        : null
      const name = pet.name || '未命名猫咪'
      const relationLabel = presentation ? presentation.roleSummary : '待记录'
      nodeDescriptors.push({
        id: pet.id,
        name,
        imagePath: pet.imagePath || '',
        current: false,
        relationLabel,
        className: type ? type.className : 'unlinked',
        accessibilityLabel: `${name}，${relationLabel}，点击切换视角`,
        slot: plan.others[index],
        visualHeight: estimatedNodeHeight(name, relationLabel),
        line: relationship ? {
          id: relationship.id,
          className: type.className,
          directionClass: presentation.directionClass
        } : null
      })
    })

    const rowHeights = []
    nodeDescriptors.forEach(node => {
      const row = node.slot.row
      rowHeights[row] = Math.max(rowHeights[row] || 0, node.visualHeight)
    })
    const rowTops = []
    let cursorY = STAGE_TOP_PADDING
    rowHeights.forEach((height, row) => {
      rowTops[row] = cursorY
      cursorY += height + NODE_ROW_GAP
    })
    const stageHeight = Math.max(300, cursorY - NODE_ROW_GAP + STAGE_BOTTOM_PADDING)
    const nodes = nodeDescriptors.map(node => Object.assign({}, node, {
      x: NODE_COLUMN_X[node.slot.column],
      y: rowTops[node.slot.row]
    }))
    const focusNode = nodes[0]
    const focusCenterX = focusNode.x + NODE_CENTER_OFFSET
    const focusCenterY = focusNode.y + NODE_AVATAR_CENTER_Y
    const lines = nodes.slice(1).filter(node => node.line).map(node => {
      const targetCenterX = node.x + NODE_CENTER_OFFSET
      const targetCenterY = node.y + NODE_AVATAR_CENTER_Y
      const deltaX = targetCenterX - focusCenterX
      const deltaY = targetCenterY - focusCenterY
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY)
      const unitX = distance ? deltaX / distance : 0
      const unitY = distance ? deltaY / distance : 0
      return {
        id: node.line.id,
        x: Math.round(focusCenterX + unitX * NODE_AVATAR_RADIUS),
        y: Math.round(focusCenterY + unitY * NODE_AVATAR_RADIUS),
        width: Math.max(0, Math.round(distance - NODE_AVATAR_RADIUS * 2)),
        angle: Math.round(Math.atan2(deltaY, deltaX) * 180 / Math.PI),
        className: node.line.className,
        directionClass: node.line.directionClass
      }
    })
    const cleanNodes = nodes.map(node => {
      const cleanNode = Object.assign({}, node)
      delete cleanNode.line
      delete cleanNode.slot
      return cleanNode
    })
    return { stageWidth: STAGE_WIDTH, stageHeight, nodes: cleanNodes, lines }
  },

  selectNode(event) {
    const id = event.currentTarget.dataset.id
    if (id && id !== this.data.focusedPetId) this.loadNetwork(id)
  },

  addPet() {
    wx.navigateTo({ url: '/pages/pet-edit/index' })
  },

  editRelationship(event) {
    const targetId = event.currentTarget.dataset.id
    const targetPet = this.data.pets.find(pet => pet.id === targetId)
    const current = storage.getRelationship(this.data.focusedPetId, targetId)
    if (!targetPet || !this.data.focusedPet) return

    wx.showActionSheet({
      itemList: RELATION_ACTIONS.map(item => item.label),
      success: ({ tapIndex }) => {
        const action = RELATION_ACTIONS[tapIndex]
        if (!action) return
        if (action.group === 'family') {
          this.chooseFamilyProfile(targetPet, current)
          return
        }
        if (action.group === 'observation') {
          this.chooseObservationProfile(targetPet, current)
          return
        }
        const selected = roleProfile(action.profile)
        if (selected.directionMode === 'directed') {
          const focusedName = String(this.data.focusedPet.name || '当前猫咪').slice(0, 10)
          const targetName = String(targetPet.name || '伙伴猫咪').slice(0, 10)
          wx.showActionSheet({
            itemList: [
              `${focusedName}是${roleLabel(selected.fromRole)}，${targetName}是${roleLabel(selected.toRole)}`,
              `${targetName}是${roleLabel(selected.fromRole)}，${focusedName}是${roleLabel(selected.toRole)}`
            ],
            success: result => this.confirmRelationshipProfile(selected, targetPet, current, result.tapIndex === 1)
          })
          return
        }
        this.confirmRelationshipProfile(selected, targetPet, current, false)
      }
    })
  },

  chooseObservationProfile(targetPet, current) {
    const choices = [roleProfile('observing'), roleProfile('needs_space')]
    wx.showActionSheet({
      itemList: choices.map(item => item.label),
      success: result => {
        const selected = choices[result.tapIndex]
        if (selected) this.confirmRelationshipProfile(selected, targetPet, current, false)
      }
    })
  },

  chooseFamilyProfile(targetPet, current) {
    const focusedPet = this.data.focusedPet
    const focusedName = String(focusedPet.name || '当前猫咪').slice(0, 8)
    const targetName = String(targetPet.name || '伙伴猫咪').slice(0, 8)
    const choices = [
      { profile: roleProfile('mother_child'), reversed: false },
      { profile: roleProfile('mother_child'), reversed: true },
      { profile: roleProfile('father_child'), reversed: false },
      { profile: roleProfile('father_child'), reversed: true },
      { profile: roleProfile('older_younger_littermate'), reversed: false },
      { profile: roleProfile('older_younger_littermate'), reversed: true }
    ]
    wx.showActionSheet({
      itemList: choices.map(item => {
        const fromName = item.reversed ? targetName : focusedName
        const toName = item.reversed ? focusedName : targetName
        return `${fromName}是${roleLabel(item.profile.fromRole)}，${toName}是${roleLabel(item.profile.toRole)}`
      }),
      success: result => {
        const selected = choices[result.tapIndex]
        if (selected) this.confirmRelationshipProfile(selected.profile, targetPet, current, selected.reversed)
      }
    })
  },

  confirmRelationshipProfile(profile, targetPet, current, reversed) {
    const focusedPet = this.data.focusedPet
    const fromPet = reversed ? targetPet : focusedPet
    const toPet = reversed ? focusedPet : targetPet
    const title = profile.directionMode === 'mutual'
      ? `${focusedPet.name} ↔ ${targetPet.name}`
      : `${fromPet.name}（${roleLabel(profile.fromRole)}）→ ${toPet.name}（${roleLabel(profile.toRole)}）`
    wx.showModal({
      title,
      content: current ? current.note : '',
      editable: true,
      placeholderText: '可选：记录你观察到的具体行为',
      confirmText: '保存身份',
      confirmColor: '#FF6F91',
      success: ({ confirm, content }) => {
        if (!confirm) return
        storage.saveRelationship({
          petAId: focusedPet.id,
          petBId: targetPet.id,
          type: profile.type,
          roleProfile: profile.value,
          directionMode: profile.directionMode,
          fromPetId: fromPet.id,
          toPetId: toPet.id,
          fromRole: profile.fromRole,
          toRole: profile.toRole,
          note: content || ''
        })
        this.loadNetwork(focusedPet.id)
        wx.showToast({ title: '双方身份已保存', icon: 'success' })
      }
    })
  },

  deleteRelationship(event) {
    const targetId = event.currentTarget.dataset.id
    const targetPet = this.data.pets.find(pet => pet.id === targetId)
    wx.showModal({
      title: '移除这条关系？',
      content: `只会移除与${targetPet ? targetPet.name : '这只猫'}的关系记录，不会删除猫咪档案。`,
      confirmText: '移除',
      confirmColor: '#B94955',
      success: ({ confirm }) => {
        if (!confirm) return
        storage.removeRelationship(this.data.focusedPetId, targetId)
        this.loadNetwork(this.data.focusedPetId)
      }
    })
  }
})
