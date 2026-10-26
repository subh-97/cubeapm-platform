import { Mail, Slack, Siren, Ticket, BellRing, MessageCircle, MessageSquare, Webhook, Send } from 'lucide-react'

// Each integration type's icon (catalog RECEIVER_TYPES' `type`), for the
// Notifications and Definition tabs. Always drawn beside the integration's
// label, never alone (D12, CLAUDE.md rule 4). `Send` stands in for a type this
// build does not know.
export const INTEGRATION_ICONS = {
  email: Mail, slack: Slack, pagerduty: Siren, jira: Ticket, opsgenie: BellRing,
  googlechat: MessageCircle, msTeamsV2: MessageSquare, webhook: Webhook,
}

export const integrationIcon = type => INTEGRATION_ICONS[type] ?? Send
