import client from 'prom-client';
import { registro } from '../telemetria/metricas';

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
// Série que só nasce no primeiro evento some do gráfico e quebra o alerta que depende dela.
cobrancasProcessadas.inc({ resultado: 'aprovada' }, 0);
cobrancasProcessadas.inc({ resultado: 'recusada' }, 0);
cobrancasProcessadas.inc({ resultado: 'falha' }, 0);
