/**
 * <RecheckPreviewModal> 初值/阈值调整影响预检与确认提交
 * - 打开后顺着测点观测记录重算：统计级别升高/降低/转正常条数，列出受影响预警（预检不写库）
 * - 已有未闭环预警处置策略默认「保留为待复核记录」，也可选择移除/自动闭环（有风险提示）
 * - 确认后测点、观测、未闭环预警在单事务内原子提交；失败整体回滚，弹窗保留不关闭
 */
import { useEffect, useMemo, useState } from 'react'
import { Alert, App as AntdApp, Button, Collapse, Modal, Radio, Space, Table, Tag, Tooltip } from 'antd'
import type { TableColumnsType } from 'antd'
import { ExclamationCircleOutlined } from '@ant-design/icons'
import AlarmTag from '@/components/common/AlarmTag'
import { usePointStore } from '@/stores/pointStore'
import type { AlarmLevel } from '@/types/alarm'
import {
  DEFAULT_RECHECK_POLICY,
  OBSERVATION_VERDICT_TEXT,
  RECHECK_POLICIES,
  type ObservationVerdict,
  type RecheckAlarmItem,
  type RecheckDraft,
  type RecheckObservationItem,
  type RecheckPointSummary,
  type RecheckPolicy,
  type RecheckPreview
} from '@/types/recheck'

export interface RecheckPreviewModalProps {
  open: boolean
  drafts: RecheckDraft[]
  title?: string
  onClose: () => void
  /** 事务提交成功后回调（用于外部清草稿、提示） */
  onCommitted?: () => void
}

const VERDICT_COLOR: Record<ObservationVerdict, string> = {
  raised: 'red',
  lowered: 'orange',
  normal: 'gold',
  unchanged: 'default'
}

function LevelCell({ level }: { level: AlarmLevel | null }) {
  return level ? <AlarmTag level={level} size="small" dot={false} /> : <Tag color="green">正常</Tag>
}

function ChangedText({ before, after, unit }: { before: number; after: number; unit: string }) {
  const changed = before !== after
  return (
    <span>
      <span className={changed ? 'muted' : undefined} style={changed ? { textDecoration: 'line-through' } : undefined}>
        {before.toFixed(3)}
      </span>
      {changed ? (
        <>
          {' → '}
          <strong>{after.toFixed(3)}</strong>
        </>
      ) : null}
      <span className="muted"> {unit}</span>
    </span>
  )
}

export function RecheckPreviewModal({ open, drafts, title, onClose, onCommitted }: RecheckPreviewModalProps) {
  const { message } = AntdApp.useApp()
  const pointStore = usePointStore()
  const [policy, setPolicy] = useState<RecheckPolicy>(DEFAULT_RECHECK_POLICY)
  const [preview, setPreview] = useState<RecheckPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [onlyChanged, setOnlyChanged] = useState(true)

  // 每次打开（或草稿变化）：策略复位为默认并重新预检；预检只算不写
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setPolicy(DEFAULT_RECHECK_POLICY)
    setPreview(null)
    setLoading(true)
    pointStore
      .previewRecheck(drafts, DEFAULT_RECHECK_POLICY)
      .then((result) => {
        if (!cancelled) setPreview(result)
      })
      .catch((error: unknown) => {
        if (!cancelled) message.error(`预检失败：${error instanceof Error ? error.message : '未知错误'}`)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, drafts])

  // 策略切换：仅重算受影响预警的动作归属（草稿与口径不变）
  useEffect(() => {
    if (!open || policy === DEFAULT_RECHECK_POLICY || loading) return
    let cancelled = false
    pointStore
      .previewRecheck(drafts, policy)
      .then((result) => {
        if (!cancelled) setPreview(result)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy])

  const obsColumns = useMemo<TableColumnsType<RecheckObservationItem>>(
    () => [
      { title: '观测日期', dataIndex: 'date', width: 110 },
      { title: '读数', dataIndex: 'reading', width: 100, render: (value: number) => value.toFixed(3) },
      {
        title: '累计变化（旧 → 新）',
        width: 200,
        render: (_v, record) => <ChangedText before={record.cumulativeBefore} after={record.cumulativeAfter} unit="" />
      },
      {
        title: '原级别',
        width: 100,
        render: (_v, record) => <LevelCell level={record.levelBefore} />
      },
      { title: '', width: 40, render: () => '→' },
      {
        title: '新级别',
        width: 100,
        render: (_v, record) => <LevelCell level={record.levelAfter} />
      },
      {
        title: '结论',
        width: 100,
        render: (_v, record) => <Tag color={VERDICT_COLOR[record.verdict]}>{OBSERVATION_VERDICT_TEXT[record.verdict]}</Tag>
      }
    ],
    []
  )

  const alarmColumns = useMemo<TableColumnsType<RecheckAlarmItem>>(
    () => [
      { title: '触发日期', dataIndex: 'triggerDate', width: 110 },
      {
        title: '触发值（旧 → 新）',
        width: 200,
        render: (_v, record) => (
          <Space size={4}>
            <ChangedText before={record.triggerValueBefore} after={record.triggerValueAfter} unit="" />
            {record.observationMissing ? (
              <Tooltip title="未找到该日期的观测行，触发值按初值差近似重算">
                <ExclamationCircleOutlined style={{ color: '#c9963c' }} />
              </Tooltip>
            ) : null}
          </Space>
        )
      },
      {
        title: '原级别',
        width: 100,
        render: (_v, record) => <AlarmTag level={record.levelBefore} size="small" dot={false} />
      },
      { title: '', width: 40, render: () => '→' },
      {
        title: '新级别',
        width: 100,
        render: (_v, record) => <LevelCell level={record.levelAfter} />
      },
      {
        title: '原状态',
        dataIndex: 'state',
        width: 90,
        render: (value: string) => (
          <Tag color={value === '已闭环' ? 'green' : value === '处置中' ? 'blue' : 'orange'}>{value}</Tag>
        )
      },
      {
        title: '处置动作',
        width: 230,
        render: (_v, record) => {
          if (record.closed) return <Tag color="green">已闭环 · 原样保留</Tag>
          if (record.action === 'update') {
            if (record.raised) return <Tag color="red">级别升高 · 更新触发值与级别</Tag>
            if (record.lowered) return <Tag color="orange">级别降低 · 更新触发值与级别</Tag>
            return <Tag color="blue">更新触发值</Tag>
          }
          if (record.action === 'review') return <Tag color="gold">转正常 · 加待复核标记</Tag>
          if (record.action === 'remove') return <Tag color="red">转正常 · 直接移除</Tag>
          if (record.action === 'autoclose') return <Tag color="green">转正常 · 自动闭环</Tag>
          return <Tag>未闭环 · 无变化</Tag>
        }
      }
    ],
    []
  )

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    try {
      const result = await pointStore.applyRecheck(drafts, policy)
      message.success(
        `已重判提交：测点 ${result.pointIds.length} 个、观测 ${result.observationUpdated} 条；` +
          `更新预警 ${result.alarmsUpdated} 张、待复核 ${result.alarmsFlagged} 张、移除 ${result.alarmsRemoved} 张、自动闭环 ${result.alarmsAutoClosed} 张`
      )
      onCommitted?.()
      onClose()
    } catch (error) {
      // 事务回滚：测点/观测/预警都不会只落一部分
      message.error(`提交失败，已全部回滚（无部分写入）：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setSubmitting(false)
    }
  }

  const obs = preview?.observationCounts
  const alm = preview?.alarmCounts
  const risky = policy !== 'keep'

  const collapseItems = (preview?.points ?? []).map((point: RecheckPointSummary) => {
    const obsRows = onlyChanged
      ? point.observations.filter((item) => item.verdict !== 'unchanged')
      : point.observations
    const alarmRows = onlyChanged ? point.alarms.filter((item) => item.closed || item.action !== 'untouched') : point.alarms
    const c = point.observationCounts
    return {
      key: point.pointId,
      label: (
        <Space wrap size={8}>
          <strong>{point.code}</strong>
          <Tag color="blue">{point.type}</Tag>
          <span className="muted">
            初值 {point.initialBefore} → {point.initialAfter}；阈值 {point.thresholdBefore} → {point.thresholdAfter}（
            {point.unit}）
          </span>
          {c.raised > 0 ? <Tag color="red">升高 {c.raised}</Tag> : null}
          {c.lowered > 0 ? <Tag color="orange">降低 {c.lowered}</Tag> : null}
          {c.normal > 0 ? <Tag color="gold">转正常 {c.normal}</Tag> : null}
        </Space>
      ),
      children: (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <div className="panel-title" style={{ fontSize: 13 }}>
              观测记录重判（{obsRows.length}
              {onlyChanged ? ` / ${point.observations.length}` : ''}）
            </div>
            {obsRows.length === 0 ? (
              <div className="muted">该测点没有级别发生变化的观测记录。</div>
            ) : (
              <Table<RecheckObservationItem>
                rowKey="id"
                size="small"
                bordered
                pagination={false}
                dataSource={obsRows}
                columns={obsColumns}
                scroll={{ x: 760 }}
              />
            )}
          </div>
          <div>
            <div className="panel-title" style={{ fontSize: 13 }}>
              受影响预警（{alarmRows.length}
              {onlyChanged ? ` / ${point.alarms.length}` : ''}）
            </div>
            {point.alarms.length === 0 ? (
              <div className="muted">该测点暂无预警单。</div>
            ) : alarmRows.length === 0 ? (
              <div className="muted">该测点的未闭环预警重算后均无变化，已闭环记录原样保留。</div>
            ) : (
              <Table<RecheckAlarmItem>
                rowKey="id"
                size="small"
                bordered
                pagination={false}
                dataSource={alarmRows}
                columns={alarmColumns}
                scroll={{ x: 880 }}
              />
            )}
          </div>
        </Space>
      )
    }
  })

  return (
    <Modal
      open={open}
      title={title ?? '初值 / 阈值调整影响预检'}
      width={960}
      onCancel={onClose}
      destroyOnClose
      maskClosable={false}
      footer={
        <Space>
          <Button onClick={onClose} disabled={submitting}>
            取消（不写入）
          </Button>
          <Tooltip title={risky ? '该策略可能抹掉本该人工确认的风险记录，请谨慎选择' : undefined}>
            <Button type="primary" danger={risky} loading={submitting} disabled={loading || !preview} onClick={submit}>
              确认提交重判（{drafts.length} 个测点）
            </Button>
          </Tooltip>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="预检只计算不落库"
          description="下表按新初值/阈值重算该测点全部观测的累计变化与级别；已闭环预警一律原样保留，未闭环预警按下述策略处置。确认前不会写入任何数据。"
        />

        <div className="recheck-stat-grid">
          <div className="recheck-stat">
            <span className="recheck-stat__num" style={{ color: '#c0392b' }}>{obs?.raised ?? 0}</span>
            <span className="recheck-stat__label">级别升高（条）</span>
          </div>
          <div className="recheck-stat">
            <span className="recheck-stat__num" style={{ color: '#e07b00' }}>{obs?.lowered ?? 0}</span>
            <span className="recheck-stat__label">级别降低（条）</span>
          </div>
          <div className="recheck-stat">
            <span className="recheck-stat__num" style={{ color: '#c9963c' }}>{obs?.normal ?? 0}</span>
            <span className="recheck-stat__label">转正常（条）</span>
          </div>
          <div className="recheck-stat">
            <span className="recheck-stat__num">{obs?.unchanged ?? 0}</span>
            <span className="recheck-stat__label">级别不变（条）</span>
          </div>
          <div className="recheck-stat">
            <span className="recheck-stat__num" style={{ color: '#1f5c99' }}>{alm?.update ?? 0}</span>
            <span className="recheck-stat__label">更新触发值/级别（张）</span>
          </div>
          <div className="recheck-stat">
            <span className="recheck-stat__num" style={{ color: '#c9963c' }}>{alm?.review ?? 0}</span>
            <span className="recheck-stat__label">加待复核标记（张）</span>
          </div>
          <div className="recheck-stat">
            <span className="recheck-stat__num" style={{ color: '#2f7a4f' }}>{alm?.closedUntouched ?? 0}</span>
            <span className="recheck-stat__label">已闭环原样保留（张）</span>
          </div>
        </div>

        <div>
          <div className="panel-title" style={{ fontSize: 13 }}>已有未闭环预警（重算转正常时）如何处置</div>
          <Radio.Group
            value={policy}
            onChange={(event) => setPolicy(event.target.value as RecheckPolicy)}
            style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            {RECHECK_POLICIES.map((item) => (
              <Radio
                key={item.value}
                value={item.value}
                style={{ alignItems: 'flex-start', marginInlineStart: 0, whiteSpace: 'normal' }}
              >
                <Space direction="vertical" size={0}>
                  <strong>{item.label}</strong>
                  <span className="muted">{item.desc}</span>
                </Space>
              </Radio>
            ))}
          </Radio.Group>
        </div>

        {risky ? (
          <Alert
            type="warning"
            showIcon
            message="误选可能抹掉本该人工确认的风险记录"
            description={
              policy === 'remove'
                ? '「直接移除」会物理删除重算转正常的未闭环预警单，事后无法再在预警处置页找回，值班员将没有复核入口。'
                : '「自动闭环」会跳过人工确认直接归档；若新口径本身有误，风险记录将被提前结案。'
            }
          />
        ) : null}

        <Space>
          <Button size="small" type={onlyChanged ? 'primary' : 'default'} onClick={() => setOnlyChanged((v) => !v)}>
            {onlyChanged ? '仅看有变化的记录（点击显示全部）' : '显示全部记录（点击仅看变化）'}
          </Button>
          <span className="muted">确认提交时测点、观测与未闭环预警一起写入，任一失败整体回滚</span>
        </Space>

        {loading ? (
          <div style={{ padding: '32px 0', textAlign: 'center' }} className="muted">
            正在沿观测记录重算影响范围…
          </div>
        ) : (
          <Collapse items={collapseItems} size="small" defaultActiveKey={(preview?.points ?? []).map((item) => item.pointId)} />
        )}
      </Space>
    </Modal>
  )
}

export default RecheckPreviewModal
