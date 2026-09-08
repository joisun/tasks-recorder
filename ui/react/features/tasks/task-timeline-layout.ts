import type { TimelineScale } from './task-types'

type TimelineUnit = TimelineScale['scales'][number]['unit']

export interface TimelineTick {
  key: string
  left: number
  width: number
  label: string
}

export interface TimelineLayout {
  width: number
  position: (date: Date) => number
  ticks: TimelineTick[][]
}

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
const MAX_TICKS = 500

const APPROXIMATE_UNIT_MS: Record<TimelineUnit, number> = {
  hour: HOUR_MS,
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 28 * DAY_MS,
  quarter: 84 * DAY_MS,
  year: 365 * DAY_MS,
}

function floorToBoundary(source: Date, unit: TimelineUnit, step = 1): Date {
  const date = new Date(source)
  if (unit === 'hour') {
    date.setMinutes(0, 0, 0)
    const hoursPerBoundary = Math.min(24, Math.max(1, step))
    date.setHours(Math.floor(date.getHours() / hoursPerBoundary) * hoursPerBoundary)
    return date
  }

  date.setHours(0, 0, 0, 0)
  if (unit === 'day') return date
  if (unit === 'week') {
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
    return date
  }

  date.setDate(1)
  if (unit === 'month') return date
  if (unit === 'quarter') {
    date.setMonth(Math.floor(date.getMonth() / 3) * 3)
    return date
  }

  date.setMonth(0)
  return date
}

function addUnits(source: Date, unit: TimelineUnit, amount: number): Date {
  const date = new Date(source)
  if (unit === 'hour') date.setHours(date.getHours() + amount)
  else if (unit === 'day') date.setDate(date.getDate() + amount)
  else if (unit === 'week') date.setDate(date.getDate() + amount * 7)
  else if (unit === 'month') date.setMonth(date.getMonth() + amount)
  else if (unit === 'quarter') date.setMonth(date.getMonth() + amount * 3)
  else date.setFullYear(date.getFullYear() + amount)
  return date
}

function effectiveStep(unit: TimelineUnit, step: number, span: number): number {
  const requested = Number.isFinite(step) && step > 0 ? Math.max(1, Math.floor(step)) : 1
  const estimatedTicks = span / (APPROXIMATE_UNIT_MS[unit] * requested)
  return requested * Math.max(1, Math.ceil(estimatedTicks / (MAX_TICKS - 2)))
}

export function buildTimelineLayout(scale: TimelineScale, minimumWidth: number): TimelineLayout {
  const start = scale.start.getTime()
  const end = scale.end.getTime()
  const floorWidth = Number.isFinite(minimumWidth) ? Math.max(0, minimumWidth) : 0
  const validRange = Number.isFinite(start) && Number.isFinite(end) && end > start
  const cellWidth = Number.isFinite(scale.cellWidth) && scale.cellWidth > 0 ? scale.cellWidth : 0
  const unitDuration = scale.lengthUnit === 'hour' ? HOUR_MS : DAY_MS
  const intrinsicWidth = validRange ? ((end - start) / unitDuration) * cellWidth : 0
  const width = Math.max(floorWidth, Number.isFinite(intrinsicWidth) ? intrinsicWidth : 0)

  const position = (date: Date) => {
    const timestamp = date.getTime()
    if (!validRange || !Number.isFinite(timestamp)) return 0
    return Math.max(0, Math.min(width, ((timestamp - start) / (end - start)) * width))
  }

  if (!validRange) {
    return { width, position, ticks: scale.scales.map(() => []) }
  }

  const ticks = scale.scales.map(({ unit, step, format }, layerIndex) => {
    const result: TimelineTick[] = []
    let increment = effectiveStep(unit, step, end - start)
    let cursor = floorToBoundary(scale.start, unit, increment)

    // Validate the actual calendar boundaries before emitting a bounded layer.
    for (let attempt = 0; attempt < 8; attempt++) {
      let boundary = cursor
      for (let count = 0; count < MAX_TICKS && boundary.getTime() < end; count++) {
        boundary = addUnits(boundary, unit, increment)
      }
      if (!Number.isFinite(boundary.getTime()) || boundary.getTime() >= end) break
      increment *= 2
      cursor = floorToBoundary(scale.start, unit, increment)
    }

    while (cursor.getTime() < end && result.length < MAX_TICKS) {
      let next = addUnits(cursor, unit, increment)
      if (!Number.isFinite(next.getTime()) || result.length === MAX_TICKS - 1) next = new Date(end)
      const nextTime = next.getTime()
      if (!Number.isFinite(nextTime) || nextTime <= cursor.getTime()) break

      const visibleStart = Math.max(start, cursor.getTime())
      const visibleEnd = Math.min(end, nextTime)
      if (visibleEnd > visibleStart) {
        let label = ''
        try {
          label = format(cursor)
        } catch {
          // A presentation formatter should not make timeline geometry unusable.
        }
        const left = position(new Date(visibleStart))
        result.push({
          key: `${layerIndex}:${unit}:${cursor.getTime()}`,
          left,
          width: position(new Date(visibleEnd)) - left,
          label,
        })
      }
      cursor = next
    }

    return result
  })

  return { width, position, ticks }
}
