import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { log } from './log';

export const tracer = trace.getTracer('loja-pedidos');
// A mesma exceção pode atravessar transação e handler. O WeakSet permite que
// o encerramento fatal reconheça esse diagnóstico sem reter os objetos de erro.
const errosRegistrados = new WeakSet<Error>();

export function erroJaRegistrado(erro: unknown): boolean {
  return erro instanceof Error && errosRegistrados.has(erro);
}

export function registrarErro(mensagem: string, erro: unknown, pedidoId?: number): void {
  const excecao = erro instanceof Error ? erro : String(erro);
  const motivo = excecao instanceof Error ? excecao.message : excecao;

  function registrar(span: Span): void {
    // Padrão OpenTelemetry de diagnóstico com evento de exceção e status ERROR.
    // O log escrito no mesmo contexto usa os IDs desse span para busca no Jaeger.
    span.recordException(excecao);
    span.setStatus({ code: SpanStatusCode.ERROR, message: motivo });
    log.error(mensagem + ': ' + motivo, pedidoId);
    if (erro instanceof Error) {
      errosRegistrados.add(erro);
    }
  }

  const spanAtivo = trace.getActiveSpan();
  if (spanAtivo) {
    registrar(spanAtivo);
    return;
  }

  // Inicialização e eventos de infraestrutura podem ocorrer fora de uma requisição.
  // Um span curto torna essas exceções correlacionáveis ao log JSON também nesse caso.
  tracer.startActiveSpan('aplicacao.erro', (span) => {
    try {
      registrar(span);
    } finally {
      span.end();
    }
  });
}
