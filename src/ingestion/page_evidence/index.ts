// Ticket 05 surface: PDF page evidence, page previews and candidate identity.
//
// Downstream tickets (06 durable envelope, 07 per-page evaluator, 12 OCR
// fallback, 13 textless recovery) import the page evidence through here, so
// the extraction reading stays next to the bundle it feeds.
export {
  createBuiltinPdfPreviewRenderer,
  PagePreviewError,
  resolveDefaultPreviewScriptPath,
  PDF_PAGE_PREVIEW_SCHEMA_VERSION,
  type BuiltinPdfPreviewRendererOptions,
  type BoundedProcessRunner,
  type PagePreviewRenderer,
  type PagePreviewRequest,
  type RenderedPagePreview,
} from "./preview_renderer"
export {
  buildExtractionCandidateIdentity,
  computePreviewSetDigest,
  CandidateIdentityError,
  CANDIDATE_IDENTITY_SCHEMA_VERSION,
  PDF_EVIDENCE_VERSION,
  type ExtractionCandidateIdentity,
  type ExtractionCandidateIdentityInput,
} from "./candidate_identity"
export {
  buildPdfExtractionEvidenceBundle,
  indexedPageTextsForNormalization,
  PageEvidenceError,
  PDF_PAGE_EVIDENCE_SCHEMA_VERSION,
  type BuildPdfExtractionEvidenceBundleInput,
  type PdfEvidenceException,
  type PdfExtractionEvidenceBundle,
  type PdfPageEvidenceRecord,
  type PdfPagePreviewRecord,
  type PdfPageTextRecord,
  type PdfPageTextStatus,
} from "./page_evidence"
export {
  deriveQualityPageEvidence,
  splitQualityPageEvidence,
  QualityEvidenceUnavailableError,
  QUALITY_EVIDENCE_UNAVAILABLE,
} from "./quality_bridge"
export {
  readBuiltinPdfPageTexts,
  BuiltinPdfTextLayerAbsentError,
  BUILTIN_PDF_TEXT_LAYER_ABSENT,
  type BuiltinPdfPageTextReading,
} from "../parser/builtin_pdf"
export { bindPreviewEvidence, type ExtractionPagePreviewBinding } from "../tracking/extraction_evidence_repo"
