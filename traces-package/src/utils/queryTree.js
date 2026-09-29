// Tree helpers for the query builder's chip model.
//
// A node is either a LEAF — `{ field, op, value, connector? }`, byte-identical
// to the flat chip the builder has always produced — or a GROUP:
// `{ kind: 'group', children: Node[], connector? }`.
//
// `connector` means the same thing on both: how this node joins to the
// *preceding sibling* ('AND' when absent). Because a leaf is unchanged, every
// flat chip array ever saved is already a valid tree — no migration needed.
//
// Positions are PATHS: arrays of indices, so `[2, 1]` is the second child of
// the third top-level node.

export function isGroup(n) {
  return !!n && n.kind === 'group'
}

// Sets or removes `connector` without leaving a `connector: undefined` key
// behind — the round-trip tests compare nodes with deepEqual, which counts
// an explicitly-undefined key as a difference.
function setConn(node, conn) {
  // The discarded binding is the point: destructuring is how the key gets
  // dropped entirely rather than left set to undefined.
  const { connector: _dropped, ...rest } = node
  return conn == null ? rest : { ...rest, connector: conn }
}

const stripConn = (node) => setConn(node, null)

export function newGroup(children = [], connector) {
  const g = { kind: 'group', children }
  return connector == null ? g : { ...g, connector }
}

// ---------- Read ----------

export function getAt(nodes, path) {
  if (!path?.length) return null
  let list = nodes
  let node = null
  for (const i of path) {
    if (!list || !list[i]) return null
    node = list[i]
    list = isGroup(node) ? node.children : null
  }
  return node
}

// The sibling list a path lives in, plus the index within it.
function siblingsOf(nodes, path) {
  const parentPath = path.slice(0, -1)
  const list = parentPath.length ? (getAt(nodes, parentPath)?.children ?? []) : nodes
  return { parentPath, list, idx: path[path.length - 1] }
}

// Writes a replacement sibling list back at `parentPath`.
function withSiblings(nodes, parentPath, list) {
  if (!parentPath.length) return list
  const parent = getAt(nodes, parentPath)
  if (!parent) return nodes
  return replaceAt(nodes, parentPath, { ...parent, children: list })
}

export function flattenLeaves(nodes) {
  const out = []
  const walk = (list) => {
    for (const n of list ?? []) {
      if (isGroup(n)) walk(n.children)
      else out.push(n)
    }
  }
  walk(nodes)
  return out
}

export function countLeaves(nodes) {
  return flattenLeaves(nodes).length
}

// Path of the last leaf in document order — what Backspace steps back onto.
// An empty group has no leaf, so the group's own path is returned instead.
export function lastLeafPath(nodes) {
  if (!nodes?.length) return null
  const i = nodes.length - 1
  const n = nodes[i]
  if (!isGroup(n)) return [i]
  const inner = lastLeafPath(n.children ?? [])
  return inner ? [i, ...inner] : [i]
}

export function pathEquals(a, b) {
  if (!a || !b || a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

// True when `path` is `ancestor` or sits underneath it.
export function isAtOrUnder(path, ancestor) {
  if (!path || !ancestor) return false
  if (path.length < ancestor.length) return false
  return ancestor.every((v, i) => v === path[i])
}

// ---------- Normalize ----------

// Collapses shapes that are legal to build but meaningless to read: empty
// groups, groups holding a single node, and a stray connector on the first
// node of any list (nothing precedes it to join to).
//
// `protect` keeps one in-progress group alive — a group the user has just
// opened is legitimately empty until they add the first filter to it.
export function normalize(nodes, protect = null, here = []) {
  const out = []
  for (let i = 0; i < (nodes?.length ?? 0); i++) {
    const n = nodes[i]
    const at = [...here, i]
    if (!isGroup(n)) { out.push(n); continue }

    const kids = normalize(n.children, protect, at)
    const shielded = protect && isAtOrUnder(protect, at)
    if (kids.length === 0 && !shielded) continue
    if (kids.length === 1 && !shielded) {
      // Unwrap: the lone child inherits how the group joined to its siblings.
      out.push(setConn(kids[0], n.connector))
      continue
    }
    out.push({ ...n, children: kids })
  }
  if (out.length && out[0].connector != null) out[0] = stripConn(out[0])
  return out
}

// ---------- Write ----------

export function replaceAt(nodes, path, node) {
  if (!path?.length) return nodes
  const [i, ...rest] = path
  if (!nodes[i]) return nodes
  const next = [...nodes]
  next[i] = rest.length
    ? { ...nodes[i], children: replaceAt(nodes[i].children ?? [], rest, node) }
    : node
  return next
}

export function removeAt(nodes, path, protect = null) {
  if (!path?.length) return nodes
  const { parentPath, list, idx } = siblingsOf(nodes, path)
  if (!list[idx]) return nodes
  const nextSibs = [...list]
  nextSibs.splice(idx, 1)
  return normalize(withSiblings(nodes, parentPath, nextSibs), protect)
}

// Appends into the group at `groupPath` (or the root list when it's empty).
// Deliberately does NOT normalize: a freshly opened group is empty, and
// normalizing would delete it before the user can put anything inside.
export function appendInto(nodes, groupPath, node) {
  if (!groupPath?.length) return [...nodes, nodes.length === 0 ? stripConn(node) : node]
  const g = getAt(nodes, groupPath)
  if (!isGroup(g)) return [...nodes, node]
  const kids = g.children ?? []
  return replaceAt(nodes, groupPath, {
    ...g,
    children: [...kids, kids.length === 0 ? stripConn(node) : node],
  })
}

// Wraps a node together with the sibling on one side.
//
// Merging into an adjacent group absorbs the node rather than nesting it —
// grouping A with an existing `(B C)` reads as `(A B C)`, not `(A (B C))`.
// Two groups DO nest, since flattening them would silently lose a grouping
// the user deliberately made.
export function wrapWithNeighbour(nodes, path, dir) {
  if (!path?.length) return nodes
  const { parentPath, list, idx } = siblingsOf(nodes, path)
  const j = dir === 'next' ? idx + 1 : idx - 1
  if (j < 0 || j >= list.length) return nodes

  const lo = Math.min(idx, j)
  const a = list[lo]
  const b = list[Math.max(idx, j)]
  const bJoined = setConn(b, b.connector ?? 'AND')

  let merged
  if (isGroup(a) && isGroup(b)) {
    merged = newGroup([stripConn(a), bJoined], a.connector)
  } else if (isGroup(a)) {
    merged = { ...a, children: [...(a.children ?? []), bJoined] }
  } else if (isGroup(b)) {
    const bk = [...(b.children ?? [])]
    // b's first child had nothing before it; now `a` does, so it takes over
    // how b used to join.
    if (bk.length) bk[0] = setConn(bk[0], b.connector ?? 'AND')
    merged = setConn({ ...b, children: [stripConn(a), ...bk] }, a.connector)
  } else {
    merged = newGroup([stripConn(a), bJoined], a.connector)
  }

  const nextSibs = [...list]
  nextSibs.splice(lo, 2, merged)
  return normalize(withSiblings(nodes, parentPath, nextSibs))
}

// Splices a group's children back into its parent.
export function unwrapAt(nodes, path) {
  const g = getAt(nodes, path)
  if (!isGroup(g)) return nodes
  const { parentPath, list, idx } = siblingsOf(nodes, path)
  const kids = [...(g.children ?? [])]
  if (kids.length) kids[0] = setConn(kids[0], g.connector)
  const nextSibs = [...list]
  nextSibs.splice(idx, 1, ...kids)
  return normalize(withSiblings(nodes, parentPath, nextSibs))
}

export function toggleConnectorAt(nodes, path) {
  const n = getAt(nodes, path)
  if (!n || !path?.length) return nodes
  const { idx } = siblingsOf(nodes, path)
  if (idx === 0) return nodes
  return replaceAt(nodes, path, setConn(n, n.connector === 'OR' ? 'AND' : 'OR'))
}

// True when any top-level sibling joins with OR.
export function hasTopLevelOr(nodes) {
  return (nodes ?? []).some(n => n.connector === 'OR')
}

// Joins `incoming` onto `existing` with AND — how a pasted query lands on a bar
// that already holds chips.
//
// Only the incoming side can be misread. A sibling list folds strictly
// left-to-right with no precedence, so whatever `existing` means on its own it
// still means as the accumulated left operand. But a top-level OR arriving on
// the right would escape: `a` + `c OR d` flattened reads as `(a AND c) OR d`,
// matching any `d` at all. Bracketing the incoming side keeps it self-contained.
export function concatWithAnd(existing, incoming) {
  const left = normalize(existing ?? [])
  const right = normalize(incoming ?? [])
  if (!left.length) return right
  if (!right.length) return left

  const tail = hasTopLevelOr(right)
    ? [newGroup(right, 'AND')]
    : right.map((n, i) => (i === 0 ? setConn(n, 'AND') : n))
  return normalize([...left, ...tail])
}
