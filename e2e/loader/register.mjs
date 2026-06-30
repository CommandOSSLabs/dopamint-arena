// Registers the v2-bridge resolve hook. Loaded AFTER tsx (`--import tsx
// --import ./loader/register.mjs`) so it sits first in the resolve chain and
// can redirect @mysten specifiers before tsx/Node default resolution runs.
import { register } from 'node:module';

register('./v2-bridge.mjs', import.meta.url);
