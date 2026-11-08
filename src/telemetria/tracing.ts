import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { log } from './log';

export const tracer = trace.getTracer('loja-pedidos');

export function registrarErro(mensagem: string, erro: unknown, pedidoId?: number): void {
  const excecao = erro instanceof Error ? erro : String(erro);
  const motivo = excecao instanceof Error ? excecao.message : excecao;

  function registrar(span: Span): void {
    span.recordException(excecao);
    span.setStatus({ code: SpanStatusCode.ERROR, message: motivo });
    log.error(mensagem + ': ' + motivo, pedidoId);
  }

  const spanAtivo = trace.getActiveSpan();
  if (spanAtivo) {
    registrar(spanAtivo);
    return;
  }

  // Fora de requisição (subida, leitura da fila) um span curto mantém o erro correlacionável ao log.
  tracer.startActiveSpan('aplicacao.erro', (span) => {
    try {
      registrar(span);
    } finally {
      span.end();
    }
  });
}
