import { useState, useRef, useMemo, useCallback } from 'react'
import { Sigma, Network, ArrowUpDown, Hash, Calculator } from 'lucide-react'
import PipePill, { PipePillChip } from '@/components/PipePill'
import AggregationPopover from '@/components/AggregationPopover'
import GroupByPopover from '@/components/GroupByPopover'
import OrderPopover from '@/components/OrderPopover'
import LimitPopover from '@/components/LimitPopover'
import MathPopover from '@/components/MathPopover'
import { newStatsPipe, newSortPipe, newLimitPipe, newMathPipe, namesInScopeBefore } from '@/utils/pipes'

// Compact chip display for a stats function inside the Aggregation pill.
function summarizeFn(f) {
  if (f.as) return f.as
  if (f.fn === 'quantile') return `q${Math.round((Number(f.p) || 0.9) * 100)}(${f.field || '·'})`
  if (f.field) return `${f.fn}(${f.field})`
  return `${f.fn}()`
}

// Full-form title used on hover (fn call + alias when present).
function fullFn(f) {
  const args = []
  if (f.fn === 'quantile') args.push(Number(f.p) || 0.9)
  if (f.field) args.push(f.field)
  const call = `${f.fn}(${args.join(', ')})`
  return f.as ? `${f.as} = ${call}` : call
}

/**
 * The Group by / Aggregation / Math / Order / Limit pill row and the popovers
 * behind it, over a `pipes` array the caller owns. The same row the Logs and
 * Traces explorers draw inline; a surface that only needs the row (the
 * Kubernetes Events panel) takes it whole from here.
 */
export default function PipeToolbar({ pipes, setPipes, fieldCatalog, aggAllFields, aggNumericFields }) {
  const aggPillRef = useRef(null)
  const [aggPopOpen, setAggPopOpen] = useState(false)
  const [editingFuncId, setEditingFuncId] = useState(null)
  const groupByPillRef = useRef(null)
  const [groupByPopOpen, setGroupByPopOpen] = useState(false)
  const orderPillRef = useRef(null)
  const [orderPopOpen, setOrderPopOpen] = useState(false)
  const limitPillRef = useRef(null)
  const [limitPopOpen, setLimitPopOpen] = useState(false)
  const mathPillRef = useRef(null)
  const [mathPopOpen, setMathPopOpen] = useState(false)
  const [editingMathId, setEditingMathId] = useState(null)

  const statsFunctions = useMemo(
    () => pipes.filter(p => p.kind === 'stats').flatMap(p => p.functions || []),
    [pipes]
  )
  const editingFunc = editingFuncId ? statsFunctions.find(f => f.id === editingFuncId) : null
  const groupBy = useMemo(() => pipes.find(p => p.kind === 'stats')?.groupBy || [], [pipes])
  const sortPipe = useMemo(() => pipes.find(p => p.kind === 'sort') || null, [pipes])
  const limitPipe = useMemo(() => pipes.find(p => p.kind === 'limit') || null, [pipes])
  const mathPipes = useMemo(() => pipes.filter(p => p.kind === 'math'), [pipes])
  const editingMath = editingMathId ? mathPipes.find(p => p.id === editingMathId) : null

  const upsertAggregation = useCallback((fn) => {
    setPipes(prev => {
      const idx = prev.findIndex(p => p.kind === 'stats')
      if (idx === -1) return [...prev, newStatsPipe({ functions: [fn] })]
      const stats = prev[idx]
      const fnIdx = stats.functions.findIndex(f => f.id === fn.id)
      const nextFns = fnIdx === -1 ? [...stats.functions, fn] : stats.functions.map(f => f.id === fn.id ? fn : f)
      const next = [...prev]
      next[idx] = { ...stats, functions: nextFns }
      return next
    })
  }, [setPipes])

  const setGroupBy = useCallback((next) => {
    setPipes(prev => {
      const idx = prev.findIndex(p => p.kind === 'stats')
      const current = idx === -1 ? [] : (prev[idx].groupBy || [])
      const nextArr = typeof next === 'function' ? next(current) : next
      if (idx === -1) {
        if (nextArr.length === 0) return prev
        return [...prev, newStatsPipe({ groupBy: nextArr, functions: [] })]
      }
      const stats = prev[idx]
      if (nextArr.length === 0 && stats.functions.length === 0) return prev.filter(p => p.id !== stats.id)
      const out = [...prev]
      out[idx] = { ...stats, groupBy: nextArr }
      return out
    })
  }, [setPipes])

  const removeAggregation = useCallback((funcId) => {
    setPipes(prev => prev.flatMap(p => {
      if (p.kind !== 'stats') return [p]
      const nextFns = p.functions.filter(f => f.id !== funcId)
      if (nextFns.length === 0 && (!p.groupBy || p.groupBy.length === 0)) return []
      return [{ ...p, functions: nextFns }]
    }))
  }, [setPipes])

  const removePipeById = useCallback((id) => setPipes(prev => prev.filter(p => p.id !== id)), [setPipes])

  const upsertMathPipe = useCallback((math) => {
    setPipes(prev => {
      const idx = prev.findIndex(p => p.id === math.id)
      if (idx === -1) return [...prev, { ...newMathPipe(), ...math }]
      const next = [...prev]
      next[idx] = { ...prev[idx], ...math }
      return next
    })
  }, [setPipes])

  // Patches the one pipe of a kind, creating it on first use.
  const patchSingle = useCallback((kind, create) => (patch) => setPipes(prev => {
    const idx = prev.findIndex(p => p.kind === kind)
    if (idx === -1) return [...prev, create(patch)]
    const next = [...prev]
    next[idx] = { ...next[idx], ...patch }
    return next
  }), [setPipes])

  const orderFieldOptions = useMemo(() => {
    const opts = []
    for (const f of groupBy) opts.push({ value: f, hint: 'group by' })
    for (const fn of statsFunctions) if (fn.as) opts.push({ value: fn.as, hint: 'aggregation' })
    return opts
  }, [groupBy, statsFunctions])

  const mathAvailableNames = useMemo(() => {
    const idx = editingMath ? pipes.findIndex(p => p.id === editingMath.id) : pipes.length
    return namesInScopeBefore(pipes, idx === -1 ? pipes.length : idx)
  }, [pipes, editingMath])

  const openCreateAggregation = () => { setEditingFuncId(null); setAggPopOpen(true) }
  const openEditAggregation = (id) => { setEditingFuncId(id); setAggPopOpen(true) }
  const closeAggregation = () => { setAggPopOpen(false); setEditingFuncId(null) }
  const openCreateMath = () => { setEditingMathId(null); setMathPopOpen(true) }
  const openEditMath = (id) => { setEditingMathId(id); setMathPopOpen(true) }
  const closeMath = () => { setMathPopOpen(false); setEditingMathId(null) }

  return (
    <>
      <div className="pipe-toolbar">
        <PipePill ref={groupByPillRef} icon={<Network />} label="Group by" active={groupByPopOpen} onAddClick={() => setGroupByPopOpen(o => !o)}>
          {groupBy.map(field => (
            <PipePillChip key={field} title={`Grouping by ${field}`} onRemove={() => setGroupBy(prev => prev.filter(f => f !== field))}>
              {field}
            </PipePillChip>
          ))}
        </PipePill>
        <PipePill ref={aggPillRef} icon={<Sigma />} label="Aggregation" active={aggPopOpen} onAddClick={openCreateAggregation}>
          {statsFunctions.map(fn => (
            <PipePillChip
              key={fn.id}
              title={fullFn(fn)}
              active={editingFuncId === fn.id && aggPopOpen}
              onClick={() => openEditAggregation(fn.id)}
              onRemove={() => removeAggregation(fn.id)}
            >
              {summarizeFn(fn)}
            </PipePillChip>
          ))}
        </PipePill>
        <PipePill ref={mathPillRef} icon={<Calculator />} label="Math" active={mathPopOpen && !editingMathId} onAddClick={openCreateMath}>
          {mathPipes.map(mp => (
            <PipePillChip
              key={mp.id}
              title={mp.expression + (mp.as ? ` as ${mp.as}` : '')}
              active={editingMathId === mp.id && mathPopOpen}
              onClick={() => openEditMath(mp.id)}
              onRemove={() => removePipeById(mp.id)}
            >
              {mp.as || mp.expression || 'expr'}
            </PipePillChip>
          ))}
        </PipePill>
        <PipePill
          ref={orderPillRef}
          icon={<ArrowUpDown />}
          label="Order"
          active={orderPopOpen}
          addAffordance={sortPipe ? 'chevron' : 'plus'}
          onAddClick={() => setOrderPopOpen(o => !o)}
        >
          {sortPipe && (
            <PipePillChip
              title={`Sort by ${sortPipe.field || '…'} ${sortPipe.dir === 'asc' ? 'ascending' : 'descending'}`}
              onClick={() => setOrderPopOpen(true)}
              onRemove={() => removePipeById(sortPipe.id)}
            >
              {sortPipe.field || '…'} {sortPipe.dir === 'asc' ? '↑' : '↓'}
            </PipePillChip>
          )}
        </PipePill>
        <PipePill
          ref={limitPillRef}
          icon={<Hash />}
          label="Limit"
          active={limitPopOpen}
          addAffordance={limitPipe ? 'chevron' : 'plus'}
          onAddClick={() => setLimitPopOpen(o => !o)}
        >
          {limitPipe && (
            <PipePillChip
              title={`Return at most ${Number(limitPipe.n).toLocaleString()} rows`}
              onClick={() => setLimitPopOpen(true)}
              onRemove={() => removePipeById(limitPipe.id)}
            >
              {Number(limitPipe.n).toLocaleString()}
            </PipePillChip>
          )}
        </PipePill>
      </div>

      <AggregationPopover
        anchorRef={aggPillRef}
        open={aggPopOpen}
        onClose={closeAggregation}
        onSave={upsertAggregation}
        initial={editingFunc}
        allFields={aggAllFields}
        numericFields={aggNumericFields}
      />
      <GroupByPopover
        anchorRef={groupByPillRef}
        open={groupByPopOpen}
        onClose={() => setGroupByPopOpen(false)}
        fields={fieldCatalog}
        selected={groupBy}
        onChange={setGroupBy}
      />
      <OrderPopover
        anchorRef={orderPillRef}
        open={orderPopOpen}
        onClose={() => setOrderPopOpen(false)}
        pipe={sortPipe}
        onChange={patchSingle('sort', patch => newSortPipe({ field: '', dir: 'desc', ...patch }))}
        onRemove={() => setPipes(prev => prev.filter(p => p.kind !== 'sort'))}
        fieldOptions={orderFieldOptions}
      />
      <LimitPopover
        anchorRef={limitPillRef}
        open={limitPopOpen}
        onClose={() => setLimitPopOpen(false)}
        pipe={limitPipe}
        onChange={patchSingle('limit', patch => newLimitPipe({ n: 100, ...patch }))}
        onRemove={() => setPipes(prev => prev.filter(p => p.kind !== 'limit'))}
      />
      <MathPopover
        anchorRef={mathPillRef}
        open={mathPopOpen}
        onClose={closeMath}
        onSave={upsertMathPipe}
        initial={editingMath}
        availableNames={mathAvailableNames}
      />
    </>
  )
}
