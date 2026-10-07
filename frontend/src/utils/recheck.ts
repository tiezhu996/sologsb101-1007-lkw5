/**
 * 初值 / 阈值调整的影响预检（纯函数，不写库）
 * 顺着测点的观测记录重算累计量与预警级别，统计升高 / 降低 / 转正常条数，列出受影响预警。
 * 预检阶段不做任何持久化；实际提交见 utils/db.ts 的 commitRecheck（单事务原子写入）。
 */
import type { Alarm, AlarmLevel } from '@/types/alarm'
import type { Point } from '@/types/point'
import type { Observation } from '@/types/observation'
import { alarmWeight, cumulativeOf, alarmLevelOf } from '@/utils/threshold'
import {
  ALARM_ACTION_TEXT,
  DEFAULT_RECHECK_POLICY,
  type AlarmAction,
  type ObservationVerdict,
  type RecheckAlarmCounts,
  type RecheckAlarmItem,
  type RecheckDraft,
  type RecheckObservationCounts,
  type RecheckObservationItem,
  type RecheckPointSummary,
  type RecheckPolicy,
  type RecheckPreview
} from '@/types/recheck'

export { ALARM_ACTION_TEXT }

/** 按权重比较两个级别（null 表示正常，权重 0） */
export function compareLevel(a: AlarmLevel | null, b: AlarmLevel | null): number {
  return alarmWeightOrNormal(a) - alarmWeightOrNormal(b)
}

function alarmWeightOrNormal(level: AlarmLevel | null): number {
  return level === null ? 0 : alarmWeight(level)
}

export function verdictOf(before: AlarmLevel | null, after: AlarmLevel | null): ObservationVerdict {
  const diff = compareLevel(after, before)
  if (diff === 0) return 'unchanged'
  if (after === null) return 'normal'
  if (before === null) return 'raised'
  return diff > 0 ? 'raised' : 'lowered'
}

export function emptyObservationCounts(): RecheckObservationCounts {
  return { raised: 0, lowered: 0, normal: 0, unchanged: 0, total: 0 }
}

export function emptyAlarmCounts(): RecheckAlarmCounts {
  return { update: 0, review: 0, remove: 0, autoclose: 0, closedUntouched: 0, openUntouched: 0, total: 0 }
}

function sumObservationCounts(points: RecheckPointSummary[]): RecheckObservationCounts {
  return points.reduce<RecheckObservationCounts>(
    (acc, item) => ({
      raised: acc.raised + item.observationCounts.raised,
      lowered: acc.lowered + item.observationCounts.lowered,
      normal: acc.normal + item.observationCounts.normal,
      unchanged: acc.unchanged + item.observationCounts.unchanged,
      total: acc.total + item.observationCounts.total
    }),
    emptyObservationCounts()
  )
}

function sumAlarmCounts(points: RecheckPointSummary[]): RecheckAlarmCounts {
  return points.reduce<RecheckAlarmCounts>(
    (acc, item) => ({
      update: acc.update + item.alarmCounts.update,
      review: acc.review + item.alarmCounts.review,
      remove: acc.remove + item.alarmCounts.remove,
      autoclose: acc.autoclose + item.alarmCounts.autoclose,
      closedUntouched: acc.closedUntouched + item.alarmCounts.closedUntouched,
      openUntouched: acc.openUntouched + item.alarmCounts.openUntouched,
      total: acc.total + item.alarmCounts.total
    }),
    emptyAlarmCounts()
  )
}

/**
 * 依据策略推导单张未闭环预警的处置动作。
 * - 重算仍越限：更新触发值与级别（级别升降仅影响文案）
 * - 重算转正常：按策略 加待复核标记 / 移除 / 自动闭环
 */
export function actionOf(
  closed: boolean,
  turnedNormal: boolean,
  changed: boolean,
  policy: RecheckPolicy
): AlarmAction {
  if (closed) return 'untouched'
  if (!turnedNormal) return changed ? 'update' : 'untouched'
  if (policy === 'remove') return 'remove'
  if (policy === 'autoclose') return 'autoclose'
  return 'review'
}

interface PointRecheckInput {
  point: Point
  draft: RecheckDraft
  observations: Observation[]
  alarms: Alarm[]
}

/** 单个测点的预检（纯计算） */
export function buildPointRecheck(input: PointRecheckInput, policy: RecheckPolicy): RecheckPointSummary {
  const { point, draft, observations, alarms } = input
  const initialAfter = Number(draft.initialValue) || 0
  const thresholdAfter = draft.threshold > 0 ? draft.threshold : 1

  const observationsByDate = new Map<string, Observation>()
  observations.forEach((row) => {
    const existing = observationsByDate.get(row.date)
    if (!existing || row.updatedAt > existing.updatedAt) observationsByDate.set(row.date, row)
  })

  const obsItems: RecheckObservationItem[] = observations
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((row) => {
      const cumulativeBefore = row.cumulative
      const cumulativeAfter = cumulativeOf(row.reading, initialAfter)
      const levelBefore = alarmLevelOf(cumulativeBefore, point.threshold)
      const levelAfter = alarmLevelOf(cumulativeAfter, thresholdAfter)
      return {
        id: row.id,
        pointId: point.id,
        date: row.date,
        reading: row.reading,
        cumulativeBefore,
        cumulativeAfter,
        levelBefore,
        levelAfter,
        verdict: verdictOf(levelBefore, levelAfter)
      }
    })

  const observationCounts = emptyObservationCounts()
  obsItems.forEach((item) => {
    observationCounts.total += 1
    observationCounts[item.verdict] += 1
  })

  const alarmItems: RecheckAlarmItem[] = alarms.map((alarm) => {
    const closed = alarm.state === '已闭环'
    const matched = observationsByDate.get(alarm.triggerDate)
    const observationMissing = !matched
    const triggerValueAfter = matched ? cumulativeOf(matched.reading, initialAfter) : alarm.triggerValue + (point.initialValue - initialAfter)
    const levelAfter = alarmLevelOf(triggerValueAfter, thresholdAfter)
    const turnedNormal = !closed && alarm.level !== null && levelAfter === null
    const raised = !closed && levelAfter !== null && compareLevel(levelAfter, alarm.level) > 0
    const lowered = !closed && levelAfter !== null && compareLevel(levelAfter, alarm.level) < 0
    const changed =
      triggerValueAfter !== alarm.triggerValue || levelAfter !== alarm.level
    const action = actionOf(closed, turnedNormal, changed, policy)
    return {
      id: alarm.id,
      pointId: point.id,
      triggerDate: alarm.triggerDate,
      triggerValueBefore: alarm.triggerValue,
      triggerValueAfter,
      levelBefore: alarm.level,
      levelAfter,
      state: alarm.state,
      closed,
      action,
      raised,
      lowered,
      turnedNormal,
      observationMissing
    }
  })

  const alarmCounts = emptyAlarmCounts()
  alarmItems.forEach((item) => {
    alarmCounts.total += 1
    if (item.closed) {
      alarmCounts.closedUntouched += 1
      return
    }
    if (item.action === 'update') alarmCounts.update += 1
    else if (item.action === 'review') alarmCounts.review += 1
    else if (item.action === 'remove') alarmCounts.remove += 1
    else if (item.action === 'autoclose') alarmCounts.autoclose += 1
    else alarmCounts.openUntouched += 1
  })

  return {
    pointId: point.id,
    code: point.code,
    type: point.type,
    unit: draft.unit || point.unit,
    initialBefore: point.initialValue,
    initialAfter,
    thresholdBefore: point.threshold,
    thresholdAfter,
    observations: obsItems,
    alarms: alarmItems,
    observationCounts,
    alarmCounts
  }
}

/**
 * 批量预检：给若干测点的口径草稿与当前库内行，返回汇总预检结果。
 * 纯函数，不写任何数据——“未确认不写入”。
 */
export function buildRecheckPreview(
  inputs: PointRecheckInput[],
  policy: RecheckPolicy = DEFAULT_RECHECK_POLICY
): RecheckPreview {
  const points = inputs.map((input) => buildPointRecheck(input, policy))
  return {
    points,
    observationCounts: sumObservationCounts(points),
    alarmCounts: sumAlarmCounts(points),
    policy,
    generatedAt: Date.now()
  }
}
