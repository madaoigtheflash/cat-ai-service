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
    relationTypes: RELATION_TYPES
  },

  onLoad(options) {
    this.initialPetId = options.id || ''
  },

  onShow() {
    this.loadNetwork(this.data.focusedPetId || this.initialPetId)
  },

  loadNetwork(preferredId) {
    const pets = storage.listPets()
    const relationships = storage.listRelationships()
    const validIds = new Set(pets.map(pet => pet.id))
    const validRelationships = relationships.filter(item => validIds.has(item.petAId) && validIds.has(item.petBId))
    const focusedPet = pets.find(pet => pet.id === preferredId) || pets[0] || null

    if (!focusedPet) {
      this.setData({ pets: [], focusedPetId: '', focusedPet: null, nodes: [], lines: [], relationshipRows: [], relationCount: 0, hiddenPetCount: 0 })
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
      hiddenPetCount: Math.max(0, otherPets.length - visibleOthers.length)
    })
  },

  buildLayout(focusedPet, otherPets, relationshipFor) {
    const centerX = 325
    const centerY = 268
    const radiusX = 226
    const radiusY = 184
    const nodeHalf = 60
    const nodes = [{
      id: focusedPet.id,
      name: focusedPet.name || '未命名猫咪',
      imagePath: focusedPet.imagePath || '',
      x: centerX - nodeHalf,
      y: centerY - nodeHalf,
      current: true,
      relationLabel: '当前焦点',
      className: 'current'
    }]
    const lines = []

    otherPets.forEach((pet, index) => {
      const count = otherPets.length
      const angle = count === 1 ? 0 : (-Math.PI / 2) + (Math.PI * 2 * index / count)
      const petCenterX = centerX + Math.cos(angle) * radiusX
      const petCenterY = centerY + Math.sin(angle) * radiusY
      const relationship = relationshipFor(pet.id)
      const type = relationship ? relationType(relationship.type) : null
      const presentation = relationship
        ? relationshipPresentation(relationship, focusedPet.id, pet.id)
        : null
      nodes.push({
        id: pet.id,
        name: pet.name || '未命名猫咪',
        imagePath: pet.imagePath || '',
        x: Math.round(petCenterX - nodeHalf),
        y: Math.round(petCenterY - nodeHalf),
        current: false,
        relationLabel: presentation ? presentation.roleSummary : '待记录',
        className: type ? type.className : 'unlinked'
      })
      if (relationship) {
        const startOffset = 62
        const endOffset = 62
        const distance = Math.sqrt(Math.pow(petCenterX - centerX, 2) + Math.pow(petCenterY - centerY, 2))
        lines.push({
          id: relationship.id,
          x: Math.round(centerX + Math.cos(angle) * startOffset),
          y: Math.round(centerY + Math.sin(angle) * startOffset),
          width: Math.max(0, Math.round(distance - startOffset - endOffset)),
          angle: Math.round(angle * 180 / Math.PI),
          className: type.className,
          directionClass: presentation.directionClass
        })
      }
    })
    return { nodes, lines }
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
