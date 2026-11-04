import type { Provider } from "@skail/runtime";
import { buildConfig } from "./build-config.generated.js";
import { PaymentFunctions } from "./payment-functions.js";
import { HttpInvoiceStore, HttpStatusNotifier } from "./web.js";

// The skail bundle cannot read environment variables: these settings are fixed at build time (gen-config.mjs).
export const providers: Provider[] = [
  {
    token: PaymentFunctions,
    useFactory: () =>
      new PaymentFunctions(
        new HttpInvoiceStore(buildConfig.webBaseUrl),
        new HttpStatusNotifier(buildConfig.webBaseUrl),
      ),
  },
];
