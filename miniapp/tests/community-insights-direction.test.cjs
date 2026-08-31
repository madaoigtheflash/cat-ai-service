const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const PAGE_PATH = path.join(__dirname, '..', 'pages', 'community-insights', 'index.js')

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function makePage() {
  let definition
  let toastTitle = ''
  let submitted
  const online = {
    listCommunityInsights: async () => ({}),
    castRelationshipVote: async payload => {
      submitted = clone(payload)
      return {
        relationship: {
          relationshipId: 'drel_saved',
          relationshipContractId: 'cat-ai.relationship.directed',
          relationshipContractVersion: 2,
          directionVersion: 2,
          directionState: 'directed',
          directionKey: `${payload.fromCatId}::${payload.toCatId}`,
          fromCat: { catId: payload.fromCatId, displayName: '奶糖' },
          toCat: { catId: payload.toCatId, displayName: '豆包' },
          totalVotes: 1,
          voteCounts: { bonded: 1, playmate: 0, housemate: 0, needs_space: 0, unsure: 0 },
          distributionVisible: true,
          myChoice: payload.choice
        }
      }
    }
  }
  const sandbox = {
    require(request) {
      if (request === '../../services/online') return online
      throw new Error(`Unexpected require: ${request}`)
    },
    Page(value) { definition = value },
    wx: {
      showToast({ title }) { toastTitle = title },
      showModal({ success }) { success({ confirm: true }) },
      setNavigationBarTitle() {},
      stopPullDownRefresh() {}
    },
    console
  }
  vm.runInNewContext(fs.readFileSync(PAGE_PATH, 'utf8'), sandbox, { filename: PAGE_PATH })
  const page = Object.assign({}, definition, { data: clone(definition.data) })
  page.setData = (patch, callback) => {
    Object.assign(page.data, clone(patch))
    if (callback) callback()
  }
  return {
    page,
    getToastTitle: () => toastTitle,
    getSubmitted: () => submitted
  }
}

function insightsFixture() {
  return {
    cats: [
      { catId: 'cat_a', displayName: '奶糖', isMine: true },
      { catId: 'cat_b', displayName: '豆包', isMine: false }
    ],
    relationships: [
      {
        relationshipId: 'drel_ab',
        relationshipContractId: 'cat-ai.relationship.directed',
        relationshipContractVersion: 2,
        directionVersion: 2,
        directionState: 'directed',
        directionKey: 'cat_a::cat_b',
        fromCat: { catId: 'cat_a', displayName: '奶糖' },
        toCat: { catId: 'cat_b', displayName: '豆包' },
        totalVotes: 1,
        voteCounts: { bonded: 1 },
        distributionVisible: true,
        myChoice: 'bonded'
      },
      {
        relationshipId: 'drel_ba',
        relationshipContractId: 'cat-ai.relationship.directed',
        relationshipContractVersion: 2,
        directionVersion: 2,
        directionState: 'directed',
        directionKey: 'cat_b::cat_a',
        fromCat: { catId: 'cat_b', displayName: '豆包' },
        toCat: { catId: 'cat_a', displayName: '奶糖' },
        totalVotes: 1,
        voteCounts: { playmate: 1 },
        distributionVisible: true,
        myChoice: 'playmate'
      },
      {
        relationshipId: 'rel_legacy',
        directionVersion: 1,
        directionState: 'legacy_pending',
        catA: { catId: 'cat_a', displayName: '奶糖' },
        catB: { catId: 'cat_b', displayName: '豆包' },
        totalVotes: 4,
        voteCounts: null,
        distributionVisible: false,
        myChoice: ''
      }
    ],
    mapCells: [],
    policy: {
      relationshipContractId: 'cat-ai.relationship.directed',
      relationshipContractVersion: 2,
      relationshipDirectionVersion: 2,
      relationshipEdgeUniqueness: 'communityId+directionKey'
    }
  }
}

test('A to B, B to A, and a legacy pair stay separate in page state', () => {
  const { page } = makePage()
  page.applyInsights(insightsFixture())

  assert.equal(page.data.relationships.length, 3)
  assert.equal(page.data.relationships[0].directionKey, 'cat_a::cat_b')
  assert.equal(page.data.relationships[1].directionKey, 'cat_b::cat_a')
  assert.equal(page.data.relationships[2].directionKey, '')
  assert.equal(page.data.relationships[2].directionState, 'legacy_pending')
  assert.match(page.data.relationships[2].roleSummary, /不能自动转换或复制/)

  assert.equal(page.data.selectedRelationship.id, 'drel_ab')
  assert.equal(page.data.selectedPairLabel, '奶糖 → 豆包')
  assert.match(page.data.selectedRoleSummary, /奶糖：主动亲近方/)

  page.data.catAIndex = 1
  page.data.catBIndex = 0
  page.refreshSelectedPair()
  assert.equal(page.data.selectedRelationship.id, 'drel_ba')
  assert.equal(page.data.selectedPairLabel, '豆包 → 奶糖')
  assert.equal(page.data.selectedRelationship.totalVotes, 1)
})

test('legacy cards cannot select a direction and new votes submit explicit endpoints', async () => {
  const { page, getToastTitle, getSubmitted } = makePage()
  page.data.communityId = 'com_1'
  page.applyInsights(insightsFixture())

  page.selectRelationship({ currentTarget: { dataset: { state: 'legacy_pending' } } })
  assert.match(getToastTitle(), /重新选择方向/)

  page.selectChoice({ currentTarget: { dataset: { value: 'needs_space' } } })
  assert.match(page.data.selectedRoleSummary, /奶糖：需要空间方/)
  await page.submitVote(page.data.cats[0], page.data.cats[1], 'bonded')
  assert.deepEqual(getSubmitted(), {
    communityId: 'com_1',
    fromCatId: 'cat_a',
    toCatId: 'cat_b',
    choice: 'bonded',
    evidenceSightingIds: []
  })
})

test('an older remote contract keeps directional voting read-only', () => {
  const { page, getToastTitle, getSubmitted } = makePage()
  const fixture = insightsFixture()
  fixture.policy = {}
  page.applyInsights(fixture)
  page.data.selectedChoice = ''

  page.selectChoice({ currentTarget: { dataset: { value: 'bonded' } } })
  assert.equal(page.data.selectedChoice, '')
  assert.match(getToastTitle(), /尚未启用/)

  page.castVote()
  assert.equal(getSubmitted(), undefined)
  assert.match(getToastTitle(), /尚未启用/)
})

test('equal leading counts are reported as a tie instead of a false winner', () => {
  const { page } = makePage()
  const fixture = insightsFixture()
  fixture.relationships[0].totalVotes = 2
  fixture.relationships[0].voteCounts = {
    bonded: 1,
    playmate: 1,
    housemate: 0,
    needs_space: 0,
    unsure: 0
  }
  page.applyInsights(fixture)

  assert.equal(page.data.selectedRelationship.leadingLabel, '意见并列 · 各 1 票')
  assert.match(page.data.selectedRelationship.roleSummary, /没有单一主导观察/)
})
