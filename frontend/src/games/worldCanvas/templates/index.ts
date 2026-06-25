/**
 * Stamp-template library barrel — vector art that a human stamps (a bounded TPS
 * spike) or an Artist-mode agent lays at its region, all funneling through the same
 * `rasterizeTemplate` → integer cell → co-signed move path as every other paint.
 * No Move / SDK / protocol change: a stamped cell is the frozen integer move.
 */
export type {
  StrokeTemplate,
  TemplatePath,
  TemplateStrokePath,
  TemplateFillPath,
  TemplateCategory,
  RasterizedTemplate,
} from "./types";
export { rasterizeTemplate, estimateMoves, fitScale } from "./rasterize";
export { buildText } from "./font";
export {
  TEMPLATES,
  TEMPLATES_BY_ID,
  TEMPLATE_CATEGORIES,
  TEMPLATE_CATEGORY_LABELS,
} from "./seeds";
export { drawTemplateThumb, drawTemplateGhost } from "./draw";
