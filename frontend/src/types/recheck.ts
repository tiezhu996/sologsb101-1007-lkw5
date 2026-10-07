/**
 * 初值 / 阈值调整后的历史数据重判预检
 * - 预检只算不写：顺着测点观测记录重算累计量与级别，列出级别变化条数与受影响预警
 * - 确认后在单个 Dexie 事务里提交测点、观测、未闭环预警，任一失败整体回滚
 */
import type { AlarmLevel } from '@/types/alarm'
import type { PointDraft } from '@/types/point'

/** 已有未闭环预警的处置策略 */
export type RecheckPolicy = 'keep' | 'remove' | 'autoclose'

export const RECHECK_POLICIES: Array<{ value: RecheckPolicy; label: string; desc: string }> = [
  {
    value: 'keep',
    label: '保留为待复核记录（默认）',
    desc: '原预警单不删除、不自动闭环；重算转正常的加「待复核」标记，交值班员人工确认。'
  },
  {
    value: 'remove',
    label: '直接移除',
    desc: '重算转正常的未闭环预警单立即删除。注意：可能抹掉本该人工确认的风险记录。'
  },
  {
    value: 'autoclose',
    label: '自动闭环',
    desc: '重算转正常的未闭环预警单直接置为已闭环，不再进入待人工确认队列。'
  }
]

/** 默认策略：保留已有未闭环预警作为待复核记录 */
export const DEFAULT_RECHECK_POLICY: RecheckPolicy = 'keep'

/** 单条观测记录重判结论 */
export type ObservationVerdict = 'raised' | 'lowered' | 'normal' | 'unchanged'

export const OBSERVATION_VERDICT_TEXT: Record<ObservationVerdict, string> = {
  raised: '级别升高',
  lowered: '级别降低',
  normal: '转正常',
  unchanged: '级别不变'
}

/** 单张预警重判后的动作 */
export type AlarmAction = 'update' | 'review' | 'remove' | 'autoclose' | 'untouched'

export const ALARM_ACTION_TEXT: Record<AlarmAction, string> = {
  update: '更新触发值与级别',
  review: '加待复核标记',
  remove: '移除预警单',
  autoclose: '自动闭环',
  untouched: '原样保留'
}

/** 待提交的测点重判草稿：新口径 + 可选的测点基础字段（编辑弹窗一并提交） */
export interface RecheckDraft extends Pick<PointDraft, 'initialValue' | 'threshold' | 'unit'> {
  pointId: string
  /** 编号、类型、断面、安装日期等非口径字段；确认后与口径一起在同一事务提交 */
  patch?: Partial<Omit<PointDraft, 'initialValue' | 'threshold'>>
}

export interface RecheckObservationItem {
  id: string
  pointId: string
  date: string
  reading: number
  cumulativeBefore: number
  cumulativeAfter: number
  levelBefore: AlarmLevel | null
  levelAfter: AlarmLevel | null
  verdict: ObservationVerdict
}

export interface RecheckAlarmItem {
  id: string
  pointId: string
  triggerDate: string
  triggerValueBefore: number
  triggerValueAfter: number
  levelBefore: AlarmLevel
  levelAfter: AlarmLevel | null
  state: string
  closed: boolean
  action: AlarmAction
  /** 级别是否升高（仅未闭环、重算后仍越限时有意义） */
  raised: boolean
  /** 级别是否降低但仍越限 */
  lowered: boolean
  /** 是否由越限转为正常 */
  turnedNormal: boolean
  /** 是否本来就没有对应观测行（触发值按初值差近似重算） */
  observationMissing: boolean
}

/** 观测重判条数统计（需求要求的升高 / 降低 / 转正常） */
export interface RecheckObservationCounts {
  raised: number
  lowered: number
  normal: number
  unchanged: number
  total: number
}

/** 受影响预警统计：按动作与状态分别计数 */
export interface RecheckAlarmCounts {
  update: number
  review: number
  remove: number
  autoclose: number
  /** 已闭环、原样保留的预警数 */
  closedUntouched: number
  /** 未闭环但重算无变化的预警数 */
  openUntouched: number
  total: number
}

export interface RecheckPointSummary {
  pointId: string
  code: string
  type: string
  unit: string
  initialBefore: number
  initialAfter: number
  thresholdBefore: number
  thresholdAfter: number
  observations: RecheckObservationItem[]
  alarms: RecheckAlarmItem[]
  observationCounts: RecheckObservationCounts
  alarmCounts: RecheckAlarmCounts
}

export interface RecheckPreview {
  points: RecheckPointSummary[]
  observationCounts: RecheckObservationCounts
  alarmCounts: RecheckAlarmCounts
  policy: RecheckPolicy
  generatedAt: number
}

export interface RecheckCommitResult {
  pointIds: string[]
  observationUpdated: number
  alarmsUpdated: number
  alarmsFlagged: number
  alarmsRemoved: number
  alarmsAutoClosed: number
}
