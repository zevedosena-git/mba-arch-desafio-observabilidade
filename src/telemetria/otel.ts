import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { AlwaysOnSampler } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { NOME_DO_SERVICO } from './servico';

const enderecoDoColetor =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

const sdk = new NodeSDK({
  resource: defaultResource().merge(
    resourceFromAttributes({ [ATTR_SERVICE_NAME]: NOME_DO_SERVICO })
  ),
  sampler: new AlwaysOnSampler(),
  traceExporter: new OTLPTraceExporter({
    url: enderecoDoColetor + '/v1/traces',
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
    }),
  ],
});

sdk.start();
