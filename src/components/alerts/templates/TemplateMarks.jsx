import { Activity, AppWindow, Bug, Cloud, Container, Database, Gauge, Server, Smartphone } from 'lucide-react'
import InfraIcon from '@/components/layout/InfraIcons'

// The marks Browse Templates draws beside a name: for an integration, the
// vendor's own, as the Infrastructure page draws it; for one of our modules,
// the sidebar's glyph (APM & Services' pulse, Errors' bug, Mobile's phone,
// Browser's window); for a Domain, a plain glyph of the area of the stack.
// Always beside the name they mark, never alone, so each is aria-hidden.

const GLYPHS = {
  services: Activity,
  errors: Bug,
  mobile: Smartphone,
  browser: AppWindow,
  apm: Gauge,
  cloud: Cloud,
  containers: Container,
  databases: Database,
}

/** A Domain's or a Sub-domain's mark, by its `icon` key (ruleTemplates.js). */
export function CategoryMark({ icon, size = 14, className = 'tpl-mark' }) {
  const Glyph = GLYPHS[icon]
  if (Glyph) return <Glyph className={className} width={size} height={size} aria-hidden="true" />
  return <span className={className} aria-hidden="true"><InfraIcon id={icon} size={size} /></span>
}

/** A hosting badge's mark: the cloud's own for AWS and GCP, a server or a cloud otherwise. */
export function HostingMark({ hosting, size = 12 }) {
  if (hosting === 'aws' || hosting === 'gcp') return <span className="tpl-mark" aria-hidden="true"><InfraIcon id={hosting} size={size} /></span>
  const Glyph = hosting === 'saas' ? Cloud : Server
  return <Glyph className="tpl-mark" width={size} height={size} aria-hidden="true" />
}
