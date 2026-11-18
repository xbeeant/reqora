import { registerDict } from "../dicts.ts";
import * as cloud from "../ns/cloud.ts";
import * as core from "../ns/core.ts";
import * as docs from "../ns/docs.ts";
import * as modals from "../ns/modals.ts";
import * as protocol from "../ns/protocol.ts";
import * as request from "../ns/request.ts";
import * as response from "../ns/response.ts";
import * as shell from "../ns/shell.ts";
import * as store from "../ns/store.ts";
import * as sync from "../ns/sync.ts";
import * as testing from "../ns/testing.ts";
import * as tools from "../ns/tools.ts";

/**
 * Dictionary registry — imported for its side effect by ../index.ts.
 *
 * Static imports (rather than Vite's `import.meta.glob`) are intentional:
 * lib/* modules import the translator directly and are also executed by Node's
 * native TS stripping in test/*.test.mjs, where Vite-only globals do not exist.
 * Keep this list in sync with ns/*.ts; `npm run i18n:check` verifies it.
 */
type NsModule = { zh?: Record<string, string>; en?: Record<string, string> };

const modules: NsModule[] = [
  cloud, core, docs, modals, protocol, request, response, shell, store, sync, testing, tools,
];

for (const mod of modules) {
  if (mod.zh) registerDict("zh", mod.zh);
  if (mod.en) registerDict("en", mod.en);
}
