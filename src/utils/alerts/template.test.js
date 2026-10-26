// Alert-name templating: the Go text/template subset production's names use
// (docs/alerts/reference/production.md §6.4) and its value annotation
// (`{{ printf "%.2f" .Value }}`). The risk is a name that renders differently
// here than when the backend sends it — so production's two documented
// spellings, and what it does with a label a series lacks, are pinned.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderTemplate, usesTemplate, templateLabels, labelAction, templateDisplay, renderWebhookPreview, WEBHOOK_VARIABLES } from './template.js'

const series = { labels: { service: 'payment-service', 'host.name': 'ip-10-0-142-133', root_name: 'POST /v1/payments' }, value: 14.2367 }

test('production\'s two documented spellings fill in from the series\' labels', () => {
  assert.equal(renderTemplate('Error rate high on {{ .Labels.service }}', series), 'Error rate high on payment-service')
  assert.equal(renderTemplate('CPU high on {{ index .Labels "host.name" }}', series), 'CPU high on ip-10-0-142-133')
  assert.equal(renderTemplate('{{ $labels.root_name }} slow', series), 'POST /v1/payments slow', 'the Prometheus spelling vmalert also reads')
})

test('the value annotation production writes renders to two decimals', () => {
  assert.equal(renderTemplate('{{ printf "%.2f" .Value }}', series), '14.24')
  assert.equal(renderTemplate('{{ printf "%d" .Value }}', series), '14')
  assert.equal(renderTemplate('{{ .Value }}', { value: 3 }), '3')
})

test('a label the series lacks is Go\'s <no value>, so the preview shows the mistake', () => {
  assert.equal(renderTemplate('{{ .Labels.env }} / {{ index .Labels "k8s.pod" }}', series), '<no value> / <no value>')
  assert.equal(renderTemplate('{{ .Value }}', { labels: {} }), '<no value>')
})

test('anything else is left exactly as written; plain text is untouched', () => {
  assert.equal(renderTemplate('{{ humanize .Value }} on {{ .Labels.service }}', series), '{{ humanize .Value }} on payment-service')
  assert.equal(renderTemplate('Payment error rate high (POST /v1/payments)', series), 'Payment error rate high (POST /v1/payments)')
  assert.equal(renderTemplate('{{.Labels.service}}', series), 'payment-service', 'no spaces')
  assert.equal(renderTemplate('{{- .Labels.service -}}', series), 'payment-service', 'trim markers')
  assert.equal(renderTemplate(null), '')
})

test('a name\'s labels are found in order of first use, whichever spelling', () => {
  assert.deepEqual(templateLabels('{{ .Labels.service }} {{ index .Labels "host.name" }} {{ .Labels.service }} {{ printf "%.2f" .Value }}'), ['service', 'host.name'])
  assert.deepEqual(templateLabels('No variables here'), [])
  assert.equal(usesTemplate('CPU on {{ index .Labels "host.name" }}'), true)
  assert.equal(usesTemplate('Payment error rate high'), false)
})

test('Insert label writes the spelling Go needs, and it renders back to the label', () => {
  assert.equal(labelAction('service'), '{{ .Labels.service }}')
  assert.equal(labelAction('host.name'), '{{ index .Labels "host.name" }}')
  assert.equal(labelAction('k8s-pod'), '{{ index .Labels "k8s-pod" }}')
  for (const key of ['service', 'host.name', 'root_name']) {
    assert.equal(renderTemplate(labelAction(key), series), series.labels[key], key)
    assert.deepEqual(templateLabels(labelAction(key)), [key])
  }
})

test('a templated name stands for all its series by naming the labels it reads', () => {
  assert.equal(templateDisplay('CPU high on {{ index .Labels "host.name" }}'), 'CPU high on ‹host.name›')
  assert.equal(templateDisplay('{{ .Labels.service }} at {{ printf "%.2f" .Value }}'), '‹service› at ‹value›')
  assert.equal(templateDisplay('payment-service error rate'), 'payment-service error rate')
})

test('a webhook payload previews against an example alert, and a misspelling shows itself', () => {
  assert.equal(
    renderWebhookPreview('{"text": "[{{ .Status }}] {{ .CommonLabels.alertname }}: {{ .CommonAnnotations.summary }} ({{ len .Alerts }})"}'),
    '{"text": "[firing] payment-service error rate: payment-service is failing 13.85% of requests (1)"}',
  )
  assert.equal(renderWebhookPreview('{{ .CommonLabel.alertname }}'), '<no value>')
  assert.equal(renderWebhookPreview(''), '')
  assert.ok(WEBHOOK_VARIABLES.every(v => v.description && v.example))
})
