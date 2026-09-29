// A local-only boundary between private pet archives and the public composer.
// Never spread an archive into a social payload, even when new fields are added.
function cleanText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

function canRegisterResult(result) {
  return Boolean(result && typeof result === 'object' && !result.demo)
}

function canSharePet(pet) {
  return Boolean(pet && typeof pet === 'object' && pet.id && !pet.demo &&
    !(pet.recognition && pet.recognition.demo))
}

function toPublicCat(pet) {
  if (!canSharePet(pet)) return null
  return {
    name: cleanText(pet.name, 20) || '未命名猫咪',
    breed: cleanText(pet.breed, 60),
    coatColor: cleanText(pet.coatColor, 60)
  }
}

// This is an offer for an explicit photo choice, never an upload instruction.
function getPhotoCandidate(pet) {
  if (!canSharePet(pet)) return ''
  const path = cleanText(pet.imagePath, 2048)
  return /^(?:wxfile:\/\/|https?:\/\/(?:tmp|usr)\/|\/(?!\/))/i.test(path) ? path : ''
}

function composeUrl(petId) {
  const id = cleanText(petId, 160)
  if (!id) throw new Error('请先保存猫咪档案')
  return `/pages/social-compose/index?petId=${encodeURIComponent(id)}`
}

module.exports = { canRegisterResult, canSharePet, toPublicCat, getPhotoCandidate, composeUrl }
