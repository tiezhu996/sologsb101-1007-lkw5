/**
 * 初值/阈值调整的影响预检（纯计算，不触碰 IndexedDB）
 * - 顺着测点观测记录按新口径复算级别，统计升高 / 降低 / 转正常条数
 * - 推导未闭环预警的处置计划；已闭环预警不进入计划（原样保留）
 * 页面预检与 db.commitThresholdImpact 的事务内重算共用本模块，保证口径一致。
 */
import { ALARM_LEVEL_WEIGHT, type Alarm, type AlarmLevel, type AlarmState } from '@/types/alarm'
import type { Observation } from '@/types/observation'
import type { Point } from '@/types/point'
import { alarmLevelOf, cumulativeOf } from '@/utils/threshold'

/**
 * 未闭环预警在口径调整后的处理策略：
 * - keep（默认）：转正常的保留为「待复核」记录，需人工确认，绝不自动抹掉
 * - close：转正常的直接自动闭环并注明复算原因
 * - remove：转正常的直接移除（不留痕，慎用）
 */
export type OpenAlarmStrategy = 'keep' | 'close' | 'remove'

/** 一次测点初值/阈值调整计划 */
export interface ThresholdChangePlan {
  pointId: string
  nextInitialValue: number
  nextThreshold: number
  /** 编辑测点场景：随口径调整一并提交的其它字段（damId 由调用方先解析好） */
  pointPatch?: Partial<Omit<Point, 'id' | 'createdAt' | 'updatedAt' | 'initialValue' | 'threshold'>>
}

/** 单条观测在新口径下的级别迁移方向 */
export type LevelShift = '升高' | '降低' | '转正常' | '不变'

export interface ObservationShift {
  id: string
  date: string
  reading: number
  oldCumulative: number
  newCumulative: number
  oldLevel: AlarmLevel | null
  newLevel: AlarmLevel | null
  shift: LevelShift
}

/** 未闭环预警的处置动作 */
export type AlarmAction = '更新' | '待复核' | '自动闭环' | '移除' | '不变'

export interface AlarmShift {
  id: string
  state: AlarmState
  triggerDate: string
  oldLevel: AlarmLevel
  oldTriggerValue: number
  /** 复算后触发日累计值；触发日无观测记录时为 null（无法复算） */
  newCumulative: number | null
  /** 复算后级别；null 表示转正常或无法复算 */
  newLevel: AlarmLevel | null
  action: AlarmAction
}

/** 单个测点的影响预检结果 */
export interface ImpactPreview {
  pointId: string
  pointCode: string
  unit: string
  oldInitialValue: number
  nextInitialValue: number
  oldThreshold: number
  nextThreshold: number
  totalObservations: number
  raised: number
  lowered: number
  normalized: number
  unchanged: number
  /** 仅级别发生变化的观测明细 */
  observationShifts: ObservationShift[]
  /** 未闭环预警的处置计划 */
  alarmShifts: AlarmShift[]
  /** 已闭环预警条数（原样保留，仅作展示） */
  closedAlarmCount: number
}

const levelWeight = (level: AlarmLevel | null): number => (level === null ? 0 : ALARM_LEVEL_WEIGHT[level])

export function shiftOfLevels(oldLevel: AlarmLevel | null, newLevel: AlarmLevel | null): LevelShift {
  if (oldLevel === newLevel) return '不变'
  if (newLevel === null) return '转正常'
  return levelWeight(newLevel) > levelWeight(oldLevel) ? '升高' : '降低'
}

/** 推导单条未闭环预警在新口径下的复算结果与处置动作 */
export function planAlarmShift(
  alarm: Alarm,
  observations: Observation[],
  nextInitialValue: number,
  nextThreshold: number,
  strategy: OpenAlarmStrategy
): AlarmShift {
  const hit = observations.find((row) => row.date === alarm.triggerDate) ?? null
  const newCumulative = hit ? cumulativeOf(hit.reading, nextInitialValue) : null
  const newLevel = newCumulative === null ? null : alarmLevelOf(newCumulative, nextThreshold)
  let action: AlarmAction
  if (newCumulative === null) {
    // 触发日观测已缺失，无法复算：无论选哪种策略都转待复核，绝不自动抹掉风险记录
    action = '待复核'
  } else if (newLevel === null) {
    action = strategy === 'close' ? '自动闭环' : strategy === 'remove' ? '移除' : '待复核'
  } else {
    action = newLevel === alarm.level && newCumulative === alarm.triggerValue ? '不变' : '更新'
  }
  return {
    id: alarm.id,
    state: alarm.state,
    triggerDate: alarm.triggerDate,
    oldLevel: alarm.level,
    oldTriggerValue: alarm.triggerValue,
    newCumulative,
    newLevel,
    action
  }
}

/** 按新初值/新阈值复算某测点的全部观测与未闭环预警，返回影响预检结果 */
export function buildImpactPreview(
  point: Point,
  observations: Observation[],
  alarms: Alarm[],
  nextInitialValue: number,
  nextThreshold: number,
  strategy: OpenAlarmStrategy
): ImpactPreview {
  const sorted = [...observations].sort((a, b) => a.date.localeCompare(b.date))
  const observationShifts: ObservationShift[] = []
  let raised = 0
  let lowered = 0
  let normalized = 0
  let unchanged = 0
  sorted.forEach((row) => {
    const oldCumulative = cumulativeOf(row.reading, point.initialValue)
    const newCumulative = cumulativeOf(row.reading, nextInitialValue)
    const oldLevel = alarmLevelOf(oldCumulative, point.threshold)
    const newLevel = alarmLevelOf(newCumulative, nextThreshold)
    const shift = shiftOfLevels(oldLevel, newLevel)
    if (shift === '升高') raised += 1
    else if (shift === '降低') lowered += 1
    else if (shift === '转正常') normalized += 1
    else unchanged += 1
    if (shift !== '不变') {
      observationShifts.push({ id: row.id, date: row.date, reading: row.reading, oldCumulative, newCumulative, oldLevel, newLevel, shift })
    }
  })
  const openAlarms = alarms.filter((alarm) => alarm.state !== '已闭环')
  const alarmShifts = openAlarms.map((alarm) => planAlarmShift(alarm, sorted, nextInitialValue, nextThreshold, strategy))
  return {
    pointId: point.id,
    pointCode: point.code,
    unit: point.unit,
    oldInitialValue: point.initialValue,
    nextInitialValue,
    oldThreshold: point.threshold,
    nextThreshold,
    totalObservations: observations.length,
    raised,
    lowered,
    normalized,
    unchanged,
    observationShifts,
    alarmShifts,
    closedAlarmCount: alarms.length - openAlarms.length
  }
}
