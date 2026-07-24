/**
 * @agent-os/fusion-core — pure fusion logic, no I/O (master plan §6, package layout).
 * Attribution contracts, template interpolation, consensus/divergence parsing.
 */

export {
  interpolateTemplate,
  TemplateInterpolationError,
} from "./templates.js";
export {
  enforceFusionContract,
  type FusionContractResult,
} from "./contract.js";
export { parseAttributedSpans, type AttributedSpan } from "./attribution.js";
