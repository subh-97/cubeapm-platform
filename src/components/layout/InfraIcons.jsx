import awsLogo from '@/assets/infra/aws.svg'
import gcpLogo from '@/assets/infra/gcp.svg'
import kubernetesLogo from '@/assets/infra/kubernetes.svg'
import apacheLogo from '@/assets/infra/apache-httpd.svg'
import elasticsearchLogo from '@/assets/infra/elasticsearch.svg'
import haproxyLogo from '@/assets/infra/haproxy.svg'
import iisLogo from '@/assets/infra/iis.svg'
import kafkaLogo from '@/assets/infra/kafka.svg'
import memcachedLogo from '@/assets/infra/memcached.svg'
import mongodbLogo from '@/assets/infra/mongodb.svg'
import mysqlLogo from '@/assets/infra/mysql.svg'
import nginxLogo from '@/assets/infra/nginx.svg'
import postgresqlLogo from '@/assets/infra/postgresql.svg'
import rabbitmqLogo from '@/assets/infra/rabbitmq.svg'
import redisLogo from '@/assets/infra/redis.svg'
import sqlServerLogo from '@/assets/infra/sql-server.svg'
import varnishLogo from '@/assets/infra/varnish-cache.svg'

// Every source but Host is shown by its vendor's own mark, kept as a file in
// assets/infra and drawn as an image rather than redrawn here. The empty alt is
// deliberate: the source's name is written right beside its icon.
const logo = src => size => <img src={src} width={size} height={size} alt="" />

const ICONS = {
  aws: logo(awsLogo),
  gcp: logo(gcpLogo),
  k8s: logo(kubernetesLogo),
  host: (size) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="#22D3EE" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="6" rx="1" />
      <rect x="3" y="14" width="18" height="6" rx="1" />
      <circle cx="7" cy="7" r=".6" fill="#22D3EE" stroke="none" />
      <circle cx="7" cy="17" r=".6" fill="#22D3EE" stroke="none" />
    </svg>
  ),
  apache: logo(apacheLogo),
  elastic: logo(elasticsearchLogo),
  haproxy: logo(haproxyLogo),
  iis: logo(iisLogo),
  kafka: logo(kafkaLogo),
  memcached: logo(memcachedLogo),
  mongo: logo(mongodbLogo),
  mysql: logo(mysqlLogo),
  nginx: logo(nginxLogo),
  postgres: logo(postgresqlLogo),
  rabbit: logo(rabbitmqLogo),
  redis: logo(redisLogo),
  sqlsvr: logo(sqlServerLogo),
  varnish: logo(varnishLogo),
}

export default function InfraIcon({ id, size = 16 }) {
  const render = ICONS[id]
  if (!render) {
    return <span className="infra-source-icon-fallback" style={{ width: size, height: size }} />
  }
  return <span className="infra-source-icon-svg" style={{ width: size, height: size }}>{render(size)}</span>
}
