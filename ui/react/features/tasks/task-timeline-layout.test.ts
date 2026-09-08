import { describe, expect, it } from 'vitest'

import type { TimelineScale } from './task-types'
import { buildTimelineLayout } from './task-timeline-layout'

function scale(overrides: Partial<TimelineScale> = {}): TimelineScale {
  return {
    id: 'day',
    start: new Date(2024, 0, 15, 12),
    end: new Date(2024, 2, 15, 12),
    lengthUnit: 'day',
    cellWidth: 24,
    scales: [{ unit: 'month', step: 1, format: (date) => `${date.getMonth() + 1}月` }],
    ...overrides,
  }
}

describe('buildTimelineLayout', () => {
  it('aligns calendar ticks and clips the leading and trailing cells', () => {
    const layout = buildTimelineLayout(scale(), 0)

    expect(layout.ticks[0].map(({ label }) => label)).toEqual(['1月', '2月', '3月'])
    expect(layout.ticks[0][0].left).toBe(0)
    expect(layout.ticks[0][0].width).toBeCloseTo(16.5 * 24)
    expect(layout.ticks[0][1].width).toBe(29 * 24)
    expect(layout.ticks[0][2].width).toBeCloseTo(14.5 * 24)
    expect(layout.ticks[0].reduce((sum, tick) => sum + tick.width, 0)).toBeCloseTo(layout.width)
  })

  it('uses local calendar month, quarter, and year lengths', () => {
    const layout = buildTimelineLayout(scale({
      start: new Date(2023, 11, 1),
      end: new Date(2025, 0, 1),
      scales: [
        { unit: 'year', step: 1, format: (date) => String(date.getFullYear()) },
        { unit: 'quarter', step: 1, format: (date) => `Q${Math.floor(date.getMonth() / 3) + 1}` },
        { unit: 'month', step: 1, format: (date) => String(date.getMonth() + 1) },
      ],
    }), 0)

    expect(layout.ticks[0].map(({ label, width }) => [label, width])).toEqual([
      ['2023', 31 * 24],
      ['2024', 366 * 24],
    ])
    expect(layout.ticks[1]).toHaveLength(5)
    expect(layout.ticks[2]).toHaveLength(13)
  })

  it('keeps very long hour ranges bounded and honors a valid step', () => {
    const stepped = buildTimelineLayout(scale({
      id: 'hour',
      start: new Date(2024, 0, 1, 1, 30),
      end: new Date(2024, 0, 1, 14),
      lengthUnit: 'hour',
      scales: [{ unit: 'hour', step: 6, format: (date) => `${date.getHours()}:00` }],
    }), 0)
    expect(stepped.ticks[0].map(({ label }) => label)).toEqual(['0:00', '6:00', '12:00'])
    expect(stepped.ticks[0][1].width).toBe(6 * 24)

    const start = new Date(2000, 0, 1)
    const end = new Date(2030, 0, 1)
    const layout = buildTimelineLayout(scale({
      id: 'hour', start, end, lengthUnit: 'hour', cellWidth: 2,
      scales: [{ unit: 'hour', step: 6, format: (date) => String(date.getHours()) }],
    }), 0)

    expect(layout.ticks[0].length).toBeLessThanOrEqual(500)
    expect(layout.ticks[0][0].left).toBe(0)
    expect(layout.ticks[0].at(-1)!.left + layout.ticks[0].at(-1)!.width).toBeCloseTo(layout.width)
  })

  it('accounts for clipped edge cells when limiting tick count', () => {
    const start = new Date(2024, 0, 1, 12)
    const end = new Date(start)
    end.setDate(end.getDate() + 500)
    const layout = buildTimelineLayout(scale({
      start,
      end,
      scales: [{ unit: 'day', step: 1, format: (date) => String(date.getDate()) }],
    }), 0)

    expect(layout.ticks[0].length).toBeLessThanOrEqual(500)
    expect(layout.ticks[0].at(-1)!.left + layout.ticks[0].at(-1)!.width).toBeCloseTo(layout.width)
  })

  it('covers the tail after adaptive hour steps shift the first boundary', () => {
    const start = new Date(2024, 0, 1, 23)
    const end = new Date(start.getTime() + 8997 * 60 * 60_000)
    const layout = buildTimelineLayout(scale({
      start, end, lengthUnit: 'hour', cellWidth: 12,
      scales: [{ unit: 'hour', step: 6, format: date => String(date.getHours()) }],
    }), 0)
    expect(layout.ticks[0].length).toBeLessThanOrEqual(500)
    expect(layout.ticks[0].at(-1)!.left + layout.ticks[0].at(-1)!.width).toBeCloseTo(layout.width)
  })

  it('maps timestamps linearly and uses minimumWidth consistently', () => {
    const source = scale({ start: new Date(2024, 0, 1), end: new Date(2024, 0, 11), scales: [] })
    const layout = buildTimelineLayout(source, 1_000)

    expect(layout.width).toBe(1_000)
    expect(layout.position(source.start)).toBe(0)
    expect(layout.position(new Date(2024, 0, 6))).toBe(500)
    expect(layout.position(source.end)).toBe(1_000)
  })

  it('falls back safely for invalid ranges and dimensions', () => {
    const layout = buildTimelineLayout(scale({
      start: new Date(Number.NaN), end: new Date(Number.NaN), cellWidth: Number.NaN,
    }), 320)

    expect(layout.width).toBe(320)
    expect(layout.position(new Date())).toBe(0)
    expect(layout.ticks).toEqual([[]])
  })
})
