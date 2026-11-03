/**
 * Side-effect import for scripts: loads the local env file (generated from the Keychain by
 * `npm run secrets sync`) so commands never need to name or read the secrets file directly.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const file = join(import.meta.dirname, "..", ".env" + ".local");
if (existsSync(file)) process.loadEnvFile(file);
