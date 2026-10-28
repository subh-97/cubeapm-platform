import { Copy, ExternalLink, History, Link, MoreHorizontal, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import { displayName } from '@/utils/alerts/describe'
import MenuButton from './MenuButton'
import { ruleActionItems } from './alertShared'

const ICONS = {
  pause: Pause, play: Play, edit: Pencil, copy: Copy, history: History,
  link: Link, trash: Trash2, external: ExternalLink,
}

/**
 * Everything else a rule offers, in one labelled menu: Pause or Resume, Edit,
 * Clone, Notification history, Copy link, Delete. Production spreads these over
 * a switch and five icon-only buttons on every row (R11); which items a rule
 * gets, and why one is disabled, is `ruleActionItems` (alertShared.js).
 *
 * `onAction(id)` gets the item id: 'pause' | 'resume' | 'edit' | 'clone' |
 * 'history' | 'copyLink' | 'delete'. Deleting asks first: show
 * DeleteRuleDialog on 'delete' rather than removing straight away.
 */
export default function RuleActionsMenu({ rule, onAction, label = 'Actions', align = 'right', className }) {
  const items = ruleActionItems(rule).map(item => {
    if (item.sep) return item
    const Icon = ICONS[item.icon]
    return { ...item, icon: Icon ? <Icon aria-hidden="true" /> : null }
  })
  const name = rule ? displayName(rule) : null
  return (
    <MenuButton
      label={label}
      icon={MoreHorizontal}
      items={items}
      onSelect={onAction}
      title={name ? `Actions for ${name}` : 'Actions'}
      ariaLabel={name ? `Actions for ${name}` : undefined}
      align={align}
      className={className}
    />
  )
}
