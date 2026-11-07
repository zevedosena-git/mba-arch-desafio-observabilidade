import type { NextFunction, Request, Response } from 'express';
import client from 'prom-client';
import { registro } from '../telemetria/metricas';

const ROTA_NAO_RESOLVIDA = 'sem_rota';

const duracaoDasRequisicoes = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duracao das requisicoes HTTP em segundos',
  labelNames: ['route', 'method', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registro],
});

// Prometheus precisa de amostras anteriores ao incremento para calcular rate().
// Inicializar em zero permite observar a primeira falha de parsing no painel 5xx.
duracaoDasRequisicoes.zero({ route: ROTA_NAO_RESOLVIDA, method: 'POST', status: '500' });

export function medirRequisicoes(
  requisicao: Request,
  resposta: Response,
  proximo: NextFunction
): void {
  const encerrarMedicao = duracaoDasRequisicoes.startTimer();

  resposta.on('finish', () => {
    // O template do Express agrupa IDs na mesma série, limitando a cardinalidade
    // do histograma Prometheus. sem_rota agrupa 404 e falhas anteriores ao roteamento.
    const rota: unknown = requisicao.route?.path;
    encerrarMedicao({
      route: typeof rota === 'string' ? rota : ROTA_NAO_RESOLVIDA,
      method: requisicao.method,
      status: String(resposta.statusCode),
    });
  });

  proximo();
}
