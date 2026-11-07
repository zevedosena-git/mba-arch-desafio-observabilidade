import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { AlwaysOnSampler, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { NOME_DO_SERVICO } from './servico';
import { erroJaRegistrado, registrarErro } from './tracing';

const enderecoDoColetor =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
// Um destino OTLP indisponível deve respeitar um limite durante a saída fatal.
const PRAZO_EXPORTACAO_FATAL_MS = 2000;
// Manter a referência ao BatchSpanProcessor permite drenar os spans concluídos
// e registrar uma falha da própria exportação antes da saída do processo.
const processador = new BatchSpanProcessor(new OTLPTraceExporter({
  url: enderecoDoColetor + '/v1/traces',
}));

const sdk = new NodeSDK({
  resource: defaultResource().merge(
    resourceFromAttributes({ [ATTR_SERVICE_NAME]: NOME_DO_SERVICO })
  ),
  sampler: new AlwaysOnSampler(),
  spanProcessors: [processador],
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
    }),
  ],
});

sdk.start();

// Política compartilhada pela API e pelo worker para conter a aplicação, emitir
// diagnóstico e concluir a saída fatal. O chamador fornece a interrupção dos seus recursos.
export function criarEncerramentoFatal(interromperAtividade: () => void) {
  let iniciado = false;

  return {
    get iniciado(): boolean {
      return iniciado;
    },
    // Uma falha do processo recebe contexto raiz para evitar associação incidental
    // com um pedido. Erros já registrados mantêm a correlação produzida na origem.
    iniciar: context.bind(ROOT_CONTEXT, (mensagem: string, erro: unknown) => {
      if (iniciado) return;
      iniciado = true;

      // Executar a interrupção antes de aguardar Promises evita trabalho de negócio
      // concorrente durante a exportação. A trava acima torna a sequência única.
      interromperAtividade();
      if (!erroJaRegistrado(erro)) registrarErro(mensagem, erro);

      const limite = setTimeout(() => {
        registrarErro('falha ao exportar telemetria no encerramento', new Error('prazo de exportacao excedido'));
        process.exit(1);
      }, PRAZO_EXPORTACAO_FATAL_MS);

      // forceFlush mantém o processador ativo para receber o span da própria falha.
      // shutdown encerraria o recebimento de spans antes de uma eventual rejeição.
      void processador.forceFlush()
        .catch(async (falha) => {
          registrarErro('falha ao exportar telemetria no encerramento', falha);
          try {
            // Uma tentativa adicional envia o diagnóstico se o destino voltar.
            // Ambas as tentativas compartilham o limite de dois segundos acima.
            await processador.forceFlush();
          } catch (falhaDoDiagnostico) {
            registrarErro('falha ao exportar span de diagnostico no encerramento', falhaDoDiagnostico);
          }
        })
        .finally(() => {
          clearTimeout(limite);
          process.exit(1);
        });
    }),
  };
}
