import client from 'prom-client';
import { registro } from '../telemetria/metricas';

// Contadores monotônicos no registry Prometheus do worker representam eventos
// de confirmação e cobrança. Os IDs individuais ficam nos logs e nos spans.
export const pedidosConfirmados = new client.Counter({
  name: 'pedidos_confirmados_total',
  help: 'Pedidos com estado confirmado gravado pelo worker',
  registers: [registro],
});
pedidosConfirmados.inc(0);

export const cobrancasProcessadas = new client.Counter({
  name: 'cobrancas_processadas_total',
  help: 'Tentativas de cobrança por resultado do processador',
  labelNames: ['resultado'],
  registers: [registro],
});
// Inicializar todos os resultados evita séries ausentes antes do primeiro evento,
// mantendo consultas e alertas disponíveis também durante o tráfego saudável.
cobrancasProcessadas.inc({ resultado: 'aprovada' }, 0);
cobrancasProcessadas.inc({ resultado: 'recusada' }, 0);
cobrancasProcessadas.inc({ resultado: 'falha' }, 0);
