/**
 * Token accounting.
 *
 * Every number this repository prints comes from here, so the estimate is one
 * documented formula rather than a marketing figure. DSH ships no tokenizer and
 * providers differ, so the estimate is deliberately conservative:
 *
 *   tokens ≈ ceil(chars / 4)
 *
 * Four characters per token is the long-standing average for English prose and
 * code under byte-pair tokenizers. It is close for ASCII, and the catalog and
 * system prompt are almost entirely ASCII.
 *
 * @module src/tokens.mjs
 */

/** Average characters per token used for every estimate in this project. */
export const CHARS_PER_TOKEN = 4

/**
 * Estimate the token count of a string.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Format an estimated token count the way the CLI prints it.
 * @param {number} tokens
 * @returns {string}
 */
export function formatTokens(tokens) {
  const value = Number(tokens) || 0
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M tokens`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k tokens`
  return `${value} tokens`
}

/**
 * Format a byte count.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * Percentage saved, rounded, guarding against a zero baseline.
 * @param {number} before
 * @param {number} after
 * @returns {number}
 */
export function percentSaved(before, after) {
  const base = Number(before) || 0
  if (base <= 0) return 0
  return Math.round(((base - (Number(after) || 0)) / base) * 100)
}
