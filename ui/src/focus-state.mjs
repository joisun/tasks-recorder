const FOCUS_ATTRIBUTES = [
  'data-details-close',
  'data-details-tab',
  'data-details-action',
  'data-copy-value',
  'data-inbox-close',
  'data-inbox-filter',
  'data-inbox-select',
  'data-inbox-select-all',
  'data-inbox-task',
  'data-inbox-action',
  'name',
]

export function focusDescriptor(element) {
  if (!element || typeof element.hasAttribute !== 'function') return null
  for (const attribute of FOCUS_ATTRIBUTES) {
    if (element.hasAttribute(attribute)) {
      return { attribute, value: element.getAttribute(attribute) ?? '' }
    }
  }
  return null
}

export function findFocusTarget(root, descriptor, fallbackSelector) {
  if (descriptor) {
    const candidates = root.querySelectorAll(`[${descriptor.attribute}]`)
    const match = [...candidates].find((candidate) => (
      candidate.getAttribute(descriptor.attribute) === descriptor.value
    ))
    if (match) return match
  }
  return fallbackSelector ? root.querySelector(fallbackSelector) : null
}

export function renderPreservingFocus({
  root,
  render,
  fallbackSelector,
  documentRef = globalThis.document,
}) {
  const activeElement = documentRef?.activeElement ?? null
  const contained = Boolean(activeElement && root.contains(activeElement))
  const descriptor = contained ? focusDescriptor(activeElement) : null
  render()
  if (!contained && activeElement !== documentRef?.body && activeElement !== null) return null
  const target = findFocusTarget(root, descriptor, fallbackSelector)
  target?.focus({ preventScroll: true })
  return target
}
