// Full tier: ADR-0001 Validation 5, the proxy soak room on the rotating stream
// (test/motion/validation/soakSuite.ts, test/motion/validation/soaks.ts).
import { soakTests } from '../validation/soakSuite.ts'

soakTests('proxy', 'rotating')
