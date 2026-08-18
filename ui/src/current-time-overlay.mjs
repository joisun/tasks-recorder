import { currentTimePosition } from './svar-gantt-state.mjs'
import { gridPanelWidthBounds, nextGridPanelWidth } from './dashboard-state.mjs'

export function currentTimeOverlayModel({ chartLeft = 0, ...timeline }) {
  const position = currentTimePosition(timeline)
  return {
    visible: position.visible,
    left: Math.round(chartLeft + (position.visible ? position.x : 0)),
    contentX: position.contentX,
  }
}

export function timelineLocateShouldDefer({ apiReady, restoreScheduled }) {
  return !apiReady || restoreScheduled
}

export function separatorWidthFromKey({
  key,
  width,
  containerWidth,
  minimum = 240,
  timelineMinimum = 329,
  step = 16,
}) {
  const bounds = gridPanelWidthBounds(containerWidth)
  const maximum = Math.min(bounds.maximum, Math.max(minimum, containerWidth - timelineMinimum))
  return nextGridPanelWidth({ key, currentWidth: width, minimum, maximum, step })
}
