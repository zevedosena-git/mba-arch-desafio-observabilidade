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

export function medirRequisicoes(
  requisicao: Request,
  resposta: Response,
  proximo: NextFunction
): void {
  const encerrarMedicao = duracaoDasRequisicoes.startTimer();

  resposta.on('finish', () => {
    // Template da rota (/produtos/:id), nunca o caminho concreto: o label precisa ter cardinalidade limitada.
    const rota: unknown = requisicao.route?.path;
    encerrarMedicao({
      route: typeof rota === 'string' ? rota : ROTA_NAO_RESOLVIDA,
      method: requisicao.method,
      status: String(resposta.statusCode),
    });
  });

  proximo();
}
